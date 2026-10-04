import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { simulatedInbound } from "../src/transports/simulated.mjs";
import {
  gygApiSource, localDateTime, parseDate, parseGygApiBooking, parsePartySize, parsePlatformEmail, parseTime, platformMailSource,
} from "../src/intake/platforms.mjs";
import { MAX_TEXT_CHARS, sanitizeText, smsBatchToEvents, smsToEvent } from "../src/intake/sms.mjs";
import { IVR_PLAN, callToEvent, fixtureTranscriber } from "../src/intake/voice.mjs";

const fx = (p) => fileURLToPath(new URL(`../fixtures/inbound/${p}`, import.meta.url));
const load = (p) => JSON.parse(readFileSync(fx(p), "utf8"));

test("GetYourGuide e-mail fixture parses into a booking", () => {
  const ev = parsePlatformEmail(load("mail/01-gyg-booking.json"));
  assert.equal(ev.kind, "booking");
  assert.equal(ev.channel, "email_gyg");
  assert.equal(ev.synthetic, true);
  assert.deepEqual(ev.booking, {
    platform: "getyourguide", ref: "GYGK7Q2M4XZ", date: "2026-10-14", time: "09:00", party_size: 3,
    visitor_name: "Anna Schmidt", activity: "Coffee farm walk with Noor",
  });
});

test("Airbnb Experiences e-mail fixture parses (weekday date, 12 h time range)", () => {
  const ev = parsePlatformEmail(load("mail/02-airbnb-booking.json"));
  assert.equal(ev.kind, "booking");
  assert.equal(ev.channel, "email_airbnb");
  assert.equal(ev.booking.platform, "airbnb");
  assert.equal(ev.booking.ref, "HMXQ4T7B2K");
  assert.equal(ev.booking.date, "2026-10-14");
  assert.equal(ev.booking.time, "09:00");
  assert.equal(ev.booking.party_size, 2);
  assert.equal(ev.booking.visitor_name, "Liam O'Brien");
});

test("Booking.com e-mail fixture parses (ISO date, dotted booking number)", () => {
  const ev = parsePlatformEmail(load("mail/03-booking-com-booking.json"));
  assert.equal(ev.kind, "booking");
  assert.equal(ev.channel, "email_booking");
  assert.deepEqual(
    { ...ev.booking, activity: undefined },
    { platform: "booking_com", ref: "4512.338.902", date: "2026-10-14", time: "09:00", party_size: 4, visitor_name: "Wanjiru Kamau", activity: undefined },
  );
});

test("GYG API fixture gives the same booking shape, local farm time from the offset", () => {
  const ev = parseGygApiBooking(load("gyg/01-gyg-api-overbook.json"));
  assert.equal(ev.kind, "booking");
  assert.equal(ev.channel, "gyg_api");
  assert.deepEqual(ev.booking, { platform: "getyourguide", ref: "GYGR8N3T6WQ", date: "2026-10-14", time: "09:00", party_size: 3, visitor_name: "Kenji Sato" });
  const src = gygApiSource(fileURLToPath(new URL("../fixtures/inbound/gyg", import.meta.url)));
  assert.equal(src.fetchEvents().length, 1);
});

test("every inbound fixture is synthetic and the simulated mailbox yields three bookings", () => {
  for (const f of ["mail", "gyg", "sms", "calls"]) assert.ok(simulatedInbound(fx(f)).fetch().length > 0);
  const evs = platformMailSource(fx("mail")).fetchEvents();
  assert.deepEqual(evs.map((e) => e.kind), ["booking", "booking", "booking"]);
  assert.ok(evs.every((e) => e.synthetic === true));
});

const gygMail = (body, subject = "New booking") => ({ synthetic: true, kind: "email", message_id: "m1", from: "no-reply@getyourguide.com", subject, received_at: "2026-10-04T06:00:00Z", body });
const FULL = "Reference number: GYGABC12345\nDate: 14 October 2026\nTime: 09:00\nNumber of participants: 2 x Adults\nLead traveler: Ana Lopez";

