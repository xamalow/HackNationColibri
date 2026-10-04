#!/usr/bin/env node
// The hub with a REAL Twilio number, without opening any inbound port on the hub PC:
//   inbound SMS  = polling Twilio's Messages API (transports/twilio_poll.mjs), deduped by message SID in the store;
//   outbound SMS = the REST adapter (transports/twilio.mjs) through the idempotent outbox, under a daily cost cap.
// All AI stays on this PC. The signed-webhook path (createTwilioWebhook) is untouched and not used here.
//
//   node apps/hub/src/run_hub.mjs --dry-run [--once] [--verbose] [--inbound file.jsonl] [--outbound-log file.jsonl]
//   node apps/hub/src/run_hub.mjs --live [--once] [--verbose]
//
// Config from the environment, optionally completed by a private KEY=VALUE file named by HUB_ENV_FILE, which must
// live OUTSIDE any git working tree (refused otherwise). Explicit environment variables win over the file.
// Logs never carry a token, a full phone number (masked to the last 2 digits) or a message body (bodies only with
// --verbose, numbers still masked, one-time codes in Noor's SMS masked).
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadFarmSheet } from "./bookings.mjs";
import { eatDate } from "./booking_requests.mjs";
import { normalizePhone } from "./commands.mjs";
import { createHub } from "./hub.mjs";
import { sanitizeText, smsToEvent } from "./intake/sms.mjs";
import { MANIFEST_KEYS } from "./notify.mjs";
import { createOutbox, STATUS } from "./outbox.mjs";
import { platformAdapters } from "./publish.mjs";
import { openStore } from "./store.mjs";
import { simulatedOutbound } from "./transports/simulated.mjs";
import { createTwilioTransport, TwilioSendError } from "./transports/twilio.mjs";
import { createFilePoller, createSeenStore, createTwilioPoller, normalizeMessage } from "./transports/twilio_poll.mjs";

