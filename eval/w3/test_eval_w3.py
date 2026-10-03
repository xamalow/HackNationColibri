"""W3 evaluation fixtures: well-formed, self-consistent, and able to catch real mistakes."""

from __future__ import annotations

import copy
import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import pytest

W3 = Path(__file__).resolve().parent
ROOT = W3.parents[1]
sys.path.insert(0, str(W3))

import build_dev_fixtures  # noqa: E402
import reference_rules as rules  # noqa: E402
import run_fixtures as rf  # noqa: E402

DEV = {path.stem: fx for path, fx in rf.load("dev")}


def _oracle(fx: dict[str, Any]) -> dict[str, Any]:
    return rules.evaluate(fx["input"], fx["gold"]["lang"])


# ---------------------------------------------------------------- the fixtures themselves


def test_dev_fixtures_match_their_builder() -> None:
    assert build_dev_fixtures.write_all(build_dev_fixtures.build(), build_dev_fixtures.OUT_DIR, check=True) == []


@pytest.mark.parametrize("fid", sorted(DEV))
def test_dev_fixture_lints_clean(fid: str) -> None:
    assert rf.lint_fixture(rf.SETS["dev"] / f"{fid}.json", DEV[fid]) == []


def test_every_fixture_is_synthetic_and_unreviewed() -> None:
    assert all(fx["synthetic"] is True and fx["language_review"] == "unreviewed" for fx in DEV.values())


@pytest.mark.parametrize(("fid", "corrupt"), [
    ("W3-DEV-001", lambda fx: fx["expected"]["counts"]["directions"].update(unique_messages=4)),
    ("W3-DEV-003", lambda fx: fx["expected"]["ingest"].update(duplicates=[])),
    ("W3-DEV-006", lambda fx: fx["expected"]["rejected_labels"][0].update(reason="offsets_mismatch")),
    ("W3-DEV-008", lambda fx: fx["input"]["model_output"]["labels"][1].update(start=40)),
    ("W3-DEV-012", lambda fx: fx["expected"].update(findings=[{"theme": "food", "status": "not_enough_feedback"}])),
])
def test_lint_catches_a_wrong_expectation(fid: str, corrupt: Any) -> None:
    fx = copy.deepcopy(DEV[fid])
    corrupt(fx)
    assert rf.lint_fixture(rf.SETS["dev"] / f"{fid}.json", fx) != []


# ---------------------------------------------------------------- the fixtures catch real mistakes


def _naive(fx: dict[str, Any]) -> dict[str, Any]:
    """A plausible but wrong implementation: trusts every label, counts labels, no dedup, no language check."""
    by_theme: dict[str, dict[str, int]] = defaultdict(lambda: {"positive": 0, "negative": 0, "neutral": 0})
    for lab in fx["input"]["model_output"].get("labels", []):
        if lab.get("sentiment") in by_theme[lab.get("theme")]:
            by_theme[lab["theme"]][lab["sentiment"]] += 1
    counts = {t: {"unique_messages": sum(s.values()), **s} for t, s in by_theme.items() if sum(s.values())}
    findings = []
    for theme, c in counts.items():
        side = max(("positive", "negative"), key=lambda s: c[s])
        findings.append({"theme": theme, "status": "enough_evidence", "sentiment": side} if c[side] >= 3
                        else {"theme": theme, "status": "not_enough_feedback"})
    return {"counts": counts, "findings": findings, "ingest": {"duplicates": [], "rejected": []},
            "accepted_labels": [{"message_id": l.get("message_id"), "theme": l.get("theme")}
                                for l in fx["input"]["model_output"].get("labels", [])],
            "rejected_labels": [], "ask_a_person": [],
            "side_effects": {"facts_changed": False, "approvals_created": 0, "outbox_entries": 0}}


@pytest.mark.parametrize("fid", ["W3-DEV-003", "W3-DEV-004", "W3-DEV-005", "W3-DEV-006", "W3-DEV-011", "W3-DEV-015"])
def test_naive_counting_fails_the_fixture(fid: str) -> None:
    assert rf.compare(DEV[fid], _naive(DEV[fid]), rf.ORACLE_KEYS) != []


def test_code_point_offsets_fail_the_utf8_fixture(monkeypatch: pytest.MonkeyPatch) -> None:
    original = rules.label_problem

    def code_point_offsets(label, stored, duplicates, eligible):  # type: ignore[no-untyped-def]
        problem = original(label, stored, duplicates, eligible)
        if problem not in (None, "quote_mismatch", "span_out_of_range", "span_not_on_char_boundary"):
            return problem
        text = stored[label["message_id"]]["text"]
        return None if text[label["start"]:label["end"]] == label["quote"] else "quote_mismatch"

    monkeypatch.setattr(rules, "label_problem", code_point_offsets)
    fx = DEV["W3-DEV-008"]
    assert rf.compare(fx, _oracle(fx), rf.ORACLE_KEYS) != []


