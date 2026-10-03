"""Check that generated text says nothing the farm sheet does not say.

Used on every listing text (Qwen output and each NLLB translation) before it
can become a proposal. Returns a list of problems; empty means the text passed.
It catches numbers, prices, times, weekdays, inflated group sizes and a list of
risky promises. It cannot judge free prose: Noor still approves every proposal.
"""

from __future__ import annotations

import re

from sauti.farm_sheet import FarmSheet
from sauti.lang import swahili as sw

_DAY_NAMES = {
    "mon": ("monday", "montag", "lundi"),
    "tue": ("tuesday", "dienstag", "mardi"),
    "wed": ("wednesday", "mittwoch", "mercredi"),
    "thu": ("thursday", "donnerstag", "jeudi"),
    "fri": ("friday", "freitag", "vendredi"),
    "sat": ("saturday", "samstag", "samedi"),
    "sun": ("sunday", "sonntag", "dimanche"),
}
_EVERY_DAY = ("every day", "daily", "7 days", "täglich", "jeden tag", "tous les jours", "chaque jour")
_MORE_THAN = (
    "more than", "over", "at least", "minimum", "mehr als", "über", "mindestens",
    "plus de", "au moins", "zaidi ya",
)
# Promises the farm sheet never contains. Matched as word prefixes.
_RISKY_CLAIMS = (
    "free", "gratis", "kostenlos", "gratuit", "bure",
    "discount", "rabatt", "réduction", "reduction", "punguzo",
    "guarantee", "garantie", "garanti",
    "organic", "bio", "biologique", "certif", "zertifiz", "award", "prize", "prix d",
    "pickup", "pick-up", "pick up", "transfer", "abholung", "navette", "hotel", "hôtel",
    "refund", "rückerstattung", "rembours", "wifi", "wi-fi", "vegan", "halal",
)

_TIME_PATTERNS = (
    re.compile(r"\b(\d{1,2})[:h.](\d{2})\b"),
    re.compile(r"\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)(?![a-z])", re.IGNORECASE),
    re.compile(r"\b(\d{1,2})\s*uhr\b", re.IGNORECASE),
)


def _extract_times(text: str) -> tuple[list[tuple[int, int]], str]:
    """All clock times as (hour, minute), and the text with them blanked out."""
    found: list[tuple[int, int]] = []

    def take(match: re.Match[str]) -> str:
        hour = int(match.group(1))
        minute = 0
        suffix = match.group(2) if match.lastindex and match.lastindex >= 2 else None
        if suffix and suffix[0].isdigit():
            minute = int(suffix)
        elif suffix and suffix.lower().startswith("p") and hour < 12:
            hour += 12
        elif suffix and suffix.lower().startswith("a") and hour == 12:
            hour = 0
        found.append((hour, minute))
        return " "

    for pattern in _TIME_PATTERNS:
        text = pattern.sub(take, text)
    return found, text


def _extract_integers(text: str) -> list[int]:
    text = re.sub(r"(?<=\d)[,.   ](?=\d{3}(?!\d))", "", text)  # 2,500 / 2.500 / 2 500
    return [int(n) for n in re.findall(r"\d+", text)]


def allowed_numbers(sheet: FarmSheet) -> set[int]:
    allowed: set[int] = set()
    if sheet.price_per_person_kes is not None:
        allowed.add(sheet.price_per_person_kes)
    if sheet.capacity_per_tour is not None:
        allowed.add(sheet.capacity_per_tour)
    for text in [sheet.directions_sw or "", *(sheet.inclusions_sw or [])]:
        allowed.update(sw.find_numbers(text))
        allowed.update(_extract_integers(text))
    return allowed


def check_text(text: str, sheet: FarmSheet) -> list[str]:
    problems: list[str] = []
    lowered = text.lower()

    times, rest = _extract_times(text)
    allowed_times = {(sheet.hours.start.hour, sheet.hours.start.minute), (sheet.hours.end.hour, sheet.hours.end.minute)} if sheet.hours else set()
    problems += [f"time {h:02d}:{m:02d} is not in the farm sheet" for h, m in times if (h, m) not in allowed_times]

    allowed = allowed_numbers(sheet)
    problems += [f"number {n} is not in the farm sheet" for n in _extract_integers(rest) if n not in allowed]

    if re.search(r"\d\s*\+", rest):
        problems.append("a number is followed by '+', the farm sheet gives maximums")
    if sheet.capacity_per_tour is not None:
        cap = str(sheet.capacity_per_tour)
        for phrase in _MORE_THAN:
            if re.search(rf"\b{re.escape(phrase)}\s+{cap}\b", lowered):
                problems.append(f"'{phrase} {cap}' inverts the maximum group size")

    days = set(sheet.days or [])
    for code, names in _DAY_NAMES.items():
        if code not in days and any(re.search(rf"\b{name}", lowered) for name in names):
            problems.append(f"{names[0]} is not a tour day")
    if len(days) < 7 and any(phrase in lowered for phrase in _EVERY_DAY):
        problems.append("says every day, but the farm is not open every day")

    for claim in _RISKY_CLAIMS:
        if re.search(rf"(?<![a-zà-ÿ]){re.escape(claim)}", lowered):
            problems.append(f"promise '{claim}' is not in the farm sheet")
    return problems
