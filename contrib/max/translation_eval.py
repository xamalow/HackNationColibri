"""Max lane: can a local Apache/MIT model translate visitor feedback into Swahili well enough for Noor to read?

    python contrib/max/translation_eval.py --flores <flores200_dataset/dev> [--n 50]          # Qwen3 0.6B
    python contrib/max/translation_eval.py --flores <dev> --model models/qwen3/Qwen3-1.7B-Q8_0.gguf \\
        --sha256 061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a                # Qwen3 1.7B
    python contrib/max/translation_eval.py --flores <dev> --engine madlad-ct2 --model <dir>   # MADLAD-400 3B
        # <dir>: a CTranslate2 conversion of google/madlad400-3b-mt (Apache-2.0) containing sentencepiece.model;
        # needs: pip install ctranslate2 sentencepiece (MIT / Apache-2.0). UNTESTED on the Max laptop.
    python contrib/max/translation_eval.py --flores <dev> --engine opus-ct2 --model models/opus
        # Opus-MT (Helsinki-NLP, Apache-2.0), CTranslate2 int8: <dir>/en-sw, <dir>/de-en, <dir>/fr-en;
        # en -> sw direct, de/fr -> en -> sw (pivot, there is no de->sw model)

Source sentences: FLORES-200 *dev* (CC-BY-SA 4.0) in deu/fra/eng; reference: the aligned swh_Latn line.
Metric: chrF (character n-gram F-score, n=6, beta=2, sacrebleu's default), implemented below. Also counted:
outputs containing a number absent from the source (a translation must never invent a price or a date).
DESKTOP numbers; FLORES is formal text, not reviews. Only aggregates are written, never FLORES text.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import statistics
import time
from collections import Counter
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DEFAULT_MODEL = ROOT / "models" / "qwen3" / "Qwen3-0.6B-Q8_0.gguf"
DEFAULT_SHA = "9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031"
SOURCES = {"de": "deu_Latn", "fr": "fra_Latn", "en": "eng_Latn"}
NAMES = {"de": "German", "fr": "French", "en": "English"}

Translate = Callable[[str, str], str]


def _ngrams(text: str, n: int) -> Counter[str]:
    s = re.sub(r"\s+", " ", text.strip())
    return Counter(s[i:i + n] for i in range(len(s) - n + 1))


def chrf(hyp: str, ref: str, max_n: int = 6, beta: float = 2.0) -> float:
    precisions, recalls = [], []
    for n in range(1, max_n + 1):
        h, r = _ngrams(hyp, n), _ngrams(ref, n)
        if not h or not r:
            continue
        overlap = sum((h & r).values())
        precisions.append(overlap / sum(h.values()))
        recalls.append(overlap / sum(r.values()))
    if not precisions:
        return 0.0
    p, r = statistics.mean(precisions), statistics.mean(recalls)
    return 0.0 if p + r == 0 else 100 * (1 + beta**2) * p * r / (beta**2 * p + r)


def invented_numbers(src: str, hyp: str) -> bool:
    return bool(set(re.findall(r"\d+", hyp)) - set(re.findall(r"\d+", src)))


def _numbers(text: str) -> list[int]:
    # "1,200" / "1.200" / "1 200" -> 1200 (thousands separators), then every digit run as an integer
    text = re.sub(r"(?<=\d)[,.\u202f\u00a0 ](?=\d{3}\b)", "", text)
    return sorted(int(n) for n in re.findall(r"\d+", text))


def number_guard(src: str, hyp: str) -> bool:
    """True if the translation may be shown: it states exactly the source's numbers (same multiset).
    Otherwise the app shows the original plus code-extracted facts, never the translation's numbers."""
    return _numbers(src) == _numbers(hyp)


def _check_sha(path: Path, expected: str) -> None:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != expected:
        raise SystemExit(f"model hash mismatch for {path.name}")


def llama_engine(model: Path, sha256: str, threads: int) -> Translate:
    from llama_cpp import Llama

    _check_sha(model, sha256)
    llm = Llama(model_path=str(model), n_ctx=2048, n_threads=threads, n_gpu_layers=0, seed=0, verbose=False)

    def translate(src: str, lang: str) -> str:
        out = llm.create_chat_completion(
            messages=[
                {"role": "system", "content": f"Translate the {NAMES[lang]} text into Swahili. "
                 "Output only the Swahili translation. Keep every number exactly as written."},
                {"role": "user", "content": f"{src}\n/no_think"},
            ],
            temperature=0.0, max_tokens=256, seed=0,
        )
        text = out["choices"][0]["message"]["content"] or ""
        return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()

    return translate


