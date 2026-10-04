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

test("codex review (D): a deferred write started inside a transaction cannot escape it", async () => {
  const s = openStore();
  let task;
  s.transaction(() => {
    task = (async () => { await Promise.resolve(); s.setKV("late", 1); })();
  });
  await assert.rejects(task, /transaction scope that has ended/);
  assert.equal(s.getKV("late"), null);
});

for (const method of ["get", "all", "iterate"]) {
  test(`INSERT RETURNING through ${method} cannot escape a refused async transaction`, async () => {
    const s = openStore();
    try {
      const statement = s.db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) RETURNING k");
      let task;
      assert.throws(() => s.transaction(() => {
        s.setKV("before", 1);
        task = (async () => {
          await Promise.resolve();
          const result = statement[method]("escaped", "1");
          return method === "iterate" ? Array.from(result) : result;
        })();
        return task;
      }), /transactionAsync/);
      await assert.rejects(task, /transaction scope that has ended/);
      assert.equal(s.getKV("before"), null);
      assert.equal(s.getKV("escaped"), null);
    } finally { s.close(); }
  });
}

test("an iterator created in a rolled-back transaction cannot execute later outside its scope", () => {
  const s = openStore();
  let rows;
  try {
    assert.throws(() => s.transaction(() => {
      rows = s.db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) RETURNING k").iterate("escaped", "1");
      throw new Error("synthetic rollback");
    }), /synthetic rollback/);
    assert.throws(() => rows.next(), /transaction scope that has ended/);
    rows.return();
    assert.equal(s.getKV("escaped"), null);
  } finally { s.close(); }
});

test("get/all/iterate RETURNING still execute inside a live transaction", () => {
  const s = openStore();
  try {
    s.transaction(() => {
      assert.equal(s.db.prepare("INSERT INTO kv (k, v) VALUES ('get', '1') RETURNING k").get().k, "get");
      assert.equal(s.db.prepare("INSERT INTO kv (k, v) VALUES ('all', '2') RETURNING k").all()[0].k, "all");
      assert.equal(Array.from(s.db.prepare("INSERT INTO kv (k, v) VALUES ('iterate', '3') RETURNING k").iterate())[0].k, "iterate");
    });
    assert.equal(s.getKV("get"), 1);
    assert.equal(s.getKV("all"), 2);
    assert.equal(s.getKV("iterate"), 3);
  } finally { s.close(); }
});
