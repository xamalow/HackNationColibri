// Live demo for the jury: two phones in a browser (Noor and a tourist) driving the REAL hub with simulated SMS.
//   node apps/hub/src/demo_web.mjs [--port 5180]      then open http://127.0.0.1:5180/
// Fully offline: the page has no external assets and only talks to this server, bound to 127.0.0.1.
// Same setup as play.mjs: in-memory store, simulated transports, synthetic data. Phone numbers are fictional
// (UK Ofcom drama range +44 7700 900xxx) and never reach the page: it only sees roles (noor, tourist1, ...).

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadFarmSheet } from "./bookings.mjs";
import { createHub, simulatedSources } from "./hub.mjs";
import { createOutbox } from "./outbox.mjs";
import { platformAdapters } from "./publish.mjs";
import { openStore } from "./store.mjs";
import { simulatedOutbound } from "./transports/simulated.mjs";

const HUB = fileURLToPath(new URL("..", import.meta.url));
const PAGE_PATH = fileURLToPath(new URL("./demo_web/index.html", import.meta.url));
export const DEFAULT_PORT = 5180;
export const HOST = "127.0.0.1";
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_TEXT = 500;
const MAX_HUB_LOG = 300;

export const NOOR = "+447700900999";
export const TOURISTS = Object.freeze({ 1: "+447700900101", 2: "+447700900102", 3: "+447700900103" });
export const STRANGER = "+447700900666";
const START_CLOCK = "2026-10-04T15:00:00Z";

let tagger = null;
try { ({ tagFeedback: tagger } = await import("../../../contrib/max/tagger/tag_feedback.mjs")); } catch { /* langid deps missing */ }

const digits = (n) => String(n ?? "").replace(/\D/g, "");
/** The role behind a number, so the page never sees a phone number. */
function roleOf(n) {
  const d = digits(n);
  if (d === digits(NOOR)) return "noor";
  for (const [i, v] of Object.entries(TOURISTS)) if (d === digits(v)) return `tourist${i}`;
  if (d === digits(STRANGER)) return "stranger";
  return "other";
}

// English glosses ONLY for fixed Swahili templates (exact, anchored patterns). Anything else gets no gloss:
// the UI never machine-translates.
const GLOSSES = [
  [/^SAUTI: Mgeni (?:\S+ )?\((?:\S+)\) anaomba (?:mtu 1|watu (\d+)), .*?(\d{1,2}\/\d{1,2}), KES (\d+)\. Jibu NDIYO (\w+) \d+, HAPANA \w+ \d+, au \w+ \d+ <ujumbe>$/,
    (m) => `A guest asks for ${m[1] ?? 1} people on ${m[2]}, KES ${m[3]}. Reply NDIYO (yes), HAPANA (no), or ${m[4]} <code> <your message>.`],
  [/^Sawa\. (\w+) imeidhinishwa\. Mgeni atapata uthibitisho\.$/, (m) => `OK. ${m[1]} approved. The guest will get a confirmation.`],
  [/^Sawa\. (\w+) imeidhinishwa\. Ombi la maoni litatumwa kwa mgeni\.$/, (m) => `OK. ${m[1]} approved. The feedback request will be sent to the guest.`],
  [/^Sawa\. (\w+) imeidhinishwa na itatumwa kwa tovuti\.$/, (m) => `OK. ${m[1]} approved; it will be sent to the websites.`],
  [/^Sawa\. (\w+) imekataliwa\. Hakuna kitakachobadilishwa\.$/, (m) => `OK. ${m[1]} declined. Nothing will change.`],
  [/^Sawa\. Ujumbe wako kwa mgeni wa (\w+) umetumwa\. Ombi bado linasubiri NDIYO au HAPANA\.$/,
    (m) => `OK. Your message to the guest of ${m[1]} was sent. The request still waits for NDIYO or HAPANA.`],
  [/^SAUTI: Umtumie mgeni wa .*?(\d{1,2}\/\d{1,2}) \((?:mtu 1|watu (\d+))\) ombi la maoni ya ziara\? Jibu NDIYO (\w+) \d+ au HAPANA \w+\.$/,
    (m) => `Send the guest of ${m[1]} (${m[2] ?? 1} people) a request for feedback on the visit? Reply NDIYO ${m[3]} <code> or HAPANA ${m[3]}.`],
  [/^SAUTI: Ujumbe wa mgeni \((SMS|WhatsApp)\) unasubiri jibu lako\. Angalia Sauti\.$/, (m) => `A guest message (${m[1]}) is waiting for your answer. Look in Sauti.`],
  [/^Sikuelewa\. Hakuna kilichobadilishwa\. Tuma MSAADA kwa maelezo\.$/, () => "Not understood. Nothing changed. Send MSAADA for help."],
  [/^Pendekezo (\w+) halipo au limeshaamuliwa\. Hakuna kilichobadilishwa\.$/, (m) => `Proposal ${m[1]} does not exist or was already decided. Nothing changed.`],
  [/^SAUTI: FUNGA 12\/10, FUNGUA 12\/10, NAFASI 8, BEI 2000\./, () => "Help: the commands Noor can send (close/reopen a day, capacity, price, yes/no)."],
  [/^SAUTI: Ufunge .*?(\d{1,2}\/\d{1,2}) kwenye tovuti zote\? Jibu NDIYO (\w+) \d+ au HAPANA \w+\.$/,
    (m) => `Close ${m[1]} on all websites? Reply NDIYO ${m[2]} <code> or HAPANA ${m[2]}.`],
  [/^SAUTI: Ufungue .*?(\d{1,2}\/\d{1,2}) kwenye tovuti zote\? Jibu NDIYO (\w+) \d+ au HAPANA \w+\.$/,
    (m) => `Reopen ${m[1]} on all websites? Reply NDIYO ${m[2]} <code> or HAPANA ${m[2]}.`],
];
export function glossOf(text) {
  for (const [re, fn] of GLOSSES) {
    const m = re.exec(text);
    if (m) return fn(m);
  }
  return null;
}

