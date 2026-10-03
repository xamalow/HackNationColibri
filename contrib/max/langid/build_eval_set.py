"""Build langid_eval.jsonl: every text this lane has with a known language, all synthetic.

    python contrib/max/langid/build_eval_set.py

Sources: contrib/max/devset/feedback_dev.jsonl (feedback, 1-2 sentences), the W2 demo inbox
(tourist messages, from branch w2-answer-tourist, copied here as w2_inbox_texts.jsonl) and
short_messages.jsonl (SMS-length texts, mixed language, out-of-scope inputs).
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAX = HERE.parent


def _read(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> None:
    rows = []
    for it in _read(MAX / "devset" / "feedback_dev.jsonl"):
        rows.append({"id": it["id"], "synthetic": True, "lang": it["lang"], "text": it["text"], "set": "feedback_dev"})
    for it in _read(HERE / "w2_inbox_texts.jsonl"):
        rows.append({**it, "set": "w2_inbox"})
    for it in _read(HERE / "short_messages.jsonl"):
        rows.append({**it, "set": "short"})
    out = HERE / "langid_eval.jsonl"
    out.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")
    print(len(rows), dict(Counter(r["lang"] for r in rows)), dict(Counter(r["set"] for r in rows)))


if __name__ == "__main__":
    main()
