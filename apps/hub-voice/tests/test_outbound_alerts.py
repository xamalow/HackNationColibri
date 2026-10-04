"""The sauti-alert worker: one call per alert, only to the enrolled owner, only known clips, never silence, capped per day."""

from __future__ import annotations

import asyncio
import inspect
import json
from pathlib import Path

import pytest

from hub_voice import outbound as ob
from hub_voice.config import FIXTURES, ConfigError, Settings
from hub_voice.hubclient import HubActions, HubReadOnly
from hub_voice.outbound import AlertRequest, CallLedger, CallPlan, ClipLibrary, OutboundConfig, Poller, Refusal, dial_target, farm_day, plan_call, result_payload, wav_frames

OWNER = "+254700000002"
DEVICE = "demo-basic-phone-001"
T0 = 1_791_000_000_000  # 2026-10-03T06:40:00Z = 09:40 EAT


def library(tmp_path: Path, rendered: tuple[str, ...] = ("alert.see_sms", "visits.booked")) -> ClipLibrary:
    """A manifest with four keys; only `rendered` have a WAV on disk."""
    audio = tmp_path / "audio"
    (audio / "sw").mkdir(parents=True)
    keys = ["alert.see_sms", "visits.booked", "platform.phone", "word.jumamosi"]
    manifest = {"copy_clips": [{"key": k, "file": f"audio/sw/{k}.wav", "status": "RECORDED" if k in rendered else "NOT_RECORDED"} for k in keys]}
    (audio / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    for k in rendered:
        ob.make_silence(audio / "sw" / f"{k}.wav", 120)
    return ClipLibrary(audio / "manifest.json")


def cfg(tmp_path: Path, **over) -> OutboundConfig:  # noqa: ANN003
    base = dict(owner_e164=OWNER, owner_device_id=DEVICE, sip_trunk_id="", daily_cap=3, manifest_path=tmp_path / "audio" / "manifest.json")
    base.update(over)
    return OutboundConfig(**base)


def request(**over) -> AlertRequest:  # noqa: ANN003
    item = {"alert_id": "alert-0001", "device_id": DEVICE, "clip_keys": ["visits.booked", "alert.see_sms"], "urgent": False}
    item.update(over)
    return AlertRequest.parse(item)


def test_request_parsing_refuses_numbers_and_junk() -> None:
    assert request().clip_keys == ("visits.booked", "alert.see_sms")
    for bad in [
        {"alert_id": "a", "device_id": DEVICE, "clip_keys": ["ok"], "to": "+254700000009"},
        {"alert_id": "a b", "device_id": DEVICE, "clip_keys": ["ok"]},
        {"alert_id": "a", "device_id": "", "clip_keys": ["ok"]},
        {"alert_id": "a", "device_id": DEVICE, "clip_keys": []},
        {"alert_id": "a", "device_id": DEVICE, "clip_keys": ["Bad.Key"]},
        {"alert_id": "a", "device_id": DEVICE, "clip_keys": ["x"] * 21},
        "not an object",
    ]:
        with pytest.raises(ValueError):
            AlertRequest.parse(bad)


def test_plan_only_for_the_enrolled_device_with_known_rendered_clips(tmp_path: Path) -> None:
    lib = library(tmp_path)
    ledger = CallLedger(tmp_path / "ledger.jsonl")
    plan = plan_call(request(), cfg(tmp_path), lib, ledger, T0)
    assert isinstance(plan, CallPlan) and [p.name for p in plan.files] == ["visits.booked.wav", "alert.see_sms.wav"] and plan.missing == ()
    # another device: refused, nothing reserved
    other = plan_call(request(alert_id="alert-0002", device_id="stranger-phone"), cfg(tmp_path), lib, CallLedger(tmp_path / "l2.jsonl"), T0)
    assert isinstance(other, Refusal) and other.reason == "device_mismatch"
    # unknown key: refused before anything else
    unk = plan_call(request(alert_id="alert-0003", clip_keys=["visits.booked", "alert.not_in_library"]), cfg(tmp_path), lib, CallLedger(tmp_path / "l3.jsonl"), T0)
    assert isinstance(unk, Refusal) and unk.reason == "unknown_clip"
    # known but not rendered: a partial sequence plays what exists and reports the rest
    partial = plan_call(request(alert_id="alert-0004", clip_keys=["word.jumamosi", "alert.see_sms"]), cfg(tmp_path), lib, CallLedger(tmp_path / "l4.jsonl"), T0)
    assert isinstance(partial, CallPlan) and partial.missing == ("word.jumamosi",) and len(partial.files) == 1
    # nothing rendered at all: not placed, Noor is never rung with silence
    silent = plan_call(request(alert_id="alert-0005", clip_keys=["word.jumamosi", "platform.phone"]), cfg(tmp_path), lib, CallLedger(tmp_path / "l5.jsonl"), T0)
    assert isinstance(silent, Refusal) and silent.reason == "nothing_to_play"
    # not configured: refused, value-free
    unconf = plan_call(request(alert_id="alert-0006"), cfg(tmp_path, owner_e164=""), lib, CallLedger(tmp_path / "l6.jsonl"), T0)
    assert isinstance(unconf, Refusal) and unconf.reason == "not_configured" and OWNER not in unconf.detail


def test_one_call_per_alert_survives_restart_and_the_daily_cap_is_per_farm_day(tmp_path: Path) -> None:
    lib = library(tmp_path)
    path = tmp_path / "ledger.jsonl"
    assert isinstance(plan_call(request(), cfg(tmp_path), lib, CallLedger(path), T0), CallPlan)
    # a "restarted" process with a fresh ledger object on the same file sees the reservation
    again = plan_call(request(), cfg(tmp_path), lib, CallLedger(path), T0 + 60_000)
    assert isinstance(again, Refusal) and again.reason == "duplicate"
    # cap 3: two more fit today, the fourth is refused
    for i in (2, 3):
        assert isinstance(plan_call(request(alert_id=f"alert-000{i}"), cfg(tmp_path), lib, CallLedger(path), T0 + i * 1000), CallPlan)
    capped = plan_call(request(alert_id="alert-0009"), cfg(tmp_path), lib, CallLedger(path), T0 + 9000)
    assert isinstance(capped, Refusal) and capped.reason == "cap_exhausted"
    # the farm day turns at midnight Nairobi (21:00 UTC), not midnight UTC
    assert farm_day(T0) == "2026-10-03"
    before_midnight_eat = int(__import__("datetime").datetime(2026, 10, 3, 20, 59, tzinfo=__import__("datetime").timezone.utc).timestamp() * 1000)
    after_midnight_eat = before_midnight_eat + 2 * 60_000
    assert farm_day(before_midnight_eat) == "2026-10-03" and farm_day(after_midnight_eat) == "2026-10-04"
    assert isinstance(plan_call(request(alert_id="alert-0010"), cfg(tmp_path), lib, CallLedger(path), after_midnight_eat), CallPlan)
    # the ledger is append-only JSONL; a torn last line is ignored, not trusted
    with path.open("a", encoding="utf-8") as fh:
        fh.write('{"kind": "reserve", "alert_id": "alert-0011", "farm_day": "2026-10-04"')  # no newline, no closing brace
    assert not CallLedger(path).reserved("alert-0011")


def test_dial_target_is_only_the_configured_owner_and_never_in_records(tmp_path: Path) -> None:
    assert dial_target(cfg(tmp_path)) == OWNER
    with pytest.raises(ConfigError):
        dial_target(cfg(tmp_path, owner_e164=""))
    ledger = CallLedger(tmp_path / "ledger.jsonl")
    ledger.record("alert-0001", "answered", T0, played=["a"], missing=[], to_sha256=ob.sha(OWNER), phone=OWNER, number=OWNER, token="secret-token")
    text = (tmp_path / "ledger.jsonl").read_text(encoding="utf-8")
    assert OWNER not in text and "secret-token" not in text and ob.sha(OWNER) in text
    with pytest.raises(ValueError):
        ledger.record("alert-0001", "approved", T0)  # not a status this worker can ever produce
    with pytest.raises(ValueError):
        result_payload("approved", [], [])


def test_wav_frames_are_20ms_pcm16_and_padded(tmp_path: Path) -> None:
    clip = tmp_path / "clip.wav"
    ob.make_silence(clip, 50, rate=24000)  # 1200 samples = 2 full frames + one half frame
    frames = list(wav_frames(clip))
    assert len(frames) == 3
    for data, rate, channels, spc in frames:
        assert rate == 24000 and channels == 1 and spc == 480 and len(data) == 960
    assert ob.clip_duration_ms(clip) == 50
    bad = tmp_path / "bad.wav"
    import wave

    with wave.open(str(bad), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(1)  # 8-bit
        wf.setframerate(24000)
        wf.writeframes(b"\x80" * 2400)
    with pytest.raises(ValueError):
        list(wav_frames(bad))


def test_poller_simulated_reserves_before_anything_reports_and_never_leaks_the_number(tmp_path: Path) -> None:
    lib = library(tmp_path)
    settings = Settings(fixtures_dir=FIXTURES, runtime_dir=tmp_path / "rt")
    hub_ro = HubReadOnly("", "", FIXTURES)
    actions = HubActions("", "", tmp_path / "rt", "demo-farm-001")
    ledger = CallLedger(tmp_path / "rt" / "ledger.jsonl")
    poller = Poller(settings, cfg(tmp_path), hub_ro, actions, ledger, lib, dispatcher=None)
    first = asyncio.run(poller.tick(T0))
    assert first == [{"alert_id": "alert-0001", "status": "simulated", "played": ["visits.booked", "alert.see_sms"]}]
    second = asyncio.run(poller.tick(T0 + 5000))  # same pending list again: duplicate, not re-reported
    assert second == [{"alert_id": "alert-0001", "status": "refused", "reason": "duplicate"}]
    calls = (tmp_path / "rt" / "outbound-calls.jsonl").read_text(encoding="utf-8")
    results = (tmp_path / "rt" / "owner-alert-results.jsonl").read_text(encoding="utf-8")
    assert calls.count("\n") == 1 and results.count("\n") == 1
    assert OWNER not in calls and OWNER not in results and ob.sha(OWNER) in calls
    assert json.loads(results)["status"] == "simulated" and json.loads(results)["missing"] == ["platform.phone", "word.jumamosi"]


def test_poller_live_dispatch_failure_keeps_the_reservation_no_retry_storm(tmp_path: Path) -> None:
    lib = library(tmp_path)
    settings = Settings(fixtures_dir=FIXTURES, runtime_dir=tmp_path / "rt")
    ledger = CallLedger(tmp_path / "rt" / "ledger.jsonl")
    calls: list[str] = []

    async def failing_dispatch(plan: CallPlan) -> str:
        calls.append(plan.alert_id)
        raise RuntimeError("livekit down")

    poller = Poller(settings, cfg(tmp_path), HubReadOnly("", "", FIXTURES), HubActions("", "", tmp_path / "rt", "demo-farm-001"), ledger, lib, dispatcher=failing_dispatch)
    # a dispatcher exception is NOT a terminal failure: LiveKit may still run the job (response lost), so it is dispatch_unknown
    assert asyncio.run(poller.tick(T0)) == [{"alert_id": "alert-0001", "status": "dispatch_unknown"}]
    assert asyncio.run(poller.tick(T0 + 1000)) == [{"alert_id": "alert-0001", "status": "refused", "reason": "duplicate"}]
    assert calls == ["alert-0001"]  # dispatched exactly once, never retried
    rows = [json.loads(line) for line in (tmp_path / "rt" / "ledger.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [r["kind"] for r in rows] == ["reserve", "result"] and rows[1]["status"] == "dispatch_unknown"
    reported = json.loads((tmp_path / "rt" / "owner-alert-results.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert reported["status"] == "dispatch_unknown" and reported["reason"].startswith("dispatch:")


def test_worker_has_no_model_and_no_approval_path() -> None:
    src = inspect.getsource(ob)
    import re

    # no model client, no approval or proposal code path: identifiers, not prose ("the voice never approves" is allowed)
    for forbidden in (r"\bopenai\b", r"\bapprove\w*\(", r"decideApproval", r"confirmBooking", r"\bpropose\w*\(", r"file_booking_request", r"file_owner_proposal", r'"NDIYO'):
        assert not re.search(forbidden, src), forbidden
    assert "sip_call_to=dial_target(cfg)" in src  # the only dial target
    assert "metadata" in src and 'meta.get("to"' not in src and 'meta.get("number"' not in src


def test_config_from_env_is_value_free(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SAUTI_OWNER_E164", "not a number")
    with pytest.raises(ConfigError) as info:
        OutboundConfig.from_env()
    assert "not a number" not in str(info.value)
    monkeypatch.setenv("SAUTI_OWNER_E164", "+254 700 000 002")
    monkeypatch.setenv("SAUTI_OWNER_DEVICE_ID", DEVICE)
    monkeypatch.setenv("SAUTI_ALERT_DAILY_CAP", "5")
    monkeypatch.delenv("LIVEKIT_URL", raising=False)
    c = OutboundConfig.from_env()
    assert c.owner_e164 == OWNER and c.daily_cap == 5 and not c.live
    monkeypatch.setenv("SAUTI_ALERT_DAILY_CAP", "0")
    with pytest.raises(ConfigError):
        OutboundConfig.from_env()
