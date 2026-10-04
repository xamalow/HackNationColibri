/* global fetch */
// The voice agent's HTTP API (voice_api.mjs through sync.mjs), shapes as hub_voice/hubclient.py sends and parses
// them. All synthetic: fictional UK drama-range numbers (+447700900xxx), simulated transports, in-memory store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFarmSheet } from "../src/bookings.mjs";
import { LOCK_KV } from "../src/commands.mjs";
import { CLOSED_DAYS_KV, createHub, SHEET_OVERRIDES_KV } from "../src/hub.mjs";
import { createOutbox } from "../src/outbox.mjs";
import { platformAdapters } from "../src/publish.mjs";
import { openStore } from "../src/store.mjs";
import { createSyncServer, pairDevice } from "../src/sync.mjs";
import { simulatedOutbound } from "../src/transports/simulated.mjs";
import { createVoiceApi, ownerMatches, ownerNumberForms, VOICE_ROUTES } from "../src/voice_api.mjs";
import { tagFeedback } from "../../../contrib/max/tagger/tag_feedback.mjs";

const NOOR = "+447700900999";
const TOURIST = "+447700900456";
const OTHER = "+447700900123";
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

async function setup(t, { tagger = tagFeedback, limits = {}, sheet = loadFarmSheet() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hub-voice-api-"));
  const log = join(dir, "out.jsonl");
  const clock = { t: new Date("2026-10-04T15:00:00Z") }; // Sunday, after the tour
  const now = () => clock.t;
  const store = openStore(":memory:");
  store.setKV("owner.phone", NOOR);
  const outbox = createOutbox(store, simulatedOutbound(log), { now });
  const hub = createHub({ store, sheet, outbox, adapters: platformAdapters({ env: {}, logPath: join(dir, "platform.jsonl") }), now, tagger });
  const voice = createVoiceApi({ store, sheet, outbox, tagger, now, limits });
  const server = createSyncServer({ store, voice, log: () => {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = pairDevice(store, "hub-voice");
  const auth = { Authorization: `Bearer ${token}` };
  const get = async (path, headers = auth) => { const r = await fetch(base + path, { headers }); return { status: r.status, body: await r.json() }; };
  const post = async (path, obj, headers = auth) => {
    const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof obj === "string" ? obj : JSON.stringify(obj) });
    return { status: r.status, body: await r.json() };
  };
  const sent = () => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const to = (n) => sent().filter((m) => m.recipient === n && m.channel === "sms").map((m) => m.body);
  const proposals = () => store.db.prepare("SELECT short_id, kind, state FROM proposals ORDER BY short_id").all().map((r) => ({ ...r }));
  const bookings = () => store.db.prepare("SELECT booking_id, date, party_size, state FROM bookings").all().map((r) => ({ ...r }));
  const touristSms = (id, text) => hub.handleEvent({ id, kind: "visitor_message", channel: "sms", received_at: now().toISOString(), from: TOURIST, text, synthetic: true });
  return { store, hub, outbox, clock, get, post, sent, to, proposals, bookings, touristSms, base, auth };
}

const voiceBooking = (over = {}) => ({
  tenant_id: "noor-farm",
  source: { channel: "voice", call_id: "call-0001" },
  booking: { date: "2026-10-17", party_size: 4, visitor_name: "Claire Example", language: "en" },
  note: "asked about lunch",
  ...over,
});
const ownerChange = (change, call_id = "call-owner-1") => ({
  tenant_id: "noor-farm", source: { channel: "voice_owner", call_id }, change: { about_ref: "", ...change },
});
const codeFrom = (sms) => sms.match(/NDIYO ([A-Z]+) (\d+)/).slice(1);

test("every voice route answers 401 without a valid token, and the error carries no detail", async (t) => {
  const env = await setup(t);
  for (const path of VOICE_ROUTES) {
    for (const headers of [{}, { Authorization: "Bearer sst_" + "x".repeat(43) }]) {
      const g = await env.get(`${path}?date=2026-10-17&status=pending_owner&sha256=${sha(NOOR)}`, headers);
      assert.equal(g.status, 401, path);
      assert.deepEqual(g.body, { error: { code: "unauthorized", message: "missing or invalid bearer token" } });
    }
  }
  const p = await env.post("/v1/proposals", voiceBooking(), {});
  assert.equal(p.status, 401);
  const o = await env.post("/v1/owner-proposals", ownerChange({ kind: "close_day", text: "funga 2026-10-16" }), {});
  assert.equal(o.status, 401);
  assert.deepEqual(env.proposals(), []);
  assert.deepEqual(env.sent(), []);
});

test("GET /v1/availability: computed by code; closed, blocked, non-tour and past days are not open", async (t) => {
  const env = await setup(t);
  let r = await env.get("/v1/availability?date=2026-10-17");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { date: "2026-10-17", capacity: 10, confirmed: 0, remaining: 10, open: true, reason: null });

  env.hub.handleEvent({ id: "gyg-1", kind: "booking", channel: "email_gyg", received_at: env.clock.t.toISOString(), synthetic: true,
    booking: { platform: "getyourguide", ref: "GYG-1", date: "2026-10-17", party_size: 3, visitor_name: "Thomas Example" } });
  r = await env.get("/v1/availability?date=2026-10-17");
  assert.deepEqual(r.body, { date: "2026-10-17", capacity: 10, confirmed: 3, remaining: 7, open: true, reason: null });

  assert.deepEqual((await env.get("/v1/availability?date=2026-10-18")).body, { date: "2026-10-18", capacity: 10, confirmed: 0, remaining: 0, open: false, reason: "not_a_tour_day" });
  assert.equal((await env.get("/v1/availability?date=2026-10-04")).body.reason, "past");
  env.store.setKV(CLOSED_DAYS_KV, { "2026-10-16": { approval_id: "X" } });
  const closed = (await env.get("/v1/availability?date=2026-10-16")).body;
  assert.equal(closed.open, false);
  assert.equal(closed.remaining, 0);
  assert.equal(closed.reason, "closed_by_owner");

  for (const bad of ["2026-02-30", "17/10/2026", "", "2026-10-17T00:00"]) {
    const e = await env.get(`/v1/availability?date=${encodeURIComponent(bad)}`);
    assert.equal(e.status, 400);
    assert.equal(e.body.error.code, "invalid_date");
  }
  assert.equal((await env.post("/v1/availability", {})).status, 405);
});

test("GET /v1/farm: approved facts with approved overrides; no phone, no private key", async (t) => {
  const sheet = { ...loadFarmSheet(), owner_phone: NOOR, contact: { phone: NOOR }, api_token: "secret-value" };
  const env = await setup(t, { sheet });
  env.store.setKV(SHEET_OVERRIDES_KV, { capacity_per_tour: 8 });
  const r = await env.get("/v1/farm");
  assert.equal(r.status, 200);
  assert.equal(r.body.price_per_person_kes, 2000);
  assert.equal(r.body.capacity_per_tour, 8);
  assert.deepEqual(r.body.days, ["mon", "tue", "wed", "thu", "fri", "sat"]);
  assert.ok(r.body.directions_sw);
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes("7700900"), "no phone number");
  assert.ok(!text.includes("secret-value"));
  assert.equal(r.body.owner_phone, undefined);
});

