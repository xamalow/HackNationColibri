// HTTP endpoints for the voice agent (apps/hub-voice, hubclient.py), served by sync.mjs behind the same paired-device
// bearer token as /v1/events. Shapes match hubclient.py exactly; see README "Voice agent API".
//
//   GET  /v1/availability?date=YYYY-MM-DD   -> { date, capacity, confirmed, remaining, open, reason }
//   GET  /v1/farm                           -> the approved farm sheet (with approved overrides); no phone, no secret
//   GET  /v1/owner/match?sha256=<hex>       -> { match }      (owner MODE only; grants nothing)
//   GET  /v1/proposals?status=pending_owner -> { pending: [{ ref, date, party_size, source, filed_at }] }
//   GET  /v1/feedback/summary               -> { period, themes: [{ theme, verdict, direction, unique_comments, summary_sw }],
//                                                ask_a_person, comments, status }
//   POST /v1/owner-proposals                -> 201 { ref, action_id, status: "pending_owner", kind, expires_at }
//   POST /v1/proposals                      -> 201 { ref, action_id, status: "pending_owner", expires_at }
//
// Rules this module keeps:
// - Nothing here approves, rejects or executes anything. Every write is a PROPOSAL whose read-back, with a one-time
//   code, goes to Noor's ENROLLED number (kv owner.phone, outbox sensitive: true); only her SMS "NDIYO <ID> <code>"
//   (commands.mjs) changes a proposal's state. No route takes a code, a decision or a recipient number.
// - Availability, prices, counts and states are computed by code (booking_requests.checkAvailability, core
//   checkCapacity, feedback analyzeStoredFeedback). No visitor name or phone number is ever returned.
// - Inputs are validated strictly (unknown fields refused, dates YYYY-MM-DD, bounded integers, capped strings); bodies
//   are capped at 16 KB. Errors are JSON { error: { code, message } } and never carry a stack, a number or a body.
// - This module does not log. The owner-match hash is compared in constant time and never stored or echoed.
//
// SWAHILI REVIEW STATUS: UNREVIEWED (feedback summary lines and the "other" alert below).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { checkAvailability, eatDate, parseRequestDate, PROPOSAL_KIND as BOOKING_REQUEST, requestVoiceBooking } from "./booking_requests.mjs";
import { seatsTaken } from "./bookings.mjs";
import {
  chargeOwnerProposal, codeActive, commandsLocked, createProposal, DEFAULTS, normalizePhone as phoneDigits,
  parseNumberWords, readback, sanitizeSuggestion,
} from "./commands.mjs";
import { analyzeStoredFeedback, THEME_SW } from "./feedback/index.mjs";
import { CLOSED_DAYS_KV, SHEET_OVERRIDES_KV } from "./hub.mjs";
import { parseIsoDate } from "./notify.mjs";
import { blockedDays } from "./publish.mjs";
import { MAX_NOTE_CHARS, NOTE_KINDS, proposeVisitorNote, resolveNoteTarget } from "./visitor_notes.mjs";

export const VOICE_MAX_BODY_BYTES = 16 * 1024;
export const VOICE_ROUTES = Object.freeze([
  "/v1/availability", "/v1/farm", "/v1/owner/match", "/v1/proposals", "/v1/feedback/summary", "/v1/owner-proposals",
]);
export const OWNER_CHANGE_KINDS = Object.freeze(["running_late", "close_day", "open_day", "capacity", "message_to_visitor", "other"]);
/** owner/match lookups per paired device per minute (the endpoint is an oracle on one number: keep it slow). */
export const OWNER_MATCH_PER_MINUTE = 30;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const TENANT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const LANG_RE = /^[A-Za-z-]{0,16}$/;
const MAX_TEXT_CHARS = 300;
const MAX_NAME_CHARS = 80;
const MAX_PARTY = 200;
const OWNER_PROPOSAL_KV = "voice.owner_proposal.";
const WEEKDAY_CODES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// Keys never served by GET /v1/farm, at any depth (defence in depth: the validated sheet has none of them).
const PRIVATE_KEY_RE = /phone|msisdn|tel|mobile|email|contact|owner|token|secret|password|passwd|pin|key|iban|account|mpesa/i;
const SOURCES = new Set(["sms", "voice", "whatsapp"]);

