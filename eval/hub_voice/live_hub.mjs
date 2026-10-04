#!/usr/bin/env node
// A real hub for the voice agent's live path (Nat lane). Started by voice_live_suite.py, one per scenario.
//
//   node eval/hub_voice/live_hub.mjs <path to apps/hub>
//
// Serves the hub's own sync server with the voice API (apps/hub/src/voice_api.mjs) on 127.0.0.1, in memory, with
// simulated transports and a fixed clock, plus a CONTROL server on 127.0.0.1 that plays Noor's and a tourist's SMS
// and reads back what was sent and stored. Prints one JSON line {base, control, token} and runs until stdin closes.
// The token is for this throwaway in-memory hub only. Numbers are synthetic UK drama-range placeholders.

import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const hubDir = process.argv[2];
if (!hubDir) {
  console.error("usage: live_hub.mjs <path to apps/hub>");
  process.exit(2);
}
const load = (p) => import(pathToFileURL(resolve(hubDir, p)).href);
const { loadFarmSheet } = await load("src/bookings.mjs");
const { createHub } = await load("src/hub.mjs");
const { createOutbox } = await load("src/outbox.mjs");
const { platformAdapters } = await load("src/publish.mjs");
const { openStore } = await load("src/store.mjs");
const { createSyncServer, pairDevice } = await load("src/sync.mjs");
const { simulatedOutbound } = await load("src/transports/simulated.mjs");
const { createVoiceApi } = await load("src/voice_api.mjs");

const NOOR = "+447700900999";
const START = new Date("2026-10-04T15:00:00Z"); // Sunday afternoon, farm time EAT (as the hub's own voice tests)

const dir = mkdtempSync(join(tmpdir(), "nat-voice-live-"));
const log = join(dir, "out.jsonl");
const now = () => START;
const store = openStore(":memory:");
store.setKV("owner.phone", NOOR);
const sheet = loadFarmSheet();
const outbox = createOutbox(store, simulatedOutbound(log), { now });
const hub = createHub({ store, sheet, outbox, adapters: platformAdapters({ env: {}, logPath: join(dir, "platform.jsonl") }), now });
const voice = createVoiceApi({ store, sheet, outbox, now });
const server = createSyncServer({ store, voice, now, log: () => {} });
const token = pairDevice(store, "hub-voice", { now });

const sent = () => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
let seq = 0;
const control = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  let out;
  try {
    switch (req.url) {
      case "/noor": out = await hub.ownerSms({ from: body.from ?? NOOR, text: String(body.text) }); await outbox.dispatch(); break;
      case "/tourist":
        out = hub.handleEvent({ id: `sms:${++seq}`, kind: "visitor_message", channel: "sms", received_at: now().toISOString(), from: body.from, text: String(body.text), synthetic: true });
        await outbox.dispatch();
        break;
      case "/sent": out = sent().map((m) => ({ channel: m.channel, recipient: m.recipient, body: m.body ?? "" })); break;
      case "/state":
        out = {
          proposals: store.db.prepare("SELECT short_id, kind, state, body FROM proposals ORDER BY created_at, short_id").all().map((r) => ({ ...r, body: JSON.parse(r.body) })),
          bookings: store.db.prepare("SELECT date, party_size, state FROM bookings").all().map((r) => ({ ...r })),
        };
        break;
      default: res.writeHead(404).end(); return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out ?? null));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e?.message ?? e) }));
  }
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
await new Promise((r) => control.listen(0, "127.0.0.1", r));
process.stdout.write(JSON.stringify({ base: `http://127.0.0.1:${server.address().port}`, control: `http://127.0.0.1:${control.address().port}`, token }) + "\n");
process.stdin.resume();
process.stdin.on("end", () => { server.closeAllConnections(); server.close(); control.close(); store.close(); process.exit(0); });