test("GET /v1/owner/match: sha256 of the enrolled number (owner.py normalisation), constant-time, never echoed", async (t) => {
  const env = await setup(t);
  // hub_voice/owner.py: "tel:+44 7700 900999" -> "+447700900999" -> sha256 hex.
  let r = await env.get(`/v1/owner/match?sha256=${sha("+447700900999")}`);
  assert.deepEqual(r.body, { match: true });
  assert.deepEqual((await env.get(`/v1/owner/match?sha256=${sha("447700900999")}`)).body, { match: true }, "a carrier that drops the + still matches");
  assert.deepEqual((await env.get(`/v1/owner/match?sha256=${sha(OTHER)}`)).body, { match: false });
  assert.deepEqual((await env.get(`/v1/owner/match?sha256=${sha("+447700900999").toUpperCase()}`)).body, { match: true });
  for (const bad of ["", "abc", sha(NOOR).slice(1), `${sha(NOOR)}00`, NOOR]) {
    const e = await env.get(`/v1/owner/match?sha256=${encodeURIComponent(bad)}`);
    assert.equal(e.status, 400);
    assert.ok(!JSON.stringify(e.body).includes("7700900"));
  }
  env.store.setKV("owner.phone", null);
  r = await env.get(`/v1/owner/match?sha256=${sha(NOOR)}`);
  assert.deepEqual(r.body, { match: false }, "no enrolled owner: never a match");
  // Kenyan national form, pure functions only (no number in a request).
  assert.deepEqual(ownerNumberForms("+254 7" + "00 000 002").length, 3);
  assert.equal(ownerMatches(NOOR, "z".repeat(64)), false);
});