class ApiError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const fail = (status, code, message, extra) => { throw new ApiError(status, code, message, extra); };

// ---------------------------------------------------------------------------------------------------------
// Validation helpers.
function object(v, name) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail(400, `invalid_${name}`, `${name} must be a JSON object`);
  return v;
}
function onlyKeys(o, allowed, name) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(400, "unknown_field", `unknown field in ${name}: ${k.slice(0, 40)}`);
}
function str(v, name, { max, re = null, optional = false } = {}) {
  if (v === undefined || v === null) {
    if (optional) return "";
    fail(400, `invalid_${name}`, `${name} is required`);
  }
  if (typeof v !== "string") fail(400, `invalid_${name}`, `${name} must be a string`);
  if ([...v].length > max) fail(400, `invalid_${name}`, `${name} exceeds ${max} characters`);
  if (re && !re.test(v)) fail(400, `invalid_${name}`, `${name} has an invalid format`);
  return v;
}
function isoDate(v, name = "date") {
  if (typeof v !== "string" || !DATE_RE.test(v) || !parseIsoDate(v)) fail(400, `invalid_${name}`, `${name} must be a real date YYYY-MM-DD`);
  return v;
}
function intIn(v, name, lo, hi) {
  if (!Number.isInteger(v) || v < lo || v > hi) fail(400, `invalid_${name}`, `${name} must be an integer ${lo}..${hi}`);
  return v;
}
/** Free text from the agent: control/bidi/invisible characters removed, whitespace collapsed, max 300 code points. */
function freeText(v, name, { required }) {
  const raw = str(v, name, { max: MAX_TEXT_CHARS, optional: !required });
  const clean = sanitizeSuggestion(raw, MAX_TEXT_CHARS);
  if (required && !clean) fail(422, `empty_${name}`, `${name} is empty`);
  return clean ?? "";
}

// ---------------------------------------------------------------------------------------------------------
// Owner match. hub_voice/owner.py normalize_number: strip "tel:" / "sip:" and "@host", drop spaces ( ) . -, keep a
// leading "+": an E.164 caller id becomes "+<country><number>". The hub hashes the enrolled number in that canonical
// form, and also in the two other spellings the same number can arrive in (digits without "+", and the Kenyan
// national "0..." form for +254 numbers), so a carrier that drops the "+" still matches. Every candidate is compared
// with timingSafeEqual, always the same number of comparisons, no early exit.
const sha = (s) => createHash("sha256").update(s, "utf8").digest();
export function ownerNumberForms(enrolled) {
  const digits = phoneDigits(enrolled);
  if (!digits) return [];
  const forms = [`+${digits}`, digits];
  if (/^254\d{9}$/.test(digits)) forms.push(`0${digits.slice(3)}`);
  return forms;
}
export function ownerMatches(enrolled, presentedHex) {
  if (typeof presentedHex !== "string" || !HEX64_RE.test(presentedHex)) return false;
  const got = Buffer.from(presentedHex, "hex");
  const forms = ownerNumberForms(enrolled);
  let match = false;
  for (let i = 0; i < 3; i++) {
    const want = i < forms.length ? sha(forms[i]) : randomBytes(32);
    if (timingSafeEqual(got, want) && i < forms.length) match = true;
  }
  return match;
}

// ---------------------------------------------------------------------------------------------------------
// Read-only views.
const effectiveSheet = (store, sheet) => ({ ...(sheet ?? {}), ...store.getKV(SHEET_OVERRIDES_KV, {}) });

/** Availability of one day, computed by code from the same facts as checkAvailability. */
export function dayAvailability(store, sheet, date, now = new Date()) {
  const s = effectiveSheet(store, sheet);
  const capacity = Number.isInteger(s.capacity_per_tour) ? s.capacity_per_tour : 0;
  const confirmed = seatsTaken(store, date);
  let reason = null;
  const probe = checkAvailability(store, s, { date, party_size: 1, request_id: "voice-availability", now });
  if (!probe.ok && probe.reason === "too_late") reason = "past";
  else if (store.getKV(CLOSED_DAYS_KV, {})[date]) reason = "closed_by_owner";
  else if (blockedDays(store)[date]) reason = "platform_blocked";
  else if (!Array.isArray(s.days) || !s.days.includes(WEEKDAY_CODES[parseIsoDate(date).weekday])) reason = "not_a_tour_day";
  else if (!probe.ok && probe.reason !== "full") reason = "ask_a_person"; // a missing fact: never claim the day is open
  const open = reason === null && capacity > 0;
  return { date, capacity, confirmed, remaining: open ? Math.max(0, capacity - confirmed) : 0, open, reason: reason ?? (capacity > 0 ? null : "ask_a_person") };
}

