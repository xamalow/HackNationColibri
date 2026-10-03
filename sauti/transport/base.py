"""Contract every external channel implements (CLAUDE.md §8, transport layer rule).

Inbound channels turn whatever arrives (SMS, WhatsApp, voicemail, missed call,
Airbnb or GetYourGuide notification e-mail, GetYourGuide API) into one
InboundMessage. Outbound channels send one approved message, identified by an
idempotency key, so a restart can never send it twice.

`simulated.py` is the default and makes the whole demo work in airplane mode.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Literal, Protocol

Channel = Literal[
    "sms", "whatsapp", "voicemail", "missed_call", "email_airbnb", "email_gyg", "gyg_api"
]
CHANNELS: frozenset[str] = frozenset(Channel.__args__)  # type: ignore[attr-defined]


@dataclass(frozen=True)
class Structured:
    """Fields a platform gives us in a fixed format, parsed by code. Trusted more than free text."""

    booking_ref: str | None = None
    requested_date: date | None = None
    party_size: int | None = None


@dataclass(frozen=True)
class InboundMessage:
    channel: Channel
    external_id: str
    sender_ref: str
    received_at: datetime
    text: str | None = None
    audio_path: Path | None = None
    lang: str | None = None  # set when the channel already knows it (e.g. Whisper)
    structured: Structured = field(default_factory=Structured)
    synthetic: bool = False


@dataclass(frozen=True)
class OutboundMessage:
    channel: str
    recipient_ref: str
    body: str
    idempotency_key: str


@dataclass(frozen=True)
class SendReceipt:
    transport_ref: str


class TransportError(Exception):
    """The channel refused the message. Counts as a failed attempt."""


class Offline(TransportError):
    """No connectivity (the normal state on weekdays). Not a failed attempt: try again later."""


class InboundChannel(Protocol):
    name: str

    def fetch(self) -> list[InboundMessage]:
        """Everything new since the last fetch. May return items seen before (ingest dedupes)."""
        ...


class OutboundChannel(Protocol):
    name: str

    def send(self, message: OutboundMessage) -> SendReceipt:
        """Send once. Raises TransportError on failure."""
        ...

    def was_sent(self, idempotency_key: str) -> bool | None:
        """True/False if the channel can tell, None if it cannot (then we never resend blindly)."""
        ...
