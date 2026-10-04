import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.mjs";
import { createOutbox, idempotencyKey, STATUS } from "../src/outbox.mjs";
import { simulatedOutbound } from "../src/transports/simulated.mjs";

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "hub-outbox-"));
  const open = [];
  t.after(() => {
    for (const s of open) { try { s.close(); } catch { /* already closed */ } }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const path = join(dir, "hub.sqlite");
  return { db: path, log: join(dir, "outbound.jsonl"), open: () => { const s = openStore(path); open.push(s); return s; } };
}
const MSG = { channel: "sms", recipient: "+254700000001", body: "SAUTI: test", cause_id: "ev-1" };
const statusOf = (s, key) => s.db.prepare("SELECT status FROM outbox WHERE idempotency_key = ?").get(key).status;

test("idempotency key covers channel, recipient, body and cause, without field collisions", () => {
  const k = idempotencyKey(MSG);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.notEqual(k, idempotencyKey({ ...MSG, cause_id: "ev-2" }));
  assert.notEqual(idempotencyKey({ ...MSG, body: "ab", cause_id: "c" }), idempotencyKey({ ...MSG, body: "a", cause_id: "bc" }));
});

test("same message enqueued twice is sent once", async (t) => {
  const p = tmp(t);
  const s = p.open();
  const tr = simulatedOutbound(p.log);
  const ob = createOutbox(s, tr);
  assert.equal(ob.enqueue(MSG).created, true);
  assert.equal(ob.enqueue(MSG).created, false);
  assert.deepEqual((await ob.dispatch()).map((r) => r.status), [STATUS.SENT]);
  assert.deepEqual(await ob.dispatch(), []);
  assert.equal(tr.log().length, 1);
});

test("restart after the provider accepted but before SENT was recorded: no duplicate", async (t) => {
  const p = tmp(t);
  const tr = simulatedOutbound(p.log);
  let s = p.open();
  let ob = createOutbox(s, tr);
  const { key } = ob.enqueue(MSG);
  // crash window: SENDING persisted, provider accepted, process died before marking SENT
  s.db.prepare("UPDATE outbox SET status = ? WHERE idempotency_key = ?").run(STATUS.SENDING, key);
  tr.send({ idempotency_key: key, ...MSG });
  s.close();

  s = p.open();
  ob = createOutbox(s, tr);
  assert.deepEqual(await ob.recover(), [{ key, status: STATUS.SENT }]);
  assert.deepEqual(await ob.dispatch(), []);
  assert.equal(tr.log().length, 1);
});

test("restart with SENDING the provider never saw: resent exactly once", async (t) => {
  const p = tmp(t);
  const tr = simulatedOutbound(p.log);
  let s = p.open();
  const { key } = createOutbox(s, tr).enqueue(MSG);
  s.db.prepare("UPDATE outbox SET status = ? WHERE idempotency_key = ?").run(STATUS.SENDING, key);
  s.close();

  s = p.open();
  const ob = createOutbox(s, tr);
  assert.deepEqual(await ob.recover(), [{ key, status: STATUS.QUEUED }]);
  await ob.dispatch();
  await ob.dispatch();
  assert.equal(tr.log().length, 1);
  assert.equal(statusOf(s, key), STATUS.SENT);
});

test("restart when the transport cannot tell: UNCERTAIN, never resent", async () => {
  const s = openStore();
  let sends = 0;
  const tr = { send: () => { sends++; return { ref: "x" }; }, wasSent: () => null };
  const ob = createOutbox(s, tr);
  const { key } = ob.enqueue(MSG);
  s.db.prepare("UPDATE outbox SET status = ? WHERE idempotency_key = ?").run(STATUS.SENDING, key);
  assert.deepEqual(await ob.recover(), [{ key, status: STATUS.UNCERTAIN }]);
  await ob.dispatch();
  assert.equal(sends, 0);
  // a throwing wasSent is also "unknown"
  const { key: k2 } = ob.enqueue({ ...MSG, cause_id: "ev-2" });
  s.db.prepare("UPDATE outbox SET status = ? WHERE idempotency_key = ?").run(STATUS.SENDING, k2);
  const ob2 = createOutbox(s, { send: tr.send, wasSent: () => { throw new Error("offline"); } });
  assert.deepEqual(await ob2.recover(), [{ key: k2, status: STATUS.UNCERTAIN }]);
});

test("SENDING is persisted before the provider call", async () => {
  const s = openStore();
  let seen;
  const ob = createOutbox(s, { send: (it) => { seen = statusOf(s, it.idempotency_key); return { ref: "x" }; }, wasSent: () => null });
  ob.enqueue(MSG);
  await ob.dispatch();
  assert.equal(seen, STATUS.SENDING);
});

test("send errors: proven non-acceptance is retried with the same key, anything else is UNCERTAIN", async () => {
  const s = openStore();
  let n = 0;
  const keys = [];
  const ob = createOutbox(s, {
    send: (it) => {
      keys.push(it.idempotency_key);
      n++;
      if (n === 1) throw Object.assign(new Error("rejected"), { notAccepted: true });
      if (n === 3) throw new Error("timeout");
      return { ref: "ok" };
    },
    wasSent: () => null,
  });
  const { key } = ob.enqueue(MSG);
  assert.deepEqual((await ob.dispatch()).map((r) => r.status), [STATUS.FAILED]);
  assert.deepEqual((await ob.dispatch()).map((r) => r.status), [STATUS.SENT]);
  assert.deepEqual(keys, [key, key]);
  const { key: k2 } = ob.enqueue({ ...MSG, cause_id: "ev-3" });
  assert.deepEqual((await ob.dispatch()).map((r) => r.status), [STATUS.UNCERTAIN]);
  assert.deepEqual(await ob.dispatch(), []);
  assert.equal(statusOf(s, k2), STATUS.UNCERTAIN);
});

test("sensitive bodies (one-time codes) are blanked once sent", async () => {
  const s = openStore();
  const ob = createOutbox(s, { send: () => ({ ref: "x" }), wasSent: () => null });
  const { key } = ob.enqueue({ ...MSG, body: "Jibu NDIYO A 482113", sensitive: true });
  await ob.dispatch();
  const row = s.db.prepare("SELECT body, status FROM outbox WHERE idempotency_key = ?").get(key);
  assert.equal(row.status, STATUS.SENT);
  assert.doesNotMatch(row.body, /482113/);
});

test("refusals: permanent -> REFUSED at once; repeated provider refusals -> REFUSED after maxAttempts; never retried after", async () => {
  const s = openStore();
  let calls = 0;
  const ob = createOutbox(s, {
    send: (it) => {
      calls++;
      if (it.body === "perm") throw Object.assign(new Error("calls_disabled"), { code: "calls_disabled", notAccepted: true, permanent: true });
      throw Object.assign(new Error("rejected"), { code: "rejected", notAccepted: true });
    },
    wasSent: () => null,
  }, { maxAttempts: 3 });
  const perm = ob.enqueue({ ...MSG, body: "perm", sensitive: true });
  assert.deepEqual(await ob.dispatch(), [{ key: perm.key, status: STATUS.REFUSED, channel: "sms", reason: "calls_disabled" }]);
  assert.deepEqual(await ob.dispatch(), []);
  assert.equal(statusOf(s, perm.key), STATUS.REFUSED);
  assert.equal(s.db.prepare("SELECT body FROM outbox WHERE idempotency_key = ?").get(perm.key).body, "[redacted after send]");
  const r = ob.enqueue({ ...MSG, body: "again", cause_id: "ev-2" });
  const seen = [];
  for (let i = 0; i < 5; i++) seen.push(...(await ob.dispatch()).map((x) => x.status));
  assert.deepEqual(seen, [STATUS.FAILED, STATUS.FAILED, STATUS.REFUSED]);
  assert.equal(statusOf(s, r.key), STATUS.REFUSED);
  assert.equal(calls, 4);
  assert.equal(ob.pending(), 0);
  assert.equal(s.getKV(`outbox.attempts.${r.key}`), null, "attempt counter cleaned up");
});

test("dispatch({ max }) sends at most max rows, oldest first; the rest stay QUEUED", async () => {
  const s = openStore();
  const sent = [];
  let t = 0;
  const ob = createOutbox(s, { send: (it) => { sent.push(it.body); return { ref: "x" }; }, wasSent: () => null }, { now: () => new Date(Date.UTC(2026, 9, 4, 0, 0, t++)) });
  for (const b of ["a", "b", "c"]) ob.enqueue({ ...MSG, body: b, cause_id: b });
  assert.equal(ob.pending(), 3);
  assert.equal((await ob.dispatch({ max: 2 })).length, 2);
  assert.deepEqual(sent, ["a", "b"]);
  assert.equal(ob.pending(), 1);
  assert.equal((await ob.dispatch({ max: 0 })).length, 0);
  await ob.dispatch();
  assert.deepEqual(sent, ["a", "b", "c"]);
});