function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!PRIVATE_KEY_RE.test(k)) out[k] = scrub(x);
    return out;
  }
  return v;
}
/** The approved farm sheet as the hub runs it (approved capacity/price overrides applied), private keys removed. */
export function farmFacts(store, sheet) {
  return scrub(effectiveSheet(store, sheet));
}

/** Booking requests waiting for Noor (state proposed, code still valid). Never a name or a number. */
export function pendingRequests(store, now = new Date()) {
  return store.db.prepare("SELECT short_id, body, created_at FROM proposals WHERE kind = ? AND state = 'proposed' ORDER BY created_at, short_id")
    .all(BOOKING_REQUEST)
    .filter((r) => codeActive(store, r.short_id, now))
    .map((r) => {
      let b;
      try { b = JSON.parse(r.body); } catch { b = {}; }
      return {
        ref: r.short_id,
        date: typeof b.date === "string" && DATE_RE.test(b.date) ? b.date : null,
        party_size: Number.isInteger(b.party_size) ? b.party_size : null,
        source: SOURCES.has(b.channel) ? b.channel : "other",
        filed_at: r.created_at,
      };
    });
}

const SUMMARY_SW = {
  negative: (t, n) => `Maoni ${n} yanasema ${t} ni shida.`,
  positive: (t, n) => `Maoni ${n} yanapenda ${t}.`,
  mixed: (t, n) => `Maoni ${n} kuhusu ${t} hayakubaliani: muulize mtu.`,
  neutral: (t, n) => `Maoni ${n} yanataja ${t} bila kusema zuri au baya.`,
  insufficient: (t, n) => `Maoni ${n} tu kuhusu ${t}: hayatoshi kuamua.`,
};
const themeSw = (theme) => (THEME_SW[theme] ?? theme).toLowerCase();

/**
 * The feedback loop's summary for Noor's call: themes with the core's unique comment counts and verdicts, a fixed
 * Swahili line per theme built by code, no quotes. Honest when there is nothing to say.
 */
export function feedbackSummary(store, tagger) {
  const empty = (status) => ({ period: null, themes: [], ask_a_person: 0, comments: 0, status });
  if (typeof tagger !== "function") return empty("no_tagger");
  let report;
  try { report = analyzeStoredFeedback(store, tagger); } catch { return empty("analysis_failed"); }
  if (!report.comments) return empty("no_feedback");
  const dates = store.getKV("feedback.sources", []).map((s) => eatDate(s.received_at)).filter(Boolean).sort();
  const themes = report.analysis.themes.map((t) => {
    const n = t.comment_count;
    const key = t.verdict === "insufficient" ? "insufficient" : t.direction === "mixed" ? "mixed"
      : t.direction === "neutral" ? "neutral" : t.direction === "positive" ? "positive" : t.direction === "negative" ? "negative" : "insufficient";
    return { theme: t.theme, verdict: t.verdict, direction: t.direction ?? null, unique_comments: n, summary_sw: SUMMARY_SW[key](themeSw(t.theme), n) };
  });
  return {
    period: dates.length ? `${dates[0]}..${dates[dates.length - 1]}` : null,
    themes, ask_a_person: report.analysis.ask_a_person.length, comments: report.comments, status: "ok",
  };
}

// ---------------------------------------------------------------------------------------------------------
// Owner change parsing (code, never a model): a structured field when the agent sends one, else the text.
function changeDate(change, text, now) {
  const today = eatDate(now);
  if (change.date !== undefined) {
    const d = isoDate(change.date);
    if (d < today) fail(422, "past_date", "date is in the past");
    return d;
  }
  const r = parseRequestDate(text, today, "sw");
  if (r.ambiguous || !r.date) fail(422, "need_date", "no single date found in the text: ask Noor for the date");
  if (r.date < today) fail(422, "past_date", "date is in the past");
  return r.date;
}

