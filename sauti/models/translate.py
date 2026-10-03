"""Language detection and translation interfaces.

NLLB-200 (step 3 of docs/W2_PLAN.md) plugs in behind `Translator`. Until it is
loaded, `NoTranslator` returns None and W2 falls back to hand-written reply
templates in the tourist's language, and shows Noor the original text.
NLLB cannot detect languages: detection is a separate `LanguageDetector`.
"""

from __future__ import annotations

import re
from typing import Protocol

SUPPORTED = ("en", "de", "fr", "sw")


class LanguageDetector(Protocol):
    def detect(self, text: str) -> tuple[str | None, float]:
        """(ISO 639-1 code, confidence) or (None, 0.0) when unsure."""
        ...


class Translator(Protocol):
    def translate(self, text: str, src: str, tgt: str) -> str | None:
        """Translation, or None when the pair is not available."""
        ...


# Frequent function words. A baseline that needs no model file; fastText lid.176 replaces it.
_STOPWORDS = {
    "en": {"the", "and", "is", "are", "we", "you", "your", "can", "how", "much", "what", "for", "to",
           "of", "a", "on", "with", "would", "like", "do", "it", "hi", "hello", "please", "visit", "tour"},
    "de": {"der", "die", "das", "und", "ist", "sind", "wir", "sie", "ihr", "kann", "können", "wie", "viel",
           "was", "für", "zu", "mit", "ein", "eine", "möchten", "gerne", "hallo", "bitte", "kostet", "am", "ich"},
    "fr": {"le", "la", "les", "et", "est", "sont", "nous", "vous", "votre", "peut", "comment", "combien",
           "pour", "de", "des", "un", "une", "avec", "voudrions", "bonjour", "merci", "visite", "je", "est-ce"},
    "sw": {"na", "ni", "kwa", "ya", "wa", "za", "habari", "bei", "ngapi", "tunataka", "kuja", "shamba",
           "tafadhali", "asante", "je", "watu", "kesho", "gani", "hii", "mimi", "sisi"},
}
MIN_HITS = 2


class StopwordLanguageDetector:
    def detect(self, text: str) -> tuple[str | None, float]:
        words = re.findall(r"[a-zäöüßàâçéèêëîïôûùœ'-]+", text.lower())
        scores = {lang: sum(w in stops for w in words) for lang, stops in _STOPWORDS.items()}
        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        (best, top), (_, second) = ranked[0], ranked[1]
        if top < MIN_HITS or top == second:
            return None, 0.0
        return best, round(top / (top + second), 2)


class NoTranslator:
    def translate(self, text: str, src: str, tgt: str) -> str | None:
        return text if src == tgt else None
