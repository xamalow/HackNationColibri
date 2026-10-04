/* global fetch */
// Owner alert calls as a pull API for hub-voice's sauti-alert worker (owner_alert_calls.mjs through sync.mjs).
// Every safety rule has a test here, plus a contract test against the worker's own parser (apps/hub-voice) so a shape
// drift on either side fails. All synthetic: fictional UK drama-range numbers (+447700900xxx), in-memory stores,
// a spy transport and a fake Twilio fetch: no network anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFarmSheet } from "../src/bookings.mjs";
import { CLOSED_DAYS_KV, createHub } from "../src/hub.mjs";
import { alertOwner, MANIFEST_KEYS, MISSING_CLIPS } from "../src/notify.mjs";
import { createOutbox } from "../src/outbox.mjs";
import {
  ALERT_ID_RE, alertCallState, CALL_DEVICE_KV, CLIP_KEY_RE, createOwnerAlertCallApi, MAX_CLIPS, ownerRef, publicAlertId,
  queueAlertCall, RESULT_STATUSES, setCallDevice,
} from "../src/owner_alert_calls.mjs";
import { platformAdapters } from "../src/publish.mjs";
import { buildHub, gitWorkTreeOf, loadConfig } from "../src/run_hub.mjs";
import { openStore } from "../src/store.mjs";
import { createSyncServer, pairDevice } from "../src/sync.mjs";

const HUB_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO = gitWorkTreeOf(HUB_DIR);
const NOOR = "+447700900999";
const NOOR_LATER = "+447700900998";
const TOURIST = "+447700900456";
const HUB_NUMBER = "+447700900001";
const START = new Date("2026-10-04T15:00:00Z"); // 18:00 EAT, Sunday
const CALL_DEVICE = "sauti-alert-01";
/** Every clip notify.mjs can ask for, as if the experience package had recorded them all. */
const ALL_CLIPS = new Set([...MANIFEST_KEYS, ...MISSING_CLIPS.map((c) => c.key)]);
const FORBIDDEN_KEYS = ["to", "number", "phone", "e164"];

const conflictEvent = (id = "t:conflict", date = "2026-10-16") => ({
  id, kind: "booking", channel: "gyg_api", received_at: START.toISOString(), synthetic: true,
  booking: { platform: "getyourguide", ref: `GYG-${id}`, date, time: "09:00", party_size: 2, visitor_name: "Lena" },
});
const question = (id) => ({
  id, kind: "visitor_message", channel: "sms", received_at: START.toISOString(), from: TOURIST, synthetic: true,
  text: "Hi, how do we get to the farm from Machakos town? Is lunch included?",
});

