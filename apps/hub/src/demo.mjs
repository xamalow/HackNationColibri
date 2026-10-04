/* global fetch */
// End-to-end demo of the tourism-office hub, fully offline (simulated transports, synthetic data).
//   npm ci --prefix packages/core && npm run build --prefix packages/core   (once)
//   node apps/hub/src/demo.mjs
// Phone numbers are fictional (UK Ofcom drama range +44 7700 900xxx). Nothing leaves this machine.

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadFarmSheet } from "./bookings.mjs";
import { createHub, simulatedSources } from "./hub.mjs";
import { createOutbox } from "./outbox.mjs";
import { platformAdapters } from "./publish.mjs";
import { openStore } from "./store.mjs";
import { createSyncServer, pairDevice } from "./sync.mjs";
import { simulatedOutbound } from "./transports/simulated.mjs";

const HUB = fileURLToPath(new URL("..", import.meta.url));
const VAR = join(HUB, "var", "demo");
const NOOR = "+447700900999";
const SPOOFER = "+447700900123";
let clock = new Date("2026-10-04T15:00:00Z");
const now = () => clock;

rmSync(VAR, { recursive: true, force: true });
mkdirSync(VAR, { recursive: true });
const smsLog = join(VAR, "outbound.jsonl");
const store = openStore(join(VAR, "hub.db"));
store.setKV("owner.phone", NOOR);
const sheet = loadFarmSheet();
const outbox = createOutbox(store, simulatedOutbound(smsLog), { now });
const adapters = platformAdapters({ env: {}, logPath: join(VAR, "platform.jsonl") });
const hub = createHub({ store, sheet, outbox, adapters, sources: simulatedSources(join(HUB, "fixtures", "inbound")), now });

const lines = (p) => { try { return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
let seen = 0;
const newOutbound = () => { const all = lines(smsLog); const fresh = all.slice(seen); seen = all.length; return fresh; };
const show = (title) => console.log(`\n=== ${title} ===`);
const printOutbound = () => {
  for (const m of newOutbound()) {
    if (m.channel === "sms") console.log(`  SMS to ${m.recipient === NOOR ? "Noor" : "sender"}: ${m.body}`);
    else console.log(`  CALL to Noor, clips: ${JSON.parse(m.body).join(" ")}`);
  }
};

show("1. Inbound: platform e-mails, GetYourGuide API, tourist SMS, a voicemail, a missed call (all SYNTHETIC)");
for (const r of await hub.ingest()) if (r.id) console.log(`  ${r.id.padEnd(34)} -> ${r.action}${r.reason ? ` (${r.reason})` : ""}`);

show("2. What Noor's basic phone received (SMS + a call of prerecorded Swahili clips)");
printOutbound();

show("3. Noor closes Friday 16/10 by SMS: the hub only PROPOSES and reads back with a one-time code");
await hub.ownerSms({ from: NOOR, text: "FUNGA 2026-10-16" });
const readback = newOutbound().find((m) => m.channel === "sms");
console.log(`  SMS to Noor: ${readback.body}`);
const [, pid, code] = readback.body.match(/NDIYO ([A-Z]+) (\d+)/);

show("4. Someone spoofing Noor's request with the right code from another number: refused, and NO reply (no SMS-pumping)");
await hub.ownerSms({ from: SPOOFER, text: `NDIYO ${pid} ${code}` });
printOutbound();
console.log(`  closed days: ${JSON.stringify(store.getKV("calendar.closed_days", {}))}`);

show("5. Noor with a wrong code: refused");
await hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} 000000` });
printOutbound();

show("6. Noor with her one-time code: approved, day closed, platforms updated (simulated adapter)");
const r = await hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
printOutbound();
console.log(`  publish: ${JSON.stringify(r.executed.results.map((x) => ({ platform: x.platform, status: x.status })))}`);
console.log(`  closed days: ${Object.keys(store.getKV("calendar.closed_days", {})).join(", ")}`);

show("7. The same code again: refused (single use)");
await hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
printOutbound();

show("8. A GetYourGuide booking arrives for the closed day: stored as a CONFLICT, Noor alerted urgently");
clock = new Date("2026-10-04T16:00:00Z");
const late = { id: "demo:gyg-late", kind: "booking", channel: "gyg_api", received_at: clock.toISOString(), synthetic: true,
  booking: { platform: "getyourguide", ref: "GYG-SYNTH-LATE", date: "2026-10-16", time: "09:00", party_size: 2, visitor_name: "Lena" } };
console.log(`  -> ${JSON.stringify(hub.handleEvent(late))}`);
await outbox.dispatch();
printOutbound();

show("9. Noor's app syncs when it has internet: pairs once, then pulls every event");
const token = pairDevice(store, "noor-iphone", { now });
const server = createSyncServer({ store, now, log: () => {} });
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}`;
const denied = await fetch(`${base}/v1/events?since=0`);
const res = await (await fetch(`${base}/v1/events?since=0`, { headers: { authorization: `Bearer ${token}` } })).json();
server.close();
const kinds = res.events.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {});
console.log(`  without token: HTTP ${denied.status}; with token: ${res.events.length} events ${JSON.stringify(kinds)}`);

store.close();
console.log("\nAll synthetic. Simulated transports only. Logs in apps/hub/var/demo/.");
