"""Intent classification: one intent from the fixed list, with a confidence score.

`KeywordIntentClassifier` is the baseline the trained classifier (MASSIVE sw-KE +
labeled synthetic messages) must beat in eval/. It reads the original text, in
English, German, French or Swahili.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Literal, Protocol

Intent = Literal["price", "date", "directions", "booking", "other"]
INTENTS: tuple[Intent, ...] = ("price", "date", "directions", "booking", "other")


@dataclass(frozen=True)
class IntentResult:
    intent: Intent
    confidence: float


class IntentClassifier(Protocol):
    def predict(self, text: str, lang: str | None) -> IntentResult: ...


# Accent-free stems, matched at word start.
_KEYWORDS: dict[Intent, tuple[str, ...]] = {
    "price": ("price", "cost", "how much", "fee", "rate", "charge", "pay", "kes", "ksh", "shilling",
              "preis", "kost", "wie viel", "wieviel", "gebuhr", "bezahl",
              "prix", "combien", "tarif", "cout", "payer",
              "bei", "ngapi", "gharama", "lipa"),
    "date": ("available", "availab", "open on", "are you open", "free on", "which day", "what time", "when",
             "verfugbar", "frei am", "geoffnet", "wann", "welche",
             "disponib", "ouvert", "quand", "libre",
             "wazi", "lini", "nafasi", "siku gani"),
    "directions": ("direction", "how to get", "how do we get", "where is", "where are", "address", "location",
                   "find you", "map", "route", "matatu", "bus", "drive",
                   "wegbeschreibung", "wie kommen", "wo ist", "wo befinde", "adresse", "anfahrt",
                   "itineraire", "comment venir", "comment aller", "ou est", "ou se trouve", "adresse",
                   "njia", "wapi", "mahali", "kufika"),
    "booking": ("book", "reserv", "reserve", "sign up", "confirm", "we would like to come", "we'd like to come",
                "buchen", "buchung", "anmelden", "reservier",
                "reserver", "reservation",
                "kuhifadhi", "nafasi kwa", "tunataka kuja", "weka"),
}
THRESHOLD_SINGLE = 0.85
THRESHOLD_MULTI = 0.55


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in text if not unicodedata.combining(c))


def keyword_hits(text: str) -> dict[Intent, int]:
    norm = _normalize(text)
    hits: dict[Intent, int] = {}
    for intent, stems in _KEYWORDS.items():
        n = sum(1 for stem in stems if re.search(r"(?<![a-z])" + re.escape(stem), norm))
        if n:
            hits[intent] = n
    return hits


class KeywordIntentClassifier:
    """Baseline. One intent found: confident. Several: the strongest, less confident. None: other."""

    def predict(self, text: str, lang: str | None) -> IntentResult:
        hits = keyword_hits(text)
        if not hits:
            return IntentResult("other", 0.0)
        ranked = sorted(hits.items(), key=lambda kv: kv[1], reverse=True)
        if len(ranked) == 1:
            return IntentResult(ranked[0][0], THRESHOLD_SINGLE)
        (best, top), (_, second) = ranked[0], ranked[1]
        if top == second:
            # booking beats date ("we'd like to book the 12th, are you free?")
            tied = {intent for intent, n in ranked if n == top}
            if tied == {"booking", "date"}:
                return IntentResult("booking", THRESHOLD_MULTI)
            return IntentResult(best, 0.3)
        return IntentResult(best, THRESHOLD_MULTI)
