"""Check that our no-network runtime reproduces Max's measured Qwen3 condition before using it.

    python eval/feedback/calibrate_runtime.py --exe <llama.cpp>/llama-completion.exe [--report out.json]

Runs Max's dev set (contrib/max/devset, 40 items) through model_tagger's completion backend with Max's
best condition, then compares item by item with Max's published raw outputs and his score
(contrib/max/results/qwen3-0.6b-q8-desktop-20261003T2225Z.json). Same model file (hash-checked), same
prompt and decoding; different runtime (llama.cpp b11381 CLI vs llama-cpp-python 0.3.19).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import model_tagger as mt

ROOT = Path(__file__).resolve().parents[2]
DEVSET = ROOT / "contrib" / "max" / "devset" / "feedback_dev.jsonl"
PUBLISHED = ROOT / "contrib" / "max" / "results" / "qwen3-0.6b-q8-desktop-20261003T2225Z.json"
CONDITION = "en_prompt_grammar_fewshot"


def parsed(raw: str) -> object:
    m = re.search(r"\{.*\}", re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL), flags=re.DOTALL)
    try:
        return json.loads(m.group(0) if m else raw)
    except ValueError:
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--exe", required=True)
    parser.add_argument("--model", default=str(mt.MODEL))
    parser.add_argument("--report")
    args = parser.parse_args(argv)
    mh = mt.max_harness
    system, grammar = mh.CONDITIONS[CONDITION]
    items = [json.loads(line) for line in DEVSET.read_text(encoding="utf-8").splitlines() if line.strip()]
    published = json.loads(PUBLISHED.read_text(encoding="utf-8"))["conditions"][CONDITION]
    theirs = {r["id"]: r["output"] for r in published["raw"]}
    preds, same, rows = [], 0, []
    for item in items:
        raw = mt.ask_completion(args.exe, Path(args.model), system, item["text"], grammar)
        preds.append(mh.check(item["text"], raw).kept)
        identical = parsed(raw) == parsed(theirs.get(item["id"], ""))
        same += identical
        rows.append({"id": item["id"], "identical_to_max": identical, "ours": raw})
    ours = mh.score(items, preds)
    report = {"condition": CONDITION, "items": len(items), "outputs_identical_to_max": f"{same}/{len(items)}",
              "ours": ours, "max_published": published["overall"], "raw": rows}
    text = json.dumps(report, indent=2, ensure_ascii=False)
    if args.report:
        Path(args.report).write_text(text + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({k: report[k] for k in ("outputs_identical_to_max", "ours", "max_published")}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
