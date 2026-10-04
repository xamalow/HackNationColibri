"""Local-model condition: Qwen3 behind the same tagger interface as the keyword baseline.

    # no network port (default backend): one llama-completion run per message
    python eval/feedback/model_tagger.py --exe <llama.cpp>/llama-completion.exe < messages.json
    # or a local server
    python eval/feedback/model_tagger.py --backend server --server http://127.0.0.1:8089 < messages.json

stdin: JSON array of {id, text, lang?}; stdout: {"status", "labels": [{message_id, theme, sentiment, quote,
start, end}], "untagged": [{message_id, reason}], "run": {...}}.

Fidelity to Max's measured condition: the system prompt, few-shot examples, JSON schema, user framing,
decoding (temperature 0, max_tokens 256, seed 0, /no_think) and the validation (`check`: themes and
sentiments from the list, quote must be an exact slice) are imported from contrib/max/qwen_extraction.py,
not copied. Only the runtime differs: the llama.cpp server binary instead of llama-cpp-python.
Max's list has "guide" (mapped to host here) and has no buy_coffee or language theme. Local only: the
server must listen on 127.0.0.1; no data leaves the machine.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("qwen_extraction", ROOT / "contrib" / "max" / "qwen_extraction.py")
max_harness = importlib.util.module_from_spec(_spec)
sys.modules["qwen_extraction"] = max_harness  # dataclasses need the module registered before exec
_spec.loader.exec_module(max_harness)  # type: ignore[union-attr]

SUPPORTED = {"sw", "en", "de", "fr"}
THEME_MAP = {"guide": "host"}
TIMEOUT_S = 180
MODEL = ROOT / "models" / "qwen3" / "Qwen3-0.6B-Q8_0.gguf"
GRAMMAR = Path(__file__).resolve().parent / "max_findings_compact.gbnf"  # see the file header


def chatml(system: str, text: str) -> str:
    """Qwen3's chat format for one system + one user turn, ending at the assistant's turn (no tools, no history)."""
    return (f"<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\nFeedback:\n<<<\n{text}\n>>>\n/no_think<|im_end|>\n"
            "<|im_start|>assistant\n")


def ask_completion(exe: str, model: Path, system: str, text: str, grammar: bool, grammar_file: Path | None = GRAMMAR) -> str:
    """One llama-completion run, no network: prompt from a temp file, same decoding as Max's condition."""
    with tempfile.NamedTemporaryFile("w", suffix=".txt", encoding="utf-8", delete=False) as f:
        f.write(chatml(system, text))
        prompt_file = f.name
    try:
        cmd = [exe, "-m", str(model), "-f", prompt_file, "-n", "256", "-c", "2048", "-t", "7", "--temp", "0",
               "-s", "0", "-no-cnv", "--no-display-prompt"]
        if grammar:
            cmd += ["--grammar-file", str(grammar_file)] if grammar_file else ["-j", json.dumps(max_harness.SCHEMA)]
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                              stdin=subprocess.DEVNULL, timeout=TIMEOUT_S, check=False)
        if proc.returncode != 0:
            raise OSError(f"llama-completion exit {proc.returncode}")
        return proc.stdout.replace("[end of text]", "").strip()
    finally:
        Path(prompt_file).unlink(missing_ok=True)


def ask(server: str, system: str, text: str, grammar: bool) -> str:
    body: dict[str, Any] = {
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": f"Feedback:\n<<<\n{text}\n>>>\n/no_think"}],
        "temperature": 0.0, "max_tokens": 256, "seed": 0,
    }
    if grammar:
        body["response_format"] = {"type": "json_object", "schema": max_harness.SCHEMA}
    req = urllib.request.Request(f"{server}/v1/chat/completions", data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:  # local server only
        return json.loads(resp.read())["choices"][0]["message"]["content"] or ""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Qwen3 local-model tagger (same interface as the keyword tagger).")
    parser.add_argument("--backend", choices=["completion", "server"], default="completion")
    parser.add_argument("--exe", help="path to llama-completion(.exe), for the completion backend")
    parser.add_argument("--model", default=str(MODEL))
    parser.add_argument("--server", default="http://127.0.0.1:8089")
    parser.add_argument("--condition", default="en_prompt_grammar_fewshot", choices=sorted(max_harness.CONDITIONS))
    args = parser.parse_args(argv)
    if args.backend == "completion" and not args.exe:
        print("--exe is required for the completion backend", file=sys.stderr)
        return 2
    if args.backend == "server" and not args.server.startswith(("http://127.0.0.1", "http://localhost")):
        print("refusing a non-local server: the core path is offline", file=sys.stderr)
        return 2
    system, grammar = max_harness.CONDITIONS[args.condition]
    messages = json.loads(sys.stdin.read())
    labels, untagged, seconds = [], [], []
    stats = {"invalid_json": 0, "invented_quotes": 0, "near_miss_quotes": 0, "off_list_labels": 0}
    for m in messages:
        if m.get("lang") and m["lang"] not in SUPPORTED:
            untagged.append({"message_id": m["id"], "reason": "unsupported_language"})
            continue
        t0 = time.perf_counter()
        try:
            raw = (ask_completion(args.exe, Path(args.model), system, m["text"], grammar) if args.backend == "completion"
                   else ask(args.server, system, m["text"], grammar))
        except (OSError, ValueError, KeyError) as exc:
            untagged.append({"message_id": m["id"], "reason": f"model_error: {type(exc).__name__}"})
            continue
        seconds.append(time.perf_counter() - t0)
        checked = max_harness.check(m["text"], raw)
        if not checked.valid_json:
            stats["invalid_json"] += 1
            untagged.append({"message_id": m["id"], "reason": "structured_output_failure"})
            continue
        stats["invented_quotes"] += checked.invented
        stats["near_miss_quotes"] += checked.near_miss
        stats["off_list_labels"] += checked.bad_label
        for f in checked.kept:
            labels.append({"message_id": m["id"], "theme": THEME_MAP.get(f["theme"], f["theme"]),
                           "sentiment": f["sentiment"], "quote": f["quote"],
                           "start": f["span"]["start"], "end": f["span"]["end"]})
    run = {"condition": args.condition, "backend": args.backend, "items": len(messages), "dropped_by_code": stats,
           "seconds_mean": round(statistics.mean(seconds), 2) if seconds else None,
           "seconds_p95": round(sorted(seconds)[int(0.95 * (len(seconds) - 1))], 2) if seconds else None}
    print(json.dumps({"status": "ok", "labels": labels, "untagged": untagged, "run": run}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
