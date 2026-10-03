"""W2 step 1: store every inbound item (state RECEIVED) before any model touches it.

Inbound text is untrusted: it is cleaned, size-limited and stored as data. A
message seen twice (same channel and external id) is stored once. Voicemails are
transcribed locally (Whisper) when a transcriber is available.
"""

from __future__ import annotations

import logging
import re
import sqlite3
from pathlib import Path
from typing import Protocol

from sauti.transport.base import CHANNELS, InboundMessage

log = logging.getLogger("sauti.w2.ingest")

MAX_TEXT_CHARS = 2000
MAX_REF_CHARS = 200
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]")


class Transcriber(Protocol):
    def transcribe(self, audio_path: Path) -> tuple[str, str | None]:
        """(transcript, detected ISO 639-1 language or None)."""
        ...


class InvalidMessage(ValueError):
    pass


def clean_text(text: str | None) -> str | None:
    """Drop control and bidi-override characters, collapse blank runs, cap the length."""
    if text is None:
        return None
    text = _CONTROL.sub("", text).replace("\r\n", "\n")
    text = re.sub(r"[ \t]+", " ", text).strip()
    return text[:MAX_TEXT_CHARS] or None


def _validate(msg: InboundMessage) -> None:
    if msg.channel not in CHANNELS:
        raise InvalidMessage(f"unknown channel {msg.channel!r}")
    for name, value in (("external_id", msg.external_id), ("sender_ref", msg.sender_ref)):
        if not value or len(value) > MAX_REF_CHARS or _CONTROL.search(value):
            raise InvalidMessage(f"bad {name}")
    if msg.channel != "missed_call" and msg.text is None and msg.audio_path is None:
        raise InvalidMessage("message has neither text nor audio")
    if msg.structured.party_size is not None and not 1 <= msg.structured.party_size <= 200:
        raise InvalidMessage("party size out of range")


def _transcribe(msg: InboundMessage, transcriber: Transcriber | None) -> tuple[str | None, str | None]:
    if msg.audio_path is None or msg.text is not None or transcriber is None:
        return msg.text, msg.lang
    try:
        text, lang = transcriber.transcribe(msg.audio_path)
        return text, lang or msg.lang
    except Exception:
        # Noor will hear "voicemail I could not transcribe", the trace goes to the log only.
        log.exception("transcription failed for %s/%s", msg.channel, msg.external_id)
        return None, msg.lang


def ingest(
    conn: sqlite3.Connection, messages: list[InboundMessage], transcriber: Transcriber | None = None
) -> list[int]:
    """Store new messages in state RECEIVED and return their ids. Duplicates and invalid items are skipped."""
    new_ids: list[int] = []
    for msg in messages:
        try:
            _validate(msg)
        except InvalidMessage as exc:
            log.warning("rejected inbound %s item: %s", msg.channel, exc)
            continue
        exists = conn.execute(
            "SELECT 1 FROM messages WHERE channel = ? AND external_id = ?", (msg.channel, msg.external_id)
        ).fetchone()
        if exists:
            continue
        text, lang = _transcribe(msg, transcriber)
        s = msg.structured
        with conn:
            cursor = conn.execute(
                "INSERT OR IGNORE INTO messages (channel, external_id, sender_ref, received_at, text_original,"
                " audio_path, lang, requested_date, party_size, booking_ref, synthetic, state)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED')",
                (
                    msg.channel, msg.external_id, msg.sender_ref, msg.received_at.isoformat(),
                    clean_text(text), str(msg.audio_path) if msg.audio_path else None, lang,
                    s.requested_date.isoformat() if s.requested_date else None, s.party_size,
                    s.booking_ref, int(msg.synthetic),
                ),
            )
        if cursor.rowcount == 1 and cursor.lastrowid is not None:
            new_ids.append(cursor.lastrowid)
    return new_ids
