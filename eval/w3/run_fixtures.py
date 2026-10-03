"""Lint the W3 fixtures, or run an implementation against them.

    python eval/w3/run_fixtures.py lint
    python eval/w3/run_fixtures.py run --impl oracle
    python eval/w3/run_fixtures.py run --set dev --report out.json --impl node dist/w3-adapter.js

An implementation is any command that reads {"fixture_id", "input"} as JSON on
stdin and prints an outcome JSON on stdout (see README, adapter contract). It
never receives `gold` or `expected`. `--impl oracle` runs reference_rules.py,
which covers steps 1-3 only, to prove the fixtures and the runner agree.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT))

import reference_rules as rules  # noqa: E402
from sauti.lang.swahili import find_numbers  # noqa: E402  (Swahili number words, code-only parser from W1)

SETS = {"dev": HERE / "fixtures" / "dev", "heldout": HERE / "heldout" / "fixtures"}
MANIFEST = HERE / "heldout_manifest.json"
ADAPTER_TIMEOUT_S = 60

TOP_KEYS = {"fixture_id", "title", "w3_steps", "domain_tests", "expectation_status", "synthetic",
            "language_review", "rationale", "input", "gold", "expected"}
OPTIONAL_TOP_KEYS = {"notes"}
EXPECTED_KEYS = {"ingest", "accepted_labels", "rejected_labels", "counts", "findings", "ask_a_person",
                 "side_effects", "cards", "decisions", "constraints"}
ORACLE_KEYS = {"ingest", "accepted_labels", "rejected_labels", "counts", "findings", "ask_a_person",
               "side_effects", "constraints"}
OWNER_INPUT_TYPES = {"show_cards", "owner_says", "new_messages"}
CONSTRAINTS = {"no_enough_evidence", "no_cards"}
CHOICES = {"try", "reject", "ask_someone"}
COUNT_KEYS = ("unique_messages", "positive", "negative", "neutral")
STATUSES = {"PROPOSED", "AGREED"}


class AdapterError(Exception):
    """The implementation did not answer with a readable outcome."""


# ---------------------------------------------------------------- loading


def load(set_name: str) -> list[tuple[Path, dict[str, Any]]]:
    folder = SETS[set_name]
    return [(p, json.loads(p.read_text(encoding="utf-8"))) for p in sorted(folder.glob("*.json"))] if folder.is_dir() else []


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------- comparing outcomes


def _labels(items: list[dict[str, Any]]) -> set[tuple[Any, ...]]:
    return {(i.get("message_id"), i.get("theme")) for i in items}


def _rejected(items: list[dict[str, Any]]) -> set[tuple[Any, ...]]:
    return {(i.get("message_id"), i.get("theme"), i.get("reason")) for i in items}


def _ingest(block: dict[str, Any]) -> tuple[set[Any], set[tuple[Any, ...]]]:
    return set(block.get("duplicates", [])), {(r.get("message_id"), r.get("reason")) for r in block.get("rejected", [])}


def _counts(block: dict[str, Any]) -> dict[str, dict[str, int]]:
    return {theme: {k: int(v.get(k, 0)) for k in COUNT_KEYS} for theme, v in block.items()}


def _findings(items: list[dict[str, Any]]) -> set[tuple[Any, ...]]:
    out = set()
    for f in items:
        enough = f.get("status") == "enough_evidence"
        out.add((f.get("theme"), f.get("status"), f.get("sentiment") if enough else None,
                 frozenset(f.get("evidence_message_ids", [])) if enough else None))
    return out


def _asks(items: list[dict[str, Any]]) -> set[tuple[Any, ...]]:
    return {(a.get("reason"), frozenset(a.get("message_ids", []))) for a in items}


def _decisions(items: list[dict[str, Any]]) -> set[tuple[Any, ...]]:
    return {(d.get("theme"), d.get("choice")) for d in items}


_NORMALIZE = {
    "ingest": _ingest, "accepted_labels": _labels, "rejected_labels": _rejected, "counts": _counts,
    "findings": _findings, "ask_a_person": _asks, "decisions": _decisions, "side_effects": lambda b: b,
}


def _fmt(value: Any) -> str:
    if isinstance(value, tuple):
        return "(" + ", ".join(_fmt(v) for v in value) + ")"
    if isinstance(value, set):
        return "{" + ", ".join(sorted(repr(tuple(sorted(x)) if isinstance(x, frozenset) else x) for x in value)) + "}"
    return json.dumps(value, sort_keys=True, default=str)


def _check_constraints(names: list[str], actual: dict[str, Any]) -> list[str]:
    problems = []
    if "no_enough_evidence" in names and any(f.get("status") == "enough_evidence" for f in actual.get("findings", [])):
        problems.append("constraint no_enough_evidence: a finding claims enough evidence")
    if "no_cards" in names and actual.get("cards"):
        problems.append("constraint no_cards: cards were produced")
    return problems


def _numbers(text: str) -> set[int]:
    return {int(d) for d in re.findall(r"\d+", text)} | set(find_numbers(text))


def _fact_numbers(value: Any) -> set[int]:
    if isinstance(value, bool):
        return set()
    if isinstance(value, int):
        return {value}
    if isinstance(value, str):
        return _numbers(value)
    if isinstance(value, dict):
        return set().union(*(_fact_numbers(v) for v in value.values())) if value else set()
    if isinstance(value, list):
        return set().union(*(_fact_numbers(v) for v in value)) if value else set()
    return set()


def check_cards(spec: dict[str, Any], fixture: dict[str, Any], actual: dict[str, Any]) -> list[str]:
    """Property checks on decision cards: exact quotes, cited evidence, choices, no invented number."""
    problems: list[str] = []
    cards = actual.get("cards")
    if not isinstance(cards, list):
        return ["cards: missing or not a list"]
    texts = {m["id"]: m["text"] for m in fixture["input"]["messages"]}
    findings = fixture["expected"].get("findings") or actual.get("findings", [])
    evidence = {f["theme"]: set(f.get("evidence_message_ids", [])) for f in findings
                if f.get("status") == "enough_evidence"}
    facts = _fact_numbers(fixture["input"].get("owner_facts", {}))
    themes = [c.get("theme") for c in cards]
    for theme in spec.get("required_themes", []):
        if theme not in themes:
            problems.append(f"cards: no card for required theme {theme}")
    for card in cards:
        theme = card.get("theme")
        where = f"card[{theme}]"
        if theme not in spec.get("allowed_themes", []):
            problems.append(f"{where}: no card is allowed for this theme")
            continue
        if set(card.get("choices", [])) != CHOICES:
            problems.append(f"{where}: choices must be exactly {sorted(CHOICES)}")
        if card.get("prospective") is not True:
            problems.append(f"{where}: must be marked prospective")
        quotes = card.get("quotes") or []
        if not quotes:
            problems.append(f"{where}: quotes no source comment")
        allowed_numbers = set(facts)
        allowed_numbers |= {v for v in actual.get("counts", {}).get(theme, {}).values() if isinstance(v, int)}
        for q in quotes:
            mid = q.get("message_id")
            if mid not in evidence.get(theme, set()):
                problems.append(f"{where}: cites {mid}, which is not validated evidence for {theme}")
                continue
            raw = texts[mid].encode("utf-8")
            start, end = q.get("start"), q.get("end")
            if not (isinstance(start, int) and isinstance(end, int)) or raw[start:end] != str(q.get("quote", "")).encode("utf-8"):
                problems.append(f"{where}: quote from {mid} is not the exact text at its UTF-8 offsets")
            allowed_numbers |= _numbers(texts[mid])
        invented = _numbers(str(card.get("text", ""))) - allowed_numbers
        if invented:
            problems.append(f"{where}: numbers not in owner facts, counts or quoted messages: {sorted(invented)}")
    return problems


def compare(fixture: dict[str, Any], actual: dict[str, Any], keys: set[str]) -> list[str]:
    """Differences between the fixture's expected outcome and an actual one, on `keys` only."""
    expected = fixture["expected"]
    problems: list[str] = []
    for key in sorted(keys & set(expected)):
        if key == "constraints":
            problems += _check_constraints(expected[key], actual)
            continue
        if key == "cards":
            problems += check_cards(expected[key], fixture, actual)
            continue
        if key not in actual:
            problems.append(f"{key}: missing from outcome")
            continue
        want, got = _NORMALIZE[key](expected[key]), _NORMALIZE[key](actual[key])
        if want != got:
            problems.append(f"{key}: expected {_fmt(want)}, got {_fmt(got)}")
    return problems


