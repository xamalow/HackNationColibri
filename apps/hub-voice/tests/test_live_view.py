"""The live view prepares during the call and never saves (Carter, 2026-10-04)."""

from __future__ import annotations

import inspect
from datetime import date

import pytest

from hub_voice.agent import CallState
from hub_voice.config import FIXTURES, Settings
from hub_voice.hubclient import BookingRequest
from hub_voice.sidecars import PreparerDisplay, RecordingDisplay
from hub_voice.sidecars.booking import BookingSidecar


@pytest.mark.asyncio
async def test_draft_appears_when_facts_complete_then_banner_carries_the_filed_ref(tmp_path) -> None:  # noqa: ANN001
    display = RecordingDisplay()
    state = CallState(Settings(fixtures_dir=FIXTURES, runtime_dir=tmp_path), "call-live", display)
    for s in state.sidecars:
        if isinstance(s, BookingSidecar):
            s._today = date(2026, 10, 8)  # deterministic weekday resolution
    view = await state.on_caller_turn("Habari, tunataka kuja Jumamosi watu wawili")
    assert display.shown and display.shown[-1]["ref"] == "draft"
    assert display.shown[-1]["banner"] == "WAITING FOR NOOR'S APPROVAL · draft"
    assert "[preparer]" in view and "nothing is saved" in view
    # the speaker files the request (what the tool does), and the screen follows immediately, before any further caller turn
    filed = await state.hub_actions.file_booking_request(BookingRequest(date="2026-10-10", party_size=2, visitor_name="Thomas", language="sw"), state.call_id)
    state.board.append("speaker", "tool", {"tool": "file_booking_request", "ref": filed.ref, "status": filed.status, "party_size": 2, "date": "2026-10-10"})
    await state.preparer.show(filed.ref, {"date": "2026-10-10", "party_size": 2})
    assert display.shown[-1]["ref"] == "A" and display.shown[-1]["banner"].endswith("· A")
    view2 = await state.on_caller_turn("Asante sana")
    assert "proposal A" in view2
    assert len([s for s in display.shown if s["ref"] == "A"]) == 1  # idempotent: no re-prepare on the next turn


def test_display_port_cannot_save() -> None:
    members = {n for n, _ in inspect.getmembers(PreparerDisplay) if not n.startswith("_")}
    assert members == {"prepare"}
    for forbidden in ("save", "commit", "submit", "publish"):
        assert forbidden not in members
    rec = {n for n, _ in inspect.getmembers(RecordingDisplay, inspect.isfunction) if not n.startswith("_")}
    assert rec == {"prepare"}
