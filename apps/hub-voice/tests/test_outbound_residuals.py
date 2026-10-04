"""codex-mobile's residuals on #66: legacy same-day rows still count against the cap; a crash after the claim is surfaced."""

from __future__ import annotations

import json
from pathlib import Path

from hub_voice.outbound import TERMINAL_STATUSES, CallLedger, farm_day

T0 = 1_791_000_000_000
DAY = farm_day(T0)


def test_legacy_same_day_reservations_without_markers_still_count_against_the_cap(tmp_path: Path) -> None:
    path = tmp_path / "ledger.jsonl"
    # a reservation persisted by the #65 worker, before marker files existed: a row, no slot, no marker
    path.write_text(json.dumps({"kind": "reserve", "alert_id": "legacy-0001", "farm_day": DAY, "t_ms": T0 - 60_000}) + "\n", encoding="utf-8")
    ledger = CallLedger(path)
    assert ledger.reserved("legacy-0001")  # the JSONL fallback still recognises it
    assert ledger.count(DAY) == 1  # and it counts
    # cap 1: the legacy call already used today's only slot
    assert ledger.reserve("new-0001", DAY, 1, T0) is False
    # cap 2: one more fits, then the day is full
    assert ledger.reserve("new-0001", DAY, 2, T0) is True
    assert ledger.count(DAY) == 2
    assert ledger.reserve("new-0002", DAY, 2, T0) is False
    # a legacy row for another day does not count today
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"kind": "reserve", "alert_id": "legacy-yesterday", "farm_day": "2026-10-02", "t_ms": T0}) + "\n")
    assert CallLedger(path).count(DAY) == 2


def test_dispatched_then_claim_then_crash_is_quarantined_and_never_redialed(tmp_path: Path) -> None:
    path = tmp_path / "ledger.jsonl"
    ledger = CallLedger(path)
    assert ledger.reserve("alert-0001", DAY, 5, T0)
    ledger.record("alert-0001", "dispatched", T0 + 1, dispatch_id="d1")  # the poller's acceptance fact
    assert ledger.claim_dial("alert-0001", T0 + 2)  # the worker claims
    # ... and crashes before any terminal result: dispatched is NOT a terminal result
    assert ledger.quarantined("alert-0001") is True
    assert not ledger.claim_dial("alert-0001", T0 + 3)  # a redispatch never redials
    assert [r["status"] for r in ledger.results("alert-0001")] == ["dispatched"]
    assert ledger.terminal_results("alert-0001") == []
    # only a worker result ends the quarantine
    ledger.record("alert-0001", "no_answer", T0 + 4, played=[], missing=[], reason="SipCallError")
    assert ledger.quarantined("alert-0001") is False
    assert TERMINAL_STATUSES == {"answered", "no_answer", "failed"}
    # simulated is an acceptance fact too, never terminal
    assert CallLedger(tmp_path / "s.jsonl").reserve("s-1", DAY, 5, T0)
    CallLedger(tmp_path / "s.jsonl").record("s-1", "simulated", T0, played=["a"], missing=[])
    assert CallLedger(tmp_path / "s.jsonl").claim_dial("s-1", T0 + 1) and CallLedger(tmp_path / "s.jsonl").quarantined("s-1")