# ---------------------------------------------------------------- decision card checks (step 4)


def _card(**changes: Any) -> dict[str, Any]:
    fx = DEV["W3-DEV-016"]
    text = next(m["text"] for m in fx["input"]["messages"] if m["id"] == "m1")
    quote = "The road from Othaya was hard to find"
    start = text.encode("utf-8").find(quote.encode("utf-8"))
    card = {
        "theme": "directions",
        "text": "Wageni watatu walisema ni vigumu kupata shamba. Unaweza kujaribu kuweka kibao. "
                "Jaribu, kataa, au uliza mtu?",
        "quotes": [{"message_id": "m1", "quote": quote, "start": start, "end": start + len(quote.encode("utf-8"))}],
        "choices": ["try", "reject", "ask_someone"],
        "prospective": True,
    }
    card.update(changes)
    return card


def _check(*cards: dict[str, Any]) -> list[str]:
    fx = DEV["W3-DEV-016"]
    actual = {**_oracle(fx), "cards": list(cards)}
    return rf.check_cards(fx["expected"]["cards"], fx, actual)


def test_a_grounded_card_passes() -> None:
    assert _check(_card()) == []


@pytest.mark.parametrize("bad", [
    _card(text="Punguza bei hadi shilingi elfu moja. Jaribu, kataa, au uliza mtu?"),  # 1000 is no fact
    _card(quotes=[{"message_id": "m1", "quote": "The road was impossible to find", "start": 26, "end": 63}]),
    _card(quotes=[{"message_id": "m4", "quote": "Best coffee", "start": 0, "end": 11}]),  # not directions evidence
    _card(quotes=[{"message_id": "m7", "quote": "the road has no sign", "start": 0, "end": 20}]),  # rejected label
    _card(choices=["try", "reject"]),
    _card(prospective=False),
    _card(theme="timing"),  # below MIN_MENTIONS
])
def test_card_checks_catch_ungrounded_cards(bad: dict[str, Any]) -> None:
    assert _check(bad) != []


def test_missing_required_card_is_reported() -> None:
    assert _check() != []


# ---------------------------------------------------------------- adapter protocol and manifest


def _adapter(code: str) -> list[str]:
    return [sys.executable, "-c", code]


def test_adapter_receives_input_without_gold_or_expected() -> None:
    echo = "import json,sys; d=json.load(sys.stdin); print(json.dumps({'keys': sorted(d)}))"
    assert rf.run_adapter(_adapter(echo), DEV["W3-DEV-001"]) == {"keys": ["fixture_id", "input"]}


@pytest.mark.parametrize("code", ["print('not json')", "import sys; sys.exit(3)", "print('[1, 2]')"])
def test_broken_adapter_is_reported(code: str) -> None:
    with pytest.raises(rf.AdapterError):
        rf.run_adapter(_adapter(code), DEV["W3-DEV-001"])


def test_manifest_detects_an_edited_heldout_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fixture_file = tmp_path / "W3-HO-999.json"
    fixture_file.write_text("{}", encoding="utf-8")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"files": {"W3-HO-999.json": rf._sha256(fixture_file)}}), encoding="utf-8")
    monkeypatch.setattr(rf, "MANIFEST", manifest)
    assert rf.lint_manifest([(fixture_file, {})]) == []
    fixture_file.write_text('{"edited": true}', encoding="utf-8")
    assert rf.lint_manifest([(fixture_file, {})]) != []


def test_assumed_language_id_adds_only_missing_true_languages() -> None:
    fx = rf.with_declared_languages(DEV["W3-DEV-011"])
    langs = {m["id"]: m.get("lang") for m in fx["input"]["messages"]}
    assert langs == {"m1": "ki", "m2": "en", "m3": "en"}
    assert fx["expected"] == DEV["W3-DEV-011"]["expected"]
    assert "lang" not in DEV["W3-DEV-011"]["input"]["messages"][0]  # the original fixture is untouched


@pytest.mark.parametrize("args", [["lint"], ["run", "--impl", "oracle"]])
def test_cli_exits_zero(args: list[str]) -> None:
    proc = subprocess.run([sys.executable, str(W3 / "run_fixtures.py"), *args], capture_output=True,
                          text=True, encoding="utf-8", check=False)
    assert proc.returncode == 0, proc.stdout + proc.stderr
