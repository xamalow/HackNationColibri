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
