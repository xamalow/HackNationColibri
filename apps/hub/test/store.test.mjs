import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store.mjs";

test("events are stored once and read back in order", () => {
  const s = openStore();
  const ev = { id: "e1", kind: "booking", channel: "email_gyg", received_at: "2026-10-04T00:00:00Z", synthetic: true };
  assert.equal(s.addEvent(ev), true);
  assert.equal(s.addEvent(ev), false);
  s.addEvent({ ...ev, id: "e2" });
  assert.deepEqual(s.eventsSince(0).map((e) => e.id), ["e1", "e2"]);
  assert.deepEqual(s.eventsSince(1).map((e) => e.id), ["e2"]);
});

test("a failed transaction leaves nothing behind", () => {
  const s = openStore();
  assert.throws(() => s.transaction(() => { s.setKV("x", 1); throw new Error("boom"); }));
  assert.equal(s.getKV("x"), null);
});

test("an async callback in the sync transaction is refused and rolled back (codex review)", async () => {
  const s = openStore();
  assert.throws(() => s.transaction(async () => { s.setKV("x", 1); }), /transactionAsync/);
  assert.equal(s.getKV("x"), null);
});

test("transactionAsync rolls back when the callback rejects after an await (codex's reproduction)", async () => {
  const s = openStore();
  await assert.rejects(s.transactionAsync(async () => {
    await Promise.resolve();
    s.setKV("synthetic-async-probe", 1);
    throw new Error("synthetic rollback");
  }), /synthetic rollback/);
  assert.equal(s.getKV("synthetic-async-probe"), null);
});

test("transactionAsync commits after the callback settles, and two of them never interleave", async () => {
  const s = openStore();
  const order = [];
  const slow = s.transactionAsync(async () => { order.push("a1"); await sleep(20); s.setKV("a", 1); order.push("a2"); });
  const fast = s.transactionAsync(async () => { order.push("b1"); s.setKV("b", 2); order.push("b2"); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ["a1", "a2", "b1", "b2"]);
  assert.equal(s.getKV("a"), 1);
  assert.equal(s.getKV("b"), 2);
});
