"""Booking sidecar: deterministic facts from the caller's words, plus the calendar.

The date, party size and time come from code (the Python W1 reference parsers in
sauti.lang.swahili and a small English layer), each with the exact quote it came
from. Availability comes from the hub, whose calendar check is @sauti/core's
checkCapacity (confirmed seats against the farm sheet capacity); in simulated mode
a local fixture applies the same rule. The advice never says "booked": the speaker
may only FILE A REQUEST that Noor approves.
"""

from __future__ import annotations

import re
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from ..hubclient import HubError
from .base import Advice, SidecarContext, Turn

_REPO = Path(__file__).resolve().parents[4]
if str(_REPO) not in sys.path:  # the Python reference lives at the repo root (sauti/)
    sys.path.insert(0, str(_REPO))

from sauti.lang.swahili import WEEKDAYS, find_numbers, find_times, parse_days  # noqa: E402

EN_PEOPLE = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "a couple": 2, "couple": 2}
PEOPLE_CUES_EN = re.compile(r"\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|a couple|couple)\s+(?:of\s+us|people|persons?|guests?|adults?|visitors?|pax)\b", re.I)
PEOPLE_CUES_SW = re.compile(r"\b(watu|wageni|mtu|mgeni)\s+([\w']+)(?:\s+na\s+([\w']+))?", re.I)
ISO = re.compile(r"\b(20\d{2})-(\d{2})-(\d{2})\b")
DAY_OF_MONTH_SW = re.compile(r"\btarehe\s+(\d{1,2}|[\w']+)\b", re.I)
RELATIVE = {"leo": 0, "today": 0, "kesho": 1, "tomorrow": 1, "kesho kutwa": 2, "day after tomorrow": 2}
DAY_WORDS_RE = re.compile(r"\b(jumatatu|jumanne|jumatano|alhamisi|ijumaa|jumamosi|jumapili|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", re.I)


def _quote(text: str, pattern: re.Pattern[str] | str) -> str | None:
    if isinstance(pattern, str):
        i = text.lower().find(pattern.lower())
        return text[i : i + len(pattern)] if i >= 0 else None
    m = pattern.search(text)
    return m.group(0) if m else None


def parse_party_size(text: str) -> tuple[int, str] | None:
    m = PEOPLE_CUES_EN.search(text)
    if m:
        raw = m.group(1).lower()
        n = int(raw) if raw.isdigit() else EN_PEOPLE.get(raw)
        if n:
            return n, m.group(0)
    m = PEOPLE_CUES_SW.search(text)
    if m:
        span = m.group(0)
        nums = find_numbers(span)
        if nums:
            return nums[0], span
    return None


def resolve_date(text: str, today: date) -> tuple[date, str] | None:
    """The first date the caller named: ISO, relative word, weekday (next occurrence), or 'tarehe N' (this or next month)."""
    low = text.lower()
    m = ISO.search(text)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3))), m.group(0)
        except ValueError:
            return None
    for word in sorted(RELATIVE, key=len, reverse=True):
        if re.search(rf"\b{re.escape(word)}\b", low):
            return today + timedelta(days=RELATIVE[word]), _quote(text, word) or word
    m = DAY_WORDS_RE.search(text)
    if m:
        days = parse_days(m.group(0))
        if days:
            target = WEEKDAYS.index(days[0])
            delta = (target - today.weekday()) % 7 or 7  # "Jumamosi" said on a Saturday means next Saturday
            return today + timedelta(days=delta), m.group(0)
    m = DAY_OF_MONTH_SW.search(text)
    if m:
        raw = m.group(1)
        n = int(raw) if raw.isdigit() else (find_numbers(raw) or [0])[0]
        if 1 <= n <= 31:
            for month_shift in (0, 1):
                y, mo = today.year, today.month + month_shift
                if mo == 13:
                    y, mo = y + 1, 1
                try:
                    d = date(y, mo, n)
                except ValueError:
                    continue
                if d >= today:
                    return d, m.group(0)
    return None


class BookingSidecar:
    name = "booking"

    def __init__(self, today: date | None = None) -> None:
        self._today = today

    async def run(self, turn: Turn, ctx: SidecarContext) -> Advice | None:
        today = self._today or date.fromtimestamp(ctx.now_ms / 1000)
        facts: dict[str, Any] = {}
        quotes: list[dict[str, str]] = []
        party = parse_party_size(turn.text)
        if party:
            facts["party_size"] = party[0]
            quotes.append({"field": "party_size", "quote": party[1]})
        when = resolve_date(turn.text, today)
        if when:
            facts["date"] = when[0].isoformat()
            quotes.append({"field": "date", "quote": when[1]})
        times = find_times(turn.text)
        if times:
            facts["time"] = times[0].strftime("%H:%M")
        if not facts:
            return None
        parts: list[str] = []
        data: dict[str, Any] = {"facts": facts, "quotes": quotes}
        if "party_size" in facts:
            parts.append(f"party {facts['party_size']}")
        if "date" in facts:
            try:
                av = await ctx.hub.availability(facts["date"])
                data["availability"] = av.as_dict()
                if not av.open:
                    parts.append(f"{facts['date']}: farm CLOSED that day; offer the nearest open day")
                elif av.remaining <= 0:
                    parts.append(f"{facts['date']}: FULL (0 of {av.capacity} left); offer another day")
                elif "party_size" in facts and facts["party_size"] > av.remaining:
                    parts.append(f"{facts['date']}: only {av.remaining} of {av.capacity} seats left, party is {facts['party_size']}; offer a smaller group or another day")
                else:
                    parts.append(f"{facts['date']}: {av.remaining} of {av.capacity} seats free; you may FILE A REQUEST (Noor confirms, never you)")
            except HubError as exc:
                data["availability_error"] = str(exc)
                parts.append(f"{facts['date']}: availability unknown ({exc}); take the request, say Noor will confirm")
        if "time" in facts:
            parts.append(f"time mentioned {facts['time']} (check farm hours)")
        return Advice(self.name, "; ".join(parts), data)