async function setup(t, { maxPerDay, maxAgeMinutes, knownClips = ALL_CLIPS, callDevice = true, owner = NOOR } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hub-alert-calls-"));
  const clock = { t: new Date(START) };
  const now = () => clock.t;
  const store = openStore(":memory:");
  if (owner) store.setKV("owner.phone", owner);
  const handed = [];
  const transport = { send: (it) => { handed.push({ channel: it.channel }); return { ref: "r" }; }, wasSent: () => null };
  const outbox = createOutbox(store, transport, { now });
  const sheet = loadFarmSheet();
  const hub = createHub({
    store, sheet, outbox, now, alertClipKeys: knownClips, adapters: platformAdapters({ env: {}, logPath: join(dir, "platform.jsonl") }),
  });
  const alertCalls = createOwnerAlertCallApi({ store, now, ...(maxPerDay !== undefined ? { maxPerDay } : {}), ...(maxAgeMinutes ? { maxAgeMinutes } : {}) });
  const server = createSyncServer({ store, alertCalls, log: () => {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const workerToken = pairDevice(store, CALL_DEVICE);
  const appToken = pairDevice(store, "noor-app");
  if (callDevice) setCallDevice(store, CALL_DEVICE);
  const as = (token) => ({ Authorization: `Bearer ${token}` });
  const get = async (path, headers = as(workerToken)) => {
    const r = await fetch(base + path, { headers });
    const text = await r.text();
    return { status: r.status, body: JSON.parse(text), text };
  };
  const post = async (path, obj, headers = as(workerToken), ctype = "application/json") => {
    const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": ctype, ...headers }, body: typeof obj === "string" ? obj : JSON.stringify(obj) });
    const text = await r.text();
    return { status: r.status, body: JSON.parse(text), text };
  };
  const pending = async () => (await get("/v1/owner-alerts/pending")).body.pending;
  const report = (id, body, headers) => post(`/v1/owner-alerts/${encodeURIComponent(id)}/result`, body, headers);
  return { store, hub, outbox, clock, handed, get, post, pending, report, as, workerToken, appToken, base };
}

const answered = (played = [], missing = []) => ({ status: "answered", played, missing });

// ------------------------------------------------------------------------------------------------ contract
// The worker's own expectations, read from its source so drift on either side fails here.
const VOICE = join(REPO, "apps", "hub-voice");
const outboundPy = readFileSync(join(VOICE, "hub_voice", "outbound.py"), "utf8");
const hubclientPy = readFileSync(join(VOICE, "hub_voice", "hubclient.py"), "utf8");
const fixture = JSON.parse(readFileSync(join(VOICE, "fixtures", "pending_alerts.json"), "utf8"));
const pyRegex = (name) => new RegExp(new RegExp(`^${name} = re\\.compile\\(r"([^"]+)"\\)`, "m").exec(outboundPy)[1]);
const pyTuple = (src) => [...src.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const WORKER = {
  alertId: pyRegex("ALERT_ID"),
  clipKey: pyRegex("CLIP_KEY"),
  maxClips: Number(/^MAX_CLIPS = (\d+)/m.exec(outboundPy)[1]),
  statuses: pyTuple(/^RESULT_STATUSES = \(([^)]*)\)/m.exec(outboundPy)[1]),
  forbidden: pyTuple(/if any\(k in \(([^)]*)\) for k in item\)/.exec(outboundPy)[1]),
  okStatuses: /if status not in \(([\d, ]+)\):/.exec(hubclientPy)[1].split(",").map((x) => Number(x.trim())),
  payloadKeys: pyTuple(/out: dict\[str, Any\] = \{([^}]*)\}/.exec(outboundPy)[1]),
};

/** A line-for-line port of hub_voice/outbound.py AlertRequest.parse (plus device_id == SAUTI_OWNER_DEVICE_ID). */
function workerParse(item, ownerDeviceId) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("alert must be an object");
  if (typeof item.alert_id !== "string" || !WORKER.alertId.test(item.alert_id)) throw new Error("alert_id");
  if (typeof item.device_id !== "string" || item.device_id.length < 1 || item.device_id.length > 128) throw new Error("device_id");
  const keys = item.clip_keys;
  if (!Array.isArray(keys) || !keys.length || keys.length > WORKER.maxClips) throw new Error("clip_keys");
  for (const k of keys) if (typeof k !== "string" || !WORKER.clipKey.test(k)) throw new Error("clip key");
  if (Object.keys(item).some((k) => WORKER.forbidden.includes(k))) throw new Error("an alert must not carry a phone number");
  if (ownerDeviceId !== undefined && item.device_id !== ownerDeviceId) throw new Error("device_mismatch");
  return { alert_id: item.alert_id, device_id: item.device_id, clip_keys: keys, urgent: Boolean(item.urgent ?? false) };
}

test("contract: the hub's constants equal the worker's (outbound.py / hubclient.py), and the worker's fixture parses", () => {
  assert.equal(String(ALERT_ID_RE), String(WORKER.alertId));
  assert.equal(String(CLIP_KEY_RE), String(WORKER.clipKey));
  assert.equal(MAX_CLIPS, WORKER.maxClips);
  assert.deepEqual([...RESULT_STATUSES], WORKER.statuses);
  assert.deepEqual(WORKER.forbidden, FORBIDDEN_KEYS);
  assert.ok(WORKER.okStatuses.includes(200), "the hub answers results with 200, which the worker accepts");
  assert.deepEqual(WORKER.payloadKeys, ["status", "played", "missing"]);
  assert.match(outboundPy, /out\["reason"\] = reason\[:64\]/, "reason is optional and at most 64 characters");
  assert.match(hubclientPy, /self\._get\("\/v1\/owner-alerts\/pending", \{\}\)/);
  assert.match(hubclientPy, /data\.get\("pending", \[\]\)/, "the worker reads the `pending` list");
  assert.match(hubclientPy, /self\._post\(f"\/v1\/owner-alerts\/\{alert_id\}\/result", payload\)/);
  // The worker's own fixture is what the hub must produce: same field set.
  const want = Object.keys(fixture.pending[0]).sort();
  assert.deepEqual(want, ["alert_id", "clip_keys", "created_at", "device_id", "urgent"]);
  workerParse(fixture.pending[0], fixture.pending[0].device_id);
});

