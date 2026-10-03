"""W2 end to end: fetch -> ingest -> understand -> propose. Sending happens only
after Noor approves (approve.py) and at the next connectivity (outbox.py).
"""

from __future__ import annotations

import logging
import sqlite3
from collections.abc import Iterable
from dataclasses import dataclass

from sauti.farm_sheet import FarmSheet
from sauti.models.intent import IntentClassifier, KeywordIntentClassifier
from sauti.models.translate import LanguageDetector, NoTranslator, StopwordLanguageDetector, Translator
from sauti.transport.base import InboundChannel
from sauti.workflows.classify import understand
from sauti.workflows.ingest import Transcriber, ingest
from sauti.workflows.propose import Adapter, propose_for_message

log = logging.getLogger("sauti.w2")


@dataclass
class Models:
    """Everything W2 needs to understand and draft. Defaults need no model file."""

    detector: LanguageDetector
    translator: Translator
    classifier: IntentClassifier
    transcriber: Transcriber | None = None
    adapter: Adapter | None = None

    @classmethod
    def baseline(cls) -> Models:
        return cls(StopwordLanguageDetector(), NoTranslator(), KeywordIntentClassifier())


def process_inbox(
    conn: sqlite3.Connection, inboxes: Iterable[InboundChannel], sheet: FarmSheet, models: Models
) -> list[int]:
    """Pull every inbox, and create one proposal per new message. Returns the new proposal ids."""
    proposal_ids: list[int] = []
    for inbox in inboxes:
        message_ids = ingest(conn, inbox.fetch(), models.transcriber)
        for message_id in message_ids:
            u = understand(conn, message_id, models.detector, models.translator, models.classifier)
            proposal_ids.append(
                propose_for_message(conn, message_id, u, sheet, models.adapter, models.translator)
            )
            log.info("W2 message %s -> proposal %s", message_id, proposal_ids[-1])
    return proposal_ids
