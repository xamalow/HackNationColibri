// Max's plan end to end through hub.mjs (all synthetic, simulated transports, fictional UK drama-range numbers):
// tourist SMS -> Noor's read-back with a one-time code -> NDIYO / HAPANA / suggestion -> tourist answered ->
// after the visit a feedback request (Noor's yes) -> tourist reply -> pain points to Noor. Plus Noor's queries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFarmSheet } from "../src/bookings.mjs";
import { handleOwnerSms } from "../src/commands.mjs";
import { createHub, HUB_LIMITS } from "../src/hub.mjs";
import { createOutbox } from "../src/outbox.mjs";
import { platformAdapters } from "../src/publish.mjs";
import { openStore } from "../src/store.mjs";
import { simulatedOutbound } from "../src/transports/simulated.mjs";
import { tagFeedback } from "../../../contrib/max/tagger/tag_feedback.mjs";

const NOOR = "+447700900999";
const TOURIST = "+447700900456";
const SPOOFER = "+447700900123";
const REQUEST = "Hello! Can we visit the coffee farm on Saturday 17 October? We are 4 people. Thanks, Claire";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "hub-flow-"));
  const log = join(dir, "out.jsonl");
  const clock = { t: new Date("2026-10-04T15:00:00Z") };
  const now = () => clock.t;
  const store = openStore(":memory:");
  store.setKV("owner.phone", NOOR);
  const sheet = loadFarmSheet();
  const outbox = createOutbox(store, simulatedOutbound(log), { now });
  const adapters = platformAdapters({ env: {}, logPath: join(dir, "platform.jsonl") });
  const hub = createHub({ store, sheet, outbox, adapters, now, tagger: tagFeedback });
  const sent = () => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const to = (n) => sent().filter((m) => m.recipient === n && m.channel === "sms").map((m) => m.body);
  const sms = (id, from, text) => ({ id, kind: "visitor_message", channel: "sms", received_at: now().toISOString(), from, text, synthetic: true });
  return { store, hub, outbox, clock, to, sms, sheet };
}

async function proposed(env) {
  const r = env.hub.handleEvent(env.sms("sms:t1", TOURIST, REQUEST));
  await env.outbox.dispatch();
  assert.equal(r.action, "request_proposed");
  const [, pid, code] = env.to(NOOR).at(-1).match(/NDIYO ([A-Z]+) (\d+)/);
  return { r, pid, code };
}

const bookingRows = (store) => store.db.prepare("SELECT booking_id, platform, date, party_size, state FROM bookings").all().map((b) => ({ ...b }));