test("contract: what GET /v1/owner-alerts/pending serves passes the worker's parser, with exactly the fixture's fields", async (t) => {
  const env = await setup(t);
  env.store.setKV(CLOSED_DAYS_KV, { "2026-10-16": { approval_id: "test" } });
  env.hub.handleEvent(conflictEvent());
  env.hub.handleEvent(question("twilio:SM0001"));
  const items = await env.pending();
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.deepEqual(Object.keys(item).sort(), Object.keys(fixture.pending[0]).sort());
    const parsed = workerParse(item, CALL_DEVICE); // the worker's SAUTI_OWNER_DEVICE_ID = the call device's paired id
    assert.ok(parsed.clip_keys.every((k) => ALL_CLIPS.has(k)));
    assert.ok(!Number.isNaN(Date.parse(item.created_at)));
  }
  assert.throws(() => workerParse(items[0], "some-other-device"), /device_mismatch/);
  // and every payload the worker can build (result_payload) is accepted
  const keys = items[0].clip_keys;
  for (const [status, played, missing, reason] of [["dispatched", [], keys.slice(1)], ["answered", keys.slice(0, 1), keys.slice(1)]]) {
    const r = await env.report(items[0].alert_id, { status, played, missing, ...(reason ? { reason } : {}) });
    assert.ok(WORKER.okStatuses.includes(r.status), `${status}: ${r.status}`);
  }
  const f = await env.report(items[1].alert_id, { status: "failed", played: [], missing: [], reason: "dispatch:TimeoutError" });
  assert.equal(f.status, 200);
});

// ------------------------------------------------------------------------------------------------ end to end
test("end to end: a booking conflict -> owner alert -> pending call with its clip keys -> answered -> event; Twilio never asked to call", async (t) => {
  const env = await setup(t);
  env.store.setKV(CLOSED_DAYS_KV, { "2026-10-16": { approval_id: "test" } });
  const ev = conflictEvent();
  const r = env.hub.handleEvent(ev);
  assert.equal(r.action, "conflict");
  assert.equal(r.alerted, true);
  await env.outbox.dispatch();
  assert.deepEqual(env.handed.map((h) => h.channel), ["sms"], "the SMS alert to Noor still goes out; no call item reaches the transport");
  assert.equal(env.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE channel = 'call'").get().n, 0);

  const expected = alertOwner(ev, { conflict: { booked: null, capacity: 10 } }).call;
  assert.equal(expected[0], "alert.urgent");
  assert.ok(expected.includes("word.ijumaa"), "2026-10-16 is a Friday");
  const [item] = await env.pending();
  assert.deepEqual(item, { alert_id: "alert-t:conflict", device_id: CALL_DEVICE, clip_keys: expected, urgent: true, created_at: START.toISOString() });

  env.clock.t = new Date(START.getTime() + 60_000);
  const d = await env.report(item.alert_id, { status: "dispatched", played: [], missing: [] });
  assert.deepEqual(d, { status: 200, body: { alert_id: item.alert_id, state: "dispatched", changed: true }, text: d.text });
  assert.deepEqual(await env.pending(), [], "dispatched: no longer pending");
  const a = await env.report(item.alert_id, answered(expected));
  assert.deepEqual(a.body, { alert_id: item.alert_id, state: "answered", changed: true });

  // Noor's app sees both facts (paired app device, /v1/events), without any number.
  const events = (await env.get("/v1/events", env.as(env.appToken))).body.events.filter((e) => e.kind === "owner_alert_call");
  assert.deepEqual(events.map((e) => [e.alert_id, e.status, e.final, e.event_id]), [
    [item.alert_id, "dispatched", false, "t:conflict"], [item.alert_id, "answered", true, "t:conflict"],
  ]);
  assert.deepEqual(events[1].played, expected);
  assert.ok(!JSON.stringify(events).includes("7700900"), "no phone number in the events");
});

test("the Twilio runner in the default mode (HUB_ALERT_CALLS unset = pull) never posts to Calls.json, even with a clip URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-alert-calls-run-"));
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    posts.push({ url: String(url), method: init.method });
    return { status: 201, text: async () => JSON.stringify({ sid: "SM" + "0".repeat(32) }) };
  };
  const env = {
    TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32), TWILIO_API_KEY_SID: "SK" + "7".repeat(32), TWILIO_API_KEY_SECRET: "fake-api-key-secret-for-tests-42",
    TWILIO_NUMBER: HUB_NUMBER, OWNER_PHONE: NOOR, HUB_DB_PATH: join(dir, "hub.db"), HUB_CLIP_BASE_URL: "https://clips.example.test/sw",
  };
  const config = loadConfig({ argv: ["--live"], env, repoRoot: REPO });
  assert.equal(config.alertCalls, "pull");
  const logs = [];
  const built = await buildHub(config, { fetchImpl, now: () => START, write: (l) => logs.push(l), tagger: false });
  try {
    built.hub.handleEvent(question("twilio:SM0002"));
    await built.outbox.dispatch();
    assert.equal(posts.filter((p) => p.url.endsWith("/Calls.json")).length, 0);
    assert.equal(posts.filter((p) => p.url.endsWith("/Messages.json")).length, 1, "the alert SMS still goes out");
    assert.equal(built.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE channel = 'call'").get().n, 0);
    assert.equal(built.store.db.prepare("SELECT COUNT(*) AS n FROM owner_alert_calls").get().n, 1, "the call waits for hub-voice");
    assert.ok(logs.some((l) => /alert calls listed for hub-voice/.test(l)));
  } finally { built.close(); }
  assert.throws(() => loadConfig({ argv: ["--live"], env: { ...env, HUB_ALERT_CALLS: "carrier-pigeon" }, repoRoot: REPO }), /HUB_ALERT_CALLS must be one of/);
});

