// Interactive demo: you play the tourists and Noor, the hub answers. Fully offline, simulated SMS, synthetic data.
//   node apps/hub/src/play.mjs
// Phone numbers are fictional (UK Ofcom drama range +44 7700 900xxx). Nothing leaves this machine.

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadFarmSheet } from "./bookings.mjs";
import { createHub, simulatedSources } from "./hub.mjs";
import { createOutbox } from "./outbox.mjs";
import { platformAdapters } from "./publish.mjs";
import { openStore } from "./store.mjs";
import { simulatedOutbound } from "./transports/simulated.mjs";

const HUB = fileURLToPath(new URL("..", import.meta.url));
const VAR = join(HUB, "var", "play");
const NOOR = "+447700900999";
const TOURISTS = { 1: "+447700900101", 2: "+447700900102", 3: "+447700900103" };
const STRANGER = "+447700900666";
let clock = new Date("2026-10-04T15:00:00Z");
const now = () => clock;

let tagger = null;
try { ({ tagFeedback: tagger } = await import("../../../contrib/max/tagger/tag_feedback.mjs")); } catch { /* langid deps missing */ }

rmSync(VAR, { recursive: true, force: true });
mkdirSync(VAR, { recursive: true });
const log = join(VAR, "outbound.jsonl");
const store = openStore(join(VAR, "hub.db"));
store.setKV("owner.phone", NOOR);
const sheet = loadFarmSheet();
const outbox = createOutbox(store, simulatedOutbound(log), { now });
const adapters = platformAdapters({ env: {}, logPath: join(VAR, "platform.jsonl") });
const hub = createHub({ store, sheet, outbox, adapters, sources: simulatedSources(join(HUB, "fixtures", "inbound")), now, tagger });

const C = { dim: "\x1b[2m", noor: "\x1b[33m", tourist: "\x1b[36m", hub: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
const nameOf = (n) => {
  const d = String(n).replace(/\D/g, "");
  if (d === NOOR.slice(1)) return `${C.noor}Noor${C.off}`;
  const t = Object.entries(TOURISTS).find(([, v]) => v.slice(1) === d);
  return t ? `${C.tourist}tourist ${t[0]}${C.off}` : `${C.red}${n}${C.off}`;
};
let seen = 0;
function flush() {
  let all = [];
  try { all = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { /* nothing sent yet */ }
  const fresh = all.slice(seen);
  seen = all.length;
  if (!fresh.length) console.log(`${C.dim}  (the hub sent nothing)${C.off}`);
  for (const m of fresh) {
    if (m.channel === "sms") console.log(`  ${C.hub}hub -> SMS to${C.off} ${nameOf(m.recipient)}: ${m.body}`);
    else console.log(`  ${C.hub}hub -> CALL to${C.off} ${nameOf(m.recipient)} ${C.dim}(clips: ${JSON.parse(m.body).join(" ")})${C.off}`);
  }
}
const fmt = () => clock.toISOString().slice(0, 16).replace("T", " ") + " UTC";
let seq = 0;
const touristSms = (n, text) => hub.handleEvent({
  id: `play:${++seq}`, kind: "visitor_message", channel: "sms", received_at: now().toISOString(), from: TOURISTS[n], text, synthetic: true,
});

const HELP = `
  You play the tourists and Noor. The hub is the office agent between them.
    t <text>          tourist 1 texts the office line   (t2 <text>, t3 <text> for tourists 2 and 3)
    n <text>          Noor texts the hub from her enrolled phone
    x <text>          a stranger texts the owner line pretending to be Noor
    day YYYY-MM-DD    move the clock to that day (09:00 farm time); runs the after-visit feedback step
    inbox             pull the simulated platforms (GetYourGuide, Airbnb, Booking.com e-mails, voicemail...)
    help | quit
  Try:  t Hello! Can we visit the coffee farm on Saturday 17 October? We are 4 people.
        n NDIYO A 123456        (copy the letter and code from Noor's SMS)
        n A 123456 Nitachelewa kidogo      (a message to the tourist; the request stays open)
        n HAPANA A 123456      n WAGENI 17/10      n LEO      n FUNGA 16/10      n MSAADA
        day 2026-10-18   then   n NDIYO <id> <code>   then   t The coffee was great but the road was hard to find
  Phone numbers are fictional; everything is simulated and offline.${tagger ? "" : `
  ${C.red}Max's tagger is not available (npm ci --prefix contrib/max/langid): no pain-point digest.${C.off}`}
`;

console.log(`${C.hub}Sauti hub, interactive demo${C.off}  ${C.dim}clock ${fmt()}${C.off}`);
console.log(HELP);
const rl = createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
  const line = (await rl.question(`${C.dim}[${fmt()}]${C.off} > `)).trim();
  if (!line) continue;
  const [cmd, ...rest] = line.split(/\s+/);
  const text = line.slice(cmd.length).trim();
  try {
    if (cmd === "quit" || cmd === "q" || cmd === "exit") break;
    else if (cmd === "help") console.log(HELP);
    else if (/^t[123]?$/.test(cmd) && text) {
      const r = touristSms(cmd.slice(1) || "1", text);
      console.log(`  ${C.dim}hub: ${r.action}${r.proposal_id ? ` (proposal ${r.proposal_id})` : ""}${r.reason ? ` (${r.reason})` : ""}${C.off}`);
      if (r.action === "feedback_reply") hub.feedbackTick(); // the pain-point digest to Noor
      await outbox.dispatch();
      flush();
    } else if ((cmd === "n" || cmd === "x") && text) {
      const r = await hub.ownerSms({ from: cmd === "n" ? NOOR : STRANGER, text });
      const ex = r.executed ? ` -> ${r.executed.kind ?? ""} ${r.executed.outcome ?? (r.executed.ok ? "ok" : r.executed.reason ?? "refused")}` : "";
      console.log(`  ${C.dim}hub: ${r.command ?? "no command"}${ex}${C.off}`);
      await outbox.dispatch();
      flush();
    } else if (cmd === "day" && /^\d{4}-\d{2}-\d{2}$/.test(rest[0] ?? "")) {
      clock = new Date(`${rest[0]}T06:00:00Z`);
      const fb = hub.feedbackTick();
      console.log(`  ${C.dim}clock moved; feedback step: ${fb.proposed.length} request(s) proposed to Noor${fb.digest ? ", pain-point digest sent" : ""}${C.off}`);
      await outbox.dispatch();
      flush();
    } else if (cmd === "inbox") {
      for (const r of await hub.ingest()) if (r.id) console.log(`  ${C.dim}${r.id} -> ${r.action}${r.reason ? ` (${r.reason})` : ""}${C.off}`);
      flush();
    } else console.log(`  ${C.dim}unknown command, type help${C.off}`);
  } catch (e) {
    console.log(`  ${C.red}error: ${e.message}${C.off}`);
  }
}
rl.close();
store.close();
