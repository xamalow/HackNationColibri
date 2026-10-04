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
import { createPublisher, platformAdapters } from "../src/publish.mjs";
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
  const publisher = createPublisher({ store, adapters: platformAdapters({ env: {}, logPath: join(dir, "platform.jsonl") }), now });
  const hub = createHub({ store, sheet, outbox, publisher, sources: simulatedSources(join(HUB, "fixtures", "inbound")), now });
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
