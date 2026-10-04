"""Language sidecar: which language is the caller speaking, and may we serve it?

Deterministic stopword scoring, no model. Target languages are the tenant's
(default sw, en). A near-Bantu look-alike (Kinyarwanda, Luganda, Lingala markers)
is "und" rather than "sw": Max's language-id rule (langid r2) is that refusing a
look-alike beats guessing. "und" or an unsupported language means: ask a person,
do not improvise. The speaker reads the advice; it does not switch policy on it.
"""

from __future__ import annotations

import re

from .base import Advice, SidecarContext, Turn

SW = {"na", "ya", "wa", "ni", "kwa", "la", "za", "cha", "vya", "sana", "habari", "asante", "ndiyo", "hapana", "tafadhali", "watu", "siku", "saa", "shilingi", "kesho", "leo", "jumamosi", "jumapili", "jumatatu", "jumanne", "jumatano", "alhamisi", "ijumaa", "ziara", "shamba", "nataka", "ninataka", "tunataka", "kuja", "kutembelea", "bei", "ngapi", "wapi", "lini", "mimi", "sisi", "wewe", "yeye", "hii", "hiyo", "hapa", "pale", "nzuri", "mbili", "tatu", "nne", "tano", "wawili", "watatu", "wanne", "mtu", "mgeni", "wageni", "karibu", "samahani", "sawa"}
EN = {"the", "and", "to", "for", "we", "i", "you", "would", "like", "book", "booking", "visit", "people", "persons", "guests", "please", "thanks", "thank", "hello", "hi", "can", "could", "want", "on", "at", "is", "are", "of", "a", "an", "it", "this", "that", "how", "much", "many", "when", "where", "what", "tomorrow", "today", "saturday", "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "two", "three", "four", "five", "farm", "tour", "price", "time", "open", "yes", "no"}
FR = {"le", "la", "les", "nous", "vous", "je", "voudrais", "réserver", "visite", "personnes", "bonjour", "merci", "demain", "samedi", "dimanche", "pour", "est", "une", "des", "s'il", "plaît", "combien"}
DE = {"wir", "ich", "möchten", "möchte", "buchen", "besuch", "personen", "hallo", "danke", "morgen", "samstag", "sonntag", "für", "ist", "eine", "der", "die", "das", "und", "bitte", "wie", "viel"}
# Markers of neighbouring Bantu languages that share many short words with Swahili. Any hit = und, not sw.
# Kinyarwanda, Luganda, Lingala, and Kikuyu with and without diacritics (Nat, 2026-10-04: "Ni wega muno, ningwenda
# guceerera mugunda wa kahua Jumamosi" scored sw on two stopwords).
LOOKALIKE = {
    "murakoze", "mwaramutse", "ni iki", "ndashaka", "nnyabo", "ssebo", "webale", "nkwagala", "mbote", "nalingi", "yambi", "ndeko", "muraho", "amakuru", "oyo", "kati",
    "ni wega", "nĩ wega", "wega muno", "wega mũno", "ningwenda", "nĩngwenda", "ngwenda", "guceerera", "gũceerera", "mugunda", "mũgũnda", "kahua", "kahũa", "wi mwega", "wĩ mwega", "uhoro waku", "ũhoro waku", "thengiu", "thengiũ", "ni kuga", "nĩ kũga", "ngai", "mwathani",
    # the letters ĩ and ũ exist in Kikuyu orthography and not in Swahili: any occurrence is a look-alike signal (Nat, #47788)
    "ĩ", "ũ",
}

WORD = re.compile(r"[\w']+", re.UNICODE)


def detect(text: str) -> tuple[str, float]:
    """(language, confidence). 'und' when there is not enough signal or a look-alike marker appears."""
    low = text.lower()
    if any(m in low for m in LOOKALIKE):
        return "und", 0.0
    toks = WORD.findall(low)
    if not toks:
        return "und", 0.0
    scores = {"sw": sum(t in SW for t in toks), "en": sum(t in EN for t in toks), "fr": sum(t in FR for t in toks), "de": sum(t in DE for t in toks)}
    best = max(scores, key=scores.get)  # type: ignore[arg-type]
    hits = scores[best]
    if hits == 0:
        return "und", 0.0
    second = sorted(scores.values(), reverse=True)[1]
    if hits == second and len(toks) < 6:
        return "und", 0.3
    conf = min(1.0, hits / max(2.0, len(toks) * 0.35))
    return (best, conf) if conf >= 0.4 or hits >= 2 else ("und", conf)


class LanguageSidecar:
    name = "language"

    async def run(self, turn: Turn, ctx: SidecarContext) -> Advice | None:
        lang, conf = detect(turn.text)
        supported = tuple(ctx.settings.languages)
        if lang == "und":
            return Advice(self.name, "Language unclear (und): ask the caller to repeat in Swahili or English; if still unclear say 'Muulize mtu' and offer a callback. Do not guess.", {"lang": "und", "confidence": round(conf, 2), "action": "ask_a_person_if_persists"})
        if lang not in supported:
            return Advice(self.name, f"Caller is speaking {lang}, which this hub does not serve. Say, in English then Swahili, that a person will call back; take no booking details in {lang}.", {"lang": lang, "confidence": round(conf, 2), "action": "unsupported_language"})
        return Advice(self.name, f"Caller language: {lang} (confidence {conf:.2f}). Answer in {lang}.", {"lang": lang, "confidence": round(conf, 2), "action": "ok"})
