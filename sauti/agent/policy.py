"""Approval policy, enforced in code (CLAUDE.md §6): reading and proposing are free,
acting requires Noor's yes on one explicit proposal ID and one exact content hash.

Every function that sends, books, records, publishes or replies calls `require_approval`
first. Unknown tools are refused (fail closed).
"""

from __future__ import annotations

import sqlite3

from sauti.storage.states import ProposalState

FREE_TOOLS = frozenset({
    "list_requests", "check_calendar", "analyze_feedback",
    "propose_reply", "propose_listing_update", "propose_improvement",
})
ACTION_TOOLS = frozenset({
    "send_reply", "book_slot", "record_payment", "approve_batch", "publish_listing", "reply_to_review",
})

# The proposal state in which each action may run.
_ALLOWED_STATES: dict[str, frozenset[ProposalState]] = {
    "send_reply": frozenset({ProposalState.QUEUED, ProposalState.RETRY}),
    "book_slot": frozenset({ProposalState.APPROVED}),
}
_DEFAULT_STATES = frozenset({ProposalState.APPROVED})


class ApprovalRequired(Exception):
    """The action has no valid approval. Nothing was done."""


def is_free(tool: str) -> bool:
    return tool in FREE_TOOLS


def require_approval(conn: sqlite3.Connection, tool: str, proposal_id: int, content_hash: str) -> None:
    """Raise ApprovalRequired unless Noor approved exactly this content of this proposal."""
    if tool in FREE_TOOLS:
        return
    if tool not in ACTION_TOOLS:
        raise ApprovalRequired(f"unknown tool {tool!r} is refused")
    row = conn.execute("SELECT content_hash, state FROM proposals WHERE id = ?", (proposal_id,)).fetchone()
    if row is None:
        raise ApprovalRequired(f"{tool}: proposal {proposal_id} does not exist")
    current_hash, state = row
    if current_hash != content_hash:
        raise ApprovalRequired(f"{tool}: proposal {proposal_id} content changed since it was approved")
    if ProposalState(state) not in _ALLOWED_STATES.get(tool, _DEFAULT_STATES):
        raise ApprovalRequired(f"{tool}: proposal {proposal_id} is {state}")
    approved = conn.execute(
        "SELECT 1 FROM approvals WHERE proposal_id = ? AND content_hash = ? AND voided_at IS NULL LIMIT 1",
        (proposal_id, content_hash),
    ).fetchone()
    if approved is None:
        raise ApprovalRequired(f"{tool}: proposal {proposal_id} has no valid approval")
