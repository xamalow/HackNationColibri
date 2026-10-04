"""Listing preparer gate: the one rule the live browser view must obey.

The preparer (codex-mobile's Playwright script under apps/hub-voice/preparer) may
OPEN the listing, FILL the exact change and SHOW the banner "WAITING FOR NOOR'S
APPROVAL · <ref>" at any time. It may COMMIT (click Save) only when this gate says
so: an approval record that validates against contracts/approval-record.schema.json,
decision approved, whose digest equals the expected digest AND the envelope's
digest recomputed from its content (sauti.core.canon), for the same action_id,
before the envelope's valid_until, and never twice for the same action.

The gate is pure and holds the replay set; it never clicks anything itself. The
sidecar wrapper only tells the speaker what the preparer is showing.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from jsonschema import Draft202012Validator

from .base import Advice, SidecarContext, Turn

_REPO = Path(__file__).resolve().parents[4]
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

from sauti.core import canon  # noqa: E402

CONTRACTS = _REPO / "contracts"


def _parse_ts(text: str) -> datetime | None:
    try:
        return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


@dataclass(frozen=True)
class GateDecision:
    ok: bool
    reason: str
    detail: str = ""


@dataclass
class PreparerGate:
    schema_path: Path = field(default=CONTRACTS / "approval-record.schema.json")
    envelope_schema_path: Path = field(default=CONTRACTS / "action-envelope.schema.json")
    _committed: set[tuple[str, str]] = field(default_factory=set, init=False, repr=False)

    def __post_init__(self) -> None:
        self._approval = Draft202012Validator(json.loads(self.schema_path.read_text(encoding="utf-8")))
        self._envelope = Draft202012Validator(json.loads(self.envelope_schema_path.read_text(encoding="utf-8")))

    def may_commit(self, approval: Any, envelope: Any, expected_digest: str, now_ms: int) -> GateDecision:
        """Pure check. Call commit() only after this returns ok, in the same step as the click."""
        if not isinstance(approval, dict) or not isinstance(envelope, dict):
            return GateDecision(False, "malformed", "approval and envelope must be objects")
        if list(self._approval.iter_errors(approval)):
            return GateDecision(False, "approval_invalid", "approval record does not validate against the contract")
        if list(self._envelope.iter_errors(envelope)):
            return GateDecision(False, "envelope_invalid", "envelope does not validate against the contract")
        if approval.get("decision") != "approved":
            return GateDecision(False, "not_approved", f"decision is {approval.get('decision')}")
        body = {k: v for k, v in envelope.items() if k != "digest"}
        try:
            actual = canon.digest(canon.ENVELOPE_DOMAIN, body)
        except canon.CanonError as exc:
            return GateDecision(False, "envelope_invalid", str(exc))
        if actual != envelope.get("digest"):
            return GateDecision(False, "digest_mismatch", "envelope content does not match its digest: edited")
        if approval.get("digest") != expected_digest or envelope.get("digest") != expected_digest:
            return GateDecision(False, "digest_mismatch", "approval, envelope and the prepared change do not name the same digest")
        if approval.get("action_id") != envelope.get("action_id"):
            return GateDecision(False, "action_mismatch", "approval is for another action")
        until = _parse_ts(str(envelope.get("valid_until")))
        if until is None or now_ms >= int(until.timestamp() * 1000):
            return GateDecision(False, "expired", f"valid_until {envelope.get('valid_until')} has passed")
        key = (str(approval["action_id"]), str(expected_digest))
        if key in self._committed:
            return GateDecision(False, "replayed", "this action was already committed once")
        return GateDecision(True, "ok")

    def commit(self, approval: dict[str, Any], envelope: dict[str, Any], expected_digest: str, now_ms: int) -> GateDecision:
        """Re-checks and records the commit. The caller clicks Save only if this returns ok."""
        d = self.may_commit(approval, envelope, expected_digest, now_ms)
        if d.ok:
            self._committed.add((str(approval["action_id"]), str(expected_digest)))
        return d


class PreparerDisplay(Protocol):
    """The live browser view's DISPLAY port (Carter, 2026-10-04: "we want to see them doing it while on the phone").

    prepare() may open the listing, fill the exact change and show the banner at any
    time during the call; it changes a screen, not a system of record. There is no
    save/commit method on this port on purpose: committing happens in the preparer
    process, on an approval event from the hub, behind PreparerGate.
    """

    async def prepare(self, ref: str, change: dict[str, Any], banner: str) -> None: ...


class RecordingDisplay:
    """Default display: remembers what would be on screen (simulated runs and tests)."""

    def __init__(self) -> None:
        self.shown: list[dict[str, Any]] = []

    async def prepare(self, ref: str, change: dict[str, Any], banner: str) -> None:
        self.shown.append({"ref": ref, "change": change, "banner": banner})


def banner_for(ref: str) -> str:
    return f"WAITING FOR NOOR'S APPROVAL · {ref}"


class PreparerSidecar:
    """Drives the live view's display port and tells the speaker what is on screen.

    Concurrency with the call: as soon as the booking facts are complete (date and
    party size) the draft is prepared on screen; once the speaker has FILED the
    request the banner carries its reference letter. Nothing here can save.
    """

    name = "preparer"
    phase = 2  # reads the booking sidecar's facts from the same turn

    def __init__(self, display: PreparerDisplay | None = None) -> None:
        self.display: PreparerDisplay = display or RecordingDisplay()
        self.state: dict[str, Any] = {"showing": None}

    async def show(self, ref: str, change: dict[str, Any]) -> None:
        """Prepare + banner for a filed request. Also called by the speaker's filing tool right after filing."""
        banner = banner_for(ref)
        await self.display.prepare(ref, change, banner)
        self.state = {"showing": ref, "change": change, "banner": banner}

    async def run(self, turn: Turn, ctx: SidecarContext) -> Advice | None:
        latest = ctx.board.latest_advice().get("booking")
        facts = dict(latest.data.get("facts", {})) if latest else {}
        filed = next((ev for ev in reversed(ctx.board.events()) if ev.kind == "tool" and ev.data.get("tool") == "file_booking_request"), None)
        if filed is not None:
            ref = str(filed.data.get("ref", "?"))
            if self.state.get("showing") != ref:
                await self.show(ref, {"date": filed.data.get("date"), "party_size": filed.data.get("party_size")})
        elif "date" in facts and "party_size" in facts and self.state.get("showing") != "draft":
            await self.show("draft", {"date": facts["date"], "party_size": facts["party_size"]})
        if not self.state.get("showing"):
            return None
        what = "draft of the change" if self.state["showing"] == "draft" else f"proposal {self.state['showing']}"
        return Advice(self.name, f"live view shows the {what} prepared on the listing, banner '{self.state['banner']}'; nothing is saved until Noor approves", dict(self.state))
