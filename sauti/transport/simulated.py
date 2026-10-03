"""Default transport: a synthetic inbox on disk and an outbox file. Works in airplane mode.

Inbox: every *.json file in the inbox folder holds one message or a list of them,
each marked "synthetic": true (we never present synthetic data as real).
Outbox: one JSON line per sent message, keyed by idempotency key.
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime
from pathlib import Path
from typing import Any

from sauti.transport.base import (
    CHANNELS,
    InboundMessage,
    Offline,
    OutboundMessage,
    SendReceipt,
    Structured,
)

log = logging.getLogger("sauti.transport.simulated")

MAX_FILE_BYTES = 1_000_000


def _parse_item(item: dict[str, Any], base_dir: Path) -> InboundMessage:
    channel = item["channel"]
    if channel not in CHANNELS:
        raise ValueError(f"unknown channel {channel!r}")
    if item.get("synthetic") is not True:
        raise ValueError("simulated inbox items must be marked synthetic")
    s = item.get("structured") or {}
    audio = item.get("audio_path")
    return InboundMessage(
        channel=channel,
        external_id=str(item["external_id"]),
        sender_ref=str(item["sender_ref"]),
        received_at=datetime.fromisoformat(item["received_at"]),
        text=item.get("text"),
        audio_path=(base_dir / audio) if audio else None,
        lang=item.get("lang"),
        structured=Structured(
            booking_ref=s.get("booking_ref"),
            requested_date=date.fromisoformat(s["requested_date"]) if s.get("requested_date") else None,
            party_size=int(s["party_size"]) if s.get("party_size") is not None else None,
        ),
        synthetic=True,
    )


class SimulatedInbox:
    name = "simulated_inbox"

    def __init__(self, folder: Path) -> None:
        self.folder = folder

    def fetch(self) -> list[InboundMessage]:
        messages: list[InboundMessage] = []
        for path in sorted(self.folder.glob("*.json")):
            if path.stat().st_size > MAX_FILE_BYTES:
                log.warning("skipping oversized inbox file %s", path.name)
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
            for item in data if isinstance(data, list) else [data]:
                try:
                    messages.append(_parse_item(item, path.parent))
                except (KeyError, ValueError, TypeError):
                    # A malformed item is skipped and logged, it never stops the inbox.
                    log.warning("skipping malformed item in %s", path.name, exc_info=True)
        return messages


class SimulatedOutbox:
    """Writes sent messages to a JSONL file. `online=False` behaves like airplane mode.

    Like a real SMS gateway it is NOT idempotent: sending twice writes twice. Only our
    outbox logic (SENDING marker + was_sent) prevents duplicates, and the tests prove it.
    """

    name = "simulated_outbox"

    def __init__(self, path: Path, online: bool = True) -> None:
        self.path = path
        self.online = online

    def _sent_keys(self) -> set[str]:
        if not self.path.exists():
            return set()
        keys = set()
        for line in self.path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                keys.add(json.loads(line)["idempotency_key"])
        return keys

    def send(self, message: OutboundMessage) -> SendReceipt:
        if not self.online:
            raise Offline("no connectivity")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "idempotency_key": message.idempotency_key,
            "channel": message.channel,
            "recipient_ref": message.recipient_ref,
            "body": message.body,
            "sent_at": datetime.now().astimezone().isoformat(),
        }
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        return SendReceipt(transport_ref=f"sim-{message.idempotency_key[:12]}")

    def was_sent(self, idempotency_key: str) -> bool | None:
        return idempotency_key in self._sent_keys()
