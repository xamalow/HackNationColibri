/* global fetch */
// End-to-end demo of the tourism-office hub, fully offline (simulated transports, synthetic data).
//   npm ci --prefix packages/core && npm run build --prefix packages/core   (once)
//   npm ci --prefix contrib/max/langid                                      (once: tourist language + feedback tags)
//   node apps/hub/src/demo.mjs
// Max's plan, phone/SMS first: a tourist texts the office line -> Noor decides by SMS with a one-time code ->
// the tourist is answered in their language -> after the visit, feedback (with Noor's yes) -> pain points to Noor.
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
const CLAIRE = "+447700900123"; // the tourist of fixtures/inbound/sms/01-booking-request.json
const SPOOFER = "+447700900666";
let clock = new Date("2026-10-04T15:00:00Z");
const now = () => clock;

// Max's tagger needs the langid dependencies; without them the demo still runs, minus the pain-point digest.
let tagger = null;
try { ({ tagFeedback: tagger } = await import("../../../contrib/max/tagger/tag_feedback.mjs")); } catch { /* langid deps not installed: no digest */ }

rmSync(VAR, { recursive: true, force: true });
mkdirSync(VAR, { recursive: true });
const smsLog = join(VAR, "outbound.jsonl");
const store = openStore(join(VAR, "hub.db"));
store.setKV("owner.phone", NOOR);
const sheet = loadFarmSheet();
const outbox = createOutbox(store, simulatedOutbound(smsLog), { now });
const adapters = platformAdapters({ env: {}, logPath: join(VAR, "platform.jsonl") });
const hub = createHub({ store, sheet, outbox, adapters, sources: simulatedSources(join(HUB, "fixtures", "inbound")), now, tagger });

const lines = (p) => { try { return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
let seen = 0;
let last = [];
const newOutbound = () => { const all = lines(smsLog); last = all.slice(seen); seen = all.length; return last; };
const who = (n) => (n === NOOR ? "Noor" : n.replace(/\D/g, "") === CLAIRE.slice(1) ? "Claire (tourist)" : "sender");
const show = (title) => console.log(`\n=== ${title} ===`);
const printOutbound = () => {
  for (const m of newOutbound()) {
    if (m.channel === "sms") console.log(`  SMS to ${who(m.recipient)}: ${m.body}`);
    else console.log(`  CALL to Noor, clips: ${JSON.parse(m.body).join(" ")}`);
  }
};
const codeFrom = (msgs) => msgs.filter((m) => m.recipient === NOOR).map((m) => m.body.match(/NDIYO ([A-Z]+) (\d+)/)).find(Boolean)?.slice(1);

show("1. Inbound: Claire's SMS, a tourist question, platform e-mails, GetYourGuide API, a voicemail, a missed call (SYNTHETIC)");
for (const r of await hub.ingest()) if (r.id) console.log(`  ${r.id.padEnd(34)} -> ${r.action}${r.reason ? ` (${r.reason})` : ""}`);

show("2. What went out: Claire's request read back to Noor WITH a one-time code, a fixed acknowledgement to Claire, alerts");
printOutbound();
const [rid, rcode] = codeFrom(last);

show("3. Noor answers with a suggestion (her code, her words): relayed to Claire, the request stays open");
await hub.ownerSms({ from: NOOR, text: `${rid} ${rcode} Karibu! Nitachelewa kidogo, tutaanza saa tatu na nusu.` });
printOutbound();

show("4. Someone else sends NDIYO with the right code: refused, no reply, nothing booked");
await hub.ownerSms({ from: SPOOFER, text: `NDIYO ${rid} ${rcode}` });
printOutbound();
console.log(`  bookings for 17/10: ${store.db.prepare("SELECT COUNT(*) n FROM bookings WHERE date = '2026-10-17' AND platform = 'direct'").get().n}`);

show("5. Noor: NDIYO with her code -> availability re-checked by code, booking written, Claire confirmed in her language");
const ok = await hub.ownerSms({ from: NOOR, text: `NDIYO ${rid} ${rcode}` });
printOutbound();
console.log(`  -> ${JSON.stringify(ok.executed)}`);

show("6. Noor asks the hub who comes on Saturday (read-only, answered only to her enrolled number)");
await hub.ownerSms({ from: NOOR, text: "WAGENI 17/10" });
printOutbound();

show("7. Noor closes Friday 16/10 by SMS: proposal + one-time code, approved, platforms updated (simulated adapter)");
await hub.ownerSms({ from: NOOR, text: "FUNGA 2026-10-16" });
printOutbound();
const [pid, code] = codeFrom(last);
await hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} 000000` });
const r = await hub.ownerSms({ from: NOOR, text: `NDIYO ${pid} ${code}` });
printOutbound();
console.log(`  publish: ${JSON.stringify(r.executed.results.map((x) => ({ platform: x.platform, status: x.status })))}`);

show("8. A GetYourGuide booking arrives for the closed day: stored as a CONFLICT, Noor alerted urgently");
clock = new Date("2026-10-04T16:00:00Z");
const late = { id: "demo:gyg-late", kind: "booking", channel: "gyg_api", received_at: clock.toISOString(), synthetic: true,
  booking: { platform: "getyourguide", ref: "GYG-SYNTH-LATE", date: "2026-10-16", time: "09:00", party_size: 2, visitor_name: "Lena" } };
console.log(`  -> ${JSON.stringify(hub.handleEvent(late))}`);
await outbox.dispatch();
printOutbound();

show("9. After Claire's visit: the feedback request is PROPOSED to Noor; Claire is asked only after Noor's NDIYO");
clock = new Date("2026-10-18T09:00:00Z");
hub.feedbackTick();
await outbox.dispatch();
printOutbound();
const [fid, fcode] = codeFrom(last);
await hub.ownerSms({ from: NOOR, text: `NDIYO ${fid} ${fcode}` });
printOutbound();

show("10. Claire answers; the hub stores it as data and sends Noor the pain points in Swahili (exact quotes, counts by code)");
clock = new Date("2026-10-18T12:00:00Z");
const reply = { id: "sms:claire-feedback", kind: "visitor_message", channel: "sms", received_at: clock.toISOString(), from: CLAIRE, synthetic: true,
  text: "The coffee tasting was wonderful, but the road was hard to find and we got lost twice." };
console.log(`  -> ${JSON.stringify(hub.handleEvent(reply))}`);
const fb = hub.feedbackTick();
await outbox.dispatch();
printOutbound();
if (!tagger) console.log("  (pain-point digest skipped: run `npm ci --prefix contrib/max/langid` for Max's tagger)");
else if (!fb.digest) console.log("  (no digest: nothing new)");

show("11. Noor's app syncs when it has internet: pairs once, then pulls every event");
const token = pairDevice(store, "noor-iphone", { now });
const server = createSyncServer({ store, now, log: () => {} });
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;
const denied = await fetch(`${base}/v1/events?since=0`);
const res = await (await fetch(`${base}/v1/events?since=0`, { headers: { authorization: `Bearer ${token}` } })).json();
server.close();
const kinds = res.events.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {});
console.log(`  without token: HTTP ${denied.status}; with token: ${res.events.length} events ${JSON.stringify(kinds)}`);

store.close();
console.log("\nAll synthetic. Simulated transports only. Logs in apps/hub/var/demo/.");
