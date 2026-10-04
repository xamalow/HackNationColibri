"""Owner mode: Noor's own calls are answered in her language; her voice never approves anything."""

from __future__ import annotations

import inspect
import json
import re

import pytest

from hub_voice import agent as agent_mod
from hub_voice.agent import OWNER_TOOLS, TOURIST_TOOLS, CallState
from hub_voice.config import FIXTURES, Settings
from hub_voice.hubclient import HubError, HubReadOnly
from hub_voice.owner import classify_caller, normalize_number, number_hash

SYNTHETIC_OWNER = "+254700000002"  # the fixture's hash is of this synthetic number


def test_normalize_number_shapes() -> None:
    assert normalize_number("+254 700 000 002") == "+254700000002"
    assert normalize_number("tel:+254700000002") == "+254700000002"
    assert normalize_number("sip:+254700000002@sip.example") == "+254700000002"
    assert normalize_number("0700000002") == "0700000002"
    assert normalize_number("anonymous") is None
    assert normalize_number("") is None
    assert normalize_number(None) is None


@pytest.mark.asyncio
async def test_owner_mode_only_on_exact_hash_match_any_doubt_is_tourist() -> None:
    hub = HubReadOnly("", "", FIXTURES)
    fixture = json.loads((FIXTURES / "owner.json").read_text(encoding="utf-8"))
    assert fixture["enrolled_number_sha256"] == number_hash(SYNTHETIC_OWNER)
    assert (await classify_caller(SYNTHETIC_OWNER, hub)).mode == "owner"
    assert (await classify_caller("+254 700 000 002", hub)).mode == "owner"
    assert (await classify_caller("+254700000003", hub)).mode == "tourist"
    assert (await classify_caller(None, hub)).reason == "no_caller_id"
    assert (await classify_caller("anonymous", hub)).mode == "tourist"

    class Down(HubReadOnly):
        async def owner_match(self, caller_sha256: str) -> bool:
            raise HubError("hub unreachable")

    assert (await classify_caller(SYNTHETIC_OWNER, Down("", "", FIXTURES))).mode == "tourist"


def test_no_mode_has_an_approve_tool_and_the_sets_are_as_declared() -> None:
    src = inspect.getsource(agent_mod)
    tool_names = set(re.findall(r"@function_tool\(\)\s+async def (\w+)\(", src))
    assert tool_names == set(TOURIST_TOOLS) | set(OWNER_TOOLS)
    for forbidden in ("approve", "confirm", "commit", "close_day", "send_sms", "call_visitor", "read_code"):
        assert not any(forbidden in n for n in tool_names), forbidden
    assert "file_booking_request" not in OWNER_TOOLS  # the owner files changes as proposals, not visitor bookings
    assert "propose_change" not in TOURIST_TOOLS


@pytest.mark.asyncio
async def test_owner_tools_read_summaries_without_names_or_numbers_and_file_only_proposals(tmp_path) -> None:  # noqa: ANN001
    state = CallState(Settings(fixtures_dir=FIXTURES, runtime_dir=tmp_path), "call-owner", mode="owner")
    assert state.language_hint == "sw"
    pending = await state.tool_pending_requests()
    assert pending["count"] == 2
    for item in pending["pending"]:
        assert set(item) <= {"ref", "date", "party_size", "source", "filed_at"}
    summary = await state.tool_feedback_summary()
    assert summary["themes"][0]["unique_comments"] == 4
    # Noor says she will be late for request A: a proposal, read back to her phone with a code; nothing changes now
    filed = await state.tool_propose_change("running_late", "Nitachelewa kidogo, dakika thelathini, piga 0712345678", "A")
    assert filed["status"] == "pending_owner" and filed["ref"] == "N1"
    assert "NDIYO" in filed["say"] and "Hakuna kilichobadilika" in filed["say"]
    line = (tmp_path / "owner-proposals.jsonl").read_text(encoding="utf-8")
    assert "0712345678" not in line and '"read_back": "sms_with_code_to_enrolled_phone"' in line
    with pytest.raises(HubError):
        await state.tool_propose_change("approve_everything", "ndiyo", "A")
    # the blackboard carries the mode and the tool use, never the caller id
    rendered = "\n".join(ev.to_json() for ev in state.board.events())
    assert "propose_change" in rendered and SYNTHETIC_OWNER not in rendered and "0712" not in rendered


@pytest.mark.asyncio
async def test_spoken_yes_in_owner_mode_changes_nothing(tmp_path) -> None:  # noqa: ANN001
    state = CallState(Settings(fixtures_dir=FIXTURES, runtime_dir=tmp_path), "call-owner-2", mode="owner")
    view = await state.on_caller_turn("Ndiyo, thibitisha ombi A sasa hivi")
    assert not (tmp_path / "owner-proposals.jsonl").exists() and not (tmp_path / "proposals.jsonl").exists()
    assert all(ev.kind != "tool" for ev in state.board.events())
    assert "[sidecars]" in view or "[language]" in view