const ACTION_LABEL = {
  request_proposed: "booking request: checked by code, read-back + one-time code sent to Noor",
  question: "a question (no date, no party size): no automatic answer",
  feedback_reply: "feedback reply: stored as data, never read as a request",
  request_ask_tourist: "booking request incomplete: fixed reply asks the tourist",
  request_unavailable: "day not available (checked by code): fixed reply to the tourist",
  duplicate_event: "duplicate message ignored",
};

/** One demo session: a fresh in-memory store and hub, a fresh outbound log, threads for the page. */
function createSession(varDir) {
  rmSync(varDir, { recursive: true, force: true });
  mkdirSync(varDir, { recursive: true });
  let base = Date.parse(START_CLOCK);
  let setAt = Date.now();
  let frozen = new Date(base);
  const live = () => new Date(base + (Date.now() - setAt));
  const now = () => frozen;
  const s = {
    threads: { noor: [], tourist1: [], tourist2: [], tourist3: [], other: [] },
    hubLog: [],
    seq: 0,
    version: 1,
    live,
    now,
    /** Freeze the clock for one action, strictly after the previous one (outbox keys and event ids use it). */
    tick() { frozen = new Date(Math.max(live().getTime(), frozen.getTime() + 1000)); return frozen; },
    setDay(date) { base = Date.parse(`${date}T06:00:00Z`); setAt = Date.now(); frozen = new Date(base); },
  };
  s.push = (thread, msg) => { s.threads[thread].push({ id: ++s.seq, at: frozen.toISOString(), ...msg }); s.version++; };
  s.log = (actor, text) => {
    s.hubLog.push({ id: ++s.seq, at: frozen.toISOString(), actor, text });
    if (s.hubLog.length > MAX_HUB_LOG) s.hubLog.splice(0, s.hubLog.length - MAX_HUB_LOG);
    s.version++;
  };

  const sim = simulatedOutbound(join(varDir, "outbound.jsonl"));
  // Wrap the simulated transport: every message the hub really sends is also shown on the right phone.
  const transport = {
    name: "demo_web",
    send(item) {
      const r = sim.send(item);
      const to = roleOf(item.recipient);
      const thread = to === "stranger" ? "other" : to;
      if (item.channel === "call") {
        let clips = [];
        try { clips = JSON.parse(item.body); } catch { /* not a clip list */ }
        s.push(thread, { from: "hub", to, kind: "call", text: "Simu kutoka Sauti", clips });
      } else {
        const gloss = to === "noor" ? glossOf(item.body) : null;
        s.push(thread, { from: "hub", to, kind: "sms", text: item.body, ...(gloss ? { gloss } : {}) });
      }
      return r;
    },
    wasSent: (key) => sim.wasSent(key),
  };
  s.store = openStore(":memory:");
  s.store.setKV("owner.phone", NOOR);
  const sheet = loadFarmSheet();
  s.outbox = createOutbox(s.store, transport, { now });
  const adapters = platformAdapters({ env: {}, logPath: join(varDir, "platform.jsonl") });
  s.hub = createHub({
    store: s.store, sheet, outbox: s.outbox, adapters, sources: simulatedSources(join(HUB, "fixtures", "inbound")), now, tagger,
  });
  s.log("hub", `Fresh hub: empty calendar, farm sheet loaded (capacity ${sheet.capacity_per_tour}, KES ${sheet.price_per_person_kes}/person).${tagger ? "" : " Feedback tagger missing: no pain-point digest."}`);
  return s;
}

