// End-to-end pipeline tests (all synthetic, simulated transports, fictional numbers).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFarmSheet } from "../src/bookings.mjs";
import { createHub, simulatedSources, CLOSED_DAYS_KV } from "../src/hub.mjs";
import { createOutbox } from "../src/outbox.mjs";
import { platformAdapters } from "../src/publish.mjs";
import { openStore } from "../src/store.mjs";
import { simulatedOutbound } from "../src/transports/simulated.mjs";

const HUB = fileURLToPath(new URL("..", import.meta.url));
const NOOR = "+447700900999";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "hub-"));
  const log = join(dir, "out.jsonl");
  const now = () => new Date("2026-10-04T15:00:00Z");
  const store = openStore(":memory:");
  store.setKV("owner.phone", NOOR);
  const sheet = loadFarmSheet();
  const outbox = createOutbox(store, simulatedOutbound(log), { now });
  const adapters = platformAdapters({ env: {}, logPath: join(dir, "platform.jsonl") });
  const hub = createHub({ store, sheet, outbox, adapters, sources: simulatedSources(join(HUB, "fixtures", "inbound")), now });
  const sent = () => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { store, hub, sent, dir };
}

test("platform bookings are confirmed, the overbooking is a conflict, and Noor is alerted for every event", async () => {
  const { hub, sent } = setup();
  const results = (await hub.ingest()).filter((r) => r.id);
  assert.deepEqual(results.filter((r) => r.action === "confirmed").length, 3);
  assert.deepEqual(results.filter((r) => r.action === "conflict").map((r) => r.reason), ["no_capacity"]);
  const toNoor = sent().filter((m) => m.recipient === NOOR);
  assert.equal(toNoor.filter((m) => m.channel === "sms").length, results.length);
  assert.ok(toNoor.some((m) => m.channel === "sms" && m.body.startsWith("SAUTI HARAKA")));
  // Ingesting again changes nothing and sends nothing new.
  const before = sent().length;
  await hub.ingest();
  assert.equal(sent().length, before);
});