test("tourist SMS -> Noor's read-back -> spoof refused -> NDIYO confirms once -> feedback asked with her yes -> pain points", async () => {
  const env = setup();
  const { store, hub, outbox, clock, to, sms } = env;
  const { pid, code } = await proposed(env);
  assert.equal(to(TOURIST).length, 1, "the tourist gets one fixed acknowledgement, no commitment");
  assert.ok(!to(NOOR).at(-1).includes(TOURIST.slice(4)), "Noor's read-back never carries the tourist's number");
  assert.deepEqual(bookingRows(store), [], "nothing is booked before Noor decides");

  // Someone else with the right code: no booking, no reply (warden F1).
  await hub.ownerSms({ from: SPOOFER, text: `NDIYO ${pid} ${code}` });
  assert.deepEqual(bookingRows(store), []);
  assert.equal(to(SPOOFER).length, 0);

  const ok = await hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
  assert.equal(ok.executed.kind, "booking_request");
  assert.equal(ok.executed.outcome, "confirmed");
  assert.deepEqual(bookingRows(store), [{ booking_id: `direct:${pid}`, platform: "direct", date: "2026-10-17", party_size: 4, state: "confirmed" }]);
  assert.equal(to(TOURIST).length, 2, "the confirmation goes to the tourist");
  assert.match(to(NOOR).at(-1), /Mgeni atapata uthibitisho/, "Noor's reply speaks of the guest, not of websites");

  // The same code again: refused, nothing new to the tourist.
  await hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
  assert.equal(to(TOURIST).length, 2);

  // Noor asks who comes on 17/10: answered to her enrolled number, read-only.
  const q = await hub.ownerSms({ from: NOOR, text: "WAGENI 17/10" });
  assert.equal(q.command, "query");
  assert.equal(q.reply_sent, true);
  assert.match(to(NOOR).at(-1), /4/);

  // After the visit: a feedback request is PROPOSED to Noor, the tourist gets nothing before her yes.
  clock.t = new Date("2026-10-18T09:00:00Z");
  const tick = hub.feedbackTick();
  await outbox.dispatch();
  assert.equal(tick.proposed.length, 1);
  assert.equal(hub.feedbackTick().proposed.length, 0, "proposed once per visit");
  assert.equal(to(TOURIST).length, 2);
  const [, fid, fcode] = to(NOOR).at(-1).match(/NDIYO ([A-Z]+) (\d+)/);
  const fb = await hub.ownerSms({ from: NOOR, text: `NDIYO ${fid} ${fcode}` });
  assert.equal(fb.executed.kind, "feedback_request");
  assert.equal(fb.executed.ok, true);
  assert.equal(to(TOURIST).length, 3, "one feedback request to the tourist");

  // The tourist's answer is stored as feedback (data), not read as a new booking request.
  const reply = hub.handleEvent(sms("sms:t2", TOURIST, "The coffee tasting was wonderful but the road was hard to find, we got lost twice."));
  assert.equal(reply.action, "feedback_reply");
  const digest = hub.feedbackTick();
  await outbox.dispatch();
  assert.ok(digest.digest);
  assert.match(to(NOOR).at(-1), /^SAUTI: Maoni ya wageni \(1\)/);
  // Noor can ask for it again later: MAONI answers with the latest digest.
  await hub.ownerSms({ from: NOOR, text: "MAONI" });
  assert.match(to(NOOR).at(-1), /^SAUTI MAONI: Maoni ya wageni \(1\)/);
  assert.equal(hub.feedbackTick().digest, null, "the same report is not sent twice");
});

test("HAPANA on a booking request needs the code; with it the tourist is declined and nothing is booked", async () => {
  const env = setup();
  const { pid, code } = await proposed(env);
  await env.hub.ownerSms({ from: NOOR, text: `HAPANA ${pid}` });
  assert.match(env.to(NOOR).at(-1), /namba uliyopewa/);
  assert.equal(env.to(TOURIST).length, 1);
  const r = await env.hub.ownerSms({ from: NOOR, text: `HAPANA ${pid} ${code}` });
  assert.equal(r.executed.outcome, "declined");
  assert.equal(env.to(TOURIST).length, 2);
  assert.deepEqual(bookingRows(env.store), []);
  await env.hub.runApproved();
  assert.equal(env.to(TOURIST).length, 2, "a decline is sent once");
});

test("Noor's suggestion is relayed to the tourist and the request stays open until NDIYO", async () => {
  const env = setup();
  const { pid, code } = await proposed(env);
  const s = await env.hub.ownerSms({ from: NOOR, text: `${pid} ${code} nitachelewa kidogo` });
  assert.equal(s.command, "suggest");
  assert.equal(s.relayed.outcome, "relayed");
  assert.equal(env.to(TOURIST).length, 2);
  assert.match(env.to(TOURIST).at(-1), /nitachelewa kidogo/);
  assert.deepEqual(bookingRows(env.store), []);
  const ok = await env.hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
  assert.equal(ok.executed.outcome, "confirmed");
});

test("a crash after Noor's NDIYO loses nothing: recover() confirms to the tourist once", async () => {
  const env = setup();
  const { pid, code } = await proposed(env);
  // The code is redeemed (state approved) but the process dies before the hub executes.
  assert.equal(handleOwnerSms(env.store, { from: NOOR, text: `NDIYO ${pid} ${code}` }, { now: env.clock.t }).command.type, "approve");
  assert.deepEqual(bookingRows(env.store), []);
  await env.hub.recover();
  await env.outbox.dispatch();
  assert.equal(bookingRows(env.store).length, 1);
  assert.equal(env.to(TOURIST).length, 2);
  await env.hub.recover();
  await env.outbox.dispatch();
  assert.equal(env.to(TOURIST).length, 2);
});

