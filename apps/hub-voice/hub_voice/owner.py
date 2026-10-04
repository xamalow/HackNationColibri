"""Owner mode: Noor calls the farm number herself.

Max's plan: the office agent "should always be able to answer Noor if she calls
or sends a text message (answer in her language), for any requests". Caller ID
selects WHAT the agent talks about (her pending requests, the feedback summary,
her schedule) and the language. It grants NOTHING: nothing said by voice
approves, confirms, closes or changes anything. Every change Noor asks for
becomes a proposal the hub reads back to her ENROLLED phone with a one-time code
(core r4 issueApprovalCode), exactly like a tourist's request. So a spoofed
caller id hears summaries without visitor names or numbers and can cause, at
most, a read-back SMS to Noor's real phone.

The number itself is never stored: only a sha256 is compared, in memory, and
the blackboard records the mode, not the id.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Literal

from .hubclient import HubReadOnly

Mode = Literal["tourist", "owner"]

E164 = re.compile(r"^\+?\d{7,15}$")  # E.164 or a local format with a leading 0; the hub owns the real mapping


def normalize_number(raw: str | None) -> str | None:
    """'+254 700 000 002' / 'tel:+254700000002' / '0700000002' -> digits with a leading + when present; None when not a number."""
    if not raw:
        return None
    s = raw.strip()
    if s.lower().startswith("tel:"):
        s = s[4:]
    s = s.split("@", 1)[0]  # sip:+2547...@host
    if s.lower().startswith("sip:"):
        s = s[4:]
    s = re.sub(r"[\s().-]", "", s)
    return s if E164.match(s) else None


def number_hash(number: str) -> str:
    return hashlib.sha256(number.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class CallerClassification:
    mode: Mode
    reason: str


async def classify_caller(raw_caller_id: str | None, hub: HubReadOnly) -> CallerClassification:
    """Owner mode iff the hub (or the fixture) recognises the sha256 of the normalised caller id. Any doubt = tourist."""
    number = normalize_number(raw_caller_id)
    if number is None:
        return CallerClassification("tourist", "no_caller_id")
    try:
        matched = await hub.owner_match(number_hash(number))
    except Exception as exc:  # noqa: BLE001 - a lookup that fails in any way is a tourist call
        return CallerClassification("tourist", f"owner_lookup_failed:{type(exc).__name__}")
    if matched is not True:  # only a literal True from the hub client; never truthiness
        return CallerClassification("tourist", "not_enrolled")
    return CallerClassification("owner", "enrolled_number_hash")


OWNER_CHANGE_KINDS = ("running_late", "close_day", "open_day", "capacity", "message_to_visitor", "other")
