"""W2 steps 4-6: compute the facts, pick a template, create a proposal (state PROPOSED).

Code decides which template applies and every value in it. The optional adapter
(Qwen) may only rephrase the rendered template; its output is kept only if it passes
`fact_check`, otherwise the plain template is used. The adapter never sees tourist text.

Fail-safe: low confidence, intent `other`, a question the farm sheet cannot answer, or
an unknown language gives a `needs_noor` proposal: no draft, Noor hears the message.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Protocol

from sauti.calendar import can_book, day_status
from sauti.farm_sheet import FarmSheet
from sauti.models.intent import IntentResult
from sauti.models.translate import Translator
from sauti.storage.states import OPEN_STATES, ProposalState, now_iso, transition
from sauti.workflows.classify import Understanding
from sauti.workflows.templates import (
    TEMPLATE_LANGS,
    Facts,
    TemplateKey,
    needs_noor_summary,
    noor_summary,
    render,
)

MIN_CONFIDENCE = 0.5

REPLY_CHANNEL = {
    "sms": "sms", "whatsapp": "whatsapp", "voicemail": "sms", "missed_call": "sms",
    # No public Airbnb messaging API, GetYourGuide messaging is in-app: Noor's daughter
    # pastes the approved text (assisted manual send).
    "email_airbnb": "airbnb_manual", "email_gyg": "gyg_manual", "gyg_api": "gyg_manual",
}

# Why there is no draft, said to Noor in Swahili.
REASONS_SW = {
    "unclear": "Sina uhakika mgeni anauliza nini.",
    "not_in_farm_sheet": "Swali hili halimo kwenye taarifa za shamba.",
    "language": "Sielewi lugha ya ujumbe huu.",
    "no_transcript": "Kuna ujumbe wa sauti ambao sikuweza kuuandika.",
    "calendar_unknown": "Sijui kama siku hiyo kuna nafasi.",
    "translation_unavailable": "Siwezi kutafsiri jibu kwa lugha ya mgeni.",
}

# Words an adapted reply may not add: they would change the deal.
_FORBIDDEN = re.compile(
    r"\b(free|gratis|kostenlos|gratuit|bure|discount|rabatt|r[ée]duction|punguzo|guarantee[d]?|garantie)\b",
    re.IGNORECASE,
)


class Adapter(Protocol):
    def adapt(self, text: str, lang: str) -> str | None:
        """Rephrase a rendered template in the same language, or None."""
        ...


@dataclass(frozen=True)
class Decision:
    kind: str  # reply, callback, needs_noor
    template: TemplateKey | None = None
    reason: str | None = None
    facts: Facts = field(default_factory=Facts)
    booking: bool = False


# ---------------------------------------------------------------- content and hash


def canonical(content: dict[str, Any]) -> str:
    return json.dumps(content, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def content_hash(content: dict[str, Any]) -> str:
    return hashlib.sha256(canonical(content).encode("utf-8")).hexdigest()


def _short_ids() -> Any:
    letters = [chr(c) for c in range(ord("A"), ord("Z") + 1)]
    yield from letters
    for a in letters:
        for b in letters:
            yield a + b


def allocate_short_id(conn: sqlite3.Connection) -> str:
    used = {
        r[0] for r in conn.execute(
            "SELECT short_id FROM proposals WHERE state IN (?, ?)", tuple(s.value for s in OPEN_STATES)
        )
    }
    return next(s for s in _short_ids() if s not in used)


# ---------------------------------------------------------------- fact check


def numbers_in(text: str) -> list[int]:
    text = re.sub(r"(?<=\d)[,.   ](?=\d{3}\b)", "", text)
    return [int(n) for n in re.findall(r"\d+", text)]


def fact_check(candidate: str, reference: str) -> bool:
    """True if `candidate` states exactly the numbers of `reference` and adds no deal-changing word."""
    if sorted(set(numbers_in(candidate))) != sorted(set(numbers_in(reference))):
        return False
    added = {m.lower() for m in _FORBIDDEN.findall(candidate)} - {m.lower() for m in _FORBIDDEN.findall(reference)}
    return not added


# ---------------------------------------------------------------- decision (code only)


def decide(channel: str, has_text: bool, u: Understanding, sheet: FarmSheet, status_of: Any) -> Decision:
    """Pick what to answer. `status_of(day)` returns the calendar DayStatus."""
    if channel == "missed_call":
        return Decision("callback", template="callback")
    if not has_text:
        return Decision("needs_noor", reason="no_transcript" if channel == "voicemail" else "unclear")
    if u.lang is None:
        return Decision("needs_noor", reason="language")
    if u.intent.intent == "other" or u.intent.confidence < MIN_CONFIDENCE:
        return Decision("needs_noor", reason="unclear")

    intent = u.intent.intent
    hours = sheet.hours
    if intent == "price":
        if sheet.price_per_person_kes is None:
            return Decision("needs_noor", reason="not_in_farm_sheet")
        party = u.party_size if not u.party_ambiguous else None
        if party:
            return Decision("reply", "price_total", facts=Facts(
                price_pp=sheet.price_per_person_kes, party_size=party, total=sheet.price_per_person_kes * party))
        return Decision("reply", "price", facts=Facts(price_pp=sheet.price_per_person_kes))

    if intent == "directions":
        if sheet.directions_sw is None:
            return Decision("needs_noor", reason="not_in_farm_sheet")
        return Decision("reply", "directions", facts=Facts(directions=sheet.directions_sw))

    # date and booking need the calendar
    if u.requested_date is None or u.date_ambiguous:
        return Decision("reply", "ask_details" if intent == "booking" else "ask_date")
    party = None if u.party_ambiguous else u.party_size
    if intent == "booking" and party is None:
        return Decision("reply", "ask_details")
    status = status_of(u.requested_date)
    base = Facts(day=u.requested_date, party_size=party)
    if status.open_day is None or status.capacity is None or hours is None:
        return Decision("needs_noor", reason="calendar_unknown")
    if status.open_day is False:
        return Decision("reply", "date_closed", facts=Facts(day=u.requested_date, open_days=tuple(sheet.days or ())))
    if status.blocked:
        return Decision("needs_noor", reason="calendar_unknown")
    if not can_book(status, party or 1):
        return Decision("reply", "date_full", facts=Facts(day=u.requested_date))
    timed = Facts(day=base.day, party_size=party, start=hours.start, end=hours.end, seats_left=status.seats_left)
    if intent == "date":
        if party is None:
            return Decision("reply", "ask_date")
        return Decision("reply", "date_open", facts=timed)
    if sheet.price_per_person_kes is None:
        return Decision("needs_noor", reason="not_in_farm_sheet")
    assert party is not None  # a booking without party size returned ask_details above
    return Decision("reply", "booking_offer", booking=True, facts=Facts(
        day=base.day, party_size=party, start=hours.start, end=hours.end,
        price_pp=sheet.price_per_person_kes, total=sheet.price_per_person_kes * party))


# ---------------------------------------------------------------- building the proposal


def _reply_lang(u: Understanding, decision: Decision) -> str:
    if decision.kind == "callback" and u.lang not in TEMPLATE_LANGS:
        return "en"
    return u.lang or "en"


def _localize_facts(decision: Decision, lang: str, translator: Translator | None) -> Facts | None:
    """Directions are stored in Swahili; other languages need NLLB, else None."""
    facts = decision.facts
    if decision.template != "directions" or lang == "sw":
        return facts
    translated = translator.translate(facts.directions or "", "sw", lang) if translator else None
    if not translated or not fact_check(translated, facts.directions or ""):
        return None
    return Facts(directions=translated)


def build_content(
    short_id: str,
    message: sqlite3.Row | tuple[Any, ...],
    u: Understanding,
    decision: Decision,
    adapter: Adapter | None = None,
    translator: Translator | None = None,
) -> dict[str, Any]:
    message_id, channel, sender_ref, text_original = message
    if decision.kind == "needs_noor":
        return _needs_noor(short_id, channel, u, decision.reason or "unclear", text_original)

    lang = _reply_lang(u, decision)
    if lang not in TEMPLATE_LANGS:
        return _needs_noor(short_id, channel, u, "translation_unavailable", text_original)
    facts = _localize_facts(decision, lang, translator)
    if facts is None:
        return _needs_noor(short_id, channel, u, "translation_unavailable", text_original)
    assert decision.template is not None
    plain = render(decision.template, lang, facts)
    body, adapted = plain, False
    if adapter is not None:
        candidate = adapter.adapt(plain, lang)
        if candidate and fact_check(candidate, plain):
            body, adapted = candidate.strip(), True
    return {
        "kind": decision.kind,
        "message_id": message_id,
        "template": decision.template,
        "lang": lang,
        "reply_channel": REPLY_CHANNEL[channel],
        "recipient_ref": sender_ref,
        "body": body,
        "adapted": adapted,
        "facts": facts.as_json(),
        "booking": (
            {"date": facts.day.isoformat(), "party_size": facts.party_size}
            if decision.booking and facts.day and facts.party_size else None
        ),
        "summary_sw": noor_summary(short_id, channel, u.lang, decision.template, facts),
    }


def _needs_noor(short_id: str, channel: str, u: Understanding, reason: str, original: str | None) -> dict[str, Any]:
    # Noor hears the Swahili translation when we have one, else the original words.
    text_for_noor = u.text_sw or original
    return {
        "kind": "needs_noor",
        "reason": reason,
        "lang": u.lang,
        "summary_sw": needs_noor_summary(short_id, channel, u.lang, REASONS_SW[reason], text_for_noor),
        "text_for_noor": text_for_noor,
        "text_is_translated": u.text_sw is not None,
    }


def _message(conn: sqlite3.Connection, message_id: int) -> tuple[Any, ...]:
    row = conn.execute(
        "SELECT id, channel, sender_ref, text_original FROM messages WHERE id = ?", (message_id,)
    ).fetchone()
    if row is None:
        raise KeyError(message_id)
    return tuple(row)


def propose_for_message(
    conn: sqlite3.Connection,
    message_id: int,
    u: Understanding,
    sheet: FarmSheet,
    adapter: Adapter | None = None,
    translator: Translator | None = None,
) -> int:
    """Create the proposal for one processed message and return its id (state PROPOSED)."""
    message = _message(conn, message_id)
    decision = decide(message[1], message[3] is not None, u, sheet, lambda d: day_status(conn, sheet, d))
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        short_id = allocate_short_id(conn)
        content = build_content(short_id, message, u, decision, adapter, translator)
        at = now_iso()
        cursor = conn.execute(
            "INSERT INTO proposals (short_id, kind, message_id, content, content_hash, state, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (short_id, content["kind"], message_id, canonical(content), content_hash(content),
             ProposalState.PROPOSED.value, at, at),
        )
        assert cursor.lastrowid is not None
        proposal_id = cursor.lastrowid
        conn.execute(
            "INSERT INTO proposal_events (proposal_id, from_state, to_state, note, at) VALUES (?, NULL, ?, ?, ?)",
            (proposal_id, ProposalState.PROPOSED.value, content.get("template") or content.get("reason"), at),
        )
    return proposal_id


def update_content(conn: sqlite3.Connection, proposal_id: int, new_content: dict[str, Any], note: str) -> bool:
    """Replace a proposal's content. Any change voids its approvals and sends it back to PROPOSED.
    Call inside the caller's transaction. Returns True if the content changed."""
    row = conn.execute("SELECT content_hash, state FROM proposals WHERE id = ?", (proposal_id,)).fetchone()
    if row is None:
        raise KeyError(proposal_id)
    old_hash, state = row
    new_hash = content_hash(new_content)
    if new_hash == old_hash:
        return False
    if ProposalState(state) not in OPEN_STATES:
        raise ValueError(f"proposal {proposal_id} is {state}, its content can no longer change")
    at = now_iso()
    conn.execute(
        "UPDATE approvals SET voided_at = ? WHERE proposal_id = ? AND voided_at IS NULL", (at, proposal_id)
    )
    if ProposalState(state) is ProposalState.APPROVED:
        transition(conn, proposal_id, ProposalState.PROPOSED, note=f"approval voided: {note}")
    conn.execute(
        "UPDATE proposals SET content = ?, content_hash = ?, kind = ?, version = version + 1, updated_at = ?"
        " WHERE id = ?",
        (canonical(new_content), new_hash, new_content["kind"], at, proposal_id),
    )
    return True


