"""The blackboard is append-only and never holds a phone number or a code."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from hub_voice.blackboard import Blackboard, RedactionError
from hub_voice.redact import contains_secret_shape, redact_text


def test_redaction_of_numbers_codes_and_mail_keeps_dates() -> None:
    text = "Nipigie +254 712 345 678 au 0712345678, kodi ni NDIYO B 4821, barua test@example.com, tarehe 2026-10-11 watu 2"
    out = redact_text(text)
    assert "712" not in out and "4821" not in out and "example.com" not in out
    assert "2026-10-11" in out and "watu 2" in out
    assert not contains_secret_shape(out)


def test_append_only_and_redacted(tmp_path: Path) -> None:
    board = Blackboard("c1", sink_path=tmp_path / "c1.jsonl")
    board.append("caller", "turn", {"text": "my number is 0712 345 678 and the code is 4821", "party_size": 2})
    board.append("booking", "advice", {"summary": "party 2; 2026-10-11: 6 of 8 seats free", "facts": {"party_size": 2, "date": "2026-10-11"}})
    events = board.events()
    assert [e.seq for e in events] == [1, 2]
    assert not hasattr(board, "remove") and not hasattr(board, "update") and not hasattr(board, "clear")
    with pytest.raises(AttributeError):
        events[0].data = {}  # type: ignore[misc]
    rendered = (tmp_path / "c1.jsonl").read_text(encoding="utf-8")
    assert "0712" not in rendered and "4821" not in rendered
    assert json.loads(rendered.splitlines()[1])["data"]["facts"]["party_size"] == 2
    # the sink is append-only: a second board on the same file adds, never truncates
    Blackboard("c1", sink_path=tmp_path / "c1.jsonl").append("system", "note", {"event": "resume"})
    assert len((tmp_path / "c1.jsonl").read_text(encoding="utf-8").splitlines()) == 3


def test_defence_in_depth_refuses_an_unredactable_secret_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    board = Blackboard("c2")
    import hub_voice.blackboard as bb

    monkeypatch.setattr(bb, "redact_value", lambda v, key=None: v)  # pretend the redactor was bypassed
    with pytest.raises(RedactionError):
        board.append("caller", "turn", {"text": "code 4821"})
    assert board.events() == ()


def test_view_for_speaker_is_latest_per_sidecar_and_bounded() -> None:
    board = Blackboard("c3")
    board.append("language", "advice", {"summary": "sw"})
    board.append("language", "advice", {"summary": "sw (0.90)"})
    board.append("safety", "advice", {"summary": "x" * 5000})
    view = board.view_for_speaker(max_chars=300)
    assert "sw (0.90)" in view and view.count("[language]") == 1
    assert len(view) <= 300
