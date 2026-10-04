"""codex #47780: nothing a pending alert or the environment carries may reach a log line or an output row verbatim."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from hub_voice.config import FIXTURES, ConfigError, Settings
from hub_voice.hubclient import HubActions, HubReadOnly
from hub_voice.outbound import CallLedger, ClipLibrary, OutboundConfig, Poller

SYNTHETIC_PHONE = "+254700000777"


class PendingWith(HubReadOnly):
    def __init__(self, items: list, fixtures: Path) -> None:
        super().__init__("", "", fixtures)
        self._items = items

    async def pending_alert_calls(self) -> list[dict]:
        return self._items


def test_malformed_alert_id_is_never_copied_into_output(tmp_path: Path) -> None:
    (tmp_path / "audio" / "sw").mkdir(parents=True)
    (tmp_path / "audio" / "manifest.json").write_text(json.dumps({"copy_clips": []}), encoding="utf-8")
    lib = ClipLibrary(tmp_path / "audio" / "manifest.json")
    cfg = OutboundConfig(owner_e164="+254700000002", owner_device_id="d", sip_trunk_id="", manifest_path=tmp_path / "audio" / "manifest.json")
    items = [
        {"alert_id": f"alert {SYNTHETIC_PHONE}", "device_id": "d", "clip_keys": ["x"]},  # space makes it malformed; carries a number
        {"alert_id": "ok-but-has-number", "device_id": "d", "clip_keys": ["x"], "to": SYNTHETIC_PHONE},  # refused for carrying a number
        "a string, not an object",
        None,
    ]
    poller = Poller(Settings(fixtures_dir=FIXTURES, runtime_dir=tmp_path / "rt"), cfg, PendingWith(items, FIXTURES), HubActions("", "", tmp_path / "rt", "t"), CallLedger(tmp_path / "rt" / "l.jsonl"), lib)
    out = asyncio.run(poller.tick(1_791_000_000_000))
    rendered = json.dumps(out)
    assert SYNTHETIC_PHONE not in rendered and "700000777" not in rendered and "ok-but-has-number" not in rendered
    assert all(row["status"] == "refused" and row["reason"] == "invalid" and row["alert_id"].startswith("invalid:") for row in out)
    assert len({row["alert_id"] for row in out}) == len(out)  # distinct inputs, distinct hashes
    assert len(out) == 4
    # nothing was reserved or reported for malformed items
    assert not (tmp_path / "rt" / "l.jsonl").exists() and not (tmp_path / "rt" / "owner-alert-results.jsonl").exists()


def test_invalid_daily_cap_error_has_no_cause_and_no_value(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SAUTI_OWNER_E164", "+254700000002")
    monkeypatch.setenv("SAUTI_ALERT_DAILY_CAP", f"12abc{SYNTHETIC_PHONE}")
    with pytest.raises(ConfigError) as info:
        OutboundConfig.from_env()
    assert info.value.__cause__ is None and info.value.__suppress_context__ is True
    assert "12abc" not in str(info.value) and SYNTHETIC_PHONE not in str(info.value)
    monkeypatch.setenv("SAUTI_OWNER_E164", f"call {SYNTHETIC_PHONE}")
    monkeypatch.setenv("SAUTI_ALERT_DAILY_CAP", "5")
    with pytest.raises(ConfigError) as info2:
        OutboundConfig.from_env()
    assert SYNTHETIC_PHONE not in str(info2.value) and info2.value.__cause__ is None
