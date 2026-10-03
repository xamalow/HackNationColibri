"""The farm calendar: one tour per day, one capacity shared by every channel.

Seats are always counted across direct, GetYourGuide and Airbnb bookings, so a
booking on one channel immediately reduces what every other channel may sell.
Days blocked in slot_blocks (e.g. a failed sync in W5) are never bookable.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date
from typing import Literal

from sauti.farm_sheet import FarmSheet
from sauti.lang.swahili import WEEKDAYS
from sauti.storage.states import now_iso

ACTIVE_STATUSES = ("HELD", "CONFIRMED")
BookingChannel = Literal["direct", "getyourguide", "airbnb"]


@dataclass(frozen=True)
class DayStatus:
    day: date
    open_day: bool | None  # None: Noor has not said which days she works
    blocked: bool
    capacity: int | None
    booked: int

    @property
    def seats_left(self) -> int | None:
        if self.capacity is None:
            return None
        return max(self.capacity - self.booked, 0)


class OverbookingError(Exception):
    pass


def booked_seats(conn: sqlite3.Connection, day: date) -> int:
    row = conn.execute(
        "SELECT COALESCE(SUM(party_size), 0) FROM bookings WHERE slot_date = ? AND status IN (?, ?)",
        (day.isoformat(), *ACTIVE_STATUSES),
    ).fetchone()
    return int(row[0])


def is_blocked(conn: sqlite3.Connection, day: date) -> bool:
    row = conn.execute(
        "SELECT 1 FROM slot_blocks WHERE slot_date = ? AND lifted_at IS NULL LIMIT 1", (day.isoformat(),)
    ).fetchone()
    return row is not None


def day_status(conn: sqlite3.Connection, sheet: FarmSheet, day: date) -> DayStatus:
    open_day = None if sheet.days is None else WEEKDAYS[day.weekday()] in sheet.days
    return DayStatus(
        day=day,
        open_day=open_day,
        blocked=is_blocked(conn, day),
        capacity=sheet.capacity_per_tour,
        booked=booked_seats(conn, day),
    )


def can_book(status: DayStatus, party_size: int) -> bool:
    """Only a definite yes. Unknown days or capacity mean no: we never risk a double booking."""
    return (
        status.open_day is True
        and not status.blocked
        and status.seats_left is not None
        and party_size <= status.seats_left
    )


def hold_seats(
    conn: sqlite3.Connection,
    sheet: FarmSheet,
    day: date,
    party_size: int,
    channel: BookingChannel,
    proposal_id: int | None = None,
    external_ref: str | None = None,
) -> int:
    """Insert a HELD booking after re-checking capacity. Call inside the caller's transaction
    (opened with BEGIN IMMEDIATE) so the check and the insert cannot interleave with another write."""
    if not can_book(day_status(conn, sheet, day), party_size):
        raise OverbookingError(f"{party_size} seats not available on {day.isoformat()}")
    cursor = conn.execute(
        "INSERT INTO bookings (slot_date, party_size, channel, external_ref, proposal_id, status, created_at)"
        " VALUES (?, ?, ?, ?, ?, 'HELD', ?)",
        (day.isoformat(), party_size, channel, external_ref, proposal_id, now_iso()),
    )
    assert cursor.lastrowid is not None
    return cursor.lastrowid
