"""Proposal state machine (CLAUDE.md §7). The only place where proposal states change.

    PROPOSED -> APPROVED -> QUEUED -> SENT -> DELIVERED
       |           |          |
       |           |          |-> FAILED -> RETRY -> SENT | FAILED
       |           |-> PROPOSED (content changed, approval voided)
       |-> REJECTED

Callers run transition() inside their own transaction, so a state change and the
write that justifies it (approval, booking, outbox row) commit together or not at all.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from enum import StrEnum


class ProposalState(StrEnum):
    PROPOSED = "PROPOSED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    QUEUED = "QUEUED"
    SENT = "SENT"
    DELIVERED = "DELIVERED"
    FAILED = "FAILED"
    RETRY = "RETRY"


class OutboxStatus(StrEnum):
    QUEUED = "QUEUED"
    # Written before the transport is called. Found after a crash, it means
    # "maybe sent": we ask the transport, and never resend blindly.
    SENDING = "SENDING"
    SENT = "SENT"
    DELIVERED = "DELIVERED"
    FAILED = "FAILED"
    # Crash during a send to a transport that cannot tell us if it went out.
    # Only Noor can decide to resend.
    UNCERTAIN = "UNCERTAIN"


P = ProposalState
ALLOWED: dict[ProposalState, frozenset[ProposalState]] = {
    P.PROPOSED: frozenset({P.APPROVED, P.REJECTED}),
    P.APPROVED: frozenset({P.QUEUED, P.PROPOSED}),
    P.QUEUED: frozenset({P.SENT, P.FAILED}),
    P.SENT: frozenset({P.DELIVERED}),
    P.FAILED: frozenset({P.RETRY}),
    P.RETRY: frozenset({P.SENT, P.FAILED}),
    P.REJECTED: frozenset(),
    P.DELIVERED: frozenset(),
}

OPEN_STATES = frozenset({P.PROPOSED, P.APPROVED})


class InvalidTransition(Exception):
    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def current_state(conn: sqlite3.Connection, proposal_id: int) -> ProposalState:
    row = conn.execute("SELECT state FROM proposals WHERE id = ?", (proposal_id,)).fetchone()
    if row is None:
        raise InvalidTransition(f"proposal {proposal_id} does not exist")
    return ProposalState(row[0])


def transition(
    conn: sqlite3.Connection, proposal_id: int, to: ProposalState, note: str | None = None
) -> None:
    """Move a proposal to `to`, or raise InvalidTransition. Logs the change for audit."""
    frm = current_state(conn, proposal_id)
    if to not in ALLOWED[frm]:
        raise InvalidTransition(f"proposal {proposal_id}: {frm} -> {to} is not allowed")
    at = now_iso()
    # Compare-and-set on the old state: a concurrent change makes this a no-op we detect.
    cursor = conn.execute(
        "UPDATE proposals SET state = ?, updated_at = ? WHERE id = ? AND state = ?",
        (to.value, at, proposal_id, frm.value),
    )
    if cursor.rowcount != 1:
        raise InvalidTransition(f"proposal {proposal_id} changed state concurrently")
    conn.execute(
        "INSERT INTO proposal_events (proposal_id, from_state, to_state, note, at) VALUES (?, ?, ?, ?, ?)",
        (proposal_id, frm.value, to.value, note, at),
    )
