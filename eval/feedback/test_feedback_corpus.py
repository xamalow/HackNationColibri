"""Feedback corpus: exact reference spans, required phenomena, and a scorer that can fail."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import build_dev_corpus  # noqa: E402
from corpus_kit import batches, read_corpus, reference_findings  # noqa: E402
from score_conditions import score  # noqa: E402

DEV = read_corpus(HERE / "dev-feedback.jsonl")
REQUIRED = {"mixed_language", "duplicate_resync", "duplicate_crosspost", "contradictory", "weak_evidence",
            "prompt_injection", "missing_date_price", "strong_outlier", "unsupported_language", "sarcasm", "code_switching"}


def test_dev_corpus_matches_its_builder() -> None:
    assert build_dev_corpus.main(["--check"]) == 0


def test_every_reference_quote_is_the_exact_text_at_its_span() -> None:
    for m in DEV:
        raw = m["text"].encode("utf-8")
        for lb in m["gold"]["labels"]:
            assert raw[lb["start"]:lb["end"]].decode("utf-8") == lb["quote"], m["id"]


def test_packet_phenomena_are_all_present_and_labels_are_marked_unreviewed() -> None:
    present = {p for m in DEV for p in m["phenomena"]}
    assert REQUIRED <= present, REQUIRED - present
    assert all(m["synthetic"] and m["label_status"] == "DRAFT_UNREVIEWED" for m in DEV)


def _gold_condition() -> dict:
    return {"condition": "reference", "batches": {b: {"findings": reference_findings(items)["findings"]}
                                                  for b, items in batches(DEV).items()}}


def test_the_reference_scores_perfectly() -> None:
    s = score(_gold_condition(), DEV)["summary"]
    assert (s["UNSUPPORTED_findings"], s["missed"], s["evidence_precision"]) == (0, 0, 1.0)
    assert s["correct"] == s["gold_findings"] > 0


def test_an_empty_condition_misses_everything() -> None:
    s = score({"batches": {b: {"findings": []} for b in batches(DEV)}}, DEV)["summary"]
    assert s["missed"] == s["gold_findings"] and s["correct"] == 0


@pytest.mark.parametrize(("batch", "finding"), [
    ("A", {"theme": "price", "direction": "negative", "evidence_ids": ["A07"]}),  # one complaint
    ("B", {"theme": "food", "direction": "positive", "evidence_ids": ["B01", "B02"]}),  # contradictory theme
    ("B", {"theme": "price", "direction": "negative", "evidence_ids": ["B05", "B11"]}),  # injection read as an opinion
    ("C", {"theme": "timing", "direction": "negative", "evidence_ids": ["C05", "C10", "C08"]}),  # Kikuyu counted
])
def test_an_unsupported_finding_is_caught(batch: str, finding: dict) -> None:
    cond = _gold_condition()
    cond["batches"][batch]["findings"].append(finding)
    assert score(cond, DEV)["summary"]["UNSUPPORTED_findings"] == 1


def test_citing_a_message_that_does_not_support_lowers_evidence_precision() -> None:
    cond = _gold_condition()
    cond["batches"]["A"]["findings"][0]["evidence_ids"].append("A10")  # "Thank you so much!"
    assert score(cond, DEV)["summary"]["evidence_precision"] < 1.0


def test_reference_labels_fed_as_a_condition_give_the_reference_findings() -> None:
    labels = {m["id"]: m["gold"]["labels"] for m in DEV}
    report = score({"condition": "labels", "labels": labels}, DEV)
    assert report["summary"]["UNSUPPORTED_findings"] == 0 and report["summary"]["missed"] == 0
    assert report["labels"]["theme_f1"] == 1.0 and report["labels"]["labels_on_unsupported_language"] == 0


def test_a_mixed_observation_on_a_contradictory_theme_is_recognized() -> None:
    cond = _gold_condition()
    assert score(cond, DEV)["summary"]["contradictions_recognized"] == "0/1"
    cond["batches"]["B"]["observations"] = [{"theme": "food", "direction": "mixed"}]
    report = score(cond, DEV)
    assert report["summary"]["contradictions_recognized"] == "1/1"
    assert report["summary"]["UNSUPPORTED_findings"] == 0  # an observation is not a finding