test("GET /v1/owner/match is rate limited per device", async (t) => {
  const env = await setup(t);
  const codes = [];
  for (let i = 0; i < 32; i++) codes.push((await env.get(`/v1/owner/match?sha256=${sha(OTHER)}`)).status);
  assert.equal(codes.filter((c) => c === 200).length, 30);
  assert.equal(codes.at(-1), 429);
});

test("POST /v1/proposals: a voice booking request becomes a proposal + read-back to Noor; nothing goes to the guest", async (t) => {
  const env = await setup(t);
  const r = await env.post("/v1/proposals", voiceBooking());
  assert.equal(r.status, 201);
  assert.match(r.body.ref, /^[A-Z]{1,3}$/);
  assert.match(r.body.action_id, new RegExp(`^${r.body.ref}:[0-9a-f]{12}$`));
  assert.equal(r.body.status, "pending_owner");
  assert.equal(env.to(NOOR).length, 1);
  const readback = env.to(NOOR)[0];
  assert.match(readback, /watu 4/);
  assert.match(readback, /KES 8000/);
  assert.match(readback, /mpigie simu/);
  assert.ok(!readback.includes("<ujumbe>"), "no suggestion form: there is nowhere to relay it");
  assert.deepEqual(env.sent().map((m) => m.recipient), [NOOR], "only Noor's enrolled number gets anything");
  assert.deepEqual(env.bookings(), [], "nothing booked on the call");

  // The agent retries the same request: same ref, no second SMS.
  const again = await env.post("/v1/proposals", voiceBooking());
  assert.equal(again.status, 200);
  assert.equal(again.body.ref, r.body.ref);
  assert.equal(env.to(NOOR).length, 1);

  // Pending list: ref, date, party size, source, filed_at; never a name or a number.
  env.touristSms("sms:t1", "Hello! Can we visit the coffee farm on Saturday 17 October? We are 2 people. Thanks, Claire");
  const p = await env.get("/v1/proposals?status=pending_owner");
  assert.equal(p.status, 200);
  assert.equal(p.body.pending.length, 2);
  for (const item of p.body.pending) assert.deepEqual(Object.keys(item).sort(), ["date", "filed_at", "party_size", "ref", "source"]);
  assert.deepEqual(p.body.pending.map((i) => [i.date, i.party_size, i.source]), [["2026-10-17", 4, "voice"], ["2026-10-17", 2, "sms"]]);
  const text = JSON.stringify(p.body);
  assert.ok(!/claire/i.test(text) && !text.includes("7700900"), "no names, no numbers");
  assert.equal((await env.get("/v1/proposals?status=approved")).status, 400);

  // Noor's NDIYO with the code (SMS from her enrolled phone) books it; still nothing to the guest.
  const [pid, code] = codeFrom(readback);
  const ok = await env.hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
  assert.equal(ok.executed.kind, "booking_request");
  assert.equal(ok.executed.outcome, "confirmed");
  assert.deepEqual(env.bookings(), [{ booking_id: `direct:${pid}`, date: "2026-10-17", party_size: 4, state: "confirmed" }]);
  assert.ok(env.to(NOOR).some((b) => b === `Sawa. ${pid} imeidhinishwa. Mgeni alipiga simu, hana SMS: mpigie simu kumthibitishia.`));
  assert.deepEqual(env.to(TOURIST).length, 1, "the SMS tourist only got their own acknowledgement");
  assert.ok(env.sent().every((m) => m.recipient === NOOR || m.recipient === TOURIST));
  const after = await env.get("/v1/proposals?status=pending_owner");
  assert.deepEqual(after.body.pending.map((i) => i.source), ["sms"]);
  assert.equal((await env.get("/v1/availability?date=2026-10-17")).body.confirmed, 4);
  const dup = await env.post("/v1/proposals", voiceBooking());
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, "already_decided");
});

