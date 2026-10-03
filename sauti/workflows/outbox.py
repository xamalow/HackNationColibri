"""W2 step 8: send queued replies at the next connectivity. Restart-safe.

Each row is marked SENDING (committed) before the transport is called. After a
crash, a SENDING row means "maybe sent": we ask the transport (was_sent); if it
cannot tell, the row becomes UNCERTAIN and only Noor may resend. So a restart
neither loses a message nor sends it twice.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from collections.abc import Mapping
from dataclasses import dataclass, field

from sauti.agent.policy import ApprovalRequired, require_approval
from sauti.storage.states import OutboxStatus, ProposalState, current_state, now_iso, transition
from sauti.transport.base import Offline, OutboundChannel, OutboundMessage, TransportError

log = logging.getLogger("sauti.w2.outbox")

MAX_ATTEMPTS = 3


@dataclass
class FlushReport:
    sent: list[int] = field(default_factory=list)
    failed: list[int] = field(default_factory=list)
    uncertain: list[int] = field(default_factory=list)
    refused: list[int] = field(default_factory=list)
    offline: bool = False


def _set_status(
    conn: sqlite3.Connection,
    row_id: int,
    status: OutboxStatus,
    attempts: int | None = None,
    last_error: str | None = None,
    transport_ref: str | None = None,
) -> None:
    conn.execute(
        "UPDATE outbox SET status = ?, updated_at = ?, attempts = COALESCE(?, attempts),"
        " last_error = COALESCE(?, last_error), transport_ref = COALESCE(?, transport_ref) WHERE id = ?",
        (status.value, now_iso(), attempts, last_error, transport_ref, row_id),
    )


def recover(conn: sqlite3.Connection, transports: Mapping[str, OutboundChannel], report: FlushReport) -> None:
    """Resolve rows left in SENDING by a crash."""
    rows = conn.execute(
        "SELECT id, proposal_id, channel, idempotency_key FROM outbox WHERE status = ?", (OutboxStatus.SENDING.value,)
    ).fetchall()
    for row_id, proposal_id, channel, key in rows:
        transport = transports.get(channel)
        answer = transport.was_sent(key) if transport else None
        with conn:
            if answer is True:
                _set_status(conn, row_id, OutboxStatus.SENT)
                _advance(conn, proposal_id, ProposalState.SENT, "confirmed after restart")
                report.sent.append(proposal_id)
            elif answer is False:
                _set_status(conn, row_id, OutboxStatus.QUEUED)
            else:
                _set_status(conn, row_id, OutboxStatus.UNCERTAIN, last_error="crash during send, delivery unknown")
                _advance(conn, proposal_id, ProposalState.FAILED, "maybe sent: ask Noor before resending")
                report.uncertain.append(proposal_id)


def _advance(conn: sqlite3.Connection, proposal_id: int, to: ProposalState, note: str) -> None:
    if current_state(conn, proposal_id) is not to:
        transition(conn, proposal_id, to, note=note)


def flush(conn: sqlite3.Connection, transports: Mapping[str, OutboundChannel]) -> FlushReport:
    """Send every QUEUED row whose approval is still valid. Stops at the first sign of no connectivity."""
    report = FlushReport()
    recover(conn, transports, report)
    rows = conn.execute(
        "SELECT o.id, o.proposal_id, o.channel, o.recipient_ref, o.body, o.idempotency_key, o.attempts,"
        " p.content_hash, p.content FROM outbox o JOIN proposals p ON p.id = o.proposal_id"
        " WHERE o.status = ? ORDER BY o.id",
        (OutboxStatus.QUEUED.value,),
    ).fetchall()
    for row_id, proposal_id, channel, recipient, body, key, attempts, phash, pcontent in rows:
        content = json.loads(pcontent)
        try:
            require_approval(conn, "send_reply", proposal_id, phash)
            if body != content["body"] or recipient != content["recipient_ref"]:
                raise ApprovalRequired("outbox row differs from the approved content")
        except ApprovalRequired:
            log.warning("outbox row %s refused by policy", row_id, exc_info=True)
            report.refused.append(proposal_id)
            continue
        transport = transports.get(channel)
        if transport is None:
            # e.g. airbnb_manual: waits for the daughter to paste it and mark it sent
            continue

        with conn:
            _set_status(conn, row_id, OutboxStatus.SENDING, attempts=attempts + 1)
        try:
            receipt = transport.send(OutboundMessage(channel, recipient, body, key))
        except Offline:
            with conn:
                _set_status(conn, row_id, OutboxStatus.QUEUED, attempts=attempts)
            report.offline = True
            break
        except TransportError as exc:
            with conn:
                if attempts + 1 >= MAX_ATTEMPTS:
                    _set_status(conn, row_id, OutboxStatus.FAILED, last_error=str(exc)[:200])
                    _advance(conn, proposal_id, ProposalState.FAILED, "send failed")
                    report.failed.append(proposal_id)
                else:
                    _set_status(conn, row_id, OutboxStatus.QUEUED, last_error=str(exc)[:200])
            continue
        with conn:
            _set_status(conn, row_id, OutboxStatus.SENT, transport_ref=receipt.transport_ref)
            _advance(conn, proposal_id, ProposalState.SENT, f"sent via {channel}")
        report.sent.append(proposal_id)
    return report


def retry(conn: sqlite3.Connection, proposal_id: int) -> None:
    """Noor asked to resend a FAILED (or UNCERTAIN) message. Same approved content, same key."""
    with conn:
        transition(conn, proposal_id, ProposalState.RETRY, note="retry requested by noor")
        conn.execute(
            "UPDATE outbox SET status = ?, attempts = 0, updated_at = ? WHERE proposal_id = ?",
            (OutboxStatus.QUEUED.value, now_iso(), proposal_id),
        )


def mark_delivered(conn: sqlite3.Connection, proposal_id: int) -> None:
    with conn:
        conn.execute(
            "UPDATE outbox SET status = ?, updated_at = ? WHERE proposal_id = ?",
            (OutboxStatus.DELIVERED.value, now_iso(), proposal_id),
        )
        transition(conn, proposal_id, ProposalState.DELIVERED)


def mark_manual_sent(conn: sqlite3.Connection, proposal_id: int) -> None:
    """The daughter pasted an approved reply into Airbnb or GetYourGuide herself."""
    with conn:
        row = conn.execute(
            "SELECT o.id, p.content_hash FROM outbox o JOIN proposals p ON p.id = o.proposal_id"
            " WHERE o.proposal_id = ? AND o.status = ?",
            (proposal_id, OutboxStatus.QUEUED.value),
        ).fetchone()
        if row is None:
            raise ValueError(f"proposal {proposal_id} has no queued reply")
        require_approval(conn, "send_reply", proposal_id, row[1])
        _set_status(conn, row[0], OutboxStatus.SENT, transport_ref="manual")
        _advance(conn, proposal_id, ProposalState.SENT, "pasted manually")