def refresh(
    conn: sqlite3.Connection, proposal_id: int, u: Understanding, sheet: FarmSheet,
    adapter: Adapter | None = None, translator: Translator | None = None,
) -> bool:
    """Recompute a proposal from today's farm sheet and calendar (e.g. its slot was just taken).
    Call inside the caller's transaction."""
    short_id, message_id = conn.execute(
        "SELECT short_id, message_id FROM proposals WHERE id = ?", (proposal_id,)
    ).fetchone()
    message = _message(conn, message_id)
    decision = decide(message[1], message[3] is not None, u, sheet, lambda d: day_status(conn, sheet, d))
    content = build_content(short_id, message, u, decision, adapter, translator)
    return update_content(conn, proposal_id, content, note="recomputed")


def understanding_from_db(conn: sqlite3.Connection, message_id: int) -> Understanding:
    """Rebuild the Understanding stored by classify.understand (no model call).
    Ambiguous values were stored as NULL, which `decide` treats the same way."""
    lang, text_sw, intent, conf, req_date, party = conn.execute(
        "SELECT lang, text_sw, intent, intent_confidence, requested_date, party_size FROM messages WHERE id = ?",
        (message_id,),
    ).fetchone()
    return Understanding(
        lang=lang, text_sw=text_sw, intent=IntentResult(intent or "other", conf or 0.0),
        requested_date=date.fromisoformat(req_date) if req_date else None, date_ambiguous=False,
        party_size=party, party_ambiguous=False,
    )
