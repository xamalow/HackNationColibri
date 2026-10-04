import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openStore } from "../src/store.mjs";
import { simulatedInbound } from "../src/transports/simulated.mjs";
import { applyBookingEvent, getBooking, listBookings, loadFarmSheet, seatsTaken } from "../src/bookings.mjs";
import { parseGygApiBooking, parsePlatformEmail } from "../src/intake/platforms.mjs";
import { smsBatchToEvents } from "../src/intake/sms.mjs";
import { callToEvent, fixtureTranscriber } from "../src/intake/voice.mjs";

const fx = (p) => fileURLToPath(new URL(`../fixtures/inbound/${p}`, import.meta.url));
const load = (p) => JSON.parse(readFileSync(fx(p), "utf8"));
const sheet = loadFarmSheet();

const booking = (over = {}) => ({
  id: `ev-${over.ref ?? "X"}`, kind: "booking", channel: "email_gyg", received_at: "2026-10-04T06:00:00Z", synthetic: true,
  booking: { platform: "getyourguide", ref: "GYGTEST0001", date: "2026-10-14", time: "09:00", party_size: 2, visitor_name: "Test Visitor", ...over },
});

test("farm sheet fixture: 2000 KES, 10 seats, mon-sat, 09:00-15:00, Swahili directions", () => {
  assert.equal(sheet.price_per_person_kes, 2000);
  assert.equal(sheet.capacity_per_tour, 10);
  assert.deepEqual(sheet.days, ["mon", "tue", "wed", "thu", "fri", "sat"]);
  assert.deepEqual(sheet.hours, { start: "09:00:00", end: "15:00:00" });
  assert.match(sheet.directions_sw, /Machakos/);
});

test("a platform booking that fits is stored confirmed with the price from the sheet", () => {
  const s = openStore();
  const r = applyBookingEvent(s, sheet, booking());
  assert.deepEqual(r, { action: "confirmed", booking_id: "getyourguide:GYGTEST0001", remaining_after: 8 });
  const b = getBooking(s, "getyourguide", "GYGTEST0001");
  assert.equal(b.state, "confirmed");
  assert.deepEqual(b.price, { amount_minor: 400000, currency: "KES", exponent: 2 });
  assert.equal(seatsTaken(s, "2026-10-14"), 2);
});

test("fixtures end to end: three e-mail bookings fill 9 of 10, the GYG API booking of 3 is a conflict", () => {
  const s = openStore();
  const mails = simulatedInbound(fx("mail")).fetch().map((m) => parsePlatformEmail(m));
  assert.deepEqual(mails.map((e) => applyBookingEvent(s, sheet, e).action), ["confirmed", "confirmed", "confirmed"]);
  assert.equal(seatsTaken(s, "2026-10-14"), 9);
  const api = parseGygApiBooking(load("gyg/01-gyg-api-overbook.json"));
  const r = applyBookingEvent(s, sheet, api);
  assert.equal(r.action, "conflict");
  assert.equal(r.reason, "no_capacity");
  assert.match(r.detail, /1 of 10 seats left/);
  const stored = getBooking(s, "getyourguide", "GYGR8N3T6WQ");
  assert.equal(stored.state, "conflict", "the platform already sold it: kept for Noor, never dropped");
  assert.equal(seatsTaken(s, "2026-10-14"), 9, "a conflict never takes seats");
  assert.equal(listBookings(s, { state: "conflict" }).length, 1);
});

test("never two confirmed bookings over capacity, whatever the arrival order", () => {
  for (const order of [[6, 5], [5, 6], [10, 1], [3, 3, 3, 3]]) {
    const s = openStore();
    order.forEach((n, i) => applyBookingEvent(s, sheet, booking({ ref: `GYGORDER${i}${n}0`, party_size: n, platform: i % 2 ? "airbnb" : "getyourguide" })));
    assert.ok(seatsTaken(s, "2026-10-14") <= 10, `order ${order}`);
    const all = listBookings(s);
    assert.equal(all.length, order.length, "every platform booking is stored, confirmed or conflict");
  }
});

test("idempotent: the same platform ref twice (e-mail then API) is stored once", () => {
  const s = openStore();
  const a = applyBookingEvent(s, sheet, booking());
  const b = applyBookingEvent(s, sheet, { ...booking(), id: "gyg_api:GYGTEST0001", channel: "gyg_api" });
  assert.equal(a.action, "confirmed");
  assert.deepEqual(b, { action: "duplicate", booking_id: "getyourguide:GYGTEST0001", state: "confirmed", differs: false });
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM bookings").get().n, 1);
  assert.equal(seatsTaken(s, "2026-10-14"), 2);
  const changed = applyBookingEvent(s, sheet, booking({ party_size: 5 }));
  assert.equal(changed.action, "duplicate");
  assert.equal(changed.differs, true, "same ref with other details is surfaced, not applied");
  assert.equal(seatsTaken(s, "2026-10-14"), 2);
  const sameRefOtherPlatform = applyBookingEvent(s, sheet, booking({ platform: "airbnb" }));
  assert.equal(sameRefOtherPlatform.action, "confirmed");
});

test("closed day and wrong start time are conflicts with the core's reason", () => {
  const s = openStore();
  const sunday = applyBookingEvent(s, sheet, booking({ ref: "GYGSUNDAY01", date: "2026-10-18" }));
  assert.equal(sunday.action, "conflict");
  assert.equal(sunday.reason, "closed_day");
  const late = applyBookingEvent(s, sheet, booking({ ref: "GYGLATE0001", time: "11:00" }));
  assert.equal(late.action, "conflict");
  assert.equal(late.reason, "unsupported_time");
  assert.equal(seatsTaken(s, "2026-10-14"), 0);
});

test("direct requests (SMS, WhatsApp, voicemail, missed call) are never auto-booked", async () => {
  const s = openStore();
  const sms = smsBatchToEvents(simulatedInbound(fx("sms")).fetch());
  const tr = fixtureTranscriber(fx("transcripts"));
  const calls = await Promise.all(simulatedInbound(fx("calls")).fetch().map((c) => callToEvent(c, tr)));
  for (const ev of [...sms, ...calls]) assert.equal(applyBookingEvent(s, sheet, ev).action, "needs_owner", ev.id);
  const flagged = parsePlatformEmail({ ...load("mail/01-gyg-booking.json"), body: "Reference number: GYGK7Q2M4XZ\nLead traveler: Anna" });
  assert.equal(applyBookingEvent(s, sheet, flagged).action, "needs_owner");
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM bookings").get().n, 0);
});

test("a malformed booking event is not stored", () => {
  const s = openStore();
  assert.deepEqual(applyBookingEvent(s, sheet, booking({ party_size: 0 })), { action: "needs_owner", reason: "invalid_booking_event" });
  assert.equal(applyBookingEvent(s, sheet, booking({ date: "14 Oct" })).action, "needs_owner");
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM bookings").get().n, 0);
});
