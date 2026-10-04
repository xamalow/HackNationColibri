import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store.mjs";
import { applyBookingEvent, loadFarmSheet, seatsTaken } from "../src/bookings.mjs";
import { CLOSED_DAYS_KV, SHEET_OVERRIDES_KV } from "../src/hub.mjs";
import { gsm7Length, isGsm7 } from "../src/notify.mjs";
import { BLOCKED_DAYS_KV, blockedDays } from "../src/publish.mjs";
import { FEEDBACK_KV, MAX_REPLY_SEPTETS, QUERY_REPLIES, answerOwnerQuery, parseQueryDate, routeOwnerSms } from "../src/owner_queries.mjs";

const OWNER = "+254700000030"; // synthetic placeholder
const NOW = new Date("2026-10-05T06:00:00Z"); // Monday 09:00 EAT
const sheet = loadFarmSheet();

const ev = (ref, date, party_size, platform = "getyourguide", visitor_name = "Test Visitor") => ({
  id: `ev-${ref}`, kind: "booking", channel: "email", received_at: "2026-10-04T06:00:00Z", synthetic: true,
  booking: { platform, ref, date, time: "09:00", party_size, visitor_name },
});

function setup() {
  const s = openStore();
  s.setKV("owner.phone", OWNER);
  assert.equal(applyBookingEvent(s, sheet, ev("G1", "2026-10-05", 4, "getyourguide", "Anna Synthetic")).action, "confirmed");
  assert.equal(applyBookingEvent(s, sheet, ev("A1", "2026-10-05", 3, "airbnb", "Ben Synthetic")).action, "confirmed");
  assert.equal(applyBookingEvent(s, sheet, ev("B1", "2026-10-06", 2, "booking", "Chloe Synthetic")).action, "confirmed");
  assert.equal(applyBookingEvent(s, sheet, ev("G2", "2026-10-06", 9, "getyourguide", "Dan Synthetic")).action, "conflict"); // over capacity
  return s;
}
const ask = (s, text, from = "0700000030", now = NOW) => answerOwnerQuery(s, sheet, { from, text }, now);
const dump = (s) => JSON.stringify(s.db.prepare("SELECT k, v FROM kv ORDER BY k").all()) +
  JSON.stringify(s.db.prepare("SELECT * FROM bookings ORDER BY booking_id").all()) +
  JSON.stringify(s.db.prepare("SELECT * FROM proposals").all()) + JSON.stringify(s.db.prepare("SELECT * FROM outbox").all());
const shape = (r) => {
  assert.ok(r && typeof r.reply === "string");
  assert.ok(isGsm7(r.reply), r.reply);
  assert.ok(gsm7Length(r.reply) <= MAX_REPLY_SEPTETS, r.reply);
  assert.equal(r.recipient, OWNER);
  return r.reply;
};

test("LEO: today's bookings, party sizes, platform and seats left equal the store", () => {
  const s = setup();
  const reply = shape(ask(s, "leo"));
  const left = sheet.capacity_per_tour - seatsTaken(s, "2026-10-05");
  assert.equal(left, 3);
  assert.match(reply, /^SAUTI LEO Jumatatu 5\/10:/);
  assert.match(reply, /Wageni 2, watu 7\./);
  assert.match(reply, /Anna watu 4 \(GYG\)/);
  assert.match(reply, /Ben watu 3 \(Airbnb\)/);
  assert.match(reply, new RegExp(`Nafasi ${left} kati ya ${sheet.capacity_per_tour} zimebaki`));
});

test("KESHO: tomorrow, conflicts counted but never as seats", () => {
  const s = setup();
  const reply = shape(ask(s, "  KESHO? "));
  assert.match(reply, /^SAUTI KESHO Jumanne 6\/10: Wageni 1, watu 2\./);
  assert.match(reply, /Chloe watu 2 \(Booking\.com\)/);
  assert.match(reply, /Nafasi 8 kati ya 10 zimebaki/);
  assert.match(reply, /Migongano 1/);
  assert.doesNotMatch(reply, /Dan/);
});

test("RATIBA: 7 days with booked/capacity, closed, blocked and non-tour days", () => {
  const s = setup();
  s.setKV(CLOSED_DAYS_KV, { "2026-10-08": { approval_id: "B:x" } });
  const reply0 = shape(ask(s, "Ratiba"));
  assert.match(reply0, /Jumatatu 5\/10 7\/10/);
  assert.match(reply0, /Jumanne 6\/10 2\/10 mgongano 1/);
  assert.match(reply0, /Jumatano 7\/10 0\/10/);
  assert.match(reply0, /Alhamisi 8\/10 IMEFUNGWA/);
  assert.match(reply0, /Jumapili 11\/10 SI SIKU YA ZIARA/);
  assert.doesNotMatch(reply0, /12\/10/); // exactly 7 days
});

test("RATIBA and WAGENI show days blocked after a failed platform sync", () => {
  const s = setup();
  s.setKV(BLOCKED_DAYS_KV, { "2026-10-09": { reason: "platform_sync_failed", approval_id: "C:abc", platforms: ["getyourguide"] } });
  assert.ok(blockedDays(s)["2026-10-09"], "precondition: the day is blocked");
  assert.match(shape(ask(s, "RATIBA")), /Ijumaa 9\/10 IMEZUIWA \(TOVUTI\)/);
  assert.match(shape(ask(s, "wageni 9/10")), /Siku imezuiwa \(tovuti\)\./);
});

