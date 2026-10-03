"""W2 steps 2-3: detect the language, translate for Noor, classify the intent, and
read the requested date and party size (by code). Results are stored on the message.

Structured fields from a platform (GetYourGuide/Airbnb e-mail or API) win over
what code reads in the free text.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date, datetime

from sauti.lang.extract import parse_date, parse_party_size
from sauti.models.intent import IntentClassifier, IntentResult
from sauti.models.translate import LanguageDetector, Translator


@dataclass(frozen=True)
class Understanding:
    lang: str | None
    text_sw: str | None
    intent: IntentResult
    requested_date: date | None
    date_ambiguous: bool
    party_size: int | None
    party_ambiguous: bool


def understand(
    conn: sqlite3.Connection,
    message_id: int,
    detector: LanguageDetector,
    translator: Translator,
    classifier: IntentClassifier,
) -> Understanding:
    row = conn.execute(
        "SELECT text_original, lang, received_at, requested_date, party_size FROM messages WHERE id = ?",
        (message_id,),
    ).fetchone()
    if row is None:
        raise KeyError(message_id)
    text, lang, received_at, structured_date, structured_party = row
    received = datetime.fromisoformat(received_at).date()

    if text is None:
        result = Understanding(lang, None, IntentResult("other", 0.0), None, False, None, False)
    else:
        if lang is None:
            lang, _ = detector.detect(text)
        text_sw = translator.translate(text, lang, "sw") if lang else None
        when = parse_date(text, received, lang)
        party = parse_party_size(text)
        result = Understanding(
            lang=lang,
            text_sw=text_sw,
            intent=classifier.predict(text, lang),
            requested_date=date.fromisoformat(structured_date) if structured_date else when.value,
            date_ambiguous=structured_date is None and when.ambiguous,
            party_size=structured_party if structured_party is not None else party.value,
            party_ambiguous=structured_party is None and party.ambiguous,
        )

    with conn:
        conn.execute(
            "UPDATE messages SET lang = ?, text_sw = ?, intent = ?, intent_confidence = ?,"
            " requested_date = ?, party_size = ?, state = 'PROCESSED' WHERE id = ?",
            (
                result.lang, result.text_sw, result.intent.intent, result.intent.confidence,
                result.requested_date.isoformat() if result.requested_date else None,
                result.party_size, message_id,
            ),
        )
    return result