function changeNumber(change, text) {
  if (change.capacity !== undefined) return intIn(change.capacity, "capacity", 1, MAX_PARTY);
  // The one run of number tokens in the text ("nafasi 8", "nafasi kumi na mbili"); none or several -> ask.
  const toks = text.toLowerCase().replace(/[.,!?]+$/g, "").split(/\s+/).filter(Boolean);
  const isNum = (t) => t === "na" || parseNumberWords([t]) !== null;
  const runs = [];
  let cur = [];
  for (const t of toks) {
    if (isNum(t)) cur.push(t);
    else if (cur.length) { runs.push(cur); cur = []; }
  }
  if (cur.length) runs.push(cur);
  const trimmed = runs.map((r) => { const x = [...r]; while (x[0] === "na") x.shift(); while (x.at(-1) === "na") x.pop(); return x; }).filter((r) => r.length);
  const n = trimmed.length === 1 ? parseNumberWords(trimmed[0]) : null;
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARTY) fail(422, "need_number", "no single capacity found in the text: ask Noor for the number");
  return n;
}

function noteRefused(reason) {
  const status = reason === "unknown_ref" ? 404 : reason === "not_open" ? 409 : 422;
  fail(status, reason, "the message cannot be sent to that request", { status: "refused", reason });
}

const otherAlert = (text) => `SAUTI: Uliomba kwa simu: "${text}". Hakuna kilichobadilishwa: Sauti haiwezi kufanya hili. Fanya mwenyewe au muulize mtu.`;

// ---------------------------------------------------------------------------------------------------------
/**
 * @param {{ store, sheet, outbox, tagger?: Function|null, now?: () => Date, tenantId?: string|null,
 *           limits?: { maxProposalsPerDay?: number }, bookingLimits?: object }} deps
 *   outbox: Noor's read-backs and alerts are queued here (and dispatched after the response is decided).
 *   tagger: Max's tagFeedback for the feedback summary; without it the summary says "no_tagger".
 *   tenantId: when set, POST bodies must carry this tenant_id.
 */
