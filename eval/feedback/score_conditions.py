"""Score one condition (manual reading, keyword baseline, local model...) against the reference.

    python eval/feedback/score_conditions.py <condition.json> [--corpus dev|heldout] [--report out.json]

Same inputs and same task for every condition: for each batch, list the points Noor could act on
(theme + direction) with the message ids that support each one, stating a point only when at least 3
different visitors support it. A condition gives either
  - "batches": {batch: {"findings": [{theme, direction, evidence_ids}], "seconds": n}}, or
  - "labels": {message_id: [{theme, sentiment, quote}]} (+ optional "excluded_ids"): findings are then
    derived by code with the same rules as the reference (duplicates: same author and same text).

Headline numbers: unsupported findings (stated without 3 real supporting comments, the critical
error), missed findings, evidence precision, and time when given.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

from corpus_kit import SENTIMENTS, THEMES, batches, read_corpus, reference_findings

HERE = Path(__file__).resolve().parent
CORPORA = {"dev": HERE / "dev-feedback.jsonl", "heldout": HERE / "heldout" / "heldout-feedback.jsonl"}


def _norm(text: str) -> str:
    return " ".join(text.casefold().split())


def derive_findings(items: list[dict[str, Any]], labels: dict[str, list[dict[str, Any]]],
                    excluded: set[str]) -> list[dict[str, Any]]:
    """What a pipeline would conclude from predicted labels, counted with the reference rules."""
    first: dict[tuple[str, str], str] = {}
    pseudo = []
    for m in items:
        key = (_norm(m.get("author") or m["id"]), _norm(m["text"]))
        rep = first.setdefault(key, m["id"])
        predicted = [{"theme": lb.get("theme"), "sentiment": lb.get("sentiment"), "quote": lb.get("quote", "x"),
                      "start": 0, "end": 0} for lb in labels.get(m["id"], [])
                     if lb.get("theme") in THEMES and lb.get("sentiment") in SENTIMENTS]
        pseudo.append({"id": m["id"], "gold": {"supported_language": m["id"] not in excluded,
                                               "duplicate_of": rep if rep != m["id"] else None, "labels": predicted}})
    return reference_findings(pseudo)["findings"]


def _supports(index: dict[str, dict[str, Any]], mid: str, theme: str, direction: str) -> bool:
    m = index.get(mid)
    if m is None or not m["gold"]["supported_language"]:
        return False
    rep = index[m["gold"]["duplicate_of"]] if m["gold"]["duplicate_of"] else m
    return any(lb["theme"] == theme and lb["sentiment"] == direction for lb in rep["gold"]["labels"])


def score_batch(items: list[dict[str, Any]], predicted: list[dict[str, Any]],
                observations: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    index = {m["id"]: m for m in items}
    ref = reference_findings(items)
    verdicts = {t: e["verdict"] for t, e in ref["themes"].items()}
    noted = [{"said": f"{o.get('theme')}:{o.get('direction')}", "reference": verdicts.get(o.get("theme"), "not_mentioned")}
             for o in (observations or [])]
    gold = {(f["theme"], f["direction"]): set(f["evidence_ids"]) for f in ref["findings"]}
    pred = {(f.get("theme"), f.get("direction")): [str(i) for i in f.get("evidence_ids", [])] for f in predicted}
    cited = [(key, mid) for key, ids in pred.items() for mid in ids]
    supporting = [(key, mid) for key, mid in cited if _supports(index, mid, key[0], key[1])]
    recall = []
    for key in gold.keys() & pred.keys():
        reps = {index[m]["gold"]["duplicate_of"] or m for m in pred[key] if m in index}
        recall.append(len(reps & gold[key]) / len(gold[key]))
    return {
        "gold_findings": sorted(f"{t}:{d}" for t, d in gold),
        "correct": sorted(f"{t}:{d}" for t, d in gold.keys() & pred.keys()),
        "unsupported": sorted(f"{t}:{d}" for t, d in pred.keys() - gold.keys()),
        "missed": sorted(f"{t}:{d}" for t, d in gold.keys() - pred.keys()),
        "evidence_cited": len(cited), "evidence_supporting": len(supporting),
        "evidence_recall_on_correct": round(sum(recall) / len(recall), 3) if recall else None,
        "observations": noted,
        "contradictions_recognized": sum(o["said"].endswith(":mixed") and o["reference"] == "conflicting" for o in noted),
        "contradictions_in_reference": sorted(ref["ask_a_person"]["conflicting_themes"]),
    }


def score_labels(items: list[dict[str, Any]], labels: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """Label-level agreement on counted messages (supported language, not a duplicate)."""
    tp = fp = fn = sentiment_ok = quotes = quotes_exact = 0
    on_unsupported = 0
    for m in items:
        pred = labels.get(m["id"], [])
        if not m["gold"]["supported_language"]:
            on_unsupported += len(pred)
            continue
        if m["gold"]["duplicate_of"]:
            continue
        gold = {lb["theme"]: lb["sentiment"] for lb in m["gold"]["labels"]}
        seen = {}
        for lb in pred:
            seen.setdefault(lb.get("theme"), lb.get("sentiment"))
            if lb.get("quote") is not None:
                quotes += 1
                quotes_exact += lb["quote"] in m["text"]
        for theme, sentiment in seen.items():
            if theme in gold:
                tp += 1
                sentiment_ok += sentiment == gold[theme]
            else:
                fp += 1
        fn += len(set(gold) - set(seen))
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return {"theme_precision": round(p, 3), "theme_recall": round(r, 3),
            "theme_f1": round(2 * p * r / (p + r), 3) if p + r else 0.0,
            "sentiment_accuracy_on_matched": round(sentiment_ok / tp, 3) if tp else None,
            "quotes_exact": f"{quotes_exact}/{quotes}", "labels_on_unsupported_language": on_unsupported}


def score(condition: dict[str, Any], messages: list[dict[str, Any]]) -> dict[str, Any]:
    per_batch = {}
    seconds = 0
    labels = condition.get("labels")
    excluded = set(condition.get("excluded_ids", []))
    for batch, items in batches(messages).items():
        given = condition.get("batches", {}).get(batch)
        observations = (given or {}).get("observations", [])
        if given is not None and "findings" in given:
            predicted = given["findings"]
            seconds += given.get("seconds") or 0
        elif labels is not None:
            predicted = derive_findings(items, labels, excluded)
        else:
            predicted = []
        per_batch[batch] = score_batch(items, predicted, observations)
    total = defaultdict(int)
    for b in per_batch.values():
        for k in ("correct", "unsupported", "missed", "gold_findings"):
            total[k] += len(b[k])
        total["evidence_cited"] += b["evidence_cited"]
        total["evidence_supporting"] += b["evidence_supporting"]
        total["contradictions_recognized"] += b["contradictions_recognized"]
        total["contradictions_in_reference"] += len(b["contradictions_in_reference"])
    summary = {
        "batches": len(per_batch), "gold_findings": total["gold_findings"], "correct": total["correct"],
        "UNSUPPORTED_findings": total["unsupported"], "missed": total["missed"],
        "evidence_precision": round(total["evidence_supporting"] / total["evidence_cited"], 3) if total["evidence_cited"] else None,
        "contradictions_recognized": f"{total['contradictions_recognized']}/{total['contradictions_in_reference']}",
        "seconds_total": seconds or None,
    }
    report = {"condition": condition.get("condition", "unnamed"), "summary": summary, "per_batch": per_batch}
    if labels is not None:
        report["labels"] = score_labels(messages, labels)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Score a condition against the reference findings.")
    parser.add_argument("condition")
    parser.add_argument("--corpus", choices=sorted(CORPORA), default="dev")
    parser.add_argument("--report")
    args = parser.parse_args(argv)
    report = score(json.loads(Path(args.condition).read_text(encoding="utf-8")), read_corpus(CORPORA[args.corpus]))
    text = json.dumps(report, indent=2, ensure_ascii=False)
    if args.report:
        Path(args.report).write_text(text + "\n", encoding="utf-8", newline="\n")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
