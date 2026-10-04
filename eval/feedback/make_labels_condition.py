"""Run a tagger over the corpus and write a labels-mode condition file for score_conditions.py.

    python eval/feedback/make_labels_condition.py --corpus dev --name keyword-max-cab5b36 \
        --out cond.json [--with-lang] -- node <checkout>/contrib/max/tagger/cli.mjs

The tagger reads a JSON array of {id, text, lang?} on stdin and prints the core's model-output shape:
{"status", "labels": [{message_id, theme, sentiment, quote, start, end}], "untagged": [{message_id, reason}]}.
Without --with-lang the tagger gets no language (its detector decides, as in the product for sources that
declare none); with it, it gets each message's true language (an upper bound).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

from corpus_kit import read_corpus
from score_conditions import CORPORA

TIMEOUT_S = 300


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--corpus", choices=sorted(CORPORA), default="dev")
    parser.add_argument("--name", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--with-lang", action="store_true")
    parser.add_argument("cmd", nargs=argparse.REMAINDER, help="tagger command, after --")
    args = parser.parse_args(argv)
    cmd = args.cmd[1:] if args.cmd[:1] == ["--"] else args.cmd
    messages = read_corpus(CORPORA[args.corpus])
    payload = [{"id": m["id"], "text": m["text"], **({"lang": m["lang"]} if args.with_lang and m["lang"] else {})}
               for m in messages]
    proc = subprocess.run(cmd, input=json.dumps(payload, ensure_ascii=False), capture_output=True, text=True,
                          encoding="utf-8", timeout=TIMEOUT_S, check=False)
    if proc.returncode != 0:
        print(f"tagger failed: {proc.stderr.strip()[:500]}", file=sys.stderr)
        return 1
    out = json.loads(proc.stdout)
    labels: dict[str, list[dict]] = defaultdict(list)
    for lb in out.get("labels", []):
        labels[lb["message_id"]].append({"theme": lb["theme"], "sentiment": lb["sentiment"], "quote": lb.get("quote")})
    excluded = sorted(u["message_id"] for u in out.get("untagged", []) if u.get("reason") in {"unsupported_language", "und"})
    condition = {"condition": args.name, "corpus": args.corpus, "with_lang": args.with_lang,
                 "status": out.get("status"), "labels": dict(labels), "excluded_ids": excluded}
    Path(args.out).write_text(json.dumps(condition, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print(f"{len(labels)} messages labeled, {len(excluded)} excluded as unsupported language -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