test("a question is not a booking request: no automatic reply, Noor is alerted", async () => {
  const env = setup();
  const r = env.hub.handleEvent(env.sms("sms:q1", TOURIST, "Hi, how do we get to the farm from Machakos town? Is lunch included?"));
  await env.outbox.dispatch();
  assert.equal(r.action, "question");
  assert.equal(r.alerted, true);
  assert.equal(env.to(TOURIST).length, 0);
  assert.equal(env.to(NOOR).length, 1);
});

test("query replies and automatic tourist replies are capped per day", async () => {
  const env = setup();
  for (let i = 0; i < HUB_LIMITS.maxQueryRepliesPerDay + 3; i++) await env.hub.ownerSms({ from: NOOR, text: "LEO" });
  assert.equal(env.to(NOOR).length, HUB_LIMITS.maxQueryRepliesPerDay);
  const hub2 = createHub({ store: env.store, sheet: loadFarmSheet(), outbox: env.outbox, now: () => env.clock.t, limits: { maxTouristAutoRepliesPerDay: 1 } });
  hub2.handleEvent(env.sms("sms:a", "+447700900401", "Can we come on 17 October?"));
  hub2.handleEvent(env.sms("sms:b", "+447700900402", "Can we come on 17 October?"));
  await env.outbox.dispatch();
  assert.equal(env.to("+447700900401").length + env.to("+447700900402").length, 1);
});

test("B15: a German request langid abstains on is answered in German, and Noor sees the language", async () => {
  const env = setup();
  env.hub.handleEvent(env.sms("sms:de", "+447700900402", "Hallo! Können wir am Samstag, 17. Oktober, die Kaffeefarm besuchen? Wir sind 4 Personen."));
  await env.outbox.dispatch();
  assert.match(env.to("+447700900402").at(-1), /Danke|Vielen/);
  assert.match(env.to(NOOR).at(-1), /Kijerumani/);
});

test("Noor can tell feedback requests apart: day and party size, never the number", async () => {
  const env = setup();
  const { pid, code } = await proposed(env);
  await env.hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
  env.clock.t = new Date("2026-10-18T09:00:00Z");
  env.hub.feedbackTick();
  await env.outbox.dispatch();
  const rb = env.to(NOOR).at(-1);
  assert.match(rb, /wa Jumamosi 17\/10 \(watu 4\) ombi la maoni/);
  assert.ok(!rb.includes("900456"));
});

test("a day code already refused: the tourist is told by code, Noor gets a short notice (not 'a message waits')", async () => {
  const env = setup();
  env.hub.handleEvent(env.sms("sms:big", TOURIST, "Can we visit on Saturday 17 October? We are 11 people."));
  await env.outbox.dispatch();
  assert.equal(env.to(TOURIST).length, 1);
  assert.match(env.to(NOOR).at(-1), /^SAUTI: Mgeni aliomba watu 11, Jumamosi 17\/10: .*Mgeni amejibiwa\.$/);
});

test("warden #58 (3): a changed tour time reaches Noor as ONE fresh read-back, sent sensitive; a GYG sale at the old time alerts her", async () => {
  const env = setup();
  const { pid, code } = await proposed(env);
  env.sheet.hours = { start: "10:00:00", end: "16:00:00" };
  const before = env.to(NOOR).length;
  const r = await env.hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
  assert.equal(r.executed.outcome, "needs_owner");
  const fresh = env.to(NOOR).slice(before).filter((m) => /saa ya ziara imebadilika/.test(m));
  assert.equal(fresh.length, 1);
  assert.equal(env.to(TOURIST).length, 1, "the tourist only has the acknowledgement");
  const rows = env.store.db.prepare("SELECT body FROM outbox WHERE recipient = ? AND status = 'SENT'").all(NOOR).map((x) => x.body);
  assert.ok(!rows.some((b) => /saa ya ziara imebadilika/.test(b)), "the read-back with a code is redacted after send");
  await env.hub.runApproved();
  await env.outbox.dispatch();
  assert.equal(env.to(NOOR).filter((m) => /saa ya ziara imebadilika/.test(m)).length, 1, "not re-sent");
  // Once queued, the read-back text (it holds a one-time code) is not kept anywhere but the outbox (redacted after send).
  assert.equal(env.store.getKV(`booking_requests.reissue_sms.${pid}`).sms, null);
  // codex: crash after the read-back was queued but before proposal.executed was written -> recover sends nothing new.
  env.store.setKV(`proposal.executed.${pid}`, null);
  await env.hub.recover();
  await env.outbox.dispatch();
  await env.hub.recover();
  await env.outbox.dispatch();
  assert.equal(env.to(NOOR).filter((m) => /saa ya ziara imebadilika/.test(m)).length, 1, "no second read-back with another code");
  const sale = env.hub.handleEvent({
    id: "gyg:old-time", kind: "booking", channel: "gyg_api", received_at: env.clock.t.toISOString(), synthetic: true,
    booking: { platform: "getyourguide", ref: "GYG-OLD", date: "2026-10-17", time: "09:00", party_size: 2, visitor_name: "Lena" },
  });
  assert.equal(sale.action, "conflict");
  assert.equal(sale.alerted, true);
});