test("POST /v1/proposals: HAPANA and a suggestion on a voice request send nothing to anyone but Noor", async (t) => {
  const env = await setup(t);
  const r = await env.post("/v1/proposals", voiceBooking());
  const [pid, code] = codeFrom(env.to(NOOR)[0]);
  assert.equal(pid, r.body.ref);
  const s = await env.hub.ownerSms({ from: NOOR, text: `${pid} ${code} nitachelewa kidogo` });
  assert.equal(s.command, null);
  assert.match(env.to(NOOR).at(-1), /hana SMS/);
  const no = await env.hub.ownerSms({ from: NOOR, text: `HAPANA ${pid} ${code}` });
  assert.equal(no.executed.outcome, "declined");
  assert.match(env.to(NOOR).at(-1), /mpigie simu kumwambia/);
  assert.ok(env.sent().every((m) => m.recipient === NOOR));
  assert.deepEqual(env.bookings(), []);
});

test("POST /v1/proposals: unavailable or invalid requests create no proposal; validation is strict", async (t) => {
  const env = await setup(t);
  const sunday = await env.post("/v1/proposals", voiceBooking({ booking: { date: "2026-10-18", party_size: 2, visitor_name: "", language: "sw" } }));
  assert.equal(sunday.status, 409);
  assert.equal(sunday.body.status, "unavailable");
  assert.equal(sunday.body.reason, "closed_day");
  const full = await env.post("/v1/proposals", voiceBooking({ booking: { date: "2026-10-17", party_size: 11, visitor_name: "", language: "sw" } }));
  assert.equal(full.status, 409);
  assert.equal(full.body.reason, "full");
  const past = await env.post("/v1/proposals", voiceBooking({ booking: { date: "2026-10-01", party_size: 2, visitor_name: "", language: "sw" } }));
  assert.equal(past.body.reason, "too_late");

  const bad = [
    voiceBooking({ booking: { date: "17/10/2026", party_size: 2, visitor_name: "", language: "en" } }),
    voiceBooking({ booking: { date: "2026-10-17", party_size: 0, visitor_name: "", language: "en" } }),
    voiceBooking({ booking: { date: "2026-10-17", party_size: 2.5, visitor_name: "", language: "en" } }),
    voiceBooking({ booking: { date: "2026-10-17", party_size: "4", visitor_name: "", language: "en" } }),
    voiceBooking({ booking: { date: "2026-10-17", party_size: 4, visitor_name: "x".repeat(81), language: "en" } }),
    voiceBooking({ booking: { date: "2026-10-17", party_size: 4, visitor_name: "", language: "en", phone: TOURIST } }),
    voiceBooking({ source: { channel: "sms", call_id: "c1" } }),
    voiceBooking({ source: { channel: "voice", call_id: "bad id with spaces" } }),
    voiceBooking({ tenant_id: "" }),
    voiceBooking({ note: "n".repeat(301) }),
    { ...voiceBooking(), approved: true },
    [],
  ];
  for (const b of bad) {
    const e = await env.post("/v1/proposals", b);
    assert.equal(e.status, 400, JSON.stringify(b).slice(0, 80));
    assert.ok(!JSON.stringify(e.body).includes("7700900") && !JSON.stringify(e.body).includes(" at "));
  }
  assert.equal((await env.post("/v1/proposals", "{not json")).status, 400);
  const big = await env.post("/v1/proposals", voiceBooking({ note: "x".repeat(17 * 1024) }));
  assert.equal(big.status, 413);
  const r = await fetch(env.base + "/v1/proposals", { method: "POST", headers: { ...env.auth, "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(r.status, 415);
  assert.deepEqual(env.proposals(), []);
  assert.deepEqual(env.sent(), []);
});

test("POST /v1/owner-proposals close_day: read-back with code to the enrolled number only; NDIYO closes the day", async (t) => {
  const env = await setup(t);
  const r = await env.post("/v1/owner-proposals", ownerChange({ kind: "close_day", text: "funga 16/10" }));
  assert.equal(r.status, 201);
  assert.equal(r.body.status, "pending_owner");
  assert.equal(r.body.kind, "close_day");
  assert.match(r.body.action_id, new RegExp(`^${r.body.ref}:[0-9a-f]{12}$`));
  assert.deepEqual(env.store.getKV(CLOSED_DAYS_KV, {}), {}, "nothing changed on the call");
  assert.deepEqual(env.sent().map((m) => m.recipient), [NOOR]);
  const rb = env.to(NOOR)[0];
  assert.match(rb, /^SAUTI: Ufunge Ijumaa 16\/10/);
  // The read-back carries a code: the stored outbox body is redacted once sent.
  assert.equal(env.store.db.prepare("SELECT body FROM outbox").get().body, "[redacted after send]");
  const [pid, code] = codeFrom(rb);
  assert.equal(pid, r.body.ref);

  // A spoofed sender with the right code changes nothing.
  await env.hub.ownerSms({ from: OTHER, text: `NDIYO ${pid} ${code}` });
  assert.deepEqual(env.store.getKV(CLOSED_DAYS_KV, {}), {});
  const ok = await env.hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
  assert.equal(ok.executed.kind, "close_day");
  assert.ok(env.store.getKV(CLOSED_DAYS_KV, {})["2026-10-16"]);
  assert.equal((await env.get("/v1/availability?date=2026-10-16")).body.open, false);

  // Same request again (agent retry): same answer, no second read-back.
  const again = await env.post("/v1/owner-proposals", ownerChange({ kind: "close_day", text: "funga 16/10" }));
  assert.equal(again.body.ref, r.body.ref);
  assert.equal(env.to(NOOR).filter((b) => b.startsWith("SAUTI: Ufunge")).length, 1);
});

test("POST /v1/owner-proposals open_day and capacity map to the SMS command kinds and execute unchanged", async (t) => {
  const env = await setup(t);
  env.store.setKV(CLOSED_DAYS_KV, { "2026-10-16": { approval_id: "X" } });
  const o = await env.post("/v1/owner-proposals", ownerChange({ kind: "open_day", text: "fungua siku hiyo", date: "2026-10-16" }));
  assert.equal(o.status, 201);
  assert.equal(o.body.kind, "reopen_day");
  const c = await env.post("/v1/owner-proposals", ownerChange({ kind: "capacity", text: "nafasi ziwe nane" }, "call-owner-2"));
  assert.equal(c.status, 201);
  assert.equal(c.body.kind, "capacity");
  const [rbOpen, rbCap] = env.to(NOOR);
  assert.match(rbCap, /Nafasi ziwe 8 kwa kila ziara/);
  for (const rb of [rbOpen, rbCap]) {
    const [pid, code] = codeFrom(rb);
    await env.hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
  }
  assert.deepEqual(env.store.getKV(CLOSED_DAYS_KV, {}), {});
  assert.equal((await env.get("/v1/farm")).body.capacity_per_tour, 8);

  for (const [change, code] of [
    [{ kind: "close_day", text: "funga" }, "need_date"],
    [{ kind: "close_day", text: "funga 12/10 au 13/10" }, "need_date"],
    [{ kind: "close_day", text: "", date: "2026-10-01" }, "past_date"],
    [{ kind: "capacity", text: "nafasi 8 au 9" }, "need_number"],
    [{ kind: "capacity", text: "nafasi" }, "need_number"],
  ]) {
    const e = await env.post("/v1/owner-proposals", ownerChange(change, "call-owner-x"));
    assert.equal(e.status, 422, JSON.stringify(change));
    assert.equal(e.body.error.code, code);
  }
  for (const change of [{ kind: "approve", text: "ndiyo thibitisha" }, { kind: "capacity", text: "", capacity: 500 }, { kind: "close_day", text: "x", recipient: OTHER }]) {
    assert.equal((await env.post("/v1/owner-proposals", ownerChange(change, "call-owner-y"))).status, 400);
  }
  assert.equal(env.proposals().length, 2, "refused changes create nothing");
});

test("running_late / message_to_visitor: a visitor_note proposal; NDIYO with code sends exactly one SMS to that tourist", async (t) => {
  const env = await setup(t);
  env.touristSms("sms:t1", "Hello! Can we visit the coffee farm on Saturday 17 October? We are 4 people. Thanks, Claire");
  await env.outbox.dispatch();
  const [bookingRef] = codeFrom(env.to(NOOR)[0]);
  assert.equal(env.to(TOURIST).length, 1);

  const r = await env.post("/v1/owner-proposals", ownerChange({ kind: "running_late", text: "nitachelewa kidogo, saa nne", about_ref: bookingRef }));
  assert.equal(r.status, 201);
  assert.equal(r.body.kind, "visitor_note");
  assert.equal(env.to(TOURIST).length, 1, "nothing to the tourist before Noor's code");
  const rb = env.to(NOOR).at(-1);
  assert.match(rb, new RegExp(`mgeni wa ${bookingRef} .*"nitachelewa kidogo, saa nne"`));
  assert.ok(!rb.includes("7700900"), "the read-back never carries the tourist's number");
  const [pid, code] = codeFrom(rb);
  assert.equal(pid, r.body.ref);

  await env.hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} 000000` });
  assert.equal(env.to(TOURIST).length, 1, "a wrong code sends nothing");
  const ok = await env.hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
  assert.equal(ok.executed.kind, "visitor_note");
  assert.equal(ok.executed.ok, true);
  assert.match(env.to(NOOR).at(-1), /Ujumbe wako utatumwa kwa mgeni/);
  assert.equal(env.to(TOURIST).length, 2);
  assert.match(env.to(TOURIST).at(-1), /Noor replied \(in Swahili\): «nitachelewa kidogo, saa nne»/);
  await env.hub.runApproved();
  await env.hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
  await env.outbox.dispatch();
  assert.equal(env.to(TOURIST).length, 2, "exactly one SMS");
  assert.ok(env.sent().every((m) => m.recipient === NOOR || m.recipient === TOURIST));

  // A note about a voice request (no SMS address), an unknown ref, or no ref: refused, no proposal, no SMS.
  await env.post("/v1/proposals", voiceBooking());
  const voiceRef = env.proposals().find((p) => p.kind === "booking_request" && p.short_id !== bookingRef).short_id;
  const before = env.proposals().length;
  const sentBefore = env.sent().length;
  const noSms = await env.post("/v1/owner-proposals", ownerChange({ kind: "message_to_visitor", text: "karibu", about_ref: voiceRef }, "c2"));
  assert.equal(noSms.status, 422);
  assert.equal(noSms.body.reason, "no_sms_contact");
  assert.equal((await env.post("/v1/owner-proposals", ownerChange({ kind: "message_to_visitor", text: "karibu", about_ref: "ZZ" }, "c3"))).status, 404);
  assert.equal((await env.post("/v1/owner-proposals", ownerChange({ kind: "message_to_visitor", text: "karibu" }, "c4"))).body.error.code, "need_ref");
  assert.equal((await env.post("/v1/owner-proposals", ownerChange({ kind: "message_to_visitor", text: "   ", about_ref: bookingRef }, "c5"))).status, 422);
  assert.equal(env.proposals().length, before);
  assert.equal(env.sent().length, sentBefore);
});

test("other: an owner alert only (her words back to her enrolled phone), no proposal", async (t) => {
  const env = await setup(t);
  const r = await env.post("/v1/owner-proposals", ownerChange({ kind: "other", text: "nunua mifuko ya kahawa" }));
  assert.equal(r.status, 201);
  assert.equal(r.body.status, "owner_alerted");
  assert.equal(r.body.ref, "");
  assert.match(r.body.action_id, /^alert:[0-9a-f]{16}$/);
  assert.deepEqual(env.proposals(), []);
  assert.deepEqual(env.sent().map((m) => m.recipient), [NOOR]);
  assert.match(env.to(NOOR)[0], /Hakuna kilichobadilishwa/);
});

test("owner-proposals share the SMS commands' daily budget and respect the commands lock", async (t) => {
  const env = await setup(t, { limits: { maxProposalsPerDay: 2 } });
  for (const d of ["2026-10-13", "2026-10-14"]) {
    assert.equal((await env.post("/v1/owner-proposals", ownerChange({ kind: "close_day", text: "", date: d }, `c-${d}`))).status, 201);
  }
  const over = await env.post("/v1/owner-proposals", ownerChange({ kind: "close_day", text: "", date: "2026-10-15" }, "c-3"));
  assert.equal(over.status, 429);
  assert.equal(over.body.error.code, "budget_exhausted");
  assert.equal(env.store.getKV(LOCK_KV, null), null, "the voice path never locks Noor's SMS commands");
  assert.equal(env.proposals().length, 2);

  const env2 = await setup(t);
  env2.store.setKV(LOCK_KV, { reason: "wrong_codes", since: env2.clock.t.toISOString() });
  const locked = await env2.post("/v1/owner-proposals", ownerChange({ kind: "close_day", text: "", date: "2026-10-15" }));
  assert.equal(locked.status, 423);
  assert.equal(locked.body.error.code, "commands_locked");
  assert.deepEqual(env2.sent(), []);

  const env3 = await setup(t);
  env3.store.setKV("owner.phone", null);
  assert.equal((await env3.post("/v1/owner-proposals", ownerChange({ kind: "close_day", text: "", date: "2026-10-15" }))).status, 503);
  assert.equal((await env3.post("/v1/proposals", voiceBooking())).status, 503);
});

test("SMS commands over budget after voice proposals still lock as before", async (t) => {
  const env = await setup(t, { limits: { maxProposalsPerDay: 10 } });
  for (let i = 0; i < 10; i++) {
    assert.equal((await env.post("/v1/owner-proposals", ownerChange({ kind: "capacity", text: "", capacity: i + 1 }, `c${i}`))).status, 201);
  }
  await env.hub.ownerSms({ from: NOOR, text: "NAFASI 8" });
  assert.equal(env.store.getKV(LOCK_KV).reason, "too_many_proposals");
});

test("GET /v1/feedback/summary: themes with unique comment counts and verdicts, no quotes; honest when empty", async (t) => {
  const none = await setup(t, { tagger: null });
  assert.deepEqual((await none.get("/v1/feedback/summary")).body, { period: null, themes: [], ask_a_person: 0, comments: 0, status: "no_tagger" });

  const env = await setup(t);
  assert.deepEqual((await env.get("/v1/feedback/summary")).body, { period: null, themes: [], ask_a_person: 0, comments: 0, status: "no_feedback" });
  const texts = [
    "The road was hard to find, we got lost twice.",
    "Directions were confusing, no sign at the turn.",
    "We could not find the farm, the directions are unclear.",
    "Lunch was delicious!",
  ];
  env.store.setKV("feedback.sources", texts.map((text, i) => ({ id: `fb${i}`, from_booking: `direct:${i}`, text, lang: "en", received_at: `2026-10-0${i + 1}T10:00:00Z` })));
  const r = await env.get("/v1/feedback/summary");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ok");
  assert.equal(r.body.comments, 4);
  assert.equal(r.body.period, "2026-10-01..2026-10-04");
  assert.ok(Number.isInteger(r.body.ask_a_person));
  const directions = r.body.themes.find((x) => x.theme === "directions");
  assert.ok(directions, JSON.stringify(r.body.themes));
  assert.equal(directions.unique_comments, 3);
  assert.equal(directions.verdict, "supported");
  assert.match(directions.summary_sw, /^Maoni 3 /);
  for (const th of r.body.themes) assert.deepEqual(Object.keys(th).sort(), ["direction", "summary_sw", "theme", "unique_comments", "verdict"]);
  const food = r.body.themes.find((x) => x.theme === "food");
  if (food) assert.equal(food.verdict, "insufficient");
  assert.ok(!/lost|delicious|confusing/i.test(JSON.stringify(r.body)), "no quotes");
});

test("unknown voice routes and methods: 404 / 405 JSON, and without a voice api the routes do not exist", async (t) => {
  const env = await setup(t);
  assert.equal((await env.get("/v1/proposals/A")).status, 404);
  assert.equal((await env.post("/v1/farm", {})).status, 405);
  const store = openStore(":memory:");
  const server = createSyncServer({ store, log: () => {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); store.close(); });
  const token = pairDevice(store, "app");
  const r = await fetch(`http://127.0.0.1:${server.address().port}/v1/farm`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 404);
});
