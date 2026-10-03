"""Requested date and party size, read from tourist text by code (never by the LLM).

Covers English, German, French and Swahili, the demo languages. When the text is
unclear (two different dates, a US-or-European 03/04, conflicting head counts) the
result is marked ambiguous and W2 asks instead of guessing.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import date, timedelta

from sauti.lang.swahili import PEOPLE_UNITS, UNITS

MONTHS = {
    # en
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6, "july": 7,
    "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "sept": 9,
    "oct": 10, "nov": 11, "dec": 12,
    # de
    "januar": 1, "februar": 2, "marz": 3, "mai": 5, "juni": 6, "juli": 7, "oktober": 10, "dezember": 12,
    # fr (accents stripped)
    "janvier": 1, "fevrier": 2, "mars": 3, "avril": 4, "juin": 6, "juillet": 7, "aout": 8,
    "septembre": 9, "octobre": 10, "novembre": 11, "decembre": 12,
    # sw
    "januari": 1, "februari": 2, "machi": 3, "aprili": 4, "julai": 7, "agosti": 8, "oktoba": 10, "desemba": 12,
}

WEEKDAYS = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3, "friday": 4, "saturday": 5, "sunday": 6,
    "montag": 0, "dienstag": 1, "mittwoch": 2, "donnerstag": 3, "freitag": 4, "samstag": 5, "sonntag": 6,
    "lundi": 0, "mardi": 1, "mercredi": 2, "jeudi": 3, "vendredi": 4, "samedi": 5, "dimanche": 6,
    "jumatatu": 0, "jumanne": 1, "jumatano": 2, "alhamisi": 3, "ijumaa": 4, "jumamosi": 5, "jumapili": 6,
}

# Relative days, after accent stripping and joining multi-word forms.
RELATIVE = {
    "today": 0, "tomorrow": 1, "heute": 0, "morgen": 1, "ubermorgen": 2,
    "aujourd'hui": 0, "demain": 1, "apres-demain": 2, "leo": 0, "kesho": 1, "keshokutwa": 2,
}
# "Guten Morgen", "am Morgen" mean morning, not tomorrow.
_MORGEN_NOT_TOMORROW = {"guten", "am", "jeden", "den", "heute"}

NUMBER_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "ein": 1, "eine": 1, "eins": 1, "zwei": 2, "drei": 3, "vier": 4, "funf": 5, "sechs": 6,
    "sieben": 7, "acht": 8, "neun": 9, "zehn": 10, "elf": 11, "zwolf": 12,
    "un": 1, "une": 1, "deux": 2, "trois": 3, "quatre": 4, "cinq": 5, "sept": 7, "huit": 8,
    "neuf": 9, "dix": 10, "onze": 11, "douze": 12,
    **UNITS, **PEOPLE_UNITS, "kumi": 10,
}

# People nouns, grouped by who they count. Different groups add up (2 adults + 2 children).
PEOPLE_NOUNS = {
    "people": "all", "persons": "all", "person": "all", "guests": "all", "visitors": "all", "pax": "all",
    "personen": "all", "leute": "all", "gaste": "all", "besucher": "all",
    "personnes": "all", "personne": "all", "invites": "all", "visiteurs": "all",
    "watu": "all", "wageni": "all", "mtu": "all", "mgeni": "all",
    "adults": "adults", "adult": "adults", "erwachsene": "adults", "adultes": "adults", "adulte": "adults",
    "children": "children", "child": "children", "kids": "children", "kinder": "children", "kind": "children",
    "enfants": "children", "enfant": "children", "watoto": "children", "mtoto": "children",
}
# Phrases that introduce a head count: "we are 4", "group of 6", "wir sind 4", "nous sommes 4".
_GROUP_LEADS = [
    ("we", "are"), ("we're",), ("group", "of"), ("family", "of"), ("party", "of"), ("for",),
    ("wir", "sind"), ("zu",), ("gruppe", "von"), ("nous", "sommes"), ("pour",), ("groupe", "de"),
    ("sisi", "ni"), ("tuko",),
]
MAX_PARTY = 200


@dataclass(frozen=True)
class Parsed[T]:
    value: T | None
    ambiguous: bool = False


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.replace("après demain", "apres-demain").replace("apres demain", "apres-demain")
    text = text.replace("kesho kutwa", "keshokutwa")
    return text


def _tokens(text: str) -> list[str]:
    return re.findall(r"\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\.?|\d+|[a-z'][a-z'-]*", text)


def _future(d_month: int, d_day: int, ref: date, year: int | None) -> date | None:
    try:
        if year is not None:
            return date(year if year > 99 else 2000 + year, d_month, d_day)
        candidate = date(ref.year, d_month, d_day)
        return candidate if candidate >= ref else date(ref.year + 1, d_month, d_day)
    except ValueError:
        return None


def _ordinal(tok: str) -> int | None:
    m = re.fullmatch(r"(\d{1,2})(?:st|nd|rd|th|er|e|\.)?", tok)
    return int(m.group(1)) if m and 1 <= int(m.group(1)) <= 31 else None


def _numeric_dates(tok: str, ref: date, lang: str | None) -> tuple[list[date], bool]:
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", tok):
        try:
            return [date.fromisoformat(tok)], False
        except ValueError:
            return [], False
    m = re.fullmatch(r"(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\.?", tok)
    if not m:
        return [], False
    a, b = int(m.group(1)), int(m.group(2))
    year = int(m.group(3)) if m.group(3) else None
    # English writers may be American (month first): 03/04 cannot be decided.
    if lang == "en" and a <= 12 and b <= 12 and a != b:
        return [], True
    if b > 12 >= a:
        a, b = b, a  # 10/20 can only be month first
    d = _future(b, a, ref, year)
    return ([d] if d else []), False


def parse_date(text: str, received: date, lang: str | None = None) -> Parsed[date]:
    """The single tour date the tourist asks for, or ambiguous/None."""
    toks = _tokens(_normalize(text))
    found: set[date] = set()
    ambiguous = False
    for i, tok in enumerate(toks):
        nums, amb = _numeric_dates(tok, received, lang)
        found.update(nums)
        ambiguous |= amb
        # A month word only counts with a day number next to it, so "may we come" is not May.
        if tok in MONTHS:
            month = MONTHS[tok]
            # "12 October", "12th of October", "le 12 octobre", "tarehe 12 Oktoba"
            before = [t for t in toks[max(0, i - 2):i] if t != "of"]
            day = _ordinal(before[-1]) if before else None
            # "October 12", "Oktoba 12"
            if day is None and i + 1 < len(toks):
                day = _ordinal(toks[i + 1])
            year = None
            for t in toks[i + 1:i + 3]:
                if re.fullmatch(r"20\d{2}", t):
                    year = int(t)
            if day is not None and (d := _future(month, day, received, year)):
                found.add(d)
        elif tok in RELATIVE:
            if tok == "morgen" and i > 0 and toks[i - 1] in _MORGEN_NOT_TOMORROW:
                continue
            found.add(received + timedelta(days=RELATIVE[tok]))
        elif tok in WEEKDAYS:
            ahead = (WEEKDAYS[tok] - received.weekday()) % 7 or 7
            found.add(received + timedelta(days=ahead))
    if ambiguous or len(found) > 1:
        return Parsed(None, ambiguous=True)
    return Parsed(next(iter(found), None))


def _number(tok: str) -> int | None:
    if tok.isdigit():
        return int(tok)
    return NUMBER_WORDS.get(tok)


def parse_party_size(text: str) -> Parsed[int]:
    """Number of visitors. Adults and children add up; two different totals are ambiguous."""
    toks = _tokens(_normalize(text))
    by_group: dict[str, set[int]] = {}
    for i, tok in enumerate(toks):
        group = PEOPLE_NOUNS.get(tok)
        if group is None:
            continue
        # "4 people", "vier Personen"; Swahili puts the number after: "watu wanne", "watu 4"
        n = _number(toks[i - 1]) if i > 0 else None
        if n is None and i + 1 < len(toks):
            n = _number(toks[i + 1])
        if n is not None and 1 <= n <= MAX_PARTY:
            by_group.setdefault(group, set()).add(n)
    for lead in _GROUP_LEADS:
        k = len(lead)
        for i in range(len(toks) - k):
            if tuple(toks[i:i + k]) == lead and (n := _number(toks[i + k])) is not None and 1 <= n <= MAX_PARTY:
                # "for 4" alone is weak ("for 2 hours"): only kept if followed by a people noun or nothing
                nxt = toks[i + k + 1] if i + k + 1 < len(toks) else None
                if nxt in PEOPLE_NOUNS:
                    continue  # "we are 2 adults": already counted by its noun
                if lead in {("for",), ("pour",), ("zu",)} and nxt is not None and nxt not in PEOPLE_NOUNS:
                    continue
                by_group.setdefault("all", set()).add(n)
    if any(len(values) > 1 for values in by_group.values()):
        return Parsed(None, ambiguous=True)
    if "adults" in by_group or "children" in by_group:
        total = sum(next(iter(by_group.get(g, {0}))) for g in ("adults", "children"))
        if "all" in by_group and next(iter(by_group["all"])) != total:
            return Parsed(None, ambiguous=True)
        return Parsed(total)
    if "all" in by_group:
        return Parsed(next(iter(by_group["all"])))
    return Parsed(None)