// ------------------------------------------------------------------------------------------------ safety rules
test("one call per alert: the same event twice, or the same alert queued twice, is one call", async (t) => {
  const env = await setup(t);
  env.hub.handleEvent(question("twilio:SM0003"));
  env.hub.handleEvent(question("twilio:SM0003"));
  const again = queueAlertCall(env.store, { alertRowId: "alert-twilio:SM0003", event_id: "twilio:SM0003", kind: "visitor_message", urgent: false, clips: ["alert.visitor_message"], knownClips: ALL_CLIPS });
  assert.equal(again.created, false);
  assert.equal(env.store.db.prepare("SELECT COUNT(*) AS n FROM owner_alert_calls").get().n, 1);
  assert.equal((await env.pending()).length, 1);
  assert.equal((await env.pending()).length, 1, "re-reading the list does not duplicate");
});

test("daily cap (farm day, EAT): at most maxPerDay calls released per day, durable, urgent first; the rest wait", async (t) => {
  const env = await setup(t, { maxPerDay: 2, maxAgeMinutes: 600 });
  env.hub.handleEvent(question("twilio:SM0010"));
  env.hub.handleEvent(question("twilio:SM0011"));
  env.store.setKV(CLOSED_DAYS_KV, { "2026-10-16": { approval_id: "test" } });
  env.hub.handleEvent(conflictEvent("t:urgent"));
  const first = await env.pending();
  assert.deepEqual(first.map((i) => i.alert_id), ["alert-t:urgent", "alert-twilio:SM0010"], "urgent first, then oldest");
  assert.deepEqual((await env.pending()).map((i) => i.alert_id), first.map((i) => i.alert_id), "re-reading releases nothing more");
  for (const i of first) assert.equal((await env.report(i.alert_id, answered())).status, 200);
  const after = await env.get("/v1/owner-alerts/pending");
  assert.deepEqual(after.body.pending, [], "cap reached: the third call waits");
  assert.deepEqual(after.body.cap, { day: "2026-10-04", listed: 2, max: 2 });
  // durable: a new API object on the same store (a restart) keeps the count
  const restarted = createOwnerAlertCallApi({ store: env.store, now: () => env.clock.t, maxPerDay: 2 });
  assert.deepEqual(restarted.pending(CALL_DEVICE).pending, []);
  // 21:00 UTC is already the next farm day (00:00 EAT)
  env.clock.t = new Date("2026-10-04T21:00:00Z");
  assert.deepEqual((await env.pending()).map((i) => i.alert_id), ["alert-twilio:SM0011"]);
  // cap 0 = no call is ever released
  const zero = createOwnerAlertCallApi({ store: env.store, now: () => env.clock.t, maxPerDay: 0, maxAgeMinutes: 600 });
  env.hub.handleEvent(question("twilio:SM0012"));
  assert.deepEqual(zero.pending(CALL_DEVICE).pending.map((i) => i.alert_id), ["alert-twilio:SM0011"], "only the already released call");
  assert.throws(() => createOwnerAlertCallApi({ store: env.store, maxPerDay: -1 }), TypeError);
});

