"""Priority 2: an approval is voided when the proposal content changes; states only move legally."""

from __future__ import annotations

import pytest

from sauti.agent.policy import ApprovalRequired, require_approval
from sauti.storage.states import InvalidTransition, ProposalState, now_iso, transition
from sauti.workflows import approve, propose
from tests.w2_helpers import SHEET, connect, propose_one, state

PRICE_Q = "Hi! How much does the tour cost for 4 people?"


def _approve_without_queueing(conn, pid: int, h: str) -> None:
    with conn:
        conn.execute(
            "INSERT INTO approvals (proposal_id, content_hash, approved_by, approved_at) VALUES (?, ?, 'noor', ?)",
            (pid, h, now_iso()),
        )
        transition(conn, pid, ProposalState.APPROVED)


def test_content_change_voids_approval_and_returns_to_proposed():
    conn = connect()
    pid, _, h, content = propose_one(conn, PRICE_Q)
    _approve_without_queueing(conn, pid, h)
    require_approval(conn, "book_slot", pid, h)  # valid right now

    changed = {**content, "body": content["body"].replace("8000", "800")}
    with conn:
        assert propose.update_content(conn, pid, changed, note="test edit")

    assert state(conn, pid) == "PROPOSED"
    with pytest.raises(ApprovalRequired):
        require_approval(conn, "book_slot", pid, h)
    new_hash = propose.content_hash(changed)
    with pytest.raises(ApprovalRequired):
        require_approval(conn, "book_slot", pid, new_hash)  # the old yes does not carry over
    voided = conn.execute("SELECT voided_at FROM approvals WHERE proposal_id = ?", (pid,)).fetchone()[0]
    assert voided is not None


def test_approving_with_the_hash_of_an_older_version_is_refused():
    conn = connect()
    pid, short_id, old_hash, content = propose_one(conn, PRICE_Q)
    with conn:
        propose.update_content(conn, pid, {**content, "body": content["body"] + " Karibu!"}, note="edit")
    result = approve.approve(conn, short_id, old_hash, SHEET)
    assert result.outcome == "changed"
    assert result.summary_sw  # Noor hears the new version
    assert state(conn, pid) == "PROPOSED"
    assert conn.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] == 0


def test_approval_needs_an_explicit_existing_short_id():
    conn = connect()
    _, short_id, h, _ = propose_one(conn, PRICE_Q)
    assert approve.approve(conn, "Z", h, SHEET).outcome == "not_found"
    assert approve.approve(conn, "", h, SHEET).outcome == "not_found"
    assert approve.approve(conn, short_id.lower(), h, SHEET).outcome == "queued"


def test_illegal_transitions_raise():
    conn = connect()
    pid, _, _, _ = propose_one(conn, PRICE_Q)
    for target in (ProposalState.QUEUED, ProposalState.SENT, ProposalState.DELIVERED):
        with pytest.raises(InvalidTransition), conn:
            transition(conn, pid, target)
    assert state(conn, pid) == "PROPOSED"


def test_rejected_is_final():
    conn = connect()
    pid, short_id, h, _ = propose_one(conn, PRICE_Q)
    assert approve.reject(conn, short_id).outcome == "rejected"
    assert approve.approve(conn, short_id, h, SHEET).outcome == "not_found"
    with pytest.raises(InvalidTransition), conn:
        transition(conn, pid, ProposalState.APPROVED)


def test_short_ids_are_unique_among_open_proposals_and_reused_after():
    conn = connect()
    _, a, _, _ = propose_one(conn, PRICE_Q, ext="1")
    _, b, _, _ = propose_one(conn, PRICE_Q, ext="2")
    assert (a, b) == ("A", "B")
    approve.reject(conn, "A")
    _, c, _, _ = propose_one(conn, PRICE_Q, ext="3")
    assert c == "A"


def test_every_state_change_is_logged():
    conn = connect()
    pid, short_id, h, _ = propose_one(conn, PRICE_Q)
    approve.approve(conn, short_id, h, SHEET)
    log = [r[0] for r in conn.execute(
        "SELECT to_state FROM proposal_events WHERE proposal_id = ? ORDER BY id", (pid,)
    )]
    assert log == ["PROPOSED", "APPROVED", "QUEUED"]
