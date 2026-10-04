"""Labeled feedback corpus (packet 07): message records, reference labels, reference findings.

A *batch* is one weekend of feedback for Noor. Each message carries reference
labels (theme, sentiment, exact quote with UTF-8 byte span). Reference findings
per batch are computed by code from those labels with the team's rules, so the
labels are the only human judgement and they are the part Nat reviews.

Rules (same as eval/w3 and Domain's core): a finding needs >= 3 unique comments
on its supporting side; >= 2 on both sides is conflicting; exactly 1 on the
other side is a dissent, shown, not hidden. Unsupported-language messages and
duplicates (re-syncs, cross-posts) do not count twice.
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any

THEMES = ("coffee", "farm_walk", "food", "host", "directions", "price", "timing", "booking", "language",
          "facilities", "buy_coffee")
SENTIMENTS = ("positive", "negative", "neutral")
MIN_SUPPORT = 3
CONFLICT_MIN = 2
LABEL_STATUS = "DRAFT_UNREVIEWED"  # becomes REVIEWED_BY_NAT after Nat's pass; Swahili also needs a native reviewer


def lab(text: str, theme: str, sentiment: str, quote: str) -> dict[str, Any]:
    """A reference label. The quote must be copied exactly from the text; the UTF-8 span is computed."""
    if theme not in THEMES or sentiment not in SENTIMENTS:
        raise ValueError(f"unknown theme/sentiment {theme}/{sentiment}")
    raw, q = text.encode("utf-8"), quote.encode("utf-8")
    start = raw.find(q)
    if start < 0 or not q:
        raise ValueError(f"quote not in text: {quote!r}")
    return {"theme": theme, "sentiment": sentiment, "quote": quote, "start": start, "end": start + len(q)}


def msg(batch: str, n: int, source: str, lang: str | None, text: str, labels: list[tuple[str, str, str]], *,
        split: str, author: str | None = None, supported: bool = True, duplicate_of: str | None = None,
        phenomena: tuple[str, ...] = (), note: str | None = None, label_status: str = LABEL_STATUS,
        review: dict[str, str] | None = None) -> dict[str, Any]:
    record: dict[str, Any] = {
        "id": f"{batch}{n:02d}", "batch": batch, "split": split, "source": source, "text": text,
        "lang": lang, "synthetic": True,
        "provenance": "written for Sauti eval by Nat's lane helper (muller-claude), 2026-10-03; non-English unreviewed",
        "gold": {
            "supported_language": supported,
            "duplicate_of": duplicate_of,
            "labels": [lab(text, t, s, q) for t, s, q in labels],
        },
        "label_status": label_status,
        "phenomena": list(phenomena),
    }
    if review:
        record["review"] = review
    if author is not None:
        record["author"] = author
    if note:
        record["gold"]["note"] = note
    return record


def reference_findings(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """Per theme: unique supporting comments, verdict and evidence ids, computed only from the reference labels."""
    by_theme: dict[str, dict[str, set[str]]] = defaultdict(lambda: {s: set() for s in SENTIMENTS})
    excluded = []
    for m in messages:
        gold = m["gold"]
        if not gold["supported_language"]:
            excluded.append(m["id"])
            continue
        rep = gold["duplicate_of"] or m["id"]
        for label in gold["labels"]:
            by_theme[label["theme"]][label["sentiment"]].add(rep)
    themes = {}
    for theme in THEMES:
        if theme not in by_theme:
            continue
        ids = by_theme[theme]
        pos, neg, neu = (len(ids[s]) for s in SENTIMENTS)
        if min(pos, neg) >= CONFLICT_MIN:
            verdict, direction = "conflicting", "mixed"
        elif max(pos, neg) >= MIN_SUPPORT:
            direction = "positive" if pos > neg else "negative"
            verdict = "supported_with_dissent" if min(pos, neg) == 1 else "supported"
        elif pos == neg == 0 and neu >= MIN_SUPPORT:
            verdict, direction = "neutral_mentions", "neutral"
        else:
            verdict, direction = "insufficient", None
        entry: dict[str, Any] = {"verdict": verdict, "direction": direction,
                                 "counts": {"positive": pos, "negative": neg, "neutral": neu}}
        if verdict.startswith("supported"):
            entry["evidence_ids"] = sorted(ids[direction])
            other = "negative" if direction == "positive" else "positive"
            if ids[other]:
                entry["dissent_ids"] = sorted(ids[other])
        themes[theme] = entry
    findings = [{"theme": t, "direction": e["direction"], "evidence_ids": e["evidence_ids"]}
                for t, e in themes.items() if e["verdict"].startswith("supported")]
    return {"themes": themes, "findings": findings, "ask_a_person": {
        "conflicting_themes": [t for t, e in themes.items() if e["verdict"] == "conflicting"],
        "unsupported_language_ids": excluded}}


def write_corpus(messages: list[dict[str, Any]], path: Path) -> None:
    ids = [m["id"] for m in messages]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate message ids")
    for m in messages:
        dup = m["gold"]["duplicate_of"]
        if dup and dup not in ids:
            raise ValueError(f"{m['id']}: duplicate_of {dup} does not exist")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(m, ensure_ascii=False) + "\n" for m in messages), encoding="utf-8", newline="\n")


def read_corpus(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def batches(messages: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for m in messages:
        out[m["batch"]].append(m)
    return dict(out)


def reading_view(messages: list[dict[str, Any]]) -> str:
    """What the manual reader sees: the messages only, never the labels."""
    lines = []
    for batch, items in batches(messages).items():
        lines += [f"## Batch {batch} ({len(items)} messages)", ""]
        for m in items:
            who = f", {m['author']}" if m.get("author") else ""
            lines.append(f"- **{m['id']}** ({m['source']}{who}): {m['text']}")
        lines.append("")
    return "\n".join(lines)
