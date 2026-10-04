"""Only RECORDED clips with audio are playable, even when a file exists (hub #77 predicate, codex-mobile on the worker)."""

from __future__ import annotations

import json
from pathlib import Path

from hub_voice import outbound as ob
from hub_voice.outbound import CallLedger, ClipLibrary, OutboundConfig, Refusal, plan_call, AlertRequest

T0 = 1_791_000_000_000


def test_suspect_not_recorded_and_no_audio_rows_are_known_but_never_played(tmp_path: Path) -> None:
    audio = tmp_path / "audio"
    (audio / "sw").mkdir(parents=True)
    rows = [
        {"key": "word.kumi", "status": "RECORDED", "file": "audio/sw/word.kumi.wav"},
        {"key": "word.na", "status": "NO_AUDIO", "audio": False, "file": "audio/sw/word.na.wav"},
        {"key": "word.mbili", "status": "SUSPECT", "file": "audio/sw/word.mbili.wav"},
        {"key": "word.tatu", "status": "NOT_RECORDED", "file": "audio/sw/word.tatu.wav"},
        {"key": "word.nne", "status": "RECORDED", "file": "audio/sw/word.nne.wav"},  # recorded but the file is absent
    ]
    (audio / "manifest.json").write_text(json.dumps({"copy_clips": rows}), encoding="utf-8")
    for k in ("word.kumi", "word.na", "word.mbili", "word.tatu"):
        ob.make_silence(audio / "sw" / f"{k}.wav", 40)  # every rejected row HAS a file: the predicate, not the filesystem, decides
    lib = ClipLibrary(audio / "manifest.json")
    assert all(lib.known(k) for k in ("word.kumi", "word.na", "word.mbili", "word.tatu", "word.nne"))
    assert lib.playable("word.kumi") and lib.playable("word.nne")
    assert not lib.playable("word.na") and not lib.playable("word.mbili") and not lib.playable("word.tatu")
    pairs, missing = lib.resolve_pairs(["word.kumi", "word.na", "word.mbili", "word.tatu", "word.nne"])
    assert [k for k, _ in pairs] == ["word.kumi"]
    assert missing == ["word.na", "word.mbili", "word.tatu", "word.nne"]
    # a call made only of such rows is never placed
    cfg = OutboundConfig(owner_e164="+254700000002", owner_device_id="d", sip_trunk_id="", manifest_path=audio / "manifest.json")
    req = AlertRequest.parse({"alert_id": "a1", "device_id": "d", "clip_keys": ["word.na", "word.mbili"]})
    plan = plan_call(req, cfg, lib, CallLedger(tmp_path / "l.jsonl"), T0)
    assert isinstance(plan, Refusal) and plan.reason == "nothing_to_play"
