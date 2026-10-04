"""Max lane: does the ONNX export of opus-mt-en-sw translate as well as the CTranslate2 int8 build (chrF 63.2)?

    python contrib/max/onnx/verify_onnx_en_sw.py --flores <flores200_dataset/dev> --variant int8          # beam 4
    python contrib/max/onnx/verify_onnx_en_sw.py --flores <dev> --variant fp32
    python contrib/max/onnx/verify_onnx_en_sw.py --flores <dev> --variant int8 --split   # decoder + decoder_with_past
    python contrib/max/onnx/verify_onnx_en_sw.py --flores <dev> --variant int8 --beams 1 # greedy

Loads models/opus-onnx/en-sw/<variant> (made by export_onnx_en_sw.py) with optimum's ORTModelForSeq2SeqLM on the
onnxruntime CPU provider, translates the first --n English sentences of FLORES-200 *dev* (CC-BY-SA 4.0, never
devtest) and scores them against swh_Latn with chrf() and number_guard() from ../translation_eval.py, the same
functions and settings (n=100, beam 4, max 256 tokens, 4 threads) as the CTranslate2 run. Only aggregates are
written to contrib/max/results/, never FLORES text. DESKTOP numbers, formal text, not reviews.
"""

from __future__ import annotations

import argparse
import json
import platform
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE.parent))

from translation_eval import _numbers, chrf, invented_numbers, number_guard  # noqa: E402

MODEL_ROOT = ROOT / "models" / "opus-onnx" / "en-sw"


def load(variant: str, split: bool, threads: int):
    import onnxruntime as ort
    from optimum.onnxruntime import ORTModelForSeq2SeqLM
    from transformers import MarianTokenizer

    model_dir = MODEL_ROOT / variant
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 1
    model = ORTModelForSeq2SeqLM.from_pretrained(model_dir, use_merged=not split, use_cache=True,
                                                 session_options=opts, provider="CPUExecutionProvider")
    return model, MarianTokenizer.from_pretrained(model_dir)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--flores", required=True, type=Path)
    ap.add_argument("--variant", choices=["fp32", "int8"], default="int8")
    ap.add_argument("--split", action="store_true", help="use decoder_model + decoder_with_past, not the merged one")
    ap.add_argument("--beams", type=int, default=4)
    ap.add_argument("--n", type=int, default=100)
    ap.add_argument("--threads", type=int, default=4)
    args = ap.parse_args()

    model, tok = load(args.variant, args.split, args.threads)
    src_lines = (args.flores / "eng_Latn.dev").read_text(encoding="utf-8").splitlines()[:args.n]
    ref_lines = (args.flores / "swh_Latn.dev").read_text(encoding="utf-8").splitlines()[:args.n]

    scores, latencies, invented, has_numbers, blocked = [], [], 0, 0, 0
    for src, ref in zip(src_lines, ref_lines, strict=True):
        t0 = time.perf_counter()
        batch = tok([src], return_tensors="pt")
        out = model.generate(**batch, num_beams=args.beams, max_new_tokens=256)
        hyp = tok.decode(out[0], skip_special_tokens=True)
        latencies.append(time.perf_counter() - t0)
        scores.append(chrf(hyp, ref))
        invented += invented_numbers(src, hyp)
        has_numbers += bool(_numbers(src) or _numbers(hyp))
        blocked += not number_guard(src, hyp)

    decoder = "decoder_model + decoder_with_past_model" if args.split else "decoder_model_merged"
    result = {
        "label": "DESKTOP, FLORES-200 dev (formal text), not reviews",
        "model": f"Helsinki-NLP/opus-mt-en-sw ONNX {args.variant} (encoder_model + {decoder})",
        "engine": "optimum ORTModelForSeq2SeqLM, onnxruntime CPUExecutionProvider",
        "date_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "cpu": platform.processor(), "threads": args.threads, "beams": args.beams, "n": args.n,
        "en->sw": {
            "chrF_mean": round(statistics.mean(scores), 1), "chrF_median": round(statistics.median(scores), 1),
            "outputs_with_invented_numbers": invented, "latency_s_mean": round(statistics.mean(latencies), 3),
            "latency_s_p95": round(sorted(latencies)[int(0.95 * (len(latencies) - 1))], 3),
            "sentences_with_numbers": has_numbers, "blocked_by_number_guard": blocked,
            "reference_ct2_int8_chrF": 63.2,
        },
    }
    print(json.dumps(result, indent=2))
    tag = f"{args.variant}{'-split' if args.split else ''}-beam{args.beams}"
    out_path = HERE.parent / "results" / f"translation-opus-onnx-en-sw-{tag}-desktop.json"
    out_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print("wrote", out_path.relative_to(ROOT))


if __name__ == "__main__":
    main()