test("a missing field is never guessed: the e-mail becomes a flagged visitor_message", () => {
  for (const [drop, field] of [["Date: 14 October 2026\n", "date"], ["Number of participants: 2 x Adults\n", "party_size"], ["Lead traveler: Ana Lopez", "visitor_name"], ["Reference number: GYGABC12345\n", "ref"]]) {
    const ev = parsePlatformEmail(gygMail(FULL.replace(drop, "")));
    assert.equal(ev.kind, "visitor_message", field);
    assert.equal(ev.reason, "booking_fields_missing");
    assert.deepEqual(ev.missing, [field]);
    assert.equal(ev.booking, undefined);
    assert.ok(ev.text.length > 0, "Noor can read the original");
  }
});

test("ambiguous or contradictory values are refused, not guessed", () => {
  const amb = parsePlatformEmail(gygMail(FULL.replace("14 October 2026", "10/12/2026")));
  assert.deepEqual(amb.missing, ["date"]);
  const wrongWeekday = parsePlatformEmail(gygMail(FULL.replace("14 October 2026", "Monday, 14 October 2026")));
  assert.deepEqual(wrongWeekday.missing, ["date"]);
  const party = parsePlatformEmail(gygMail(FULL.replace("2 x Adults", "a few adults")));
  assert.deepEqual(party.missing, ["party_size"]);
  const time = parsePlatformEmail(gygMail(FULL.replace("Time: 09:00", "Time: morning")));
  assert.deepEqual(time.missing, ["time"]);
  const noTime = parsePlatformEmail(gygMail(FULL.replace("Time: 09:00\n", "")));
  assert.equal(noTime.kind, "booking");
  assert.equal(noTime.booking.time, undefined, "no time line: the core uses the tour start");
});

test("cancellations, changes and unknown senders are never parsed as new bookings", () => {
  assert.equal(parsePlatformEmail(gygMail(FULL, "Booking cancelled")).reason, "platform_cancellation");
  assert.equal(parsePlatformEmail(gygMail(`${FULL}\nThis booking has been changed.`)).reason, "platform_change");
  assert.equal(parsePlatformEmail(gygMail(`${FULL}\nThis booking was cancelled by the traveler.`)).reason, "platform_cancellation");
  const policy = parsePlatformEmail(gygMail(`${FULL}\nFree cancellation up to 24 hours before the activity.`));
  assert.equal(policy.kind, "booking", "cancellation policy text is not a cancellation");
  const spoof = parsePlatformEmail({ ...gygMail(FULL), from: "no-reply@getyourguide.com.evil.example" });
  assert.equal(spoof.kind, "visitor_message");
  assert.equal(spoof.reason, "unknown_sender");
  assert.equal(spoof.channel, "email");
});

test("GYG API: no time-zone offset or bad counts -> flagged, never guessed", () => {
  const item = load("gyg/01-gyg-api-overbook.json");
  const noTz = parseGygApiBooking({ ...item, data: { ...item.data, dateTime: "2026-10-14T09:00:00" } });
  assert.equal(noTz.kind, "visitor_message");
  assert.deepEqual(noTz.missing, ["date"]);
  const noCount = parseGygApiBooking({ ...item, data: { ...item.data, bookingItems: [{ category: "ADULT" }] } });
  assert.deepEqual(noCount.missing, ["party_size"]);
  assert.deepEqual(localDateTime("2026-10-14T06:00:00Z"), { date: "2026-10-14", time: "09:00" });
  assert.deepEqual(localDateTime("2026-10-13T22:30:00Z"), { date: "2026-10-14", time: "01:30" });
});

test("date, time and party-size parsers", () => {
  assert.equal(parseDate("2026-10-14"), "2026-10-14");
  assert.equal(parseDate("Wed, Oct 14, 2026"), "2026-10-14");
  assert.equal(parseDate("14th Oct 2026"), "2026-10-14");
  assert.equal(parseDate("2026-02-30"), null);
  assert.equal(parseDate("14/10/2026"), null);
  assert.equal(parseDate("tomorrow"), null);
  assert.equal(parseTime("12:30 PM"), "12:30");
  assert.equal(parseTime("12 am"), "00:00");
  assert.equal(parseTime("9"), null);
  assert.equal(parseTime("25:00"), null);
  assert.equal(parsePartySize("4 guests"), 4);
  assert.equal(parsePartySize("2 adults and 1 child"), 3);
  assert.equal(parsePartySize("0"), null);
  assert.equal(parsePartySize("2-3"), null);
});

