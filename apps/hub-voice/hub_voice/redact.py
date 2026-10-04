"""Redaction for everything that is recorded: phone numbers, one-time codes, e-mail.

The blackboard is for the record and for the demo screen, so it must never hold a
caller's number or an approval code. Numbers that matter for the booking (party
size, price, date) live in typed fact fields the parsers fill; free text is
redacted wholesale. Losing "2000" in a transcript line is the price of never
leaking a code.
"""

from __future__ import annotations

import re
from typing import Any

# 7+ digits with optional separators, optional +: phone numbers in any local format. A sentence-final period or a
# code at the start of a sentence must still match (Nat, 2026-10-04: "NDIYO A 482193." is normal STT output); only a
# decimal point between digits ("3.14159") is excluded.
PHONE = re.compile(r"(?<!\w)(?<!\d\.)\+?(?:\d[\s().-]{0,3}){7,15}\d(?!\w)(?!\.\d)")
# A standalone group of 4 to 8 digits: approval codes (the hub issues 6 by default, 4..8).
CODE = re.compile(r"(?<!\w)(?<!\d\.)\d(?:[ ]?\d){3,7}(?!\w)(?!\.\d)")
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
# Years are the one 4-digit group worth keeping in prose ("2026-10-11").
ISO_DATE = re.compile(r"\b(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b")

PHONE_MARK = "[number]"
CODE_MARK = "[code]"
EMAIL_MARK = "[email]"
DATE_KEEP = "\u0000DATE\u0000"


def redact_text(text: str) -> str:
    """Replace phone numbers, codes and e-mail addresses in free text."""
    if not text:
        return text
    kept: list[str] = []

    def keep(m: re.Match[str]) -> str:
        kept.append(m.group(0))
        return f"{DATE_KEEP}{len(kept) - 1}{DATE_KEEP}"

    out = ISO_DATE.sub(keep, text)
    out = EMAIL.sub(EMAIL_MARK, out)
    out = PHONE.sub(PHONE_MARK, out)
    out = CODE.sub(CODE_MARK, out)
    for i, date in enumerate(kept):
        out = out.replace(f"{DATE_KEEP}{i}{DATE_KEEP}", date)
    return out


# Typed fact fields that may hold numbers (filled by parsers, not by free text).
NUMERIC_FACT_KEYS = frozenset({"party_size", "price_kes", "remaining", "capacity", "confirmed", "seq", "t_ms", "budget_ms", "elapsed_ms", "attempt", "count", "misunderstandings", "year", "month", "day", "hour", "minute"})


def redact_value(value: Any, key: str | None = None) -> Any:
    """Recursively redact strings inside any JSON-like value. Numbers in known fact fields pass; other ints are kept (they are not text)."""
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, dict):
        return {k: redact_value(v, k) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact_value(v, key) for v in value]
    return value


def contains_secret_shape(text: str) -> bool:
    """True if the text still looks like it carries a phone number or a code (used by tests and the sink)."""
    probe = ISO_DATE.sub("", text)
    return bool(PHONE.search(probe) or CODE.search(probe) or EMAIL.search(probe))
