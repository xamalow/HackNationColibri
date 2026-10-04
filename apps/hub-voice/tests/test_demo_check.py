"""The one-command voice-lane check passes on the fixtures, and fails when a rule is broken."""

from __future__ import annotations

import asyncio

import pytest

from hub_voice import demo_check
from hub_voice.agent import REFUSAL_LINES


def test_demo_check_passes_on_the_fixtures() -> None:
    r = asyncio.run(demo_check.run())
    failing = [c for c in r.checks if not c["ok"]]
    assert r.ok, failing
    assert len(r.checks) >= 18


def test_demo_check_catches_a_broken_rule(monkeypatch: pytest.MonkeyPatch) -> None:
    # pretend a full day were answered with the "another day" line: the check must go red
    monkeypatch.setitem(REFUSAL_LINES, "full", "Samahani, siku hiyo imejaa. Tuchague siku nyingine? / another day?")
    monkeypatch.setitem(REFUSAL_LINES, "group_exceeds_capacity", "pick another day / another day")
    r = asyncio.run(demo_check.run())
    assert not r.ok
    assert any("larger than one tour" in c["name"] and not c["ok"] for c in r.checks)
