"""Reference reading of the W3 step 1-3 rules, used only to lint the fixtures.

This is NOT product code. Claude Domain owns the real implementation. This
module exists so that every hand-written `expected` block in a fixture is
cross-checked by a second, independent reading of the same rules: if the two
disagree, the fixture (or the rule) is wrong and the lint fails.

Every rule here is PROPOSED until Domain and Carther agree on it (see README).
It reads `gold.lang` from the fixture, which implementations never receive.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

SOURCES = frozenset({
    "direct_review", "google_review", "getyourguide_review", "tourist_message", "noor_note", "guide_note",
})
SUPPORTED_LANGS = frozenset({"en", "sw", "de", "fr"})
THEMES = (
    "coffee", "farm_walk", "food", "host", "directions", "price",
    "timing", "booking", "language", "facilities", "buy_coffee",
)
SENTIMENTS = ("positive", "negative", "neutral")
LABEL_FIELDS = ("message_id", "theme", "sentiment", "quote", "start", "end")

MIN_MENTIONS = 3  # CLAUDE.md W3: fewer than 3 mentions means "not enough feedback to conclude"
CONTRADICTION_MIN = 2  # both a positive and a negative side this large: ask a person


def _norm(text: str) -> str:
    return " ".join(text.casefold().split())


def _ingest(messages: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], list[str], list[dict[str, str]]]:
    """Stored messages by id (first copy wins), duplicate ids, rejected records."""
    stored: dict[str, dict[str, Any]] = {}
    seen: set[tuple[str, str]] = set()
    duplicates: list[str] = []
    rejected: list[dict[str, str]] = []
    for message in messages:
        if message.get("source") not in SOURCES or not str(message.get("text", "")).strip():
            rejected.append({"message_id": message["id"], "reason": "invalid_message"})
            continue
        key = (message["source"], message["external_id"])
        if key in seen:
            duplicates.append(message["id"])
            continue
        seen.add(key)
        stored[message["id"]] = message
    return stored, duplicates, rejected


def _char_boundary(raw: bytes, offset: int) -> bool:
    return offset in (0, len(raw)) or (raw[offset] & 0xC0) != 0x80


def label_problem(label: dict[str, Any], stored: dict[str, dict[str, Any]], duplicates: set[str],
                  eligible: set[str]) -> str | None:
    """Why a model label must be rejected, or None when it is valid. Offsets are UTF-8 bytes.

    Span reasons use Claude Domain's strings verbatim (packages/core evidence.ts @ 8c066ff):
    unknown_source, span_out_of_range, span_not_on_char_boundary, quote_mismatch.
    The other reasons cover layers the core does not have yet.
    """
    if any(field not in label for field in LABEL_FIELDS):
        return "malformed_label"
    mid = label["message_id"]
    if mid in duplicates:
        return "duplicate_message"
    if mid not in stored:
        return "unknown_source"
    if mid not in eligible:
        return "message_not_eligible"
    if label["theme"] not in THEMES:
        return "unknown_theme"
    if label["sentiment"] not in SENTIMENTS:
        return "unknown_sentiment"
    raw = stored[mid]["text"].encode("utf-8")
    start, end = label["start"], label["end"]
    if not (isinstance(start, int) and isinstance(end, int) and 0 <= start < end <= len(raw)):
        return "span_out_of_range"
    if not (_char_boundary(raw, start) and _char_boundary(raw, end)):
        return "span_not_on_char_boundary"
    try:
        sliced = raw[start:end].decode("utf-8")
    except UnicodeDecodeError:
        return "quote_mismatch"
    return None if sliced == label["quote"] else "quote_mismatch"


def _representatives(stored: dict[str, dict[str, Any]], order: dict[str, int]) -> dict[str, str]:
    """Message id -> id of the message it counts as. Same author + same text on two sources counts once."""
    first: dict[tuple[str, str], str] = {}
    rep: dict[str, str] = {}
    for mid in sorted(stored, key=lambda m: (stored[m]["received_at"], order[m])):
        author = stored[mid].get("author")
        if not author:
            rep[mid] = mid
            continue
        key = (_norm(author), _norm(stored[mid]["text"]))
        rep[mid] = first.setdefault(key, mid)
    return rep


def _finding(theme: str, ids: dict[str, set[str]]) -> tuple[dict[str, Any], dict[str, Any] | None]:
    pos, neg = len(ids["positive"]), len(ids["negative"])
    if pos >= CONTRADICTION_MIN and neg >= CONTRADICTION_MIN:
        ask = {"reason": "contradictory_reviews", "message_ids": sorted(ids["positive"] | ids["negative"])}
        return {"theme": theme, "status": "contradictory"}, ask
    for sentiment, n in (("positive", pos), ("negative", neg)):
        if n >= MIN_MENTIONS:
            evidence = sorted(ids[sentiment])
            return {"theme": theme, "status": "enough_evidence", "sentiment": sentiment,
                    "evidence_message_ids": evidence}, None
    return {"theme": theme, "status": "not_enough_feedback"}, None


def evaluate(fixture_input: dict[str, Any], gold_lang: dict[str, str]) -> dict[str, Any]:
    """Outcome for W3 steps 1-3, in the adapter outcome format (README)."""
    messages = fixture_input["messages"]
    order = {m["id"]: i for i, m in enumerate(messages)}
    stored, duplicates, rejected = _ingest(messages)
    eligible = {mid for mid in stored if gold_lang.get(mid) in SUPPORTED_LANGS}
    ask: list[dict[str, Any]] = []
    unsupported = sorted(mid for mid in stored if mid not in eligible)
    if unsupported:
        ask.append({"reason": "unsupported_language", "message_ids": unsupported})

    outcome: dict[str, Any] = {
        "ingest": {"duplicates": duplicates, "rejected": rejected},
        "accepted_labels": [], "rejected_labels": [], "counts": {}, "findings": [], "ask_a_person": ask,
        "side_effects": {"facts_changed": False, "approvals_created": 0, "outbox_entries": 0},
    }
    model = fixture_input["model_output"]
    if model.get("status") != "ok" or not isinstance(model.get("labels"), list):
        ask.append({"reason": "structured_output_failure",
                    "message_ids": sorted(eligible, key=lambda m: order[m])})
        return outcome

    rep = _representatives({m: stored[m] for m in eligible}, order)
    by_theme: dict[str, dict[str, set[str]]] = defaultdict(lambda: {s: set() for s in SENTIMENTS})
    for label in model["labels"]:
        problem = label_problem(label, stored, set(duplicates), eligible)
        if problem is not None:
            outcome["rejected_labels"].append(
                {"message_id": label.get("message_id"), "theme": label.get("theme"), "reason": problem})
            continue
        outcome["accepted_labels"].append({"message_id": label["message_id"], "theme": label["theme"]})
        by_theme[label["theme"]][label["sentiment"]].add(rep[label["message_id"]])

    for theme in THEMES:
        if theme not in by_theme:
            continue
        ids = by_theme[theme]
        outcome["counts"][theme] = {
            "unique_messages": len(set().union(*ids.values())), **{s: len(ids[s]) for s in SENTIMENTS},
        }
        finding, contradiction = _finding(theme, ids)
        outcome["findings"].append(finding)
        if contradiction:
            ask.append(contradiction)
    return outcome