# ---------------------------------------------------------------- lint


def lint_fixture(path: Path, fx: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    keys = set(fx)
    if missing := TOP_KEYS - keys:
        return [f"missing keys {sorted(missing)}"]
    if extra := keys - TOP_KEYS - OPTIONAL_TOP_KEYS:
        problems.append(f"unknown keys {sorted(extra)}")
    if fx["fixture_id"] != path.stem:
        problems.append("fixture_id does not match the file name")
    if fx["synthetic"] is not True:
        problems.append("every fixture must be marked synthetic")
    if fx["expectation_status"] not in STATUSES:
        problems.append(f"expectation_status must be one of {sorted(STATUSES)}")
    if not set(fx["w3_steps"]) <= {1, 2, 3, 4, 5}:
        problems.append("w3_steps must be within 1-5 (step 6 is not specified yet)")
    ids = [m.get("id") for m in fx["input"]["messages"]]
    if len(ids) != len(set(ids)):
        problems.append("message ids are not unique")
    for m in fx["input"]["messages"]:
        if not {"id", "source", "external_id", "received_at", "text"} <= set(m):
            problems.append(f"message {m.get('id')}: missing required fields")
    if set(fx["gold"]["lang"]) != set(ids):
        problems.append("gold.lang must cover exactly the input messages")
    if fx["input"]["model_output"].get("status") not in {"ok", "malformed"}:
        problems.append("model_output.status must be ok or malformed")
    for event in fx["input"].get("owner_inputs", []):
        if event.get("type") not in OWNER_INPUT_TYPES:
            problems.append(f"unknown owner input type {event.get('type')}")
    if extra := set(fx["expected"]) - EXPECTED_KEYS:
        problems.append(f"unknown expected keys {sorted(extra)}")
    if unknown := set(fx["expected"].get("constraints", [])) - CONSTRAINTS:
        problems.append(f"unknown constraints {sorted(unknown)}")
    if problems:
        return problems
    # Second, independent reading of the rules: hand-written expectations must agree with it.
    oracle = rules.evaluate(fx["input"], fx["gold"]["lang"])
    return [f"oracle disagrees, {p}" for p in compare(fx, oracle, ORACLE_KEYS)]


def lint_manifest(heldout: list[tuple[Path, dict[str, Any]]]) -> list[str]:
    if not heldout:
        return []
    if not MANIFEST.exists():
        return ["held-out fixtures exist but heldout_manifest.json is missing"]
    recorded = json.loads(MANIFEST.read_text(encoding="utf-8"))["files"]
    present = {p.name: _sha256(p) for p, _ in heldout}
    problems = [f"held-out {name}: not in manifest" for name in sorted(set(present) - set(recorded))]
    problems += [f"held-out {name}: missing locally" for name in sorted(set(recorded) - set(present))]
    problems += [f"held-out {name}: changed since the manifest was committed"
                 for name in sorted(set(present) & set(recorded)) if present[name] != recorded[name]]
    return problems


def cmd_lint(_: argparse.Namespace) -> int:
    failures = 0
    heldout = load("heldout")
    for set_name in ("dev", "heldout"):
        fixtures = load(set_name)
        if set_name == "heldout" and not fixtures:
            print("held-out: not present on this machine, skipped")
            continue
        for path, fx in fixtures:
            for problem in lint_fixture(path, fx):
                failures += 1
                print(f"LINT {set_name}/{path.name}: {problem}")
        print(f"{set_name}: {len(fixtures)} fixtures linted")
    for problem in lint_manifest(heldout):
        failures += 1
        print(f"LINT manifest: {problem}")
    print("lint OK" if not failures else f"lint FAILED ({failures} problems)")
    return 1 if failures else 0


# ---------------------------------------------------------------- run an implementation


def with_declared_languages(fx: dict[str, Any]) -> dict[str, Any]:
    """Assume a perfect upstream language identifier: every message declares its true language.

    Only the language is added (never an expected outcome), and only where the source declared none.
    Use it to separate an implementation's own logic from a missing language-identification layer.
    """
    out = json.loads(json.dumps(fx))
    for message in out["input"]["messages"]:
        message.setdefault("lang", out["gold"]["lang"][message["id"]])
    return out


def run_adapter(command: list[str], fx: dict[str, Any]) -> dict[str, Any]:
    payload = json.dumps({"fixture_id": fx["fixture_id"], "input": fx["input"]}, ensure_ascii=False)
    try:
        proc = subprocess.run(command, input=payload, capture_output=True, text=True, encoding="utf-8",
                              timeout=ADAPTER_TIMEOUT_S, check=False)
    except subprocess.TimeoutExpired as exc:
        raise AdapterError(f"no answer within {ADAPTER_TIMEOUT_S}s") from exc
    except OSError as exc:
        raise AdapterError(f"could not start: {exc}") from exc
    if proc.returncode != 0:
        raise AdapterError(f"exit code {proc.returncode}: {proc.stderr.strip()[:300]}")
    try:
        outcome = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise AdapterError("stdout is not JSON") from exc
    if not isinstance(outcome, dict):
        raise AdapterError("the outcome must be a JSON object")
    return outcome


def cmd_run(args: argparse.Namespace) -> int:
    oracle = args.impl == ["oracle"]
    results = []
    for set_name in (["dev", "heldout"] if args.set == "all" else [args.set]):
        for path, fx in load(set_name):
            keys = set(ORACLE_KEYS if oracle else EXPECTED_KEYS)
            if args.assume_language_id:
                fx = with_declared_languages(fx)
            try:
                actual = rules.evaluate(fx["input"], fx["gold"]["lang"]) if oracle else run_adapter(args.impl, fx)
                # An implementation may declare what it does not do yet: reported as not checked, never as a pass.
                keys -= set(actual.get("not_implemented", []))
                problems = compare(fx, actual, keys)
            except AdapterError as exc:
                problems = [f"adapter: {exc}"]
            skipped = sorted(set(fx["expected"]) - keys)
            checked = set(fx["expected"]) & keys - {"side_effects"}
            # Never call a fixture passed when part of what it tests was not run.
            status = ("FAIL" if problems else "NOT_COVERED" if not checked else "PARTIAL" if skipped else "PASS")
            results.append({"set": set_name, "fixture_id": fx["fixture_id"], "status": status,
                            "domain_tests": fx["domain_tests"], "w3_steps": fx["w3_steps"],
                            "problems": problems, "skipped_keys": skipped})
            note = f" (not checked: {', '.join(skipped)})" if skipped else ""
            print(f"{status} {set_name}/{fx['fixture_id']} {fx['title']}{note}")
            for problem in problems:
                print(f"     {problem}")
    tally = {s: sum(r["status"] == s for r in results) for s in ("PASS", "PARTIAL", "FAIL", "NOT_COVERED")}
    failed = tally["FAIL"]
    print(", ".join(f"{n} {s.lower()}" for s, n in tally.items()) + f", of {len(results)}"
          + (" (oracle covers steps 1-3 only)" if oracle else ""))
    if args.report:
        Path(args.report).write_text(json.dumps({"impl": args.impl, "assume_language_id": args.assume_language_id,
                                                 "results": results}, indent=2) + "\n", encoding="utf-8")
    return 1 if failed or not results else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Lint the W3 fixtures or run an implementation against them.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("lint", help="check fixture structure, offsets, held-out manifest and expectations")
    run = sub.add_parser("run", help="run an implementation's adapter on every fixture")
    run.add_argument("--set", choices=["dev", "heldout", "all"], default="dev")
    run.add_argument("--report", help="write a JSON report to this path")
    run.add_argument("--assume-language-id", action="store_true",
                     help="declare each message's true language first (simulates a perfect upstream language identifier)")
    run.add_argument("--impl", nargs=argparse.REMAINDER, required=True,
                     help="'oracle', or the adapter command and its arguments (must come last)")
    args = parser.parse_args(argv)
    return cmd_lint(args) if args.command == "lint" else cmd_run(args)


if __name__ == "__main__":
    sys.exit(main())
