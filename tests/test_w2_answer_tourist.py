"""W2 behaviour: parsing by code, fixed templates, fact check, fail-safes, demo inbox end to end."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from sauti.lang.extract import parse_date, parse_party_size
from sauti.transport.simulated import SimulatedInbox
from sauti.workflows import ingest as ingest_mod
from sauti.workflows.answer_tourist import Models, process_inbox
from sauti.workflows.propose import fact_check
from tests.w2_helpers import MONDAY, SHEET, ListInbox, connect, msg, propose_one

ROOT = Path(__file__).resolve().parent.parent
SAT_3 = date(2026, 10, 3)


# ---------------------------------------------------------------- parsing (code, not LLM)

@pytest.mark.parametrize("text,lang,expected", [
    ("Can we visit on October 12?", "en", date(2026, 10, 12)),
    ("am 15. Oktober", "de", date(2026, 10, 15)),
    ("le 10 octobre", "fr", date(2026, 10, 10)),
    ("tarehe 12 Oktoba", "sw", date(2026, 10, 12)),
    ("tomorrow please", "en", date(2026, 10, 4)),
    ("Guten Morgen, geht es morgen?", "de", date(2026, 10, 4)),
    ("2026-11-02", None, date(2026, 11, 2)),
    ("on 10/20", "en", date(2026, 10, 20)),
    ("on 20/10", "en", date(2026, 10, 20)),
    ("January 5", "en", date(2027, 1, 5)),  # past this year -> next year
])
def test_parse_date(text, lang, expected):
    assert parse_date(text, SAT_3, lang).value == expected


@pytest.mark.parametrize("text,lang", [
    ("Can we come 03/04?", "en"),           # US or European? ask
    ("Saturday or Sunday?", "en"),          # two dates
])
def test_ambiguous_dates_are_not_guessed(text, lang):
    parsed = parse_date(text, SAT_3, lang)
    assert parsed.value is None and parsed.ambiguous


@pytest.mark.parametrize("text,expected", [
    ("for 4 people", 4),
    ("wir sind drei", 3),
    ("nous sommes deux adultes et deux enfants", 4),
    ("watu wanne", 4),
    ("2 adults and 1 child", 3),
    ("a tour for 2 hours", None),
])
def test_parse_party_size(text, expected):
    assert parse_party_size(text).value == expected


def test_conflicting_party_sizes_are_ambiguous():
    assert parse_party_size("we are 4 people, sorry 5 people").ambiguous


# ---------------------------------------------------------------- fact check

def test_fact_check_rejects_changed_or_added_numbers_and_deal_words():
    ref = "Our tour costs 2000 KES per person, so 8000 KES for 4 people."
    assert fact_check("Karibu! The tour is 2,000 KES per person: 8000 KES for 4 people.", ref)
    assert not fact_check("The tour is 2000 KES per person: 6000 KES for 4 people.", ref)
    assert not fact_check("The tour is 2000 KES per person, 8000 KES for 4 people, 10% off.", ref)
    assert not fact_check("The tour is free! 2000 KES per person, 8000 KES for 4 people.", ref)


class _LyingAdapter:
    def adapt(self, text: str, lang: str) -> str | None:
        return text.replace("8000", "4000")


class _PoliteAdapter:
    def adapt(self, text: str, lang: str) -> str | None:
        return "Karibu sana! " + text


def test_adapter_output_that_changes_a_fact_is_dropped():
    conn = connect()
    models = Models.baseline()
    models.adapter = _LyingAdapter()
    [pid] = process_inbox(conn, [ListInbox([msg("How much for 4 people?")])], SHEET, models)
    body, = conn.execute("SELECT json_extract(content, '$.body') FROM proposals WHERE id = ?", (pid,)).fetchone()
    assert "8000" in body and "4000" not in body


def test_adapter_output_that_keeps_the_facts_is_used():
    conn = connect()
    models = Models.baseline()
    models.adapter = _PoliteAdapter()
    [pid] = process_inbox(conn, [ListInbox([msg("How much for 4 people?")])], SHEET, models)
    body, adapted = conn.execute(
        "SELECT json_extract(content, '$.body'), json_extract(content, '$.adapted') FROM proposals WHERE id = ?",
        (pid,),
    ).fetchone()
    assert body.startswith("Karibu sana!") and adapted == 1


# ---------------------------------------------------------------- fail-safes

@pytest.mark.parametrize("text,reason", [
    ("Do you have vegetarian lunch options?", "unclear"),
    ("asdkj qwe zzz", "language"),
])
def test_no_draft_when_unsure(text, reason):
    _, _, _, content = propose_one(connect(), text)
    assert content["kind"] == "needs_noor" and content["reason"] == reason
    assert "body" not in content
    assert content["text_for_noor"] == text  # Noor hears the message itself


def test_question_not_in_farm_sheet_gets_no_draft():
    from sauti.farm_sheet import FarmSheet

    no_price = FarmSheet(**{**SHEET.model_dump(), "price_per_person_kes": None})
    _, _, _, content = propose_one(connect(), "How much does it cost?", sheet=no_price)
    assert content["reason"] == "not_in_farm_sheet"


def test_directions_without_translation_model_go_to_noor_but_swahili_works():
    conn = connect()
    _, _, _, fr = propose_one(conn, "Bonjour, comment venir à la ferme ?", ext="fr")
    assert fr["kind"] == "needs_noor" and fr["reason"] == "translation_unavailable"
    _, _, _, sw = propose_one(conn, "Habari, njia ya kufika shamba ni ipi? Tafadhali", ext="sw")
    assert sw["template"] == "directions" and SHEET.directions_sw in sw["body"]


def test_missed_call_gets_a_callback_proposal_not_a_send():
    _, _, _, content = propose_one(connect(), None, channel="missed_call")
    assert content["kind"] == "callback" and content["reply_channel"] == "sms"


def test_untranscribed_voicemail_goes_to_noor():
    conn = connect()
    from sauti.transport.base import InboundMessage

    vm = InboundMessage(channel="voicemail", external_id="vm1", sender_ref="+00-SYNTH-vm",
                        received_at=msg("x").received_at, audio_path=Path("missing.wav"), synthetic=True)
    [pid] = process_inbox(conn, [ListInbox([vm])], SHEET, Models.baseline())
    reason, = conn.execute("SELECT json_extract(content, '$.reason') FROM proposals WHERE id = ?", (pid,)).fetchone()
    assert reason == "no_transcript"


# ---------------------------------------------------------------- ingest

def test_ingest_dedupes_and_cleans_untrusted_text():
    conn = connect()
    dirty = msg("Hi\u202e there\x00, price for 2 people?", ext="d1")
    assert len(ingest_mod.ingest(conn, [dirty, dirty])) == 1
    assert ingest_mod.ingest(conn, [dirty]) == []
    text, = conn.execute("SELECT text_original FROM messages").fetchone()
    assert text == "Hi there, price for 2 people?"


def test_ingest_rejects_invalid_items():
    conn = connect()
    assert ingest_mod.ingest(conn, [msg(None, ext="empty")]) == []
    assert ingest_mod.ingest(conn, [msg("hi", ext="x" * 500)]) == []


# ---------------------------------------------------------------- demo inbox end to end

def test_synthetic_demo_inbox_end_to_end():
    conn = connect()
    inbox = SimulatedInbox(ROOT / "data" / "synthetic" / "inbox")
    pids = process_inbox(conn, [inbox], SHEET, Models.baseline())
    got = [
        r[0] for r in conn.execute(
            "SELECT COALESCE(json_extract(content, '$.template'), json_extract(content, '$.reason'))"
            " FROM proposals ORDER BY id"
        )
    ]
    assert len(pids) == 9
    assert got == [
        "price_total", "booking_offer", "date_open", "price_total", "date_closed",
        "unclear", "translation_unavailable", "callback", "booking_offer",
    ]
    assert all(r[0] == 1 for r in conn.execute("SELECT synthetic FROM messages"))
    # Fetching again creates nothing new.
    assert process_inbox(conn, [inbox], SHEET, Models.baseline()) == []


def test_monday_reference_is_a_monday():
    assert MONDAY.weekday() == 0