// ---------------------------------------------------------------------------------------------------------
// Actions (each runs alone, in order: see `serial`)

const NAMES = { 1: "Claire (EN)", 2: "Jonas (DE)", 3: "Amina (SW)" };

async function touristSays(s, n, text, { digest: runDigest = true } = {}) {
  s.tick();
  s.push(`tourist${n}`, { from: `tourist${n}`, to: "hub", kind: "sms", text });
  const r = s.hub.handleEvent({
    id: `web:${s.seq}`, kind: "visitor_message", channel: "sms", received_at: s.now().toISOString(), from: TOURISTS[n], text, synthetic: true,
  });
  let digest = null;
  if (r.action === "feedback_reply" && runDigest) digest = s.hub.feedbackTick().digest;
  await s.outbox.dispatch();
  const label = ACTION_LABEL[r.action] ?? r.action;
  const extra = [r.proposal_id ? `proposal ${r.proposal_id}` : null, r.reason ? `reason: ${r.reason}` : null].filter(Boolean).join(", ");
  const alerted = r.alerted && r.action !== "request_proposed" ? " -> Noor alerted (SMS + call)" : "";
  s.log(`tourist ${NAMES[n]}`, `${label}${extra ? ` (${extra})` : ""}${alerted}${digest ? " -> pain-point digest (Swahili, counts by code) sent to Noor" : ""}`);
  return { action: r.action, proposal_id: r.proposal_id ?? null };
}

function describeOwner(r, replies) {
  if (r.command === "query") return `query ${r.query ?? ""} -> read-only answer to Noor's enrolled number${r.reply_sent ? "" : " (daily cap reached, not sent)"}`;
  if (!r.command) {
    if (!r.reply_sent) return "no command, no reply";
    const gloss = replies.map((m) => m.gloss).find(Boolean);
    return `no change -> fixed reply${gloss ? ` ("${gloss}")` : ""}`;
  }
  const parts = [r.command];
  if (r.executed) {
    const e = r.executed;
    parts.push(`-> ${e.kind ?? ""} ${e.outcome ?? (e.ok ? "ok" : e.reason ?? "refused")}`.replace(/\s+/g, " ").trim());
  } else if (r.command === "propose") parts.push("-> read-back with a one-time code sent to Noor (nothing changes until NDIYO)");
  else if (r.command === "reject") parts.push("-> declined");
  if (r.relayed) parts.push(`-> her words relayed to the tourist; request still open`);
  return parts.join(" ");
}

async function noorSays(s, text) {
  s.tick();
  s.push("noor", { from: "noor", to: "hub", kind: "sms", text });
  const seen = s.threads.noor.length;
  const r = await s.hub.ownerSms({ from: NOOR, text });
  await s.outbox.dispatch();
  s.log("Noor", describeOwner(r, s.threads.noor.slice(seen)));
  return { command: r.command, executed: r.executed ? { kind: r.executed.kind ?? null, ok: Boolean(r.executed.ok), outcome: r.executed.outcome ?? null } : null };
}

async function strangerSays(s, text) {
  s.tick();
  s.push("other", { from: "stranger", to: "hub", kind: "sms", text });
  const before = s.store.db.prepare("SELECT COUNT(*) AS n FROM bookings").get().n;
  const r = await s.hub.ownerSms({ from: STRANGER, text });
  await s.outbox.dispatch();
  const after = s.store.db.prepare("SELECT COUNT(*) AS n FROM bookings").get().n;
  s.log("stranger", `"${text.replace(/\d{4,}/g, "######")}" from a number that is not Noor's -> ${r.command ? r.command : "ignored"}, no reply, bookings ${before} -> ${after}`);
  return { command: r.command, bookings_before: before, bookings_after: after };
}