test("a schedule change needs Noor's number AND the one-time code; spoof, wrong and reused codes do nothing", async () => {
  const { store, hub, sent } = setup();
  await hub.ownerSms({ from: NOOR, text: "FUNGA 2026-10-16" });
  const [, pid, code] = sent().at(-1).body.match(/NDIYO ([A-Z]+) (\d+)/);
  await hub.ownerSms({ from: "+447700900123", text: `NDIYO ${pid} ${code}` });
  await hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} 000000` });
  assert.deepEqual(store.getKV(CLOSED_DAYS_KV, {}), {});
  const ok = await hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
  assert.equal(ok.executed.ok, true);
  assert.deepEqual(Object.keys(store.getKV(CLOSED_DAYS_KV, {})), ["2026-10-16"]);
  const again = await hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
  assert.equal(again.executed, null);
});

test("a platform booking on a day Noor closed becomes a conflict and an urgent alert", async () => {
  const { store, hub } = setup();
  store.setKV(CLOSED_DAYS_KV, { "2026-10-16": { approval_id: "test" } });
  const r = hub.handleEvent({ id: "t:late", kind: "booking", channel: "gyg_api", received_at: "2026-10-04T15:00:00Z", synthetic: true,
    booking: { platform: "getyourguide", ref: "GYG-T", date: "2026-10-16", time: "09:00", party_size: 2, visitor_name: "Lena" } });
  assert.equal(r.action, "conflict");
  assert.equal(r.reason, "day_unavailable");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE date = ? AND state = 'confirmed'").get("2026-10-16").n, 0);
});

test("events for the app keep their own kind (owner_propose / owner_approval), with the proposal kind beside it", async () => {
  const { store, hub, sent } = setup();
  await hub.ownerSms({ from: NOOR, text: "FUNGA 2026-10-16" });
  const [, pid, code] = sent().at(-1).body.match(/NDIYO ([A-Z]+) (\d+)/);
  await hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
  const kinds = store.eventsSince(0).map((e) => [e.kind, e.proposal_kind]);
  assert.deepEqual(kinds, [["owner_propose", "close_day"], ["owner_approval", "close_day"]]);
});

test("codex review (1): a forged approval (proposal not approved through the code) cannot publish", async () => {
  const { store, hub, sent } = setup();
  await hub.ownerSms({ from: NOOR, text: "FUNGA 2026-10-16" });
  const [, pid] = sent().at(-1).body.match(/NDIYO ([A-Z]+) (\d+)/);
  const row = store.db.prepare("SELECT digest FROM proposals WHERE short_id = ?").get(pid);
  // Someone calls the publisher directly with a well-formed change for a proposal that is still only proposed.
  await assert.rejects(hub.publisher.publishAvailability({ approved: true, approval_id: `${pid}:${row.digest.slice(0, 12)}`,
    digest: row.digest, days: [{ date: "2026-10-16", open: false }] }), { code: "approval_not_found" });
  // And a modified payload for an approved proposal is refused too.
  const [, , code] = sent().at(-1).body.match(/NDIYO ([A-Z]+) (\d+)/);
  await hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
  await assert.rejects(hub.publisher.publishAvailability({ approved: true, approval_id: `${pid}:${row.digest.slice(0, 12)}`,
    digest: row.digest, days: [{ date: "2026-10-17", open: false }] }), { code: "approval_not_found" });
});

test("codex review (2): approval redeemed, then a crash before execution: recover() finishes the work once", async () => {
  const { store, hub, sent } = setup();
  const { handleOwnerSms } = await import("../src/commands.mjs");
  await hub.ownerSms({ from: NOOR, text: "FUNGA 2026-10-16" });
  const [, pid, code] = sent().at(-1).body.match(/NDIYO ([A-Z]+) (\d+)/);
  // The code is redeemed (state 'approved' persisted) but the process dies before the hub executes anything.
  const r = handleOwnerSms(store, { from: NOOR, text: `NDIYO ${pid} ${code}` }, { now: new Date("2026-10-04T15:00:00Z") });
  assert.equal(r.command.type, "approve");
  assert.deepEqual(store.getKV(CLOSED_DAYS_KV, {}), {});
  const rec = await hub.recover();
  assert.equal(rec.executed.length, 1);
  assert.deepEqual(Object.keys(store.getKV(CLOSED_DAYS_KV, {})), ["2026-10-16"]);
  assert.equal((await hub.recover()).executed.length, 0, "executed once");
});

test("codex review (A): a tampered stored proposal has NO local effect", async () => {
  const { store, hub, sent } = setup();
  await hub.ownerSms({ from: NOOR, text: "FUNGA 2026-10-20" });
  const [, pid, code] = sent().at(-1).body.match(/NDIYO ([A-Z]+) (\d+)/);
  const { handleOwnerSms } = await import("../src/commands.mjs");
  handleOwnerSms(store, { from: NOOR, text: `NDIYO ${pid} ${code}` }, { now: new Date("2026-10-04T15:00:00Z") });
  // The body is changed after approval, digest left as it was.
  store.db.prepare("UPDATE proposals SET body = ? WHERE short_id = ?").run(JSON.stringify({ date: "2026-10-21" }), pid);
  const done = await hub.runApproved();
  assert.equal(done[0].ok, false);
  assert.deepEqual(store.getKV(CLOSED_DAYS_KV, {}), {}, "no day closed, neither the approved one nor the tampered one");
});

test("codex review (B): an approved capacity change survives a restart", async () => {
  const { store, hub, sent } = setup();
  await hub.ownerSms({ from: NOOR, text: "NAFASI 8" });
  const [, pid, code] = sent().at(-1).body.match(/NDIYO ([A-Z]+) (\d+)/);
  await hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
  const fresh = loadFarmSheet();
  assert.equal(fresh.capacity_per_tour, 10);
  createHub({ store, sheet: fresh, outbox: createOutbox(store, simulatedOutbound(join(mkdtempSync(join(tmpdir(), "hub-")), "o.jsonl"))),
    adapters: platformAdapters({ env: {} }), sources: [] });
  assert.equal(fresh.capacity_per_tour, 8);
});
