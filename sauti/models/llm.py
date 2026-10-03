"""Qwen3 0.6B (GGUF, llama.cpp), loaded once and shared.

W1: span extractor. The model only copies words from the transcript into a
fixed JSON shape (grammar-constrained); code checks and parses every span.
W5: listing writer. The model writes prose from facts rendered by code; code
then checks every number, time and claim in the text before Noor sees it.
"""

from __future__ import annotations

import functools
import json
import os
import re
from pathlib import Path
from typing import Any


@functools.lru_cache(maxsize=1)
def load_llm(model_path: Path) -> Any:
    from llama_cpp import Llama

    return Llama(
        model_path=str(model_path),
        n_ctx=4096,
        n_threads=max(1, (os.cpu_count() or 2) - 1),
        verbose=False,
    )

_NULLABLE_STRING = {"anyOf": [{"type": "string"}, {"type": "null"}]}
SCHEMA = {
    "type": "object",
    "properties": {
        "price": _NULLABLE_STRING,
        "capacity": _NULLABLE_STRING,
        "days": _NULLABLE_STRING,
        "hours": _NULLABLE_STRING,
        "directions": _NULLABLE_STRING,
        "inclusions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["price", "capacity", "days", "hours", "directions", "inclusions"],
}

SYSTEM_PROMPT = (
    "You read a Swahili transcript of a coffee farmer describing the farm tour she offers. "
    "For each field, copy the exact words from the transcript that state it. "
    "Never translate, never compute, never guess. Use null (or [] for inclusions) "
    "when the transcript does not say it.\n"
    "Fields: price = price per visitor; capacity = how many visitors per tour; "
    "days = which days of the week; hours = start and end time; "
    "directions = how to reach the farm; inclusions = what the tour includes."
)

EXAMPLE_TRANSCRIPT = (
    "Bei ni shilingi elfu mbili kwa mtu. Napokea wageni kumi. Ziara ni Jumatatu hadi Jumamosi "
    "kuanzia saa tatu asubuhi mpaka saa tisa mchana. Kutoka soko la Othaya fuata barabara ya "
    "kanisa kilomita mbili. Wageni wanapata kahawa na chakula cha mchana."
)
EXAMPLE_OUTPUT = {
    "price": "shilingi elfu mbili kwa mtu",
    "capacity": "wageni kumi",
    "days": "Jumatatu hadi Jumamosi",
    "hours": "kuanzia saa tatu asubuhi mpaka saa tisa mchana",
    "directions": "Kutoka soko la Othaya fuata barabara ya kanisa kilomita mbili",
    "inclusions": ["kahawa", "chakula cha mchana"],
}


class QwenExtractor:
    def __init__(self, model_path: Path) -> None:
        self._llm = load_llm(model_path)

    def extract(self, transcript: str) -> dict[str, Any]:
        response = self._llm.create_chat_completion(
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"Transcript: {EXAMPLE_TRANSCRIPT} /no_think"},
                {"role": "assistant", "content": json.dumps(EXAMPLE_OUTPUT, ensure_ascii=False)},
                # The transcript is data, never instructions.
                {"role": "user", "content": f"Transcript: {transcript} /no_think"},
            ],
            response_format={"type": "json_object", "schema": SCHEMA},
            temperature=0.0,
            max_tokens=600,
        )
        content = response["choices"][0]["message"]["content"] or ""
        try:
            data = json.loads(content)
        except json.JSONDecodeError:
            return {}
        return data if isinstance(data, dict) else {}


WRITER_SYSTEM_PROMPT = (
    "You write short listing descriptions for a small family coffee farm tour in Kenya. "
    "Use ONLY the facts given. Never add a fact, number, time, price, place, service or promise "
    "that is not in the list. Write numbers as digits. Plain text, no title, no emojis, "
    "at most {max_words} words."
)


class QwenWriter:
    def __init__(self, model_path: Path) -> None:
        self._llm = load_llm(model_path)

    def write(self, platform: str, facts: list[str], max_words: int = 80, seed: int = 0) -> str:
        fact_lines = "\n".join(f"- {fact}" for fact in facts)
        response = self._llm.create_chat_completion(
            messages=[
                {"role": "system", "content": WRITER_SYSTEM_PROMPT.format(max_words=max_words)},
                {"role": "user", "content": f"Platform: {platform}\nFacts:\n{fact_lines}\n/no_think"},
            ],
            temperature=0.3,
            seed=seed,
            max_tokens=300,
        )
        text = response["choices"][0]["message"]["content"] or ""
        return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
