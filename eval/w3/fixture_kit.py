"""Helpers to write W3 fixtures as data. Shared by the dev and held-out builders.

A fixture is one scenario for W3 steps 1-5 plus the outcome expected from ANY
implementation. Quotes are located in the message text here, so UTF-8 byte
offsets are right unless a fixture passes wrong ones on purpose.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

FARM_SHEET = {  # data/farm_sheet.example.json, the owner facts the decision card may use
    "price_per_person_kes": 2000,
    "capacity_per_tour": 10,
    "days": ["mon", "tue", "wed", "thu", "fri", "sat"],
    "hours": {"start": "09:00:00", "end": "15:00:00"},
    "directions_sw": "Kutoka soko la Othaya fuata barabara ya kanisa kilomita mbili",
    "inclusions_sw": ["kahawa", "chakula cha mchana"],
}
NO_SIDE_EFFECTS = {"facts_changed": False, "approvals_created": 0, "outbox_entries": 0}


def message(mid: str, source: str, text: str, *, gold_lang: str, author: str | None = None,
            lang: str | None = None, day: int = 10, hour: int = 10, ext: str | None = None) -> dict[str, Any]:
    """A source message. `lang` is what the source declares (often nothing); `gold_lang` is the truth."""
    record: dict[str, Any] = {
        "id": mid, "source": source, "external_id": ext or f"{source}:{mid}",
        "received_at": f"2026-09-{day:02d}T{hour:02d}:00:00Z", "text": text,
    }
    if author is not None:
        record["author"] = author
    if lang is not None:
        record["lang"] = lang
    record["_gold_lang"] = gold_lang
    return record


def label(messages: list[dict[str, Any]], mid: str, theme: str, sentiment: str, quote: str,
          offsets: tuple[int, int] | None = None) -> dict[str, Any]:
    """A model label citing `quote` in message `mid`. Offsets are UTF-8 bytes, end exclusive."""
    if offsets is None:
        text = next(m["text"] for m in messages if m["id"] == mid).encode("utf-8")
        start = text.find(quote.encode("utf-8"))
        if start < 0:
            raise ValueError(f"{mid}: quote not in message, pass offsets explicitly: {quote!r}")
        offsets = (start, start + len(quote.encode("utf-8")))
    return {"message_id": mid, "theme": theme, "sentiment": sentiment, "quote": quote,
            "start": offsets[0], "end": offsets[1]}


def fixture(fid: str, title: str, *, steps: list[int], rationale: str, messages: list[dict[str, Any]],
            labels: list[dict[str, Any]] | None = None, malformed_output: str | None = None,
            expected: dict[str, Any], domain_tests: list[int] | None = None,
            owner_inputs: list[dict[str, Any]] | None = None, owner_facts: dict[str, Any] | None = None,
            notes: str | None = None) -> dict[str, Any]:
    gold_lang = {m["id"]: m["_gold_lang"] for m in messages}
    clean = [{k: v for k, v in m.items() if k != "_gold_lang"} for m in messages]
    model_output: dict[str, Any] = (
        {"status": "malformed", "raw": malformed_output} if malformed_output is not None
        else {"status": "ok", "labels": labels or []}
    )
    data: dict[str, Any] = {
        "fixture_id": fid,
        "title": title,
        "w3_steps": steps,
        "domain_tests": domain_tests or [],
        "expectation_status": "PROPOSED",
        "synthetic": True,
        "language_review": "unreviewed",
        "rationale": rationale,
        "input": {"messages": clean, "model_output": model_output},
        "gold": {"lang": gold_lang},
        "expected": {"side_effects": NO_SIDE_EFFECTS, **expected},
    }
    if owner_facts is not None:
        data["input"]["owner_facts"] = owner_facts
    if owner_inputs is not None:
        data["input"]["owner_inputs"] = owner_inputs
    if notes:
        data["notes"] = notes
    return data


def write_all(fixtures: list[dict[str, Any]], out_dir: Path, check: bool) -> list[str]:
    """Write fixtures as <fixture_id>.json. With check=True, only report files that are stale."""
    stale = []
    out_dir.mkdir(parents=True, exist_ok=True)
    ids = [f["fixture_id"] for f in fixtures]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate fixture ids")
    for data in fixtures:
        path = out_dir / f"{data['fixture_id']}.json"
        text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        if path.exists() and path.read_text(encoding="utf-8") == text:
            continue
        stale.append(path.name)
        if not check:
            path.write_text(text, encoding="utf-8", newline="\n")
    expected_names = {f"{i}.json" for i in ids}
    stale += sorted(p.name + " (orphan)" for p in out_dir.glob("*.json") if p.name not in expected_names)
    return stale
