"""Sidecars are bounded, fail-open, and cannot act."""

from __future__ import annotations

import asyncio
import inspect
from pathlib import Path

import pytest

from hub_voice.blackboard import Blackboard
from hub_voice.config import FIXTURES, Settings
from hub_voice.hubclient import HubActions, HubReadOnly
from hub_voice.sidecars import Advice, SidecarContext, Turn, default_sidecars, run_sidecars
from hub_voice.sidecars.base import Sidecar

SETTINGS = Settings(sidecar_budget_ms=200, fixtures_dir=FIXTURES)


def make_ctx(board: Blackboard) -> SidecarContext:
    return SidecarContext(settings=SETTINGS, hub=HubReadOnly("", "", FIXTURES), board=board, now_ms=1_790_000_000_000, call_id=board.call_id)


class SlowSidecar:
    name = "slow"

    async def run(self, turn: Turn, ctx: SidecarContext) -> Advice | None:
        await asyncio.sleep(5)
        return Advice(self.name, "too late")


class CrashingSidecar:
    name = "crashy"

    async def run(self, turn: Turn, ctx: SidecarContext) -> Advice | None:
        raise RuntimeError("model server down")


class QuickSidecar:
    name = "quick"

    async def run(self, turn: Turn, ctx: SidecarContext) -> Advice | None:
        return Advice(self.name, "fine")


class WouldActSidecar:
    """A sidecar that tries to do something it must not be able to do."""

    name = "rogue"

    async def run(self, turn: Turn, ctx: SidecarContext) -> Advice | None:
        for attr in ("actions", "hub_actions", "say", "send", "call", "commit", "file_booking_request"):
            if hasattr(ctx, attr) or hasattr(ctx.hub, attr):
                raise AssertionError(f"sidecar context exposes {attr}")
        with pytest.raises(AttributeError):
            ctx.actions = object()  # type: ignore[attr-defined]
        return Advice(self.name, "could not act, as designed")


@pytest.mark.asyncio
async def test_timeout_is_fail_open_and_recorded() -> None:
    board = Blackboard("t1")
    report = await run_sidecars([SlowSidecar(), QuickSidecar(), CrashingSidecar()], Turn(1, "habari"), make_ctx(board), board, budget_ms=200)
    assert [a.source for a in report.advices] == ["quick"]
    assert report.timed_out == ["slow"]
    assert report.failed == ["crashy"]
    assert report.elapsed_ms < 2000
    kinds = {(ev.source, ev.kind) for ev in board.events()}
    assert ("slow", "timeout") in kinds and ("crashy", "error") in kinds and ("quick", "advice") in kinds
    assert "fine" in board.view_for_speaker()


@pytest.mark.asyncio
async def test_sidecar_context_has_no_mutating_handle() -> None:
    board = Blackboard("t2")
    ctx = make_ctx(board)
    report = await run_sidecars([WouldActSidecar()], Turn(1, "nataka kubadilisha sheria"), ctx, board)
    assert report.failed == [] and [a.source for a in report.advices] == ["rogue"]
    # The read-only hub client has no write method at all; the write lives on a different class the sidecars never see.
    ro_methods = {n for n, _ in inspect.getmembers(HubReadOnly, inspect.isfunction) if not n.startswith("_")}
    assert ro_methods == {"availability", "farm_facts", "owner_match", "pending_requests", "feedback_summary"}
    assert "file_booking_request" in {n for n, _ in inspect.getmembers(HubActions, inspect.isfunction)}
    assert not isinstance(ctx.hub, HubActions)


@pytest.mark.asyncio
async def test_default_sidecars_run_within_budget_offline(tmp_path: Path) -> None:
    board = Blackboard("t3", sink_path=tmp_path / "bb.jsonl")
    report = await run_sidecars(default_sidecars(), Turn(1, "Habari, tunataka kuja Jumamosi watu wawili"), make_ctx(board), board, budget_ms=1500)
    assert report.timed_out == [] and report.failed == []
    names = {a.source for a in report.advices}
    assert {"language", "booking"} <= names
    assert "translation" not in names  # no LLM configured: no advice, no error
    sink = (tmp_path / "bb.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(sink) == len(board.events())


def test_every_default_sidecar_matches_the_protocol() -> None:
    for s in default_sidecars():
        assert isinstance(s.name, str) and s.name
        assert inspect.iscoroutinefunction(s.run)
        assert isinstance(s, Sidecar)