export function createVoiceApi({ store, sheet, outbox, tagger = null, now = () => new Date(), tenantId = null, limits = {}, bookingLimits = {} }) {
  if (!store || !sheet || !outbox) throw new Error("createVoiceApi needs store, sheet and outbox");
  const lim = { maxProposalsPerDay: DEFAULTS.maxProposalsPerDay, ...limits };
  const matchWindow = new Map(); // device -> { start, count }

  const record = (kind, body) => {
    const at = now().toISOString();
    store.addEvent({ id: `${kind}:${body.proposal_id ?? body.id}:${at}`, channel: "hub", received_at: at, synthetic: false, ...body, kind });
  };
  const dispatchSoon = async () => { try { await outbox.dispatch(); } catch { /* the row stays queued; recover() resolves it */ } };
  const owner = () => store.getKV("owner.phone");

  function tenantAndSource(body, channel) {
    const tenant = str(body.tenant_id, "tenant_id", { max: 64, re: TENANT_RE });
    if (tenantId && tenant !== tenantId) fail(403, "wrong_tenant", "tenant_id does not match this hub");
    const source = object(body.source, "source");
    onlyKeys(source, ["channel", "call_id"], "source");
    if (source.channel !== channel) fail(400, "invalid_channel", `source.channel must be "${channel}"`);
    return str(source.call_id, "call_id", { max: 128, re: TOKEN_RE });
  }

  // ---- POST /v1/proposals: a tourist's booking request taken on a voice call.
  async function postBookingRequest(raw) {
    const body = object(raw, "body");
    onlyKeys(body, ["tenant_id", "source", "booking", "note"], "body");
    const call_id = tenantAndSource(body, "voice");
    const b = object(body.booking, "booking");
    onlyKeys(b, ["date", "party_size", "visitor_name", "language"], "booking");
    const booking = {
      date: isoDate(b.date),
      party_size: intIn(b.party_size, "party_size", 1, MAX_PARTY),
      visitor_name: str(b.visitor_name, "visitor_name", { max: MAX_NAME_CHARS, optional: true }),
      language: str(b.language, "language", { max: 16, re: LANG_RE, optional: true }),
    };
    // The note is validated but not stored: tourist words never reach an outbound message, and Noor's read-back is
    // built from structured fields only.
    freeText(body.note, "note", { required: false });

    const r = requestVoiceBooking(store, sheet, { booking, call_id, now: now(), limits: bookingLimits });
    switch (r.action) {
      case "proposed": {
        outbox.enqueue({ channel: "sms", recipient: r.owner_recipient, body: r.owner_sms, cause_id: `booking_request:${r.proposal_id}`, sensitive: true });
        record("booking_request", { proposal_id: r.proposal_id, outcome: "proposed", source: "voice", reason: null });
        await dispatchSoon();
        return { status: 201, body: { ref: r.proposal_id, action_id: `${r.proposal_id}:${r.digest.slice(0, 12)}`, status: "pending_owner", expires_at: r.expires_at } };
      }
      case "duplicate": {
        const row = store.db.prepare("SELECT short_id, digest, state FROM proposals WHERE short_id = ?").get(r.proposal_id);
        if (row?.state !== "proposed") fail(409, "already_decided", "this request was already decided by Noor", { status: row?.state ?? "unknown" });
        return { status: 200, body: { ref: row.short_id, action_id: `${row.short_id}:${row.digest.slice(0, 12)}`, status: "pending_owner", duplicate: true } };
      }
      case "unavailable":
        fail(409, "unavailable", "not available on that date", { status: "unavailable", reason: r.reason, facts: r.facts });
        break;
      case "invalid":
        fail(422, `invalid_${r.reason}`, `${r.reason} cannot be booked`, { status: "invalid", reason: r.reason });
        break;
      default:
        fail(r.reason === "no_owner_enrolled" || r.reason === "missing_fact" ? 503 : 429, r.reason, "a person must handle this request",
          { status: "needs_owner", reason: r.reason });
    }
    return null;
  }

  // ---- POST /v1/owner-proposals: a change Noor asked for on her own call.
  async function postOwnerProposal(raw) {
    const body = object(raw, "body");
    onlyKeys(body, ["tenant_id", "source", "change"], "body");
    const call_id = tenantAndSource(body, "voice_owner");
    const c = object(body.change, "change");
    onlyKeys(c, ["kind", "text", "about_ref", "date", "capacity"], "change");
    if (typeof c.kind !== "string" || !OWNER_CHANGE_KINDS.includes(c.kind)) fail(400, "invalid_kind", `kind must be one of ${OWNER_CHANGE_KINDS.join(", ")}`);
    const needsText = c.kind === "other" || NOTE_KINDS.includes(c.kind);
    const text = freeText(c.text, "text", { required: needsText });
    const about_ref = str(c.about_ref, "about_ref", { max: 8, optional: true });

    const recipient = owner();
    if (!recipient) fail(503, "no_owner_enrolled", "no owner phone is enrolled on this hub");
    if (commandsLocked(store)) fail(423, "commands_locked", "Noor's commands are locked; she re-enables them in the Sauti app");

    const key = createHash("sha256").update(JSON.stringify([call_id, c.kind, text, about_ref, c.date ?? null, c.capacity ?? null])).digest("hex");
    const prior = store.getKV(OWNER_PROPOSAL_KV + key);
    if (prior) return { status: 200, body: { ...prior, duplicate: true } };

    let kind;
    let change;
    let note = null;
    if (c.kind === "close_day" || c.kind === "open_day") {
      kind = c.kind === "close_day" ? "close_day" : "reopen_day";
      change = { date: changeDate(c, text, now()) };
    } else if (c.kind === "capacity") {
      kind = "capacity";
      change = { capacity_per_tour: changeNumber(c, text) };
    } else if (NOTE_KINDS.includes(c.kind)) {
      if (!about_ref) fail(422, "need_ref", "which request is the message about? about_ref is required");
      if ([...text].length > MAX_NOTE_CHARS) fail(422, "text_too_long", "message is too long");
      kind = "visitor_note";
      note = { about_ref, note_kind: c.kind, text };
      const target = resolveNoteTarget(store, about_ref);
      if (!target.ok) noteRefused(target.reason);
    }

    if (!chargeOwnerProposal(store, { now: now(), maxProposalsPerDay: lim.maxProposalsPerDay })) {
      fail(429, "budget_exhausted", "the daily proposal budget is used up");
    }

    let out;
    if (c.kind === "other") {
      // Not something the hub can do: Noor gets her own words back as an alert, nothing is proposed or changed.
      const eventId = `voice-owner:${key.slice(0, 32)}`;
      store.db.prepare("INSERT OR IGNORE INTO alerts (id, event_id, sms, call, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(`alert-${eventId}`, eventId, otherAlert(text), "[]", now().toISOString());
      outbox.enqueue({ channel: "sms", recipient, body: otherAlert(text), cause_id: eventId });
      record("owner_alert", { id: eventId, outcome: "voice_owner_other" });
      out = { ref: "", action_id: `alert:${key.slice(0, 16)}`, status: "owner_alerted", kind: "other" };
    } else {
      let p;
      if (note) {
        p = proposeVisitorNote(store, note, { now: now() });
        if (!p.ok) noteRefused(p.reason);
      } else {
        p = createProposal(store, kind, change, { now: now() });
        p.readback = readback(kind, change, p.short_id, p.code);
      }
      outbox.enqueue({ channel: "sms", recipient, body: p.readback, cause_id: `reply:voice:${p.short_id}`, sensitive: true });
      record("owner_propose", { proposal_id: p.short_id, proposal_kind: kind, via: "voice_owner" });
      out = { ref: p.short_id, action_id: `${p.short_id}:${p.digest.slice(0, 12)}`, status: "pending_owner", kind, expires_at: p.expires_at };
    }
    store.setKV(OWNER_PROPOSAL_KV + key, out);
    await dispatchSoon();
    return { status: 201, body: out };
  }

  function getOwnerMatch(url, device) {
    const t = now().getTime();
    const w = matchWindow.get(device);
    if (!w || t - w.start >= 60_000) matchWindow.set(device, { start: t, count: 1 });
    else if (++w.count > OWNER_MATCH_PER_MINUTE) fail(429, "rate_limited", "too many owner lookups");
    const hex = String(url.searchParams.get("sha256") ?? "").toLowerCase();
    if (!HEX64_RE.test(hex)) fail(400, "invalid_sha256", "sha256 must be 64 hex characters");
    return { match: ownerMatches(owner(), hex) };
  }

  /**
   * Route one authenticated request. Returns null when the path is not a voice route (the caller answers 404),
   * else { status, body }. Validation and refusals come back as JSON errors; transport-level errors from readBody
   * (413, 415, invalid JSON) propagate to the caller's handler.
   * @param {{ method: string, url: URL, device: string, readBody: () => Promise<unknown> }} req
   */
  async function handle({ method, url, device, readBody }) {
    const path = url.pathname;
    if (!VOICE_ROUTES.includes(path)) return null;
    const want = (m) => { if (method !== m) fail(405, "method_not_allowed", `use ${m}`); };
    try {
      switch (path) {
        case "/v1/availability": {
          want("GET");
          return { status: 200, body: dayAvailability(store, sheet, isoDate(url.searchParams.get("date")), now()) };
        }
        case "/v1/farm":
          want("GET");
          return { status: 200, body: farmFacts(store, sheet) };
        case "/v1/owner/match":
          want("GET");
          return { status: 200, body: getOwnerMatch(url, device) };
        case "/v1/feedback/summary":
          want("GET");
          return { status: 200, body: feedbackSummary(store, tagger) };
        case "/v1/proposals":
          if (method === "GET") {
            if (url.searchParams.get("status") !== "pending_owner") fail(400, "invalid_status", 'status must be "pending_owner"');
            return { status: 200, body: { pending: pendingRequests(store, now()) } };
          }
          want("POST");
          return await postBookingRequest(await readBody());
        case "/v1/owner-proposals":
          want("POST");
          return await postOwnerProposal(await readBody());
        default:
          return null;
      }
    } catch (err) {
      if (err instanceof ApiError) return { status: err.status, body: { ...err.extra, error: { code: err.code, message: err.message } } };
      throw err;
    }
  }

  return { handle, routes: VOICE_ROUTES };
}
