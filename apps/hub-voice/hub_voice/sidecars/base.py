"""Bounded advisory sidecars.

Each caller turn, every sidecar runs in parallel under one time budget. A sidecar
returns Advice or None. A timeout or an exception is recorded on the blackboard
and the call carries on with whatever advice arrived (fail-open). Sidecars
receive a SidecarContext that can only READ: the blackboard view, the hub's
read-only queries, settings and the clock. There is no handle to speak, send,
call, commit or file anything, so a sidecar cannot act even if a model inside
it is talked into trying.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Protocol, Sequence, runtime_checkable

from ..blackboard import Blackboard
from ..config import Settings
from ..hubclient import HubReadOnly


@dataclass(frozen=True)
class Turn:
    """One caller utterance as the STT delivered it."""

    index: int
    text: str
    language_hint: str | None = None
    is_final: bool = True


@dataclass(frozen=True)
class Advice:
    source: str
    summary: str  # what the speaker reads, one or two sentences, redaction applies
    data: dict[str, Any] = field(default_factory=dict)
    kind: str = "advice"


@dataclass(frozen=True)
class SidecarContext:
    """Read-only view a sidecar gets. Deliberately has no 'actions' member."""

    __slots__ = ("settings", "hub", "board", "now_ms", "call_id")
    settings: Settings
    hub: HubReadOnly
    board: Blackboard
    now_ms: int
    call_id: str


@runtime_checkable
class Sidecar(Protocol):
    name: str

    async def run(self, turn: Turn, ctx: SidecarContext) -> Advice | None: ...


@dataclass
class SidecarRunReport:
    advices: list[Advice]
    timed_out: list[str]
    failed: list[str]
    elapsed_ms: int


async def _run_one(sidecar: Sidecar, turn: Turn, ctx: SidecarContext, budget_s: float) -> tuple[str, Advice | None, str | None]:
    try:
        advice = await asyncio.wait_for(sidecar.run(turn, ctx), timeout=budget_s)
        return sidecar.name, advice, None
    except asyncio.TimeoutError:
        return sidecar.name, None, "timeout"
    except Exception as exc:  # noqa: BLE001 - fail-open by design; the failure is recorded
        return sidecar.name, None, f"error: {type(exc).__name__}: {exc}"


async def run_sidecars(sidecars: Sequence[Sidecar], turn: Turn, ctx: SidecarContext, board: Blackboard, budget_ms: int | None = None) -> SidecarRunReport:
    """Run every sidecar under one budget; record advice, timeouts and errors; never raise.

    Sidecars declare an optional `phase` (default 1). Phase 1 runs in parallel; phase 2
    (readers of other sidecars' advice: escalator, preparer) runs after it on the
    remaining budget, never below a quarter of it, so their advice lands on the SAME
    turn instead of one turn late.
    """
    budget = (budget_ms if budget_ms is not None else ctx.settings.sidecar_budget_ms) / 1000.0
    started = time.monotonic()
    report = SidecarRunReport(advices=[], timed_out=[], failed=[], elapsed_ms=0)
    phases = sorted({int(getattr(s, "phase", 1)) for s in sidecars})
    for phase in phases:
        remaining = max(budget * 0.25, budget - (time.monotonic() - started))
        group = [s for s in sidecars if int(getattr(s, "phase", 1)) == phase]
        results = await asyncio.gather(*(_run_one(s, turn, ctx, remaining) for s in group))
        for name, advice, failure in results:
            if failure == "timeout":
                report.timed_out.append(name)
                board.append(name, "timeout", {"turn": turn.index, "budget_ms": int(remaining * 1000)})
            elif failure is not None:
                report.failed.append(name)
                board.append(name, "error", {"turn": turn.index, "message": failure})
            elif advice is not None:
                report.advices.append(advice)
                board.append(advice.source, advice.kind, {"turn": turn.index, "summary": advice.summary, **advice.data})
    report.elapsed_ms = int((time.monotonic() - started) * 1000)
    return report
