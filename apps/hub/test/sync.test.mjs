/* global fetch */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { openStore } from "../src/store.mjs";
import { createSyncServer, pairDevice, revokeDevice, pendingOwnerActions, markOwnerAction, TOKENS_KV } from "../src/sync.mjs";

const ACTION_ID = "0b6f3c1e-2d4a-4b8c-9e1f-3a5b7c9d1e2f";
const DIGEST = "a".repeat(64);
let store, server, base, token, logLines;

before(async () => {
  store = openStore();
  for (let i = 1; i <= 450; i++) {
    store.addEvent({ id: `e${i}`, kind: "booking", channel: "email_gyg", received_at: "2026-10-04T08:00:00Z", synthetic: true,
      booking: { platform: "getyourguide", ref: `GYG-${i}`, date: "2026-10-12", party_size: 2, visitor_name: "Thomas Example" } });
  }
  token = pairDevice(store, "noor-iphone");
  logLines = [];
  server = createSyncServer({ store, log: (l) => logLines.push(JSON.stringify(l)) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.closeAllConnections(); server.close(); store.close(); });

const auth = (t = token) => ({ Authorization: `Bearer ${t}` });
const getJson = async (path, headers = {}) => { const r = await fetch(base + path, { headers }); return { status: r.status, headers: r.headers, body: await r.json() }; };
const postJson = async (path, obj, headers = auth()) => {
  const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(obj) });
  return { status: r.status, body: await r.json() };
};
const validAction = { action_id: ACTION_ID, kind: "book_slot", rendered_digest: DIGEST, decision: "approve" };

test("only the token hash is stored", () => {
  const entries = store.getKV(TOKENS_KV);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].device_id, "noor-iphone");
  assert.match(entries[0].token_sha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(entries).includes(token));
});

test("health is public and says nothing else", async () => {
  const r = await getJson("/v1/health");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});

test("401 without a token, with a wrong token, with a malformed header", async () => {
  for (const headers of [{}, auth("sst_" + "x".repeat(43)), { Authorization: `Basic ${token}` }, { Authorization: `Bearer ${token}x` }]) {
    const r = await getJson("/v1/events?since=0", headers);
    assert.equal(r.status, 401);
    assert.deepEqual(Object.keys(r.body), ["error"]);
    assert.equal(r.body.error.code, "unauthorized");
  }
  const p = await postJson("/v1/owner-actions", validAction, {});
  assert.equal(p.status, 401);
  assert.equal(pendingOwnerActions(store).length, 0);
});

test("no CORS headers and no stack traces", async () => {
  const r = await getJson("/v1/events?since=abc", auth());
  assert.equal(r.status, 400);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  assert.equal(r.body.error.code, "invalid_since");
  assert.ok(!JSON.stringify(r.body).includes("at "), "no stack frames");
});

test("events are paged by since, max 200 per page", async () => {
  const seen = [];
  let since = 0, pages = 0, more = true;
  while (more) {
    const r = await getJson(`/v1/events?since=${since}`, auth());
    assert.equal(r.status, 200);
    assert.ok(r.body.events.length <= 200);
    seen.push(...r.body.events.map((e) => e.id));
    since = r.body.next; more = r.body.has_more; pages++;
  }
  assert.equal(pages, 3);
  assert.equal(seen.length, 450);
  assert.equal(new Set(seen).size, 450);
  assert.equal(seen[0], "e1"); assert.equal(seen[449], "e450");

  const tail = await getJson("/v1/events?since=440&limit=5", auth());
  assert.deepEqual(tail.body.events.map((e) => e.seq), [441, 442, 443, 444, 445]);
  assert.equal(tail.body.next, 445);
  const big = await getJson("/v1/events?since=0&limit=100000", auth());
  assert.equal(big.body.events.length, 200);
  const empty = await getJson("/v1/events?since=450", auth());
  assert.deepEqual(empty.body, { events: [], next: 450, has_more: false });
});

