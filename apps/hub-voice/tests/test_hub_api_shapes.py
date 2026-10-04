"""The client speaks the hub's real answer shapes (apps/hub voice_api.mjs, #45): refusals become words, not errors."""

from __future__ import annotations

import asyncio
import json

import pytest

from hub_voice.agent import REFUSAL_LINES, CallState, refusal_line
from hub_voice.config import FIXTURES, Settings
from hub_voice.hubclient import Availability, BookingRequest, FiledRequest, FilingRefused, HubActions, HubError, HubReadOnly

LIVE = "http://hub.invalid:1"


def live_actions(status: int, body, seen: list | None = None) -> HubActions:  # noqa: ANN001
    a = HubActions(LIVE, "t", FIXTURES, "demo-farm-001")

    async def fake_post(path: str, payload: dict):  # noqa: ANN202
        if seen is not None:
            seen.append((path, payload))
        return status, body

    a._post = fake_post  # type: ignore[method-assign]
    return a


REQ = BookingRequest(date="2026-10-10", party_size=2, visitor_name="Thomas", language="sw")


def test_201_and_200_retry_are_filed_with_expiry() -> None:
    a = live_actions(201, {"ref": "C", "action_id": "9f9f9f9f-1234-4abc-8123-abcdefabcdef", "status": "pending_owner", "expires_at": "2026-10-04T09:00:00Z"})
    out = asyncio.run(a.file_booking_request(REQ, "call-1"))
    assert isinstance(out, FiledRequest) and out.ref == "C" and out.expires_at == "2026-10-04T09:00:00Z" and out.status == "pending_owner"
    retry = live_actions(200, {"ref": "C", "action_id": "9f9f9f9f-1234-4abc-8123-abcdefabcdef", "status": "pending_owner"})
    assert isinstance(asyncio.run(retry.file_booking_request(REQ, "call-1")), FiledRequest)


@pytest.mark.parametrize(
    "status,body,expected_status,expected_reason",
    [
        (409, {"status": "unavailable", "reason": "full", "facts": {"remaining": 0, "capacity": 8}}, "unavailable", "full"),
        (409, {"status": "unavailable", "reason": "closed_day"}, "unavailable", "closed_day"),
        (409, {"status": "unavailable", "reason": "too_late"}, "unavailable", "too_late"),
        (422, {"status": "invalid", "reason": "party_size"}, "invalid", "party_size"),
        (429, {"status": "needs_owner", "reason": "budget_exhausted"}, "needs_owner", "budget_exhausted"),
        (503, {"status": "needs_owner", "reason": "store_unavailable"}, "needs_owner", "store_unavailable"),
        (409, None, "unavailable", "unknown"),
    ],
)
def test_refusals_are_structured_not_exceptions(status: int, body, expected_status: str, expected_reason: str) -> None:  # noqa: ANN001
    out = asyncio.run(live_actions(status, body).file_booking_request(REQ, "call-2"))
    assert isinstance(out, FilingRefused)
    assert out.status == expected_status and out.reason == expected_reason
    line = refusal_line(out)
    assert "/" in line and "Samahani" in line  # Swahili first, English after
    assert "booked" not in line.lower() and "confirmed" not in line.lower()


def test_unexpected_status_or_missing_ref_is_an_error_not_a_filing() -> None:
    with pytest.raises(HubError):
        asyncio.run(live_actions(500, {"error": "boom"}).file_booking_request(REQ, "c"))
    with pytest.raises(HubError):
        asyncio.run(live_actions(201, {"status": "pending_owner"}).file_booking_request(REQ, "c"))
    with pytest.raises(HubError):
        asyncio.run(live_actions(201, {"ref": "A", "action_id": 5}).file_booking_request(REQ, "c"))