async function jumpDay(s, date) {
  s.setDay(date);
  s.tick();
  const fb = s.hub.feedbackTick();
  await s.outbox.dispatch();
  s.log("clock", `moved to ${date} 09:00 farm time; feedback step: ${fb.proposed.length} request(s) proposed to Noor${fb.proposed.length ? ` (${fb.proposed.join(", ")})` : ""}${fb.digest ? ", pain-point digest sent" : ""}`);
  return { proposed: fb.proposed };
}

// "Load sample feedback": three visits played through the REAL hub (no shortcut): each tourist books Saturday
// 17 October, Noor approves with her code, the clock moves to the 18th, Noor approves each feedback request, the
// tourists answer, and the pain-point digest goes to Noor. Then MAONI on Noor's phone asks for it again.
const SAMPLE_VISITS = [
  [1, "Hello! Can we visit the coffee farm on Saturday 17 October? We are 2 people.",
    "The coffee tasting was wonderful but the road was hard to find, we got lost."],
  [2, "Hi, we would like to come on Saturday 17 October, 2 people please.",
    "Lovely coffee and a great guide, but the directions were confusing and there is no sign."],
  [3, "Habari, tungependa kuja Jumamosi tarehe 17 Oktoba, sisi ni watu wawili.",
    "Kahawa ilikuwa nzuri sana, lakini maelekezo ya kufika yalikuwa magumu, tulipotea njia."],
];
function latestOwnerCode(s, since = 0) {
  for (const m of s.threads.noor.slice(since).reverse()) {
    const c = m.from !== "noor" && /NDIYO ([A-Z]+) (\d{4,8})/.exec(m.text ?? "");
    if (c) return [c[1], c[2]];
  }
  return null;
}
async function sampleFeedback(s) {
  for (const [n, request] of SAMPLE_VISITS) {
    const seen = s.threads.noor.length;
    await touristSays(s, n, request);
    const c = latestOwnerCode(s, seen);
    if (c) await noorSays(s, `NDIYO ${c[0]} ${c[1]}`);
  }
  if (s.now() < new Date("2026-10-18T06:00:00Z")) await jumpDay(s, "2026-10-18");
  for (const m of s.threads.noor.filter((x) => x.from !== "noor" && /ombi la maoni/.test(x.text ?? ""))) {
    const c = /NDIYO ([A-Z]+) (\d{4,8})/.exec(m.text);
    if (c) await noorSays(s, `NDIYO ${c[1]} ${c[2]}`);
  }
  for (const [n, , reply] of SAMPLE_VISITS) await touristSays(s, n, reply);
  s.log("demo", "sample feedback loaded: 3 visits on 17 Oct, 3 replies; Noor can now text MAONI");
  return { visits: SAMPLE_VISITS.length };
}

