"""The result-status contract between the worker and the hub (codex-mobile on #70): poller facts vs terminal worker facts."""

from __future__ import annotations

from pathlib import Path

import pytest

from hub_voice.outbound import POLLER_STATUSES, RESULT_STATUSES, TERMINAL_STATUSES, CallLedger, farm_day, result_payload

T0 = 1_791_000_000_000
DAY = farm_day(T0)


def test_status_sets_partition_the_contract() -> None:
    assert set(RESULT_STATUSES) == POLLER_STATUSES | TERMINAL_STATUSES
    assert not (POLLER_STATUSES & TERMINAL_STATUSES)
    assert "dispatch_unknown" in POLLER_STATUSES and "failed" in TERMINAL_STATUSES
    for s in RESULT_STATUSES:
        assert result_payload(s, [], [])["status"] == s
    with pytest.raises(ValueError):
        result_payload("timeout", [], [])


def test_dispatch_unknown_is_superseded_by_a_later_worker_result_and_never_blocks_it(tmp_path: Path) -> None:
    """The dispatch answer was lost; LiveKit ran the job anyway; the worker claimed, dialed and reported answered."""
    ledger = CallLedger(tmp_path / "ledger.jsonl")
    assert ledger.reserve("alert-0001", DAY, 5, T0)
    ledger.record("alert-0001", "dispatch_unknown", T0 + 1, reason="dispatch:ReadTimeout")
    assert ledger.terminal_results("alert-0001") == []  # unknown is not terminal: still open for reconciliation
    assert ledger.claim_dial("alert-0001", T0 + 2)  # the (actually dispatched) worker may still claim and dial
    assert ledger.quarantined("alert-0001")  # mid-dial it is an uncertain attempt
    ledger.record("alert-0001", "answered", T0 + 30_000, played=["visits.booked"], missing=[])
    statuses = [r["status"] for r in ledger.results("alert-0001")]
    assert statuses == ["dispatch_unknown", "answered"]
    assert [r["status"] for r in ledger.terminal_results("alert-0001")] == ["answered"]
    assert not ledger.quarantined("alert-0001")
    # and a worker-terminal failed is final: nothing the poller writes later changes that
    ledger2 = CallLedger(tmp_path / "l2.jsonl")
    assert ledger2.reserve("alert-0002", DAY, 5, T0) and ledger2.claim_dial("alert-0002", T0)
    ledger2.record("alert-0002", "failed", T0 + 5, reason="SipCallError")
    assert [r["status"] for r in ledger2.terminal_results("alert-0002")] == ["failed"]
    assert not ledger2.claim_dial("alert-0002", T0 + 6)  # never redialed
