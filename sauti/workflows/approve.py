"""W2 step 7: Noor approves or rejects one proposal by its short ID.

An approval names an explicit short ID and carries the hash of the content Noor
was shown or heard. If the content changed since (new facts, slot taken), the
approval is refused and Noor hears the new version. Approving a booking holds the
seats in the shared calendar, in the same transaction that queues the reply.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from datetime import date
from typing import Any, Literal

from sauti.agent.policy import require_approval
from sauti.calendar import OverbookingError, hold_seats
from sauti.farm_sheet import FarmSheet
from sauti.storage.states import OPEN_STATES, ProposalState, now_iso, transition
from sauti.workflows import propose

Outcome = Literal["queued", "rejected", "changed", "slot_taken", "not_found", "nothing_to_send"]


@dataclass(frozen=True)
class ApproveResult:
    outcome: Outcome
    short_id: str
    summary_sw: str | None = None  # what Noor must hear now (new version), if any


def idempotency_key(proposal_id: int, content_hash: str) -> str:
    return hashlib.sha256(f"w2-reply:{proposal_id}:{content_hash}".encode()).hexdigest()


def _open_proposal(conn: sqlite3.Connection, short_id: str) -> tuple[int, str, dict[str, Any]] | None:
    row = conn.execute(
        "SELECT id, content_hash, content FROM proposals WHERE short_id = ? AND state IN (?, ?)",
        (short_id.strip().upper(), *(s.value for s in OPEN_STATES)),
    ).fetchone()
    return None if row is None else (row[0], row[1], json.loads(row[2]))


def list_open(conn: sqlite3.Connection) -> list[tuple[str, str, str]]:
    """(short_id, content_hash, summary_sw) of every open proposal, oldest first. Free (read only)."""
    rows = conn.execute(
        "SELECT short_id, content_hash, content FROM proposals WHERE state = ? ORDER BY id",
        (ProposalState.PROPOSED.value,),
    ).fetchall()
    return [(r[0], r[1], json.loads(r[2])["summary_sw"]) for r in rows]


def approve(
    conn: sqlite3.Connection, short_id: str, presented_hash: str, sheet: FarmSheet, approved_by: str = "noor"
) -> ApproveResult:
    short_id = short_id.strip().upper()
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        found = _open_proposal(conn, short_id)
        if found is None:
            return ApproveResult("not_found", short_id)
        proposal_id, current_hash, content = found
        if current_hash != presented_hash:
            return ApproveResult("changed", short_id, content["summary_sw"])
        if content["kind"] == "needs_noor":
            return ApproveResult("nothing_to_send", short_id)

        conn.execute(
            "INSERT INTO approvals (proposal_id, content_hash, approved_by, approved_at) VALUES (?, ?, ?, ?)",
            (proposal_id, current_hash, approved_by, now_iso()),
        )
        transition(conn, proposal_id, ProposalState.APPROVED, note=f"approved by {approved_by}")

        booking = content.get("booking")
        if booking:
            require_approval(conn, "book_slot", proposal_id, current_hash)
            try:
                hold_seats(conn, sheet, date.fromisoformat(booking["date"]), int(booking["party_size"]),
                           "direct", proposal_id=proposal_id)
            except OverbookingError:
                # Someone booked first (another channel). Undo this approval and propose again.
                conn.rollback()
                return _slot_taken(conn, proposal_id, short_id, sheet)

        transition(conn, proposal_id, ProposalState.QUEUED)
        at = now_iso()
        conn.execute(
            "INSERT INTO outbox (proposal_id, channel, recipient_ref, body, idempotency_key, status, created_at,"
            " updated_at) VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?)",
            (proposal_id, content["reply_channel"], content["recipient_ref"], content["body"],
             idempotency_key(proposal_id, current_hash), at, at),
        )
    return ApproveResult("queued", short_id)


def _slot_taken(conn: sqlite3.Connection, proposal_id: int, short_id: str, sheet: FarmSheet) -> ApproveResult:
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        message_id = conn.execute("SELECT message_id FROM proposals WHERE id = ?", (proposal_id,)).fetchone()[0]
        propose.refresh(conn, proposal_id, propose.understanding_from_db(conn, message_id), sheet)
        content = json.loads(conn.execute("SELECT content FROM proposals WHERE id = ?", (proposal_id,)).fetchone()[0])
    return ApproveResult("slot_taken", short_id, content["summary_sw"])


def reject(conn: sqlite3.Connection, short_id: str) -> ApproveResult:
    short_id = short_id.strip().upper()
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        found = _open_proposal(conn, short_id)
        if found is None:
            return ApproveResult("not_found", short_id)
        proposal_id = found[0]
        if conn.execute("SELECT state FROM proposals WHERE id = ?", (proposal_id,)).fetchone()[0] != "PROPOSED":
            return ApproveResult("not_found", short_id)
        transition(conn, proposal_id, ProposalState.REJECTED, note="rejected by noor")
    return ApproveResult("rejected", short_id)
