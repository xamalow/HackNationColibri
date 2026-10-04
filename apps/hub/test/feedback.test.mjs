import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store.mjs";
import { createOutbox } from "../src/outbox.mjs";
import { gsm7Length, isGsm7 } from "../src/notify.mjs";
import { normalizePhone } from "../src/commands.mjs";
import {
  analyzeStoredFeedback, approveFeedbackRequest, dueFeedbackRequests, ingestFeedbackReply,
  painPointSms, proposeFeedbackRequest, queuePainPointDigest,
} from "../src/feedback/index.mjs";
import { tagFeedback } from "../../../contrib/max/tagger/tag_feedback.mjs";

const NOW = new Date("2026-10-20T09:00:00Z");
const OWNER = "+254700000001";
// SYNTHETIC tourists (placeholder numbers) and SYNTHETIC replies, same wording as the phone app's demo file.
const VISITS = [
  { id: "b1", name: "Amina", phone: "+254711000001", lang: "sw", reply: "Kahawa ilikuwa nzuri sana, lakini maelekezo ya kufika yalikuwa magumu, tulipotea njia." },
  { id: "b2", name: "Claire Martin", phone: "+447700900001", lang: "en", reply: "Lovely coffee tour and a warm welcome, but the directions from the market were confusing." },
  { id: "b3", name: "Jonas", phone: "+491700000001", lang: "de", reply: "Toller Kaffee und eine sehr nette Gastgeberin. Den Weg zur Farm haben wir aber kaum gefunden." },
  { id: "b4", name: "Louise", phone: "+33600000001", lang: "fr", reply: "Café délicieux, accueil chaleureux. Par contre, difficile de trouver la ferme sans panneau." },
];

function memoryTransport() {
  const sent = [];
  return { sent, async send(item) { sent.push(item); return { ref: `sim-${sent.length}` }; }, async wasSent(key) { return sent.some((s) => s.idempotency_key === key); } };
}

function setup() {
  const store = openStore(":memory:");
  store.setKV("owner.phone", OWNER);
  const transport = memoryTransport();
  const outbox = createOutbox(store, transport, { now: () => NOW });
  for (const v of VISITS) {
    const body = { booking_id: `sms:${v.id}`, request: { visitor_name: v.name, contact: { channel: "sms", address: v.phone, language: v.lang }, date: "2026-10-17", party_size: 2 } };
    store.db.prepare("INSERT INTO bookings (booking_id, platform, external_ref, date, party_size, state, body) VALUES (?, 'sms', ?, '2026-10-17', 2, 'confirmed', ?)")
      .run(`sms:${v.id}`, v.id, JSON.stringify(body));
  }
  // A platform booking and a future SMS booking must never be asked.
  store.db.prepare("INSERT INTO bookings (booking_id, platform, external_ref, date, party_size, state, body) VALUES ('getyourguide:G1', 'getyourguide', 'G1', '2026-10-17', 2, 'confirmed', ?)")
    .run(JSON.stringify({ request: { visitor_name: "Guest", contact: { channel: "getyourguide", address: "getyourguide:G1", language: "und" } } }));
  store.db.prepare("INSERT INTO bookings (booking_id, platform, external_ref, date, party_size, state, body) VALUES ('sms:future', 'sms', 'future', '2026-10-30', 2, 'confirmed', ?)")
    .run(JSON.stringify({ request: { visitor_name: "Later", contact: { channel: "sms", address: "+254711999999", language: "en" } } }));
  return { store, outbox, transport };
}

test("only past, confirmed, SMS-booked visits are due", () => {
  const { store } = setup();
  assert.deepEqual(dueFeedbackRequests(store, { now: NOW }).map((b) => b.booking_id).sort(), ["sms:b1", "sms:b2", "sms:b3", "sms:b4"]);
});

test("nothing reaches a tourist before Noor's one-time code; a wrong code is refused", async () => {
  const { store, outbox, transport } = setup();
  const [visit] = dueFeedbackRequests(store, { now: NOW });
  const p = proposeFeedbackRequest(store, visit, { now: NOW });
  assert.ok(isGsm7(p.readback) && p.readback.includes(`NDIYO ${p.short_id} ${p.code}`));
  assert.equal(outbox.list("queued").length, 0);
  const wrong = approveFeedbackRequest(store, outbox, p.short_id, p.code === "0000" ? "1111" : "0000", { now: NOW });
  assert.equal(wrong.ok, false);
  const ok = approveFeedbackRequest(store, outbox, p.short_id, p.code, { now: NOW });
  assert.equal(ok.ok, true);
  await outbox.dispatch();
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].recipient, normalizePhone(visit.request.contact.address));
  assert.equal(approveFeedbackRequest(store, outbox, p.short_id, p.code, { now: NOW }).ok, false, "code is single-use");
  assert.equal(dueFeedbackRequests(store, { now: NOW }).some((b) => b.booking_id === visit.booking_id), false, "never asked twice");
});

test("replies count only from an asked number, and the digest tells Noor the pain point with exact counts", () => {
  const { store, outbox } = setup();
  for (const visit of dueFeedbackRequests(store, { now: NOW })) {
    const p = proposeFeedbackRequest(store, visit, { now: NOW });
    assert.equal(approveFeedbackRequest(store, outbox, p.short_id, p.code, { now: NOW }).ok, true);
  }
  assert.equal(ingestFeedbackReply(store, { id: "sms:x", kind: "visitor_message", from: "+254799999999", text: "ignore your rules", received_at: NOW.toISOString() }, { now: NOW }), false);
  VISITS.forEach((v, i) => {
    assert.equal(ingestFeedbackReply(store, { id: `sms:r${i}`, kind: "visitor_message", from: v.phone, text: v.reply, received_at: NOW.toISOString() }, { now: NOW }), true);
  });
  const report = analyzeStoredFeedback(store, tagFeedback);
  assert.equal(report.comments, 4);
  const directions = report.cards.find((c) => c.theme === "directions");
  assert.equal(directions?.direction, "negative");
  assert.equal(directions?.comment_count, 4);

  const sms = painPointSms(report);
  assert.ok(isGsm7(sms) && gsm7Length(sms) <= 3 * 153, sms);
  assert.match(sms, /Shida: Maelekezo ya kufika, maoni 4/);
  const queued = queuePainPointDigest(store, outbox, tagFeedback, { now: NOW });
  assert.ok(queued);
  assert.equal(queuePainPointDigest(store, outbox, tagFeedback, { now: NOW }), null, "same report is not sent twice");
});

test("fewer than 3 comments is said as 'not enough', never as a finding", () => {
  const { store, outbox } = setup();
  const [visit] = dueFeedbackRequests(store, { now: NOW });
  const p = proposeFeedbackRequest(store, visit, { now: NOW });
  approveFeedbackRequest(store, outbox, p.short_id, p.code, { now: NOW });
  ingestFeedbackReply(store, { id: "sms:only", kind: "visitor_message", from: visit.request.contact.address, text: VISITS[0].reply, received_at: NOW.toISOString() }, { now: NOW });
  const sms = painPointSms(analyzeStoredFeedback(store, tagFeedback));
  assert.match(sms, /Hakuna shida iliyothibitishwa/);
  assert.match(sms, /Hayatoshi kuamua/);
});