test("autoFeedback (Max): after the visit the fixed question goes straight to the visitor, once, without asking Noor", async () => {
  const env = setup();
  const { pid, code } = await proposed(env);
  await env.hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
  const auto = createHub({ store: env.store, sheet: loadFarmSheet(), outbox: env.outbox, now: () => env.clock.t, tagger: tagFeedback, autoFeedback: true });
  const toNoor = env.to(NOOR).length;
  env.clock.t = new Date("2026-10-18T09:00:00Z");
  const tick = auto.feedbackTick();
  await env.outbox.dispatch();
  assert.equal(tick.sent.length, 1);
  assert.equal(tick.proposed.length, 0);
  assert.equal(env.to(NOOR).length, toNoor, "Noor is not asked");
  assert.match(env.to(TOURIST).at(-1), /What did you like, and what could be better\?/);
  assert.equal(auto.feedbackTick().sent.length, 0, "once per visit");
  const reply = auto.handleEvent(env.sms("sms:fb", TOURIST, "The coffee was great but the road was hard to find."));
  assert.equal(reply.action, "feedback_reply", "the answer is stored as feedback");
});

test("demo:check capacity race: NDIYO on a request the day can no longer hold gets the explanation, never 'Mgeni atapata uthibitisho'", async () => {
  const env = setup();
  const OTHER = "+447700900457";
  const a = env.hub.handleEvent(env.sms("sms:r1", TOURIST, "Hello, we would like to visit on Tuesday 13 October, 6 people."));
  const b = env.hub.handleEvent(env.sms("sms:r2", OTHER, "Hi, can we visit on Tuesday 13 October? We are 6 people."));
  await env.outbox.dispatch();
  assert.deepEqual([a.action, b.action], ["request_proposed", "request_proposed"], "each fits alone");
  const codeOf = (id) => env.to(NOOR).map((m) => new RegExp(`NDIYO ${id} (\\d{6})`).exec(m)).filter(Boolean).at(-1)[1];
  const ra = await env.hub.ownerSms({ from: NOOR, text: `NDIYO ${a.proposal_id} ${codeOf(a.proposal_id)}` });
  assert.equal(ra.executed.outcome, "confirmed");
  assert.match(env.to(NOOR).at(-1), /Mgeni atapata uthibitisho/, "a real confirmation is acknowledged");
  const before = env.to(NOOR).length;
  const rb = await env.hub.ownerSms({ from: NOOR, text: `NDIYO ${b.proposal_id} ${codeOf(b.proposal_id)}` });
  assert.notEqual(rb.executed.outcome, "confirmed");
  const toNoor = env.to(NOOR).slice(before);
  assert.equal(toNoor.length, 1, "one SMS to Noor: why it was not booked");
  assert.match(toNoor[0], new RegExp(`^SAUTI: ${b.proposal_id} haikuthibitishwa: Jumanne 13/10 imejaa`));
  assert.ok(!toNoor.some((m) => /atapata uthibitisho/.test(m)), "no acknowledgement that contradicts it");
  assert.equal(env.store.db.prepare("SELECT SUM(party_size) AS n FROM bookings WHERE date = '2026-10-13' AND state = 'confirmed'").get().n, 6);
});