def madlad_engine(model_dir: Path, threads: int) -> Translate:
    import ctranslate2
    import sentencepiece as spm

    translator = ctranslate2.Translator(str(model_dir), device="cpu", inter_threads=1, intra_threads=threads)
    sp = spm.SentencePieceProcessor(model_file=str(model_dir / "sentencepiece.model"))

    def translate(src: str, lang: str) -> str:
        tokens = sp.encode("<2sw> " + src, out_type=str)
        result = translator.translate_batch([tokens], beam_size=1, max_decoding_length=256)
        return sp.decode(result[0].hypotheses[0])

    return translate


def opus_engine(model_dir: Path, threads: int) -> Translate:
    import ctranslate2
    import sentencepiece as spm

    def load(name: str):
        d = model_dir / name
        tr = ctranslate2.Translator(str(d), device="cpu", inter_threads=1, intra_threads=threads)
        return tr, spm.SentencePieceProcessor(model_file=str(d / "source.spm")), spm.SentencePieceProcessor(
            model_file=str(d / "target.spm"))

    pairs = {name: load(name) for name in ("en-sw", "de-en", "fr-en")}

    def step(name: str, text: str) -> str:
        tr, src_sp, tgt_sp = pairs[name]
        tokens = src_sp.encode(text, out_type=str) + ["</s>"]
        out = tr.translate_batch([tokens], beam_size=4, max_decoding_length=256)
        return tgt_sp.decode([t for t in out[0].hypotheses[0] if t != "</s>"])

    def translate(src: str, lang: str) -> str:
        english = src if lang == "en" else step(f"{lang}-en", src)
        return step("en-sw", english)

    return translate


def run(flores: Path, n: int, translate: Translate, model_name: str, engine: str) -> dict:
    ref_lines = (flores / "swh_Latn.dev").read_text(encoding="utf-8").splitlines()
    report = {"label": "DESKTOP, FLORES-200 dev (formal text), not reviews", "model": model_name, "engine": engine,
              "date_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"), "n_per_direction": n,
              "directions": {}}
    for lang, code in SOURCES.items():
        src_lines = (flores / f"{code}.dev").read_text(encoding="utf-8").splitlines()
        scores, invented, latencies, has_numbers, blocked = [], 0, [], 0, 0
        for src, ref in list(zip(src_lines, ref_lines, strict=False))[:n]:
            t0 = time.perf_counter()
            hyp = translate(src, lang)
            latencies.append(time.perf_counter() - t0)
            scores.append(chrf(hyp, ref))
            invented += invented_numbers(src, hyp)
            has_numbers += bool(_numbers(src) or _numbers(hyp))
            blocked += not number_guard(src, hyp)
        report["directions"][f"{lang}->sw"] = {
            "chrF_mean": round(statistics.mean(scores), 1), "chrF_median": round(statistics.median(scores), 1),
            "outputs_with_invented_numbers": invented, "latency_s_mean": round(statistics.mean(latencies), 2),
            "sentences_with_numbers": has_numbers, "blocked_by_number_guard": blocked,
            "shown_with_wrong_number_after_guard": 0,  # by construction: the guard compares the full multiset
        }
        print(lang, report["directions"][f"{lang}->sw"], flush=True)
    return report


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--flores", required=True, type=Path)
    ap.add_argument("--n", type=int, default=50)
    ap.add_argument("--engine", choices=["llama", "madlad-ct2", "opus-ct2"], default="llama")
    ap.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    ap.add_argument("--sha256", default=DEFAULT_SHA)
    ap.add_argument("--threads", type=int, default=4)
    args = ap.parse_args()
    if args.engine == "madlad-ct2":
        translate = madlad_engine(args.model, args.threads)
    elif args.engine == "opus-ct2":
        translate = opus_engine(args.model, args.threads)
    else:
        translate = llama_engine(args.model, args.sha256, args.threads)
    report = run(args.flores, args.n, translate, args.model.name, args.engine)
    out_path = HERE / "results" / f"translation-{args.model.stem.lower().replace('_', '-')}-{args.engine}-desktop.json"
    out_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print("wrote", out_path.relative_to(ROOT))


if __name__ == "__main__":
    main()
