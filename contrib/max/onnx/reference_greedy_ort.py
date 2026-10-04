"""Max lane: the int8 en->sw ONNX model driven by plain onnxruntime + sentencepiece, no transformers/optimum.

    python contrib/max/onnx/reference_greedy_ort.py --flores <flores200_dataset/dev> [--n 20]

This is the loop Mobile ports to onnxruntime-react-native (README.md, "For Mobile"): SentencePiece pieces ->
vocab.json ids + </s>, one encoder run, then greedy steps on decoder_model_merged.onnx with the KV cache.
--flores checks it against optimum's ORTModelForSeq2SeqLM greedy output, sentence by sentence
(measured: 20/20 identical on the first 20 FLORES-200 dev sentences, ids identical to MarianTokenizer's).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

MODEL_DIR = Path(__file__).resolve().parents[3] / "models" / "opus-onnx" / "en-sw" / "int8"
EOS, UNK, PAD = 0, 1, 58949  # PAD is also decoder_start_token_id and the only bad_words_id
MAX_TOKENS = 256


class Translator:
    def __init__(self, model_dir: Path = MODEL_DIR) -> None:
        import onnxruntime as ort
        import sentencepiece as spm

        self.vocab: dict[str, int] = json.loads((model_dir / "vocab.json").read_text(encoding="utf-8"))
        self.pieces = {i: p for p, i in self.vocab.items()}
        self.sp = spm.SentencePieceProcessor(model_file=str(model_dir / "source.spm"))
        self.enc = ort.InferenceSession(str(model_dir / "encoder_model.onnx"), providers=["CPUExecutionProvider"])
        self.dec = ort.InferenceSession(str(model_dir / "decoder_model_merged.onnx"),
                                        providers=["CPUExecutionProvider"])
        self.kv_names = [i.name for i in self.dec.get_inputs() if i.name.startswith("past_key_values.")]
        self.out_names = [o.name for o in self.dec.get_outputs()]

    def encode(self, text: str) -> list[int]:
        return [self.vocab.get(p, UNK) for p in self.sp.encode(text, out_type=str)] + [EOS]

    def translate(self, text: str) -> str:
        ids = np.array([self.encode(text)], dtype=np.int64)
        mask = np.ones_like(ids)
        hidden = self.enc.run(None, {"input_ids": ids, "attention_mask": mask})[0]
        past = {n: np.zeros((1, 8, 0, 64), dtype=np.float32) for n in self.kv_names}
        token, out = PAD, []
        for step in range(MAX_TOKENS):
            feeds = {"input_ids": np.array([[token]], dtype=np.int64), "encoder_hidden_states": hidden,
                     "encoder_attention_mask": mask, "use_cache_branch": np.array([step > 0]), **past}
            res = dict(zip(self.out_names, self.dec.run(None, feeds), strict=True))
            logits = res["logits"][0, -1].copy()
            logits[PAD] = -np.inf
            token = int(logits.argmax())
            if token == EOS:
                break
            out.append(token)
            for name in self.kv_names:  # encoder (cross-attention) cache is computed once, at step 0
                if step == 0 or ".decoder." in name:
                    past[name] = res[name.replace("past_key_values.", "present.")]
        return "".join(self.pieces[i] for i in out).replace("\u2581", " ").strip()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--flores", required=True, type=Path)
    ap.add_argument("--n", type=int, default=20)
    args = ap.parse_args()

    from optimum.onnxruntime import ORTModelForSeq2SeqLM
    from transformers import MarianTokenizer

    tr = Translator()
    model, tok = ORTModelForSeq2SeqLM.from_pretrained(MODEL_DIR), MarianTokenizer.from_pretrained(MODEL_DIR)
    lines = (args.flores / "eng_Latn.dev").read_text(encoding="utf-8").splitlines()[:args.n]
    same_ids = same_text = 0
    for src in lines:
        same_ids += tok([src])["input_ids"][0] == tr.encode(src)
        ref = model.generate(**tok([src], return_tensors="pt"), num_beams=1, max_new_tokens=MAX_TOKENS)
        same_text += tr.translate(src) == tok.decode(ref[0], skip_special_tokens=True)
    print(f"token ids identical: {same_ids}/{len(lines)}; greedy translations identical: {same_text}/{len(lines)}")


if __name__ == "__main__":
    main()
