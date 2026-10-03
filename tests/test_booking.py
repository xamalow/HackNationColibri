"""Priority 4: no overbooking across direct, GetYourGuide and Airbnb bookings."""

from __future__ import annotations

import pytest

from sauti.calendar import OverbookingError, booked_seats, hold_seats
from sauti.farm_sheet import FarmSheet
from sauti.storage.states import now_iso
from sauti.workflows import approve
from tests.w2_helpers import SHEET, THURSDAY_15, connect, propose_one, state

BOOK_3 = "We would like to book the tour for 3 people on October 15."


def _gyg_booking(conn, seats: int, ref: str = "GYG-SYNTH-1") -> None:
    with conn:
        hold_seats(conn, SHEET, THURSDAY_15, seats, "getyourguide", external_ref=ref)


def test_capacity_counts_every_channel():
    conn = connect()
    _gyg_booking(conn, 8)
    _, _, _, content = propose_one(conn, BOOK_3)
    assert content["template"] == "date_full"
    assert content["booking"] is None


def test_slot_taken_between_proposal_and_approval_is_not_booked():
    conn = connect()
    pid, short_id, h, content = propose_one(conn, BOOK_3)
    assert content["template"] == "booking_offer"
    _gyg_booking(conn, 8)  # a GetYourGuide booking arrives while Noor is in the field

    result = approve.approve(conn, short_id, h, SHEET)
    assert result.outcome == "slot_taken"
    assert booked_seats(conn, THURSDAY_15) == 8
    assert conn.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] == 0
    # The proposal was recomputed, Noor must approve the new version (now "fully booked").
    new_hash, new_content = conn.execute("SELECT content_hash, content FROM proposals WHERE id = ?", (pid,)).fetchone()
    assert new_hash != h and '"date_full"' in new_content
    assert state(conn, pid) == "PROPOSED"
    assert conn.execute("SELECT COUNT(*) FROM approvals WHERE voided_at IS NULL").fetchone()[0] == 0


def test_approving_a_booking_holds_seats_once():
    conn = connect()
    _, short_id, h, _ = propose_one(conn, BOOK_3)
    assert approve.approve(conn, short_id, h, SHEET).outcome == "queued"
    assert booked_seats(conn, THURSDAY_15) == 3
    assert approve.approve(conn, short_id, h, SHEET).outcome == "not_found"  # no double approval
    assert booked_seats(conn, THURSDAY_15) == 3


def test_two_requests_for_the_last_seats_cannot_both_be_booked():
    conn = connect()
    _gyg_booking(conn, 6)
    _, a, ha, ca = propose_one(conn, BOOK_3, ext="a")
    _, b, hb, cb = propose_one(conn, BOOK_3.replace("3 people", "4 people"), ext="b")
    assert ca["template"] == cb["template"] == "booking_offer"  # each alone fits in the 4 seats left
    assert approve.approve(conn, a, ha, SHEET).outcome == "queued"
    assert approve.approve(conn, b, hb, SHEET).outcome == "slot_taken"
    assert booked_seats(conn, THURSDAY_15) == 9


def test_hold_seats_refuses_over_capacity_directly():
    conn = connect()
    with pytest.raises(OverbookingError), conn:
        hold_seats(conn, SHEET, THURSDAY_15, 11, "direct")


def test_blocked_day_is_never_offered():
    conn = connect()
    with conn:
        conn.execute(
            "INSERT INTO slot_blocks (slot_date, reason, created_at) VALUES (?, 'gyg sync failed', ?)",
            (THURSDAY_15.isoformat(), now_iso()),
        )
    _, _, _, content = propose_one(conn, BOOK_3)
    assert content["kind"] == "needs_noor"
    with pytest.raises(OverbookingError), conn:
        hold_seats(conn, SHEET, THURSDAY_15, 1, "direct")


def test_unknown_capacity_or_days_means_ask_noor():
    conn = connect()
    no_capacity = FarmSheet(**{**SHEET.model_dump(), "capacity_per_tour": None})
    _, _, _, content = propose_one(conn, BOOK_3, ext="c", sheet=no_capacity)
    assert content["kind"] == "needs_noor" and content["reason"] == "calendar_unknown"


def test_closed_day_gets_the_open_days():
    conn = connect()
    _, _, _, content = propose_one(conn, "Can we book for 2 people on October 18?")
    assert content["template"] == "date_closed"
    assert "Sunday" in content["body"] and "Saturday" in content["body"]


def test_platform_structured_fields_win_over_free_text():
    conn = connect()
    _, _, _, content = propose_one(
        conn, "We would like to book it, we are 5!", channel="email_airbnb",
        requested_date=THURSDAY_15, party_size=2, booking_ref="ABNB-SYNTH-1",
    )
    assert content["booking"] == {"date": THURSDAY_15.isoformat(), "party_size": 2}
    assert content["reply_channel"] == "airbnb_manual"
