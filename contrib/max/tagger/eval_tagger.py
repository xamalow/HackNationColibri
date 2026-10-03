"""Score the deterministic tagger (tag_feedback.mjs).

    python contrib/max/tagger/eval_tagger.py

Reference A: labels in Nat's public W3 dev fixtures that Nat's own reference rules ACCEPT (adversarial
labels filtered out), compared on (message, theme) and sentiment. Reference B: contrib/max/devset
(written by this lane, optimistic). Nat's held-out W3 set is the fair test and is run by Nat.
DESKTOP numbers, synthetic data.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "eval" / "w3"))
import reference_rules as rules  # noqa: E402

CATALOGUE = set(rules.THEMES)


def tag(messages: list[dict]) -> dict:
    proc = subprocess.run(["node", str(HERE / "cli.mjs")], input=json.dumps(messages), capture_output=True,
                          text=True, encoding="utf-8", timeout=60, check=True)
    return json.loads(proc.stdout)


def score(pairs: list[tuple[dict, dict]]) -> dict:
    tp = fp = fn = s_ok = s_n = 0
    for gold, got in pairs:
        tp += len(gold.keys() & got.keys())
        fp += len(got.keys() - gold.keys())
        fn += len(gold.keys() - got.keys())
        for t in gold.keys() & got.keys():
            s_n += 1
            s_ok += gold[t] == got[t]
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return {"precision": round(p, 3), "recall": round(r, 3), "f1": round(2 * p * r / (p + r), 3) if p + r else 0.0,
            "sentiment_accuracy_on_matched": round(s_ok / s_n, 3) if s_n else None, "tp": tp, "fp": fp, "fn": fn}


def reference_a() -> tuple[list[tuple[dict, dict]], int, list[str]]:
    pairs, exact, by_lang = [], 0, []
    for path in sorted((ROOT / "eval" / "w3" / "fixtures" / "dev").glob("*.json")):
        fx = json.loads(path.read_text(encoding="utf-8"))
        inp = fx["input"]
        if inp["model_output"].get("status") != "ok":
            continue
        outcome = rules.evaluate(inp, fx["gold"]["lang"])
        accepted = {(a["message_id"], a["theme"]) for a in outcome.get("accepted_labels", [])}
        sentiment = {(lb["message_id"], lb["theme"]): lb["sentiment"] for lb in inp["model_output"]["labels"]}
        msgs = [{"id": m["id"], "text": m["text"], "lang": fx["gold"]["lang"].get(m["id"])} for m in inp["messages"]]
        out = tag(msgs)
        for m in msgs:
            if m["lang"] not in rules.SUPPORTED_LANGS:
                continue
            gold = {t: sentiment[(mid, t)] for (mid, t) in accepted if mid == m["id"]}
            got = {lb["theme"]: lb["sentiment"] for lb in out["labels"] if lb["message_id"] == m["id"]}
            pairs.append((gold, got))
            by_lang.append(m["lang"])
            text = m["text"].encode("utf-8")
            exact += sum(text[lb["start"]:lb["end"]].decode("utf-8") == lb["quote"]
                         for lb in out["labels"] if lb["message_id"] == m["id"])
    return pairs, exact, by_lang


def reference_b() -> tuple[list[tuple[dict, dict]], list[str]]:
    items = [json.loads(line) for line in (HERE.parent / "devset" / "feedback_dev.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    out = tag([{"id": i["id"], "text": i["text"], "lang": i["lang"]} for i in items])
    pairs = []
    for i in items:
        gold = {g["theme"]: g["sentiment"] for g in i["gold"] if g["theme"] in CATALOGUE}  # 'guide' is not in the catalogue
        got = {lb["theme"]: lb["sentiment"] for lb in out["labels"] if lb["message_id"] == i["id"]}
        pairs.append((gold, got))
    return pairs, [i["lang"] for i in items]


def main() -> None:
    a_pairs, exact, a_langs = reference_a()
    b_pairs, b_langs = reference_b()
    report = {
        "label": "DESKTOP, synthetic data; Nat's held-out W3 set is the fair test",
        "reference_a_w3_dev_accepted_labels": {
            "messages": len(a_pairs), "overall": score(a_pairs), "quotes_exact_slices": exact,
            "by_lang": {lg: score([p for p, l in zip(a_pairs, a_langs) if l == lg]) for lg in sorted(set(a_langs))},
        },
        "reference_b_max_devset_optimistic": {
            "messages": len(b_pairs), "overall": score(b_pairs),
            "by_lang": {lg: score([p for p, l in zip(b_pairs, b_langs) if l == lg]) for lg in sorted(set(b_langs))},
        },
    }
    out = HERE.parent / "results" / "tagger-desktop-r0.json"
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