const HUB_DIR = fileURLToPath(new URL("..", import.meta.url));
// Credentials: a Twilio API key (TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET) is the primary path; TWILIO_AUTH_TOKEN is
// only a fallback (and for webhook signatures later). Old names stay accepted as aliases: TWILIO_FROM_NUMBER for
// TWILIO_NUMBER, HUB_OWNER_PHONE for OWNER_PHONE.
export const REQUIRED_LIVE = Object.freeze(["TWILIO_ACCOUNT_SID", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_NUMBER", "OWNER_PHONE", "HUB_DB_PATH"]);
export const REQUIRED_DRY = Object.freeze(["OWNER_PHONE", "HUB_DB_PATH"]);
export const ALIASES = Object.freeze({ TWILIO_NUMBER: "TWILIO_FROM_NUMBER", OWNER_PHONE: "HUB_OWNER_PHONE" });
export const OPTIONAL = Object.freeze([
  "TWILIO_AUTH_TOKEN", "HUB_CLIP_BASE_URL", "HUB_POLL_SECONDS", "HUB_FARM_SHEET", "HUB_MAX_OUTBOUND_PER_DAY", "HUB_BACKLOG_MINUTES",
  "HUB_DRY_RUN", "HUB_DRY_RUN_INBOUND", "HUB_DRY_RUN_OUTBOUND", "HUB_VERBOSE", "TWILIO_STATUS_CALLBACK_URL",
]);
export const DEFAULTS = Object.freeze({ pollSeconds: 4, maxOutboundPerDay: 100, backlogMinutes: 60, retentionDays: 7 });
const CURSOR_KV = "twilio.poll.cursor";
const INFLIGHT_KV = "twilio.poll.inflight";
const SENT_TODAY_KV = "runner.outbound_per_day";
const MARGIN_MS = 15 * 60_000; // re-read the window a little before the last successful poll
const MAX_BACKOFF_MS = 60_000;
const E164 = /^\+[1-9]\d{6,14}$/;

/** A configuration problem. The message names variables or flags, never a value. */
export class ConfigError extends Error {
  constructor(message) { super(message); this.name = "ConfigError"; }
}

// ------------------------------------------------------------------------------------------------ env file
/** KEY=VALUE lines (optional `export `, `#` comments, optional matching quotes). Returns { vars, badLines }. */
export function parseEnvText(text) {
  const vars = {};
  const badLines = [];
  String(text).replace(/^\uFEFF/, "").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) { badLines.push(i + 1); return; }
    let v = m[2];
    const q = /^(["'])(.*)\1$/.exec(v);
    if (q) v = q[2];
    else v = v.replace(/\s+#.*$/, "").trim();
    vars[m[1]] = v;
  });
  return { vars, badLines };
}

/** The nearest ancestor directory (or the dir itself) holding a `.git` entry, or null. */
export function gitWorkTreeOf(dir) {
  let d = resolve(dir);
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** true if `child` is `parent` or inside it (case-insensitive on Windows via path.relative). */
export function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** Read the private env file. Refused if it is inside any git working tree (it would risk being committed). */
export function loadEnvFile(path) {
  if (!path) return {};
  const abs = resolve(path);
  if (!existsSync(abs)) throw new ConfigError("HUB_ENV_FILE does not exist");
  const file = real(abs);
  if (gitWorkTreeOf(dirname(file))) throw new ConfigError("HUB_ENV_FILE is inside a git working tree: keep it outside any repository");
  const { vars, badLines } = parseEnvText(readFileSync(file, "utf8"));
  if (badLines.length) throw new ConfigError(`HUB_ENV_FILE has unreadable line(s) ${badLines.join(", ")} (expected KEY=VALUE)`);
  return vars;
}

// ------------------------------------------------------------------------------------------------ config
export function parseArgs(argv = []) {
  const o = { dryRun: false, live: false, once: false, verbose: false, help: false, inbound: null, outboundLog: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--live") o.live = true;
    else if (a === "--once") o.once = true;
    else if (a === "--verbose" || a === "-v") o.verbose = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--inbound" && argv[i + 1]) o.inbound = argv[++i];
    else if (a === "--outbound-log" && argv[i + 1]) o.outboundLog = argv[++i];
    // Never echo an argument (it may carry a secret, e.g. --auth-token=...): its position only.
    else throw new ConfigError(`argument #${i + 1} is not recognised (not shown); see --help`);
  }
  return o;
}

const intIn = (raw, name, min, max, dflt) => {
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new ConfigError(`${name} must be a number from ${min} to ${max}`);
  return n;
};

/**
 * Build the runner's config from argv + env (+ HUB_ENV_FILE). Throws ConfigError naming what is wrong.
 * @param {{ argv?: string[], env?: object, repoRoot?: string }} o
 */
export function loadConfig({ argv = [], env = process.env, repoRoot = gitWorkTreeOf(HUB_DIR) ?? resolve(HUB_DIR, "..", "..") } = {}) {
  const args = parseArgs(argv);
  const file = loadEnvFile(env.HUB_ENV_FILE);
  const raw = (k) => (env[k] !== undefined && env[k] !== "" ? env[k] : file[k] || undefined);
  const get = (k) => raw(k) ?? (ALIASES[k] ? raw(ALIASES[k]) : undefined);
  const dryEnv = get("HUB_DRY_RUN") === "1" || get("HUB_DRY_RUN") === "true";
  if (args.live && (args.dryRun || dryEnv)) throw new ConfigError("--live conflicts with --dry-run / HUB_DRY_RUN=1");
  const live = args.live;
  // Live auth: the API key pair, or (fallback) the auth token. Only variable NAMES are ever reported.
  const keyGiven = Boolean(get("TWILIO_API_KEY_SID") || get("TWILIO_API_KEY_SECRET"));
  const authOk = (k) => (k === "TWILIO_API_KEY_SID" || k === "TWILIO_API_KEY_SECRET") && !keyGiven && get("TWILIO_AUTH_TOKEN");
  const missing = (live ? REQUIRED_LIVE : REQUIRED_DRY).filter((k) => !get(k) && !authOk(k));
  if (missing.length) {
    const authMissing = live && !keyGiven && !get("TWILIO_AUTH_TOKEN");
    throw new ConfigError(`missing ${missing.join(", ")}${authMissing ? " (or the fallback TWILIO_AUTH_TOKEN instead of the API key)" : ""}`);
  }
  if (live && get("TWILIO_API_KEY_SID") && !/^SK[0-9a-fA-F]{32}$/.test(String(get("TWILIO_API_KEY_SID")))) {
    throw new ConfigError("TWILIO_API_KEY_SID must be SK followed by 32 hex characters");
  }

  const ownerPhone = String(get("OWNER_PHONE")).trim();
  if (!E164.test(ownerPhone)) throw new ConfigError("OWNER_PHONE must be E.164 (+ and digits)");
  const from = get("TWILIO_NUMBER") ? String(get("TWILIO_NUMBER")).trim() : null;
  if (from && !E164.test(from)) throw new ConfigError("TWILIO_NUMBER must be E.164 (+ and digits)");
  if (from && normalizePhone(from) === normalizePhone(ownerPhone)) throw new ConfigError("OWNER_PHONE must differ from TWILIO_NUMBER");

  const dbPath = resolve(String(get("HUB_DB_PATH")));
  const varDir = join(repoRoot, "apps", "hub", "var");
  const dbReal = join(real(dirname(dbPath)), basename(dbPath));
  if (isInside(dbReal, repoRoot) && !isInside(dbReal, varDir)) {
    throw new ConfigError("HUB_DB_PATH must be outside the repository or under apps/hub/var/ (gitignored)");
  }
  const farmSheet = get("HUB_FARM_SHEET") ? resolve(String(get("HUB_FARM_SHEET"))) : null;
  return {
    mode: live ? "live" : "dry-run",
    once: args.once,
    help: args.help,
    verbose: args.verbose || get("HUB_VERBOSE") === "1",
    accountSid: get("TWILIO_ACCOUNT_SID") ?? null,
    apiKeySid: keyGiven ? get("TWILIO_API_KEY_SID") ?? null : null,
    apiKeySecret: keyGiven ? get("TWILIO_API_KEY_SECRET") ?? null : null,
    authToken: get("TWILIO_AUTH_TOKEN") ?? null,
    from,
    ownerPhone,
    dbPath,
    farmSheet,
    clipBaseUrl: get("HUB_CLIP_BASE_URL") || null,
    statusCallbackUrl: get("TWILIO_STATUS_CALLBACK_URL") || null,
    pollMs: Math.round(intIn(get("HUB_POLL_SECONDS"), "HUB_POLL_SECONDS", 1, 300, DEFAULTS.pollSeconds) * 1000),
    maxOutboundPerDay: Math.floor(intIn(get("HUB_MAX_OUTBOUND_PER_DAY"), "HUB_MAX_OUTBOUND_PER_DAY", 0, 10_000, DEFAULTS.maxOutboundPerDay)),
    backlogMinutes: intIn(get("HUB_BACKLOG_MINUTES"), "HUB_BACKLOG_MINUTES", 0, 7 * 24 * 60, DEFAULTS.backlogMinutes),
    inbound: resolve(args.inbound ?? get("HUB_DRY_RUN_INBOUND") ?? join(dirname(dbPath), "dry-run-inbound.jsonl")),
    outboundLog: resolve(args.outboundLog ?? get("HUB_DRY_RUN_OUTBOUND") ?? join(dirname(dbPath), "dry-run-outbound.jsonl")),
  };
}

// ------------------------------------------------------------------------------------------------ logging
/** "+447700900101" -> "***01". Never more than the last 2 digits. */
export function mask(phone) {
  const d = String(phone ?? "").replace(/\D/g, "");
  return d.length >= 2 ? `***${d.slice(-2)}` : "***";
}
const sidTail = (sid) => `..${String(sid).slice(-6)}`;

// A phone number as people write it: +44 7700 900123, (+44) 7700-900-123, 0712 345 678, +44.7700.900.123 ...
// Masked when the candidate holds 9 or more digits (dates like 2026-10-17 hold 8 and stay readable).
const FORMATTED_PHONE = /(?:\+|\b)\d[\d\s().-]{5,}\d/g;
const BODY_MAX_CHARS = 200;

/**
 * Line logger. Every message is scrubbed: the given secrets become [redacted], the given phone numbers and any
 * other number-looking run (E.164, or formatted with spaces, dashes, dots, parentheses; 9+ digits) are masked to
 * their last 2 digits. debug() and body() print only when verbose; body() scrubs BEFORE it shortens.
 */
export function createLogger({ write = (line) => process.stderr.write(`${line}\n`), verbose = false, secrets = [], phones = [], now = () => new Date() } = {}) {
  const sec = secrets.filter((s) => typeof s === "string" && s.length >= 4);
  const ph = phones.filter(Boolean).map(String);
  const scrub = (s) => {
    let out = String(s);
    for (const x of sec) out = out.split(x).join("[redacted]");
    for (const p of ph) {
      out = out.split(p).join(mask(p));
      const digits = p.replace(/\D/g, "");
      if (digits.length >= 7) out = out.split(digits).join(mask(p));
    }
    out = out.replace(/\+\d{7,15}\b/g, (m) => mask(m)).replace(/(?<![\w])\d{9,15}(?![\w])/g, (m) => mask(m));
    return out.replace(FORMATTED_PHONE, (m) => (m.replace(/\D/g, "").length >= 9 ? mask(m) : m));
  };
  // The timestamp prefix is ours; only the message is scrubbed (dates and times in it are not numbers to mask).
  const line = (level, msg) => write(`${now().toISOString()} ${level.padEnd(5)} ${scrub(msg)}`);
  return {
    info: (m) => line("info", m),
    warn: (m) => line("warn", m),
    error: (m) => line("error", m),
    debug: (m) => { if (verbose) line("debug", m); },
    /** A message body, verbose only, cleaned and shortened. */
    body: (label, text, { codes = false } = {}) => {
      if (!verbose) return;
      // Redact FIRST (secrets, numbers, codes), shorten AFTER: a secret crossing the cut cannot leave a prefix.
      let t = scrub(sanitizeText(text).text.replace(/\s+/g, " "));
      if (codes) t = t.replace(/\b\d{5,8}\b/g, (m) => "#".repeat(m.length)); // one-time codes (6 digits); dates stay
      const chars = Array.from(t);
      if (chars.length > BODY_MAX_CHARS) t = `${chars.slice(0, BODY_MAX_CHARS).join("")}...`;
      line("body", `${label}: ${t}`);
    },
    scrub,
  };
}

const errText = (e) => (e && typeof e.code === "string" ? `${e.name ?? "Error"} ${e.code}${e.status ? ` (HTTP ${e.status}${e.twilioCode ? `, Twilio ${e.twilioCode}` : ""})` : ""}` : e?.name ?? "Error");

// ------------------------------------------------------------------------------------------------ transports
/** Dry-run outbound: the simulated JSONL log; calls refused like the live adapter when no clip URL is set. */
export function dryRunTransport(logPath, { callsEnabled = false } = {}) {
  const sim = simulatedOutbound(logPath);
  return {
    name: "dry_run",
    send(item) {
      if (item.channel === "call" && !callsEnabled) throw new TwilioSendError("calls_disabled", { notAccepted: true, permanent: true });
      return sim.send(item);
    },
    wasSent: (key) => sim.wasSent(key),
  };
}

/**
 * The outbox as the hub sees it, under a hard daily cap (farm-time day) on items handed to the provider
 * (SENT or UNCERTAIN: both may cost money). Beyond the cap nothing is sent and nothing is dropped: items stay
 * QUEUED and go out the next day (or after the cap is raised). Results are logged without numbers or bodies.
 */
export function cappedOutbox(outbox, store, { maxPerDay, now = () => new Date(), log }) {
  let warnedDay = null;
  const loggedRefusals = new Set();
  return {
    ...outbox,
    async dispatch() {
      const day = eatDate(now());
      const usedToday = () => { const st = store.getKV(SENT_TODAY_KV, {}); return st.day === day ? st.count ?? 0 : 0; };
      const warnIfCapped = () => {
        const used = usedToday();
        const pending = outbox.pending();
        if (used >= maxPerDay && pending && warnedDay !== day) {
          warnedDay = day;
          log.warn(`cost cap reached: ${used}/${maxPerDay} outbound today (HUB_MAX_OUTBOUND_PER_DAY); ${pending} item(s) left QUEUED, not dropped`);
        }
      };
      if (usedToday() >= maxPerDay) { warnIfCapped(); return []; }
      // Codex review: the unit is reserved durably in the transaction that marks the row SENDING, BEFORE the provider
      // call, so a crash or a restart can never reset the count. Given back only for a provably unsent row.
      const reserve = () => {
        const used = usedToday();
        if (used >= maxPerDay) return false;
        store.setKV(SENT_TODAY_KV, { day, count: used + 1 });
        return true;
      };
      const release = () => {
        store.transaction(() => { const used = usedToday(); if (used > 0) store.setKV(SENT_TODAY_KV, { day, count: used - 1 }); });
      };
      const results = await outbox.dispatch({ reserve, release });
      for (const r of results) {
        const k = r.key.slice(0, 8);
        if (r.status === STATUS.SENT) log.info(`out ${r.channel} ${k} SENT`);
        else if (r.status === STATUS.UNCERTAIN) log.warn(`out ${r.channel} ${k} UNCERTAIN (${r.reason ?? "error"}): may have been sent, never resent automatically`);
        else if (r.status === STATUS.FAILED) log.warn(`out ${r.channel} ${k} refused by the provider (${r.reason ?? "error"}), will retry`);
        else if (r.status === STATUS.REFUSED) {
          if (r.reason === "calls_disabled") {
            if (!loggedRefusals.has("calls")) { loggedRefusals.add("calls"); log.info("calls to Noor skipped: HUB_CLIP_BASE_URL is not set (SMS-only; the SMS carries every fact)"); }
          } else log.warn(`out ${r.channel} ${k} REFUSED (${r.reason ?? "error"}), not retried`);
        }
      }
      warnIfCapped();
      return results;
    },
  };
}

// ------------------------------------------------------------------------------------------------ runner
/**
 * The polling loop around a hub. Inject everything (tests use a fake fetch and a fixed clock).
 * Owner SMS (sender == enrolled number) -> hub.ownerSms (marked seen BEFORE processing: a crash mid-command loses
 * that command rather than replaying it; Noor can resend). Any other sender -> hub.handleEvent with id
 * "twilio:<sid>" (the events table dedupes it too), marked seen after.
 */
export function createRunner({
  store, hub, outbox, poller, log, now = () => new Date(), ownerPhone, hubNumber = null, synthetic = false,
  backlogMinutes = DEFAULTS.backlogMinutes, retentionDays = DEFAULTS.retentionDays, pollMs = DEFAULTS.pollSeconds * 1000,
  firstStartFloor = null,
}) {
  const seen = createSeenStore(store);
  const ownerDigits = normalizePhone(ownerPhone);
  const hubDigits = hubNumber ? normalizePhone(hubNumber) : null;
  let stopping = false;
  let wake = null;

  function cursor() {
    let c = store.getKV(CURSOR_KV);
    if (!c) {
      const floor = firstStartFloor ?? new Date(now().getTime() - backlogMinutes * 60_000).toISOString();
      c = { floor, last_ok_started: null };
      store.setKV(CURSOR_KV, c);
      if (!firstStartFloor) log.info(`first start: messages sent before ${floor} are not processed (HUB_BACKLOG_MINUTES)`);
    }
    return c;
  }

  async function start() {
    cursor();
    const inflight = store.getKV(INFLIGHT_KV);
    if (inflight) {
      log.warn(`an owner SMS (${sidTail(inflight)}) was being processed when the hub stopped: not replayed (Noor may resend it)`);
      store.setKV(INFLIGHT_KV, null);
    }
    const r = await hub.recover();
    const uncertain = r.outbox.filter((x) => x.status === STATUS.UNCERTAIN).length;
    log.info(`recovered: ${r.outbox.length} interrupted send(s) (${uncertain} uncertain), ${r.executed.length} decided proposal(s) finished`);
    return r;
  }

  async function route(m, atIso) {
    if (ownerDigits && normalizePhone(m.from) === ownerDigits) {
      store.setKV(INFLIGHT_KV, m.sid);
      seen.add(m.sid, atIso);
      log.body(`in ${sidTail(m.sid)} owner`, m.body, { codes: true });
      const r = await hub.ownerSms({ from: m.from, text: sanitizeText(m.body, 1600).text });
      store.setKV(INFLIGHT_KV, null);
      const ex = r.executed ? ` -> ${r.executed.kind ?? ""} ${r.executed.outcome ?? (r.executed.ok ? "ok" : r.executed.reason ?? "refused")}` : "";
      log.info(`in  ${sidTail(m.sid)} from ${mask(m.from)} owner: ${r.command ?? "no command"}${ex}`);
      return { sid: m.sid, route: "owner", command: r.command ?? null };
    }
    log.body(`in ${sidTail(m.sid)} visitor`, m.body);
    const ev = smsToEvent({ kind: "sms", message_id: m.sid, from: m.from, to: m.to, received_at: atIso, text: m.body, synthetic }, { now });
    ev.id = `twilio:${m.sid}`;
    let r;
    try { r = hub.handleEvent(ev); } finally { seen.add(m.sid, atIso); }
    log.info(`in  ${sidTail(m.sid)} from ${mask(m.from)} visitor: ${r.action}${r.reason ? ` (${r.reason})` : ""}`);
    return { sid: m.sid, route: "visitor", action: r.action };
  }

  /** One poll: list, filter, dedupe, route (oldest first). Throws PollError on a failed listing. */
  async function pollOnce() {
    const started = now();
    const c = cursor();
    const floorMs = Math.max(Date.parse(c.floor) || 0, started.getTime() - retentionDays * 86_400_000);
    const sinceMs = Math.max(floorMs, c.last_ok_started ? Date.parse(c.last_ok_started) - MARGIN_MS : floorMs);
    const listing = await poller.list({ since: new Date(sinceMs) });
    const msgs = listing.messages.map(normalizeMessage);
    const skipped = { invalid: msgs.filter((m) => !m).length, not_inbound: 0, incomplete: 0, other_number: 0, before_floor: 0, errors: 0 };
    const fresh = msgs.filter(Boolean).sort((a, b) => (a.sent_at ?? "").localeCompare(b.sent_at ?? "") || a.sid.localeCompare(b.sid));
    const handled = [];
    for (const m of fresh) {
      if (m.direction !== "inbound") { skipped.not_inbound++; continue; }
      if (m.status === "receiving") { skipped.incomplete++; continue; } // an MMS still arriving: next poll
      if (hubDigits && m.to && normalizePhone(m.to) !== hubDigits) { skipped.other_number++; continue; }
      if (hubDigits && normalizePhone(m.from) === hubDigits) { skipped.other_number++; continue; }
      if (seen.has(m.sid)) continue;
      const atIso = m.sent_at ?? now().toISOString();
      if (Date.parse(atIso) < floorMs) { skipped.before_floor++; continue; } // never processed, so not recorded either
      try {
        handled.push(await route(m, atIso));
      } catch (e) {
        skipped.errors++;
        store.setKV(INFLIGHT_KV, null);
        if (!seen.has(m.sid)) seen.add(m.sid, atIso); // a poison message is not retried forever
        log.error(`in  ${sidTail(m.sid)} could not be processed (${errText(e)}); skipped`);
      }
    }
    if (!listing.truncated) store.setKV(CURSOR_KV, { ...c, last_ok_started: started.toISOString() });
    else log.warn(`poll truncated after ${listing.pages} page(s); the same window is read again next time`);
    const pruned = seen.prune(floorMs);
    if (skipped.invalid || skipped.before_floor || listing.bad_lines) {
      log.debug(`skipped: ${skipped.invalid + (listing.bad_lines ?? 0)} invalid, ${skipped.before_floor} before the floor`);
    }
    return { fetched: listing.messages.length, handled, skipped, pruned };
  }

  /** Poll, then the after-visit feedback step, then send what is queued (under the cap). Never throws. */
  async function cycle() {
    let poll = null;
    let error = null;
    try { poll = await pollOnce(); } catch (e) { error = e; }
    try { hub.feedbackTick(); } catch (e) { log.error(`feedback step failed (${errText(e)})`); }
    let sent = [];
    try { sent = await outbox.dispatch(); } catch (e) { log.error(`dispatch failed (${errText(e)})`); }
    return { poll, error, outbox: sent };
  }

  /** Loop until stop(). Backoff on transient poll errors; stops on refused credentials. Returns an exit code. */
  async function run({ once = false, sleep = defaultSleep } = {}) {
    let failures = 0;
    for (;;) {
      const r = await cycle();
      if (r.error) {
        if (r.error.auth) { log.error(`Twilio refused the credentials (${errText(r.error)}): check TWILIO_ACCOUNT_SID / TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET`); return 3; }
        failures++;
        log.warn(`poll failed (${errText(r.error)}), retry with backoff (#${failures})`);
      } else failures = 0;
      if (once || stopping) return 0;
      const base = failures ? Math.min(pollMs * 2 ** failures, MAX_BACKOFF_MS) : pollMs;
      const delay = failures ? Math.round(base * (0.75 + Math.random() * 0.5)) : base;
      await sleep(delay, (fn) => { wake = fn; });
      wake = null;
      if (stopping) return 0;
    }
  }

  function stop() { stopping = true; if (wake) wake(); }

  return { start, pollOnce, cycle, run, stop, seen };
}

function defaultSleep(ms, onWake) {
  return new Promise((done) => {
    const t = setTimeout(done, ms);
    onWake(() => { clearTimeout(t); done(); });
  });
}

// ------------------------------------------------------------------------------------------------ assembly
async function loadTagger() {
  try { return (await import("../../../contrib/max/tagger/tag_feedback.mjs")).tagFeedback; } catch { return null; }
}

/**
 * Everything wired from a config: store (owner.phone written), transport, capped outbox, hub, poller, runner.
 * @param {object} config  loadConfig() result
 * @param {{ fetchImpl?: typeof fetch, now?: () => Date, write?: (line: string) => void, tagger?: Function|null|false }} [deps]
 */
export async function buildHub(config, { fetchImpl = globalThis.fetch, now = () => new Date(), write, tagger } = {}) {
  const log = createLogger({
    write, verbose: config.verbose, now,
    secrets: [config.apiKeySecret, config.apiKeySid, config.authToken, config.accountSid], phones: [config.ownerPhone, config.from],
  });
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const store = openStore(config.dbPath);
  store.setKV("owner.phone", config.ownerPhone);
  const sheet = config.farmSheet ? loadFarmSheet(config.farmSheet) : loadFarmSheet();
  let transport;
  let poller;
  if (config.mode === "live") {
    transport = createTwilioTransport({
      accountSid: config.accountSid, apiKeySid: config.apiKeySid, apiKeySecret: config.apiKeySecret, authToken: config.authToken,
      from: config.from, fetchImpl,
      clipBaseUrl: config.clipBaseUrl ?? undefined, smsOnly: !config.clipBaseUrl, availableClips: MANIFEST_KEYS,
      statusCallbackUrl: config.statusCallbackUrl ?? undefined,
    });
    poller = createTwilioPoller({
      accountSid: config.accountSid, apiKeySid: config.apiKeySid, apiKeySecret: config.apiKeySecret, authToken: config.authToken,
      to: config.from, fetchImpl,
    });
  } else {
    transport = dryRunTransport(config.outboundLog, { callsEnabled: Boolean(config.clipBaseUrl) });
    poller = createFilePoller(config.inbound);
  }
  const outbox = cappedOutbox(createOutbox(store, transport, { now }), store, { maxPerDay: config.maxOutboundPerDay, now, log });
  const tag = tagger === undefined ? await loadTagger() : tagger || null;
  const hub = createHub({
    store, sheet, outbox, now, tagger: tag,
    adapters: platformAdapters({ env: {}, logPath: join(dirname(config.dbPath), "platform.jsonl") }), // platforms stay simulated
  });
  const runner = createRunner({
    store, hub, outbox, poller, log, now, ownerPhone: config.ownerPhone, hubNumber: config.from,
    synthetic: config.mode !== "live", pollMs: config.pollMs,
    backlogMinutes: config.mode === "live" ? config.backlogMinutes : 0,
    firstStartFloor: config.mode === "live" ? null : new Date(0).toISOString(),
  });
  log.info([
    `mode ${config.mode}`, config.mode === "live" ? `auth ${config.apiKeySid ? "API key" : "auth token (fallback)"}` : null, `owner ${mask(config.ownerPhone)}`, config.from ? `hub number ${mask(config.from)}` : null,
    `poll every ${config.pollMs / 1000}s`, `cap ${config.maxOutboundPerDay} outbound/day`,
    config.clipBaseUrl ? "calls on" : "SMS-only (no HUB_CLIP_BASE_URL)", tag ? "tagger on" : "tagger off",
    config.mode === "live" ? "inbound by polling, no port opened" : "no network",
  ].filter(Boolean).join(", "));
  return { store, hub, outbox, runner, log, close: () => store.close() };
}

const HELP = `Sauti hub with a real Twilio number (inbound by polling, no inbound port).
  node apps/hub/src/run_hub.mjs --dry-run [--once] [--verbose] [--inbound f.jsonl] [--outbound-log f.jsonl]
  node apps/hub/src/run_hub.mjs --live    [--once] [--verbose]
Required (live): ${REQUIRED_LIVE.join(", ")}
Required (dry-run): ${REQUIRED_DRY.join(", ")}
Optional: ${OPTIONAL.join(", ")}
HUB_ENV_FILE: a private KEY=VALUE file outside any git working tree. See apps/hub/README-twilio.md.`;

/** CLI entry. Returns the exit code. */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const write = deps.write ?? ((line) => process.stderr.write(`${line}\n`));
  let config;
  try {
    if (parseArgs(argv).help) { write(HELP); return 0; }
    config = loadConfig({ argv, env, ...(deps.repoRoot ? { repoRoot: deps.repoRoot } : {}) });
  } catch (e) {
    if (e instanceof ConfigError) { write(`config error: ${e.message}`); return 2; }
    throw e;
  }
  const built = await buildHub(config, { ...deps, write });
  const { runner, log } = built;
  const onSignal = (sig) => { log.info(`${sig}: finishing the current batch, then closing the store`); runner.stop(); };
  if (!deps.noSignals) { process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal); }
  let code;
  try {
    await runner.start();
    code = await runner.run({ once: config.once });
  } catch (e) {
    log.error(`stopped on an unexpected error (${errText(e)})`);
    code = 1;
  } finally {
    if (!deps.noSignals) { process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); }
    built.close();
  }
  log.info(`stopped (exit ${code})`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