test("WAGENI <date>: dd/mm, dd/mm/yyyy and ISO; nearest dd/mm; bad date gets a fixed hint", () => {
  const s = setup();
  for (const t of ["WAGENI 6/10", "wageni 06/10/2026", "WAGENI 2026-10-06", "wageni kesho"]) {
    assert.match(shape(ask(s, t)), /^SAUTI WAGENI Jumanne 6\/10: Wageni 1, watu 2\./, t);
  }
  assert.equal(parseQueryDate("1/10", NOW), "2026-10-01"); // a past day this year, not next year
  assert.equal(parseQueryDate("2/1", NOW), "2027-01-02"); // early January: the coming one
  assert.equal(parseQueryDate("31/02", NOW), null);
  assert.equal(shape(ask(s, "WAGENI 31/02")), QUERY_REPLIES.bad_date);
  assert.equal(shape(ask(s, "WAGENI")), QUERY_REPLIES.bad_date);
  assert.match(shape(ask(s, "WAGENI 20/10")), /Hakuna wageni\. Nafasi 10 kati ya 10 zimebaki\./);
});

test("BEI and NAFASI: current values from the sheet, approved overrides applied, sheet not mutated", () => {
  const s = setup();
  assert.equal(shape(ask(s, "bei")), `SAUTI BEI: KES ${sheet.price_per_person_kes} kwa mgeni mmoja.`);
  assert.equal(shape(ask(s, "NAFASI")), `SAUTI NAFASI: watu ${sheet.capacity_per_tour} kwa kila ziara.`);
  s.setKV(SHEET_OVERRIDES_KV, { price_per_person_kes: 2500, capacity_per_tour: 12 });
  assert.match(shape(ask(s, "BEI")), /KES 2500 /);
  assert.match(shape(ask(s, "NAFASI")), /watu 12 /);
  assert.match(shape(ask(s, "LEO")), /Nafasi 5 kati ya 12 zimebaki/);
  assert.equal(sheet.price_per_person_kes, 2000);
  // With arguments they are commands (proposals), not queries.
  assert.equal(ask(s, "BEI 2500"), null);
  assert.equal(ask(s, "NAFASI 8"), null);
});

test("MAONI: stored summary (made GSM-7, cut to 2 segments) or 'Hakuna maoni mapya'", () => {
  const s = setup();
  assert.equal(shape(ask(s, "maoni")), QUERY_REPLIES.no_feedback);
  s.setKV(FEEDBACK_KV, { text_sw: "Wageni 3 walipenda kahawa; 2 walisema njia ni mbaya. “Café” \u{1F600}" });
  const r = shape(ask(s, "MAONI"));
  assert.match(r, /^SAUTI MAONI: Wageni 3 walipenda kahawa; 2 walisema njia ni mbaya\. "Cafe"$/);
  s.setKV(FEEDBACK_KV, "neno ".repeat(200));
  const long = shape(ask(s, "MAONI"));
  assert.ok(long.endsWith("..."));
});

test("only the enrolled number gets an answer; unknown text and MSAADA go to the command parser", () => {
  const s = setup();
  assert.equal(ask(s, "LEO", "+254700000031"), null);
  assert.equal(ask(s, "LEO", ""), null);
  assert.equal(ask(s, "LEO", "+447700900123"), null);
  assert.ok(ask(s, "LEO", "+254 700 000 030"));
  for (const t of ["", "MSAADA", "habari", "FUNGA 12/10", "NDIYO A 123456", "LEO KESHO", "leo tafadhali"]) assert.equal(ask(s, t), null, t);
  const none = openStore();
  assert.equal(answerOwnerQuery(none, sheet, { from: "0700000030", text: "LEO" }, NOW), null); // no one enrolled
});

test("a busy day still fits 2 segments: the list is cut with a '+N zaidi' count, totals stay exact", () => {
  const s = openStore();
  s.setKV("owner.phone", OWNER);
  const big = { ...sheet, capacity_per_tour: 200 };
  s.setKV(SHEET_OVERRIDES_KV, { capacity_per_tour: 200 });
  for (let i = 0; i < 30; i++) assert.equal(applyBookingEvent(s, big, ev(`M${i}`, "2026-10-05", 2, "airbnb", `Visitorname${i}`)).action, "confirmed");
  const reply = shape(ask(s, "LEO"));
  assert.match(reply, /Wageni 30, watu 60\./);
  assert.match(reply, /\+\d+ zaidi\./);
  assert.match(reply, /Nafasi 140 kati ya 200 zimebaki\.$/);
});

test("queries never change the store", () => {
  const s = setup();
  s.setKV(FEEDBACK_KV, "maoni mazuri");
  const before = dump(s);
  for (const t of ["LEO", "KESHO", "RATIBA", "WAGENI 6/10", "WAGENI x", "BEI", "NAFASI", "MAONI", "MSAADA", "hello"]) {
    ask(s, t);
    ask(s, t, "+254700000031");
  }
  assert.equal(dump(s), before);
});

test("routeOwnerSms: a query is queued to the enrolled number, anything else goes to hub.ownerSms", async () => {
  const s = setup();
  const queued = [];
  const outbox = { enqueue: (it) => { queued.push(it); return { key: "k", created: true }; }, dispatch: async () => [] };
  const hub = { ownerSms: async () => ({ command: null, reply_sent: true }) };
  const r = await routeOwnerSms({ store: s, sheet, outbox, hub }, { from: "0700000030", text: "LEO" }, NOW);
  assert.equal(r.query, "LEO");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].recipient, OWNER);
  assert.match(queued[0].body, /^SAUTI LEO/);
  const r2 = await routeOwnerSms({ store: s, sheet, outbox, hub }, { from: "0700000030", text: "MSAADA" }, NOW);
  assert.equal(r2.query, null);
  assert.equal(queued.length, 1);
});
