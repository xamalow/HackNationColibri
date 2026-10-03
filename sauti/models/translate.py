"""Translation: NLLB-200 distilled 600M (CTranslate2 int8), offline.

License CC-BY-NC 4.0: fine for the hackathon, to replace for commercial use.
"""

from __future__ import annotations

import re
from pathlib import Path

SWAHILI = "swh_Latn"
ENGLISH = "eng_Latn"
GERMAN = "deu_Latn"
FRENCH = "fra_Latn"


def _sentences(text: str) -> list[str]:
    return [s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s]


class Translator:
    def __init__(self, model_dir: Path) -> None:
        import ctranslate2
        from transformers import AutoTokenizer

        self._translator = ctranslate2.Translator(str(model_dir), device="cpu", compute_type="int8")
        self._tokenizer = AutoTokenizer.from_pretrained(model_dir)

    def translate(self, text: str, source: str, target: str) -> str:
        sentences = _sentences(text)
        if not sentences:
            return ""
        self._tokenizer.src_lang = source
        batch = [self._tokenizer.convert_ids_to_tokens(self._tokenizer.encode(s)) for s in sentences]
        results = self._translator.translate_batch(
            batch, target_prefix=[[target]] * len(batch), beam_size=4, max_decoding_length=256
        )
        out = []
        for result in results:
            tokens = result.hypotheses[0][1:]  # drop the target language token
            out.append(self._tokenizer.decode(self._tokenizer.convert_tokens_to_ids(tokens), skip_special_tokens=True))
        return " ".join(out)
