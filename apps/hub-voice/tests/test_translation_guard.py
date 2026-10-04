"""The translation aid never shows an empty or thinking-only answer, and never a number the caller did not say."""

from __future__ import annotations

import asyncio
import json

import pytest

from hub_voice.blackboard import Blackboard
from hub_voice.config import FIXTURES, Settings
from hub_voice.hubclient import HubReadOnly
from hub_voice.sidecars import SidecarContext, Turn
from hub_voice.sidecars import translation as tr
from hub_voice.sidecars.translation import NO_REASONING_REQUEST, TranslationSidecar, number_guard, visible_answer

httpx = pytest.importorskip("httpx")


def ctx_with_llm() -> SidecarContext:
    settings = Settings(fixtures_dir=FIXTURES, llm_base_url="http://127.0.0.1:1/v1", llm_model="gemma-4-e4b-it")
    board = Blackboard("tr")
    return SidecarContext(settings=settings, hub=HubReadOnly("", "", FIXTURES), board=board, now_ms=0, call_id="tr")


def fake_llm(monkeypatch: pytest.MonkeyPatch, message: dict, status: int = 200, seen: list | None = None) -> None:
    class FakeResponse:
        status_code = status

        def json(self):  # noqa: ANN202
            return {"choices": [{"message": message}]}

    class FakeClient:
        def __init__(self, *a, **k) -> None:  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):  # noqa: ANN204
            return self

        async def __aexit__(self, *a) -> None:  # noqa: ANN002
            return None

        async def post(self, url: str, json: dict):  # noqa: A002, ANN202
            if seen is not None:
                seen.append(json)
            return FakeResponse()

    monkeypatch.setattr(tr.httpx, "AsyncClient", FakeClient)


def test_visible_answer_strips_thinking_and_handles_parts() -> None:
    assert visible_answer({"content": "<think>hmm hmm</think>We would like to come on Saturday."}) == "We would like to come on Saturday."
    assert visible_answer({"content": "<think>only thinking, never closed"}) == ""
    assert visible_answer({"content": ""}) == ""
    assert visible_answer({"content": None, "reasoning_content": "lots of thinking"}) == ""
    assert visible_answer({"content": [{"type": "text", "text": "Habari"}, {"type": "text", "text": " yako"}]}) == "Habari yako"
    assert visible_answer({}) == ""


@pytest.mark.parametrize(
    "message",
    [{"content": ""}, {"content": "<think>" + "x" * 300}, {"content": "<thinking>a</thinking>"}, {"content": None, "reasoning_content": "..."}, {}],
    ids=["empty", "thinking-unclosed", "thinking-only", "reasoning-field-only", "no-content"],
)
def test_empty_or_thinking_only_answer_is_withheld(monkeypatch: pytest.MonkeyPatch, message: dict) -> None:
    fake_llm(monkeypatch, message)
    adv = asyncio.run(TranslationSidecar().run(Turn(1, "Tunataka kuja Jumamosi watu wawili", language_hint="sw"), ctx_with_llm()))
    assert adv is not None and adv.data.get("withheld") is True and adv.data.get("reason") == "empty_or_thinking_only"
    assert "translation" not in adv.data


def test_good_answer_is_labeled_and_request_asks_for_no_reasoning(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list = []
    fake_llm(monkeypatch, {"content": "<think>brief</think>We want to come on Saturday, two people."}, seen=seen)
    adv = asyncio.run(TranslationSidecar().run(Turn(1, "Tunataka kuja Jumamosi watu wawili", language_hint="sw"), ctx_with_llm()))
    assert adv is not None and adv.data["translation"] == "We want to come on Saturday, two people."
    assert adv.data["label"] == "machine_translation_unreviewed" and "never counted" in adv.summary
    assert seen and all(seen[0][k] == v for k, v in NO_REASONING_REQUEST.items())
    assert seen[0]["temperature"] == 0


def test_number_guard_withholds_invented_digits(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_llm(monkeypatch, {"content": "We want to come at 11:00 for 2 people."})
    adv = asyncio.run(TranslationSidecar().run(Turn(1, "Tunataka kuja saa tano watu wawili", language_hint="sw"), ctx_with_llm()))
    assert adv is not None and adv.data == {"withheld": True, "reason": "number_guard"}
    assert number_guard("watu 2", "2 people") and not number_guard("watu wawili", "2 people")


def test_no_llm_configured_means_no_advice_and_no_network() -> None:
    board = Blackboard("tr0")
    ctx = SidecarContext(settings=Settings(fixtures_dir=FIXTURES), hub=HubReadOnly("", "", FIXTURES), board=board, now_ms=0, call_id="tr0")
    assert asyncio.run(TranslationSidecar().run(Turn(1, "habari", language_hint="sw"), ctx)) is None
    assert json.dumps([e.to_json() for e in board.events()]) == "[]"