def test_owner_proposal_sends_date_and_capacity_and_maps_budget_to_needs_owner() -> None:
    seen: list = []
    a = live_actions(201, {"ref": "N3", "action_id": "x", "status": "pending_owner", "kind": "close_day", "expires_at": "2026-10-04T09:00:00Z"}, seen)
    out = asyncio.run(a.file_owner_proposal("close_day", "funga Jumamosi", None, "call-o", date="2026-10-10"))
    assert isinstance(out, FiledRequest) and out.ref == "N3"
    path, payload = seen[0]
    assert path == "/v1/owner-proposals"
    assert payload["change"] == {"kind": "close_day", "text": "funga Jumamosi", "about_ref": "", "date": "2026-10-10"}
    assert payload["source"] == {"channel": "voice_owner", "call_id": "call-o"}
    cap = live_actions(201, {"ref": "N4", "action_id": "y", "status": "pending_owner"}, seen)
    asyncio.run(cap.file_owner_proposal("capacity", "nafasi kumi", None, "call-o", capacity=10))
    assert seen[1][1]["change"]["capacity"] == 10 and "date" not in seen[1][1]["change"]
    with pytest.raises(HubError):
        asyncio.run(cap.file_owner_proposal("capacity", "x", None, "c", capacity=0))
    with pytest.raises(HubError):
        asyncio.run(cap.file_owner_proposal("close_day", "x", None, "c", date="10/10"))
    budget = asyncio.run(live_actions(429, {"status": "needs_owner", "reason": "budget_exhausted"}).file_owner_proposal("other", "x", None, "c"))
    assert isinstance(budget, FilingRefused) and budget.status == "needs_owner"
    assert "atakupigia" in refusal_line(budget, owner=True)


def test_availability_reason_is_read() -> None:
    ro = HubReadOnly(LIVE, "t", FIXTURES)

    async def fake_get(path: str, params: dict):  # noqa: ANN202
        return {"date": params["date"], "capacity": 8, "confirmed": 0, "remaining": 0, "open": False, "reason": "closed_by_owner"}

    ro._get = fake_get  # type: ignore[method-assign]
    av = asyncio.run(ro.availability("2026-10-12"))
    assert av == Availability(date="2026-10-12", capacity=8, confirmed=0, open=False, reason="closed_by_owner")
    assert av.remaining == 0 and av.as_dict()["reason"] == "closed_by_owner"


def test_simulated_twin_refuses_full_and_closed_days_like_the_hub(tmp_path) -> None:  # noqa: ANN001
    a = HubActions("", "", tmp_path, "demo-farm-001", fixtures_dir=FIXTURES)
    full = asyncio.run(a.file_booking_request(BookingRequest(date="2026-10-17", party_size=1, visitor_name="A", language="sw"), "c"))
    assert isinstance(full, FilingRefused) and full.reason == "full"
    closed = asyncio.run(a.file_booking_request(BookingRequest(date="2026-10-12", party_size=1, visitor_name="A", language="sw"), "c"))
    assert isinstance(closed, FilingRefused) and closed.status == "unavailable"
    ok = asyncio.run(a.file_booking_request(BookingRequest(date="2026-10-10", party_size=2, visitor_name="A", language="sw"), "c"))
    assert isinstance(ok, FiledRequest) and ok.ref == "A"
    assert not (tmp_path / "proposals.jsonl").read_text(encoding="utf-8").count("2026-10-17")


def test_speaker_tool_says_the_refusal_and_does_not_touch_the_live_view(tmp_path) -> None:  # noqa: ANN001
    state = CallState(Settings(fixtures_dir=FIXTURES, runtime_dir=tmp_path), "call-r")
    result = asyncio.run(state.tool_file_booking_request("2026-10-17", 2, "Thomas"))
    assert result["status"] == "unavailable" and result["reason"] == "full"
    assert result["say"] == REFUSAL_LINES["full"]
    assert state.preparer.state.get("showing") is None
    events = [json.loads(e.to_json()) for e in state.board.events()]
    assert events[-1]["data"] == {"tool": "file_booking_request", "status": "unavailable", "reason": "full", "party_size": 2, "date": "2026-10-17"}
    ok = asyncio.run(state.tool_file_booking_request("2026-10-10", 2, "Thomas"))
    assert ok["ref"] == "A" and state.preparer.state["showing"] == "A"
