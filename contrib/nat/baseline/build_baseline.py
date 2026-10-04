"""Builds the baseline-comparison numbers (Nat lane) for docs/evidence/BASELINE.md.

    python contrib/nat/baseline/build_baseline.py <root with packages/core/dist and contrib/max> [--demo-manual f.json]

Writes contrib/nat/results/baseline-{dev,heldout,demo}.json, with the conditions
manual_nat | app_tagger_core | template_baseline | qwen3_0.6b.
- dev (public corpus): summary + per_batch. The reference is the designer's labels (DRAFT); Nat did not read dev.
- heldout (texts stay on Nat's machine): summary only, no per-batch findings, no quotes.
- demo: the app's 10 bundled SYNTHETIC reviews (apps/mobile/src/demo/demoFeedback.ts), what the video shows. There is
  no designer reference: Nat's manual reading IS the reference (contrib/nat/baseline/demo-reading-sheet.md). Until it is
  given with --demo-manual, the manual column is null and nothing is scored.
app_tagger_core and template_baseline are computed by run_conditions.mjs; Qwen and manual held-out come from the
already published results (contrib/nat/results/feedback-model-qwen3-0.6b-*-lang.json, feedback-manual-nat-heldout.json).
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
FEEDBACK = REPO / "eval" / "feedback"
RESULTS = REPO / "contrib" / "nat" / "results"
sys.path.insert(0, str(FEEDBACK))

from corpus_kit import read_corpus  # noqa: E402
from score_conditions import CORPORA, score  # noqa: E402

RUNNER = Path(__file__).resolve().parent / "run_conditions.mjs"
DEMO_TS = REPO / "apps" / "mobile" / "src" / "demo" / "demoFeedback.ts"
CAVEATS = [
    "Small sets: 6 reference findings in dev, 6 in held-out, 10 demo reviews. Enough to show a pattern, not a rate.",
    "All messages are synthetic. Reference labels were written by the corpus designer (DRAFT); Nat's manual reading is one reader.",
    "app_tagger_core is the app's finding path (apps/mobile/src/domain/w3.ts runW3: tagger + core rules, no model). Gemma only translates.",
    "template_baseline is pre-registered in the room (#47814): the same tagger labels, counted with none of the core's rules.",
    "Swahili is UNREVIEWED by a native speaker.",
]


def git_sha() -> str:
    return subprocess.run(["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()


def run_conditions(root: Path, messages: list[dict], out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    src = out / "messages.jsonl"
    src.write_text("".join(json.dumps(m, ensure_ascii=False) + "\n" for m in messages), encoding="utf-8")
    subprocess.run(["node", str(RUNNER), str(root), str(src), str(out)], check=True, capture_output=True)
    return {name: json.loads((out / f"{name}.json").read_text(encoding="utf-8")) for name in ("app_tagger_core", "template_baseline", "themes")}


def summary_only(report: dict) -> dict:
    return {"summary": report["summary"]}


def build_corpus(root: Path, corpus: str, tmp: Path) -> dict:
    messages = read_corpus(CORPORA[corpus])
    plain = [{"id": m["id"], "batch": m["batch"], "text": m["text"], "lang": m.get("lang")} for m in messages]
    got = run_conditions(root, plain, tmp / corpus)
    app = score(got["app_tagger_core"], messages)
    tpl = score(got["template_baseline"], messages)
    qwen = json.loads((RESULTS / f"feedback-model-qwen3-0.6b-{corpus}-lang.json").read_text(encoding="utf-8"))
    if corpus == "heldout":
        manual = json.loads((RESULTS / "feedback-manual-nat-heldout.json").read_text(encoding="utf-8"))
        return {
            "set": "heldout", "messages": len(messages), "texts": "private (Nat's machine); summaries only",
            "conditions": {
                "manual_nat": summary_only(manual), "app_tagger_core": summary_only(app),
                "template_baseline": summary_only(tpl), "qwen3_0.6b": summary_only(qwen),
            },
        }
    for rep, got_c in ((app, got["app_tagger_core"]), (tpl, got["template_baseline"])):
        for b, v in rep["per_batch"].items():
            v["stated"] = got_c["batches"][b].get("lines") or [f"{f['theme']}: {f['direction']}" for f in got_c["batches"][b]["findings"]]
    return {
        "set": "dev", "messages": len(messages), "reference": "designer labels (DRAFT); Nat did not read dev",
        "conditions": {
            "manual_nat": None, "app_tagger_core": {"summary": app["summary"], "per_batch": app["per_batch"]},
            "template_baseline": {"summary": tpl["summary"], "per_batch": tpl["per_batch"]},
            "qwen3_0.6b": {"summary": qwen["summary"], "per_batch": qwen.get("per_batch")},
        },
    }


def demo_messages() -> list[dict]:
    text = DEMO_TS.read_text(encoding="utf-8")
    block = re.search(r"DEMO_FEEDBACK_CSV = `(.*?)`", text, re.S)
    if not block:
        raise SystemExit("demo CSV not found in demoFeedback.ts")
    rows = list(csv.DictReader(io.StringIO(block.group(1).strip())))
    return [{"id": r["source"], "batch": "DEMO", "text": r["review"], "lang": r["language"]} for r in rows]


def build_demo(root: Path, tmp: Path, manual_path: str | None) -> dict:
    messages = demo_messages()
    got = run_conditions(root, messages, tmp / "demo")
    themes = got["themes"]["DEMO"]
    tpl = {line["theme"]: line for line in themes["template"]}
    manual = json.loads(Path(manual_path).read_text(encoding="utf-8")) if manual_path else None
    manual_by_theme = {(f["theme"]): f for f in (manual or {}).get("findings", [])}
    rows = []
    for theme in sorted({t["theme"] for t in themes["app"]} | set(tpl) | set(manual_by_theme)):
        a = next((t for t in themes["app"] if t["theme"] == theme), None)
        t = tpl.get(theme)
        m = manual_by_theme.get(theme)
        rows.append({
            "theme": theme,
            "app_tagger_core": None if a is None else {
                "shows": f"{a['direction']} ({a['comment_count']} comments)" if a["verdict"] in ("supported", "supported_with_dissent") else (a["note"] or a["verdict"]),
                "verdict": a["verdict"], "direction": a["direction"], "comments": a["comment_count"],
                "supporting_ids": a["supporting_ids"], "dissenting_ids": a["dissenting_ids"], "quotes": a["quotes"],
            },
            "template_baseline": None if t is None else {"shows": t["text"], "mentions": t["mentions"], "majority": t["majority"], "ids": t["ids"]},
            "manual_nat": None if manual is None else ({"direction": m["direction"], "evidence_ids": m.get("evidence_ids", [])} if m else {"direction": "not stated"}),
        })
    out = {
        "set": "demo", "messages": len(messages), "source": "apps/mobile/src/demo/demoFeedback.ts (SYNTHETIC)",
        "app_ask_a_person": themes["app_ask_a_person"],
        "manual_nat_status": "read by Nat" if manual else "Nat reads at 08:00 (contrib/nat/baseline/demo-reading-sheet.md)",
        "rows": rows,
    }
    if manual:
        stated = {(f["theme"], f["direction"]) for f in manual["findings"] if f["direction"] in ("positive", "negative")}
        for name in ("app_tagger_core", "template_baseline"):
            claims = set()
            for r in rows:
                c = r[name]
                if c and (c.get("direction") or c.get("majority")) in ("positive", "negative") and (name != "app_tagger_core" or c["verdict"] in ("supported", "supported_with_dissent")):
                    claims.add((r["theme"], c.get("direction") or c.get("majority")))
            out.setdefault("agreement_with_nat", {})[name] = {
                "nat_findings": len(stated), "matched": len(claims & stated), "not_stated_by_nat": len(claims - stated), "missed": len(stated - claims),
            }
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("root", help="checkout with packages/core/dist built and contrib/max (langid deps installed)")
    ap.add_argument("--demo-manual", help="Nat's demo reading, {findings: [{theme, direction, evidence_ids}]}")
    args = ap.parse_args()
    root = Path(args.root).resolve()
    sha = git_sha()
    with tempfile.TemporaryDirectory(prefix="nat-baseline-") as t:
        tmp = Path(t)
        for name, data in (("dev", build_corpus(root, "dev", tmp)), ("heldout", build_corpus(root, "heldout", tmp)),
                           ("demo", build_demo(root, tmp, args.demo_manual))):
            data = {"generated_by": "contrib/nat/baseline/build_baseline.py", "repo_head": sha, **data, "caveats": CAVEATS}
            if name == "heldout":  # held-out texts and per-batch findings stay private: summaries only
                flat = json.dumps(data)
                assert '"per_batch"' not in flat and '"quote' not in flat and ":positive" not in flat and ":negative" not in flat, "held-out detail would leak"
            path = RESULTS / f"baseline-{name}.json"
            path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
            print("wrote", path.relative_to(REPO))
    return 0


if __name__ == "__main__":
    sys.exit(main())
