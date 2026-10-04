// Booking events -> the hub's calendar, decided by @sauti/core (code, never a model).
//
// A platform booking (GetYourGuide, Airbnb, Booking.com) is ALREADY CONFIRMED AND PAID on the platform: the hub
// cannot refuse it. It is checked with checkCapacity against the farm sheet and every confirmed booking on that
// day from every channel:
//   - it fits          -> stored "confirmed", seats blocked everywhere      -> { action: "confirmed" }
//   - it does not fit  -> stored "conflict" (overbooking across channels, closed day, wrong time, missing fact)
//                         and NEVER counted as seats, never dropped          -> { action: "conflict", reason }
//     Noor must be alerted (notify.mjs) and settle it with the visitor / platform herself.
// A direct request (SMS, WhatsApp, voicemail, missed call) is never auto-booked: { action: "needs_owner" };
// it becomes a book_slot proposal Noor approves (core proposeBooking / approveExact / confirmBooking).
// Idempotent: (platform, ref) is UNIQUE in the store, so the same booking seen twice (e-mail and API, or a
// redelivered e-mail) is stored once.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkCapacity, validateFarmSheet } from "./core.mjs";

export const DEFAULT_FARM_SHEET = fileURLToPath(new URL("../fixtures/farm_sheet.json", import.meta.url));
export const FARM_TIMEZONE = "Africa/Nairobi";

/** Read and validate a farm sheet file ({ sheet } wrapper or a bare sheet). Throws on an invalid sheet. */
export function loadFarmSheet(path = DEFAULT_FARM_SHEET) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const v = validateFarmSheet(raw && typeof raw === "object" && "sheet" in raw ? raw.sheet : raw);
  if (!v.ok) throw new Error(`invalid farm sheet ${path}: ${v.errors.join("; ")}`);
  return v.sheet;
}

/**
 * Confirmed bookings on one day, in the shape checkCapacity reads (state, slot_id, request.party_size).
 * Built from the table's columns, so bookings written by other modules count too.
 */
export function confirmedOn(store, date) {
  return store.db
    .prepare("SELECT booking_id, date, party_size FROM bookings WHERE date = ? AND state = 'confirmed'")
    .all(date)
    .map((r) => ({ booking_id: r.booking_id, slot_id: r.date, state: "confirmed", request: { party_size: r.party_size } }));
}

/** Seats taken on a day (confirmed only; conflicts never hold seats). */
export function seatsTaken(store, date) {
  return confirmedOn(store, date).reduce((n, b) => n + b.request.party_size, 0);
}

export function getBooking(store, platform, ref) {
  const r = store.db.prepare("SELECT body FROM bookings WHERE platform = ? AND external_ref = ?").get(platform, ref);
  return r ? JSON.parse(r.body) : null;
}

export function listBookings(store, { state } = {}) {
  const rows = state
    ? store.db.prepare("SELECT body FROM bookings WHERE state = ? ORDER BY date, booking_id").all(state)
    : store.db.prepare("SELECT body FROM bookings ORDER BY date, booking_id").all();
  return rows.map((r) => JSON.parse(r.body));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validBooking(b) {
  return (
    b && typeof b === "object" &&
    typeof b.platform === "string" && b.platform.length > 0 &&
    typeof b.ref === "string" && b.ref.length > 0 &&
    typeof b.date === "string" && DATE.test(b.date) &&
    (b.time === undefined || /^\d{2}:\d{2}$/.test(b.time)) &&
    Number.isInteger(b.party_size) && b.party_size >= 1 &&
    typeof b.visitor_name === "string" && b.visitor_name.length > 0
  );
}

/**
 * Apply one HubEvent.
 * @param {ReturnType<import("./store.mjs").openStore>} store
 * @param {import("../../../packages/core/dist/index.js").FarmSheet} sheet
 * @param {import("./intake/sms.mjs").HubEvent} event
 * @param {{ factRevision?: number | null }} [opts]
 * @returns {{ action: "confirmed", booking_id: string, remaining_after: number }
 *         | { action: "conflict", booking_id: string, reason: string, detail: string }
 *         | { action: "duplicate", booking_id: string, state: string, differs: boolean }
 *         | { action: "needs_owner", reason: string }}
 */
export function applyBookingEvent(store, sheet, event, opts = {}) {
  if (event?.kind !== "booking") {
    return { action: "needs_owner", reason: `${event?.kind ?? "unknown"} from ${event?.channel ?? "unknown"}: direct requests are proposals for Noor, never auto-booked` };
  }
  const b = event.booking;
  if (!validBooking(b)) return { action: "needs_owner", reason: "invalid_booking_event" };
  const booking_id = `${b.platform}:${b.ref}`;

  return store.transaction(() => {
    const existing = getBooking(store, b.platform, b.ref);
    if (existing) {
      const r = existing.request;
      const differs = r.date !== b.date || r.party_size !== b.party_size || (r.time ?? null) !== (b.time ?? null) || r.visitor_name !== b.visitor_name;
      return { action: "duplicate", booking_id: existing.booking_id, state: existing.state, differs };
    }
    const request = {
      request_id: event.id,
      visitor_name: b.visitor_name,
      // No direct channel to a platform guest: replies go through the platform's own inbox.
      contact: { channel: b.platform === "getyourguide" ? "getyourguide" : "local", address: booking_id, language: "und" },
      date: b.date,
      party_size: b.party_size,
      source_id: event.id,
      ...(b.time ? { time: b.time } : {}),
    };
    const verdict = checkCapacity(sheet, confirmedOn(store, b.date), request, FARM_TIMEZONE);
    const common = {
      booking_id, platform: b.platform, external_ref: b.ref, channel: event.channel, request,
      slot_id: b.date, fact_revision: opts.factRevision ?? null, arrival: null, synthetic: event.synthetic === true,
    };
    const body = verdict.ok
      ? { ...common, state: "confirmed", slot_start: verdict.slot_start, slot_end: verdict.slot_end, price: verdict.price }
      : { ...common, state: "conflict", conflict: { reason: verdict.reason, detail: verdict.detail } };
    store.db
      .prepare("INSERT INTO bookings (booking_id, platform, external_ref, date, party_size, state, body) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(booking_id, b.platform, b.ref, b.date, b.party_size, body.state, JSON.stringify(body));
    return verdict.ok
      ? { action: "confirmed", booking_id, remaining_after: verdict.remaining_after }
      : { action: "conflict", booking_id, reason: verdict.reason, detail: verdict.detail };
  });
}