test("enrolled owner only: no number anywhere in the API, nothing queued without an owner, a re-enrolled number drops older calls", async (t) => {
  const env = await setup(t, { owner: null });
  env.hub.handleEvent(question("twilio:SM0020"));
  assert.equal(env.store.db.prepare("SELECT COUNT(*) AS n FROM owner_alert_calls").get().n, 0, "no enrolled owner: no call queued");
  const none = await env.get("/v1/owner-alerts/pending");
  assert.deepEqual(none.body.pending, []);

  env.store.setKV("owner.phone", NOOR);
  env.hub.handleEvent(question("twilio:SM0021"));
  const r = await env.get("/v1/owner-alerts/pending");
  assert.equal(r.body.pending.length, 1);
  for (const n of [NOOR, NOOR.slice(1), ownerRef(NOOR)]) assert.ok(!r.text.includes(n), "neither the number nor its hash is served");
  const walk = (v) => (Array.isArray(v) ? v.forEach(walk) : v && typeof v === "object" ? Object.entries(v).forEach(([k, x]) => { assert.ok(!FORBIDDEN_KEYS.includes(k), k); walk(x); }) : null);
  walk(r.body);
  assert.ok(!/7700900/.test(JSON.stringify(alertCallState(env.store, r.body.pending[0].alert_id))), "the number is not stored with the call");

  // a request cannot name a recipient
  const withTo = await env.report(r.body.pending[0].alert_id, { ...answered(), to: TOURIST });
  assert.equal(withTo.status, 400);
  assert.equal(withTo.body.error.code, "unknown_field");
  assert.ok(!withTo.text.includes(TOURIST));

  // the call was queued for the number enrolled then; after a re-enrolment it is not listed any more
  env.store.setKV("owner.phone", NOOR_LATER);
  assert.deepEqual(await env.pending(), []);
  env.store.setKV("owner.phone", NOOR);
  assert.equal((await env.pending()).length, 1);
});

test("the call device: only the designated paired device reads the list and reports; none designated -> nothing listed", async (t) => {
  const env = await setup(t, { callDevice: false });
  env.hub.handleEvent(question("twilio:SM0030"));
  const r = await env.get("/v1/owner-alerts/pending");
  assert.deepEqual(r.body.pending, []);
  assert.equal(r.body.reason, "no_call_device");
  assert.equal((await env.report("alert-twilio:SM0030", answered())).status, 403);
  assert.throws(() => setCallDevice(env.store, "never-paired"), /not paired/);
  assert.throws(() => setCallDevice(env.store, "bad id!"), /device id/);
  setCallDevice(env.store, CALL_DEVICE);
  assert.equal(env.store.getKV(CALL_DEVICE_KV), CALL_DEVICE);
  const other = await env.get("/v1/owner-alerts/pending", env.as(env.appToken));
  assert.equal(other.status, 403);
  assert.equal(other.body.error.code, "not_call_device");
  const [item] = await env.pending();
  assert.equal(item.device_id, CALL_DEVICE);
  const fromApp = await env.report(item.alert_id, answered(), env.as(env.appToken));
  assert.equal(fromApp.status, 403);
  assert.equal(alertCallState(env.store, item.alert_id).state, "pending", "a result from another device changes nothing");
});

test("auth: no token or a wrong token -> 401 on both routes, nothing changes", async (t) => {
  const env = await setup(t);
  env.hub.handleEvent(question("twilio:SM0040"));
  const [item] = await env.pending();
  for (const headers of [{}, { Authorization: "Bearer sst_not-a-real-token-0000000000" }, { Authorization: env.workerToken }]) {
    const g = await env.get("/v1/owner-alerts/pending", headers);
    assert.equal(g.status, 401);
    const p = await env.report(item.alert_id, answered(), headers);
    assert.equal(p.status, 401);
    assert.deepEqual(p.body, { error: { code: "unauthorized", message: "missing or invalid bearer token" } });
  }
  assert.equal(alertCallState(env.store, item.alert_id).state, "pending");
});