// Guided demo (Max: "a pre-conceived demo for the full process, so we can just click"): each click plays ONE
// step through the REAL hub with pre-written messages; the narration says what the jury should notice.
const approveLatest = async (s, since, verb = "NDIYO") => {
  const c = latestOwnerCode(s, since);
  if (c) await noorSays(s, `${verb} ${c[0]} ${c[1]}`);
  return c;
};
const GUIDED = [
  { title: "A tourist books by SMS", say: "Claire texts the farm: Saturday 17 October, 4 people. The hub checks the calendar and the price, and sends Noor a short summary in Swahili on her basic phone. Claire gets a friendly acknowledgement.",
    run: async (s) => { await touristSays(s, 1, "Hello! Can we visit the coffee farm on Saturday 17 October? We are 4 people."); } },
  { title: "Noor says yes", say: "Noor answers NDIYO (yes) from her phone. The booking is saved and Claire gets her confirmation with the time and the price.",
    run: async (s) => { await approveLatest(s, 0); } },
  { title: "Two more visitors book, Noor says yes", say: "Amina writes in Swahili, another guest in English. Noor gets each request in Swahili and says yes to both; each guest is confirmed in their language.",
    run: async (s) => {
      let seen = s.threads.noor.length;
      await touristSays(s, 3, "Habari, tungependa kuja Jumamosi tarehe 17 Oktoba, sisi ni watu wawili.");
      await approveLatest(s, seen);
      seen = s.threads.noor.length;
      await touristSays(s, 2, "Hi, we would like to come on Saturday 17 October, 2 people please.");
      await approveLatest(s, seen);
    } },
  { title: "Noor checks who is coming", say: "Noor texts WAGENI 17/10: 3 groups, 8 people, 2 places left.",
    run: async (s) => { await noorSays(s, "WAGENI 17/10"); } },
  { title: "The visit day", say: "Saturday's tour has happened. The next morning the hub asks Noor if it may send each visitor a short feedback question.",
    run: async (s) => { if (s.now() < new Date("2026-10-18T06:00:00Z")) await jumpDay(s, "2026-10-18"); } },
  { title: "Noor says yes to the feedback questions", say: "Each visitor receives one short question in their language: what did you like, what could be better?",
    run: async (s) => {
      for (const m of s.threads.noor.filter((x) => x.from !== "noor" && /ombi la maoni/.test(x.text ?? ""))) {
        const c = /NDIYO ([A-Z]+) (\d{4,8})/.exec(m.text);
        if (c) await noorSays(s, `NDIYO ${c[1]} ${c[2]}`);
      }
    } },
  { title: "The visitors answer", say: "Three answers in English and Swahili. The hub groups them by theme and sends Noor one summary in Swahili: everyone loved the coffee, and the road to the farm is hard to find.",
    run: async (s) => {
      // One summary after the three answers (not one per answer).
      await touristSays(s, 1, "The coffee tasting was wonderful but the road was hard to find, we got lost.", { digest: false });
      await touristSays(s, 3, "Kahawa ilikuwa nzuri sana, lakini maelekezo ya kufika yalikuwa magumu, tulipotea njia.", { digest: false });
      await touristSays(s, 2, "Lovely coffee and a great guide, but the directions were confusing and there is no sign.", { digest: false });
      s.tick();
      const fb = s.hub.feedbackTick();
      await s.outbox.dispatch();
      s.log("hub", `feedback: 3 answers${fb.digest ? " -> summary sent to Noor in Swahili" : ""}`);
    } },
  { title: "Noor asks for the feedback summary", say: "Any time later, Noor texts MAONI and gets the summary again: the road is the problem to fix, the coffee is what guests love.",
    run: async (s) => { await noorSays(s, "MAONI"); } },
];
async function guidedNext(s) {
  const i = s.guidedStep ?? 0;
  if (i >= GUIDED.length) return { done: true, step: i, total: GUIDED.length };
  const step = GUIDED[i];
  s.log("demo", `step ${i + 1}/${GUIDED.length}: ${step.title}`);
  await step.run(s);
  s.guidedStep = i + 1;
  s.version++;
  return { done: s.guidedStep >= GUIDED.length, step: s.guidedStep, total: GUIDED.length, title: step.title, say: step.say };
}
const guidedState = (s) => {
  const i = s.guidedStep ?? 0;
  const last = i > 0 ? GUIDED[i - 1] : null;
  return {
    step: i, total: GUIDED.length, next: GUIDED[i]?.title ?? null,
    last: last ? { title: last.title, say: last.say } : null, titles: GUIDED.map((g) => g.title),
  };
};

async function inbox(s) {
  s.tick();
  const results = await s.hub.ingest();
  const items = results.filter((r) => r.id);
  for (const r of items) {
    const source = String(r.id).split(":")[0];
    s.log("platforms", `${source} item -> ${r.action}${r.reason ? ` (${r.reason})` : ""}${r.alerted ? ", Noor alerted" : ""}`);
  }
  if (!items.length) s.log("platforms", "nothing new from the platforms");
  return { items: items.length };
}

// ---------------------------------------------------------------------------------------------------------
// HTTP

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function readJson(req) {
  return new Promise((ok, fail) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return fail(new HttpError(413, "payload_too_large"));
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (c) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { failed = true; chunks.length = 0; fail(new HttpError(413, "payload_too_large")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (failed) return;
      if (!size) return ok({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
        ok(v);
      } catch { fail(new HttpError(400, "invalid_json")); }
    });
    req.on("error", () => { if (!failed) { failed = true; fail(new HttpError(400, "bad_request")); } });
  });
}

function cleanText(v) {
  if (typeof v !== "string") throw new HttpError(400, "text_required");
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) throw new HttpError(400, "text_required");
  if (t.length > MAX_TEXT) throw new HttpError(400, "text_too_long");
  return t;
}

