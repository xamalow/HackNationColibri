"""Shared fixtures for the W2 and core tests (not a conftest, to stay out of other lanes' way)."""

from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, time, timezone
from pathlib import Path

from sauti.farm_sheet import FarmSheet, OpeningHours
from sauti.storage import db
from sauti.transport.base import InboundMessage, OutboundMessage, SendReceipt, Structured
from sauti.workflows.answer_tourist import Models, process_inbox

SHEET = FarmSheet(
    price_per_person_kes=2000,
    capacity_per_tour=10,
    days=["mon", "tue", "wed", "thu", "fri", "sat"],
    hours=OpeningHours(start=time(9, 0), end=time(15, 0)),
    directions_sw="Kutoka soko la Othaya fuata barabara ya kanisa kilomita mbili",
    inclusions_sw=["kahawa"],
)
MONDAY = date(2026, 10, 5)
THURSDAY_15 = date(2026, 10, 15)
SUNDAY_18 = date(2026, 10, 18)


def connect(path: Path | str = ":memory:") -> sqlite3.Connection:
    return db.connect(path)


def msg(text: str | None, ext: str = "t-1", channel: str = "sms", **structured: object) -> InboundMessage:
    return InboundMessage(
        channel=channel,  # type: ignore[arg-type]
        external_id=ext,
        sender_ref=f"+00-SYNTH-{ext}",
        received_at=datetime(2026, 10, 5, 8, 0, tzinfo=timezone.utc),
        text=text,
        structured=Structured(**structured),  # type: ignore[arg-type]
        synthetic=True,
    )


class ListInbox:
    name = "list_inbox"

    def __init__(self, messages: list[InboundMessage]) -> None:
        self.messages = messages

    def fetch(self) -> list[InboundMessage]:
        return list(self.messages)


def propose_one(conn: sqlite3.Connection, text: str | None, ext: str = "t-1", sheet: FarmSheet = SHEET,
                channel: str = "sms", **structured: object) -> tuple[int, str, str, dict]:
    """Run W2 on one message: (proposal id, short id, content hash, content)."""
    [pid] = process_inbox(conn, [ListInbox([msg(text, ext, channel, **structured)])], sheet, Models.baseline())
    return proposal(conn, pid)


def proposal(conn: sqlite3.Connection, pid: int) -> tuple[int, str, str, dict]:
    short_id, h, content = conn.execute(
        "SELECT short_id, content_hash, content FROM proposals WHERE id = ?", (pid,)
    ).fetchone()
    return pid, short_id, h, json.loads(content)


def state(conn: sqlite3.Connection, pid: int) -> str:
    return conn.execute("SELECT state FROM proposals WHERE id = ?", (pid,)).fetchone()[0]


class RecordingTransport:
    """Outbound fake: records sends, can be offline, failing, or unable to answer was_sent."""

    name = "recording"

    def __init__(self, online: bool = True, fail: bool = False, knows: bool = True) -> None:
        self.online, self.fail, self.knows = online, fail, knows
        self.sent: list[OutboundMessage] = []

    def send(self, message: OutboundMessage) -> SendReceipt:
        from sauti.transport.base import Offline, TransportError

        if not self.online:
            raise Offline("offline")
        if self.fail:
            raise TransportError("refused")
        self.sent.append(message)  # not idempotent, like a real SMS gateway
        return SendReceipt(transport_ref="rec")

    def was_sent(self, idempotency_key: str) -> bool | None:
        if not self.knows:
            return None
        return any(m.idempotency_key == idempotency_key for m in self.sent)