test("SMS fixtures become visitor_message events with stable ids", () => {
  const evs = smsBatchToEvents(simulatedInbound(fx("sms")).fetch());
  assert.equal(evs.length, 2);
  assert.ok(evs.every((e) => e.kind === "visitor_message" && e.synthetic === true));
  assert.deepEqual(evs.map((e) => e.id), ["sms:sim-sms-0001", "whatsapp:sim-wa-0001"]);
  assert.equal(evs[1].from, "+12025550143", "whatsapp: prefix removed");
  assert.equal(evs[0].booking, undefined, "an SMS booking request is not a booking");
});

test("SMS dedupe: the same message twice yields one event; no provider id -> content hash id", () => {
  const it = load("sms/01-booking-request.json");
  assert.equal(smsBatchToEvents([it, { ...it }]).length, 1);
  const noId = { ...it, message_id: undefined };
  assert.equal(smsToEvent(noId).id, smsToEvent({ ...noId }).id);
  assert.notEqual(smsToEvent(noId).id, smsToEvent({ ...noId, text: "other" }).id);
  assert.match(smsToEvent({ ...it, message_id: "x'; DROP TABLE events;--" }).id, /^sms:[0-9a-f]{24}$/);
});

test("untrusted text: control and bidi characters stripped, capped at 2000 code points", () => {
  const ev = smsToEvent({ synthetic: true, kind: "sms", from: "+447700900123", text: "Hi‮evil‬\u0007 there​\r\nbye\u0000" });
  assert.equal(ev.text, "Hievil there\nbye");
  const long = smsToEvent({ synthetic: true, kind: "sms", from: "+447700900123", text: "😀".repeat(2500) });
  assert.equal(Array.from(long.text).length, MAX_TEXT_CHARS);
  assert.equal(long.truncated, true);
  assert.equal(sanitizeText("a\uD800b").text, "a�b", "lone surrogate made well-formed");
  assert.equal(smsToEvent({ synthetic: true, kind: "sms", from: "not a number", text: "hi" }).reason, "no_reply_address");
});

test("IVR plan: greeting in sw+en, voicemail of at most 60 s, thanks", () => {
  assert.deepEqual(IVR_PLAN.slice(0, 3).map((s) => s.step), ["play", "record", "play"]);
  assert.equal(IVR_PLAN[0].clip, "ivr.greeting");
  assert.deepEqual([...IVR_PLAN[0].langs], ["sw", "en"]);
  assert.equal(IVR_PLAN[1].max_seconds, 60);
  assert.equal(IVR_PLAN[2].clip, "ivr.thanks");
  assert.ok(Object.isFrozen(IVR_PLAN));
});

test("voicemail from the fixture transcriber is marked transcript_source fixture", async () => {
  const tr = fixtureTranscriber(fx("transcripts"));
  const ev = await callToEvent(load("calls/01-voicemail.json"), tr);
  assert.equal(ev.kind, "voicemail");
  assert.equal(ev.transcript_source, "fixture");
  assert.equal(ev.lang, "en");
  assert.equal(ev.id, "call:sim-call-0001");
  assert.equal(ev.synthetic, true);
  assert.match(ev.text, /coffee tour/);
});

test("missed or short call -> missed_call; transcriber failure is kept, not dropped", async () => {
  const tr = fixtureTranscriber(fx("transcripts"));
  const missed = await callToEvent(load("calls/02-missed-call.json"), tr);
  assert.equal(missed.kind, "missed_call");
  assert.equal(missed.from, "+447700900789");
  const short = await callToEvent({ ...load("calls/01-voicemail.json"), recording_s: 1 }, tr);
  assert.equal(short.kind, "missed_call");
  const broken = await callToEvent({ ...load("calls/01-voicemail.json"), recording: "nope.wav" }, tr);
  assert.equal(broken.kind, "voicemail");
  assert.equal(broken.reason, "transcription_failed");
  const unlabeled = await callToEvent(load("calls/01-voicemail.json"), { transcribe: () => ({ text: "hello there", lang: "en" }) });
  assert.equal(unlabeled.transcript_source, "unknown", "an unlabeled transcriber never claims to be Whisper");
});