function cleanDate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, "invalid_date");
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new HttpError(400, "invalid_date");
  const y = d.getUTCFullYear();
  if (y < 2026 || y > 2027) throw new HttpError(400, "date_out_of_range");
  return v;
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
// The page may only talk to this server: no external script, style, font, image or connection.
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; "
  + "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...SECURITY_HEADERS });
  res.end(body);
}

/**
 * @param {{ varDir?: string, log?: (line: string) => void }} [opts]
 * @returns {{ server: import("node:http").Server, listen: (port?: number) => Promise<number>, close: () => Promise<void> }}
 */
export function createDemoServer({ varDir = join(HUB, "var", "demo-web"), log = (l) => console.error(l) } = {}) {
  let session = createSession(varDir);
  let chain = Promise.resolve();
  /** Actions run one at a time, in arrival order: the hub and the clock never interleave. */
  const serial = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };
  const page = () => readFileSync(PAGE_PATH, "utf8");
  let port = 0;

  const state = () => ({
    version: session.version,
    clock: session.live().toISOString(),
    tagger: Boolean(tagger),
    threads: session.threads,
    hubLog: session.hubLog,
    guided: guidedState(session),
  });

  const routes = {
    "POST /api/tourist": async (b) => {
      const n = b.tourist;
      if (!Number.isInteger(n) || n < 1 || n > 3) throw new HttpError(400, "invalid_tourist");
      const text = cleanText(b.text);
      return serial(() => touristSays(session, n, text));
    },
    "POST /api/noor": async (b) => { const text = cleanText(b.text); return serial(() => noorSays(session, text)); },
    "POST /api/stranger": async (b) => { const text = cleanText(b.text); return serial(() => strangerSays(session, text)); },
    "POST /api/day": async (b) => { const date = cleanDate(b.date); return serial(() => jumpDay(session, date)); },
    "POST /api/inbox": async () => serial(() => inbox(session)),
    "POST /api/sample-feedback": async () => serial(() => sampleFeedback(session)),
    "POST /api/guided/next": async () => serial(() => guidedNext(session)),
    "POST /api/reset": async () => serial(() => {
      const old = session;
      session = createSession(varDir);
      try { old.store.db.close(); } catch { /* already closed */ }
      return { ok: true };
    }),
  };

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    // DNS-rebinding guard: only answer requests addressed to this machine.
    const host = String(req.headers.host ?? "");
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return send(res, 421, { error: { code: "wrong_host" } });
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = page();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html), "Content-Security-Policy": CSP, ...SECURITY_HEADERS,
      });
      return res.end(html);
    }
    if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, state());
    if (req.method === "GET" && url.pathname === "/favicon.ico") { res.writeHead(204, SECURITY_HEADERS); return res.end(); }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, { error: { code: "not_found" } });
    // JSON only: a cross-site form post cannot set this content type without a preflight we never answer.
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "json_required");
    }
    const body = await readJson(req);
    const result = await route(body);
    return send(res, 200, { ok: true, result });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) {
        if (err.status === 413) res.setHeader("Connection", "close");
        return send(res, err.status, { error: { code: err.code } });
      }
      log(`demo_web: internal error on ${req.method} ${String(req.url ?? "").split("?")[0]}: ${err?.message ?? err}`);
      return send(res, 500, { error: { code: "internal" } });
    });
  });

  return {
    server,
    /** Bind to 127.0.0.1 only. Resolves with the port. */
    listen: (p = DEFAULT_PORT) => new Promise((ok, fail) => {
      server.once("error", fail);
      server.listen(p, HOST, () => { server.off("error", fail); port = server.address().port; ok(port); });
    }),
    close: () => new Promise((ok) => {
      server.close(() => ok());
      server.closeAllConnections?.();
      try { session.store.db.close(); } catch { /* already closed */ }
    }),
  };
}

function parsePort(argv) {
  const i = argv.indexOf("--port");
  if (i === -1) return DEFAULT_PORT;
  const p = Number(argv[i + 1]);
  if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error("--port needs a number between 0 and 65535");
  return p;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const demo = createDemoServer();
  const port = await demo.listen(parsePort(process.argv.slice(2)));
  console.log(`Sauti Host live demo: http://${HOST}:${port}/   (offline, simulated SMS, synthetic data; Ctrl+C to stop)`);
  if (!tagger) console.log("Max's tagger is not available (npm ci --prefix contrib/max/langid): no pain-point digest.");
  const stop = () => demo.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