test("body over 64 KB -> 413, nothing recorded", async () => {
  const r = await postJson("/v1/owner-actions", { ...validAction, client_ref: "x".repeat(70 * 1024) });
  assert.equal(r.status, 413);
  assert.equal(r.body.error.code, "payload_too_large");

  // Chunked upload (no Content-Length) is capped too.
  const status = await new Promise((resolve, reject) => {
    const req = request(`${base}/v1/owner-actions`, { method: "POST", headers: { ...auth(), "Content-Type": "application/json", "Transfer-Encoding": "chunked" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    for (let i = 0; i < 80; i++) req.write("x".repeat(1024));
    req.end();
  });
  assert.equal(status, 413);
  assert.equal(pendingOwnerActions(store).length, 0);
});

test("JSON only, strict fields", async () => {
  const r = await fetch(base + "/v1/owner-actions", { method: "POST", headers: { ...auth(), "Content-Type": "text/plain" }, body: "hi" });
  assert.equal(r.status, 415);
  const bad = await fetch(base + "/v1/owner-actions", { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: "{not json" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "invalid_json");
  for (const [patch, code] of [[{ decision: "yes" }, "invalid_decision"], [{ rendered_digest: "ABC" }, "invalid_digest"],
    [{ kind: "wire_money" }, "invalid_kind"], [{ action_id: "1" }, "invalid_action_id"], [{ pin: "1234" }, "unknown_field"]]) {
    const x = await postJson("/v1/owner-actions", { ...validAction, ...patch });
    assert.equal(x.status, 400); assert.equal(x.body.error.code, code);
  }
});

test("owner action is recorded as pending, never applied, and replay is idempotent", async () => {
  const before = store.db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n;
  const r = await postJson("/v1/owner-actions", validAction);
  assert.equal(r.status, 202);
  assert.equal(r.body.state, "pending");
  assert.equal(r.body.applied, false);
  const again = await postJson("/v1/owner-actions", validAction);
  assert.equal(again.status, 202);
  assert.equal(again.body.request_id, r.body.request_id);

  const pending = pendingOwnerActions(store);
  assert.equal(pending.length, 1);
  assert.deepEqual({ ...pending[0], request_id: undefined, received_at: undefined },
    { request_id: undefined, received_at: undefined, device_id: "noor-iphone", action_id: ACTION_ID, kind: "book_slot", rendered_digest: DIGEST, decision: "approve", client_ref: null, state: "pending" });
  // Nothing was queued, approved or sent by the sync server.
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n, before);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE state = 'approved'").get().n, 0);

  assert.equal(markOwnerAction(store, r.body.request_id, "applied"), true);
  assert.equal(markOwnerAction(store, r.body.request_id, "applied"), false, "only from pending");
  assert.equal(pendingOwnerActions(store).length, 0);
});

test("re-pairing rotates the token; revoked devices get 401", async () => {
  const t2 = pairDevice(store, "noor-iphone");
  assert.equal((await getJson("/v1/events?since=0&limit=1", auth())).status, 401, "old token dead");
  assert.equal((await getJson("/v1/events?since=0&limit=1", auth(t2))).status, 200);
  assert.equal(revokeDevice(store, "noor-iphone"), true);
  assert.equal((await getJson("/v1/events?since=0&limit=1", auth(t2))).status, 401);
  token = pairDevice(store, "noor-iphone");
});

test("logs never contain tokens, names or event content", () => {
  const all = logLines.join("\n");
  assert.ok(logLines.length > 5);
  assert.ok(!all.includes(token));
  assert.ok(!all.includes("sst_"));
  assert.ok(!all.includes("Thomas"));
  assert.ok(!all.includes(ACTION_ID));
  for (const l of logLines) assert.deepEqual(Object.keys(JSON.parse(l)).sort(), ["device", "method", "route", "status"]);
});

test("unknown routes and wrong methods", async () => {
  assert.equal((await getJson("/v1/nope", auth())).status, 404);
  assert.equal((await getJson("/admin")).status, 404);
  assert.equal((await getJson("/v1/owner-actions", auth())).status, 405);
});