test("no retry storm: after a dispatched or final result the hub never lists the call again; a stale call ages out", async (t) => {
  const env = await setup(t, { maxAgeMinutes: 30 });
  env.hub.handleEvent(question("twilio:SM0050"));
  env.hub.handleEvent(question("twilio:SM0051"));
  env.hub.handleEvent(question("twilio:SM0052"));
  const items = await env.pending();
  assert.equal((await env.report(items[0].alert_id, { status: "no_answer", played: [], missing: [] })).status, 200);
  assert.equal((await env.report(items[1].alert_id, { status: "failed", played: [], missing: [], reason: "dispatch:ConnectError" })).status, 200);
  for (let i = 0; i < 3; i++) assert.deepEqual((await env.pending()).map((x) => x.alert_id), [items[2].alert_id]);
  env.clock.t = new Date(START.getTime() + 31 * 60_000);
  assert.deepEqual(await env.pending(), [], "older than maxAgeMinutes: the SMS already carried every fact");
  const late = await env.report(items[2].alert_id, answered());
  assert.equal(late.status, 200, "a late report for a released call is still recorded");
});

test("results are idempotent and ordered: repeats change nothing; dispatched then a final outcome; nothing after a final", async (t) => {
  const env = await setup(t);
  env.hub.handleEvent(question("twilio:SM0060"));
  const [item] = await env.pending();
  const keys = item.clip_keys;
  const events = () => env.store.eventsSince(0).filter((e) => e.kind === "owner_alert_call").length;
  assert.equal((await env.report(item.alert_id, { status: "dispatched", played: [], missing: [] })).body.changed, true);
  const rep = await env.report(item.alert_id, { status: "dispatched", played: [], missing: [] });
  assert.deepEqual(rep.body, { alert_id: item.alert_id, state: "dispatched", changed: false });
  assert.equal((await env.report(item.alert_id, answered(keys))).body.changed, true);
  const again = await env.report(item.alert_id, answered([]));
  assert.deepEqual(again.body, { alert_id: item.alert_id, state: "answered", changed: false }, "same status again: first report wins");
  const late = await env.report(item.alert_id, { status: "dispatched", played: [], missing: [] });
  assert.equal(late.body.changed, false, "a replayed dispatched after the outcome is the same old fact");
  const contradict = await env.report(item.alert_id, { status: "failed", played: [], missing: [] });
  assert.equal(contradict.status, 409);
  assert.equal(contradict.body.error.code, "already_final");
  assert.equal(events(), 2);
  assert.deepEqual(alertCallState(env.store, item.alert_id).results.map((x) => x.status), ["dispatched", "answered"]);

  // a final result straight from pending (refused / simulated) ends it too; "dispatched" cannot follow a final
  env.hub.handleEvent(question("twilio:SM0061"));
  const [b] = await env.pending();
  assert.equal((await env.report(b.alert_id, { status: "refused", played: [], missing: [], reason: "cap_exhausted" })).body.state, "refused");
  assert.equal((await env.report(b.alert_id, { status: "dispatched", played: [], missing: [] })).status, 409);
  assert.deepEqual(await env.pending(), []);
});

test("validation: bad ids 400, unknown ids 404, never-released calls 409, strict bodies; errors never echo a value", async (t) => {
  const env = await setup(t, { maxPerDay: 1 });
  env.hub.handleEvent(question("twilio:SM0070"));
  env.hub.handleEvent(question("twilio:SM0071"));
  const [item] = await env.pending();
  const unreleased = "alert-twilio:SM0071";
  const cases = [
    [`/v1/owner-alerts/${encodeURIComponent("alert/../x")}/result`, answered(), 400, "invalid_alert_id"],
    [`/v1/owner-alerts/${"a".repeat(129)}/result`, answered(), 400, "invalid_alert_id"],
    ["/v1/owner-alerts/%E0%A4%A/result", answered(), 400, "invalid_alert_id"],
    ["/v1/owner-alerts/alert-nope-SECRET42/result", answered(), 404, "unknown_alert"],
    [`/v1/owner-alerts/${unreleased}/result`, answered(), 409, "not_released"],
    [`/v1/owner-alerts/${item.alert_id}/result`, { status: "approved", played: [], missing: [] }, 400, "invalid_status"],
    [`/v1/owner-alerts/${item.alert_id}/result`, { status: "answered", missing: [] }, 400, "invalid_played"],
    [`/v1/owner-alerts/${item.alert_id}/result`, { status: "answered", played: ["word.SECRET42"], missing: [] }, 400, "invalid_played"],
    [`/v1/owner-alerts/${item.alert_id}/result`, { status: "answered", played: ["visits.booked"], missing: [] }, 400, "invalid_played"],
    [`/v1/owner-alerts/${item.alert_id}/result`, { status: "answered", played: [], missing: "x" }, 400, "invalid_missing"],
    [`/v1/owner-alerts/${item.alert_id}/result`, { status: "answered", played: [], missing: [], reason: "x".repeat(65) }, 400, "invalid_reason"],
    [`/v1/owner-alerts/${item.alert_id}/result`, { status: "answered", played: [], missing: [], duration_s: 3 }, 400, "unknown_field"],
    [`/v1/owner-alerts/${item.alert_id}/result`, [1, 2], 400, "invalid_body"],
    [`/v1/owner-alerts/${item.alert_id}/result`, "{not json", 400, "invalid_json"],
    [`/v1/owner-alerts/${item.alert_id}/claim`, {}, 404, "not_found"],
  ];
  for (const [path, body, status, code] of cases) {
    const r = await env.post(path, body);
    assert.equal(r.status, status, path);
    assert.equal(r.body.error.code, code, path);
    assert.ok(!r.text.includes("SECRET42") && !r.text.includes("SM0071"), "value-free error");
  }
  assert.equal((await env.post(`/v1/owner-alerts/${item.alert_id}/result`, "status=answered", undefined, "text/plain")).status, 415);
  assert.equal((await env.post("/v1/owner-alerts/pending", {})).status, 405);
  const getResult = await env.get(`/v1/owner-alerts/${item.alert_id}/result`);
  assert.equal(getResult.status, 405);
  assert.equal(alertCallState(env.store, item.alert_id).state, "pending", "no invalid request changed anything");
  // a free-text reason is not stored verbatim
  const ok = await env.report(item.alert_id, { status: "failed", played: [], missing: [], reason: "call +447700900999 failed" });
  assert.equal(ok.status, 200);
  assert.equal(alertCallState(env.store, item.alert_id).results[0].reason, "other");
});

test("clips: a call is listed only when every clip is recorded (the worker refuses unknown keys); otherwise it is held", async (t) => {
  const env = await setup(t, { knownClips: MANIFEST_KEYS }); // the real manifest: alert.* clips are not recorded yet
  env.store.setKV(CLOSED_DAYS_KV, { "2026-10-16": { approval_id: "test" } });
  env.hub.handleEvent(conflictEvent());
  const r = await env.get("/v1/owner-alerts/pending");
  const missing = alertOwner(conflictEvent(), { conflict: { booked: null, capacity: 10 } }).call.filter((k) => !MANIFEST_KEYS.has(k));
  if (missing.length) {
    assert.deepEqual(r.body.pending, []);
    assert.equal(r.body.held.missing_clips, 1);
    assert.equal(r.body.cap.listed, 0, "a held call does not use the daily cap");
  } else {
    assert.equal(r.body.pending.length, 1);
  }
  // more than the worker's MAX_CLIPS is never listed either
  const many = queueAlertCall(env.store, { alertRowId: "alert-many", event_id: "many", kind: "booking", urgent: false, clips: Array(MAX_CLIPS + 1).fill("visits.booked"), knownClips: ALL_CLIPS });
  assert.equal(many.clips_ready, false);
});

test("alert ids: the hub's id when it fits the worker's pattern, else an opaque hash (never the raw id)", () => {
  assert.equal(publicAlertId("alert-twilio:SM00ab"), "alert-twilio:SM00ab");
  const odd = publicAlertId("alert-mail/<x@example.test>");
  assert.match(odd, /^alert-h[0-9a-f]{32}$/);
  assert.ok(ALERT_ID_RE.test(odd));
  assert.equal(publicAlertId("alert-mail/<x@example.test>"), odd, "stable");
  const s = openStore(":memory:");
  s.setKV("owner.phone", NOOR);
  const q = queueAlertCall(s, { alertRowId: "alert-x".padEnd(200, "x"), event_id: "x", kind: "missed_call", urgent: false, clips: ["alert.missed_call"], knownClips: ALL_CLIPS });
  assert.match(q.alert_id, /^alert-h[0-9a-f]{32}$/);
  s.close();
});
