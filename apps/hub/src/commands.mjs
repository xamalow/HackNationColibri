// Noor's SMS commands, from her basic phone.
//
// SWAHILI REVIEW STATUS: UNREVIEWED (every reply and read-back below).
//
// Security model (Carter, 2026-10-04; supersedes the PIN-in-SMS draft):
// - Sender IDs can be spoofed, so an SMS "NDIYO" is an approval ONLY when BOTH hold:
//   (1) it comes from Noor's enrolled number (kv "owner.phone"), and
//   (2) it carries the per-proposal ONE-TIME CODE that the hub itself sent in its read-back SMS.
//   The code is random (crypto.randomInt), stored only as a salted scrypt hash bound to the proposal short id
//   AND its content digest (content changes -> code void), single-use, expiring (24 h default), compared in
//   constant time (timingSafeEqual), and voided after 5 wrong attempts on that proposal.
// - FUNGA / FUNGUA / NAFASI / BEI only CREATE a proposal and a read-back carrying its code. The read-back
//   must be sent to the enrolled number from kv (never to an address taken from the inbound message), so a
//   spoofer never sees a code. Nothing is applied or published until "NDIYO <ID> <code>".
// - HAPANA <ID> discards a pending proposal (no code: it can only prevent, never cause, an action).
// - Unknown sender / unparsable / wrong code: a fixed reply, and nothing else happens.
// - The output is a structured command object; the hub executes it elsewhere (publish.mjs).
// - No logging here; codes and phone numbers never leave this module except in the read-back body.
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { findNumbers } from "./core.mjs";
import { sanitizeText } from "./intake/sms.mjs";
import { EAT_OFFSET_MS, parseIsoDate, swDateShort } from "./notify.mjs";

export const REPLIES = Object.freeze({
  not_understood: "Sikuelewa. Hakuna kilichobadilishwa. Tuma MSAADA kwa maelezo.",
  unregistered: "Namba hii haijasajiliwa.",
  help: "SAUTI: FUNGA 12/10, FUNGUA 12/10, NAFASI 8, BEI 2000. Utapata SMS yenye namba: jibu NDIYO B namba. HAPANA B kukataa.",
  not_pending: (id) => `Pendekezo ${id} halipo au limeshaamuliwa. Hakuna kilichobadilishwa.`,
  locked: (id) => `Makosa mengi kwa ${id}. Namba yake imefutwa. Tuma amri tena kupata namba mpya.`,
  approved: (id, kind) => (kind === "booking_request" ? `Sawa. ${id} imeidhinishwa. Mgeni atapata uthibitisho.`
    : kind === "feedback_request" ? `Sawa. ${id} imeidhinishwa. Ombi la maoni litatumwa kwa mgeni.`
      : kind === "visitor_note" ? `Sawa. ${id} imeidhinishwa. Ujumbe wako utatumwa kwa mgeni.`
        : `Sawa. ${id} imeidhinishwa na itatumwa kwa tovuti.`),
  rejected: (id) => `Sawa. ${id} imekataliwa. Hakuna kitakachobadilishwa.`,
  // A booking request taken on a voice call has no SMS address for the guest (the caller id is never recorded).
  approved_call_back: (id) => `Sawa. ${id} imeidhinishwa. Mgeni alipiga simu, hana SMS: mpigie simu kumthibitishia.`,
  rejected_call_back: (id) => `Sawa. ${id} imekataliwa. Mgeni alipiga simu, hana SMS: mpigie simu kumwambia.`,
  no_sms_contact: (id) => `Mgeni wa ${id} alipiga simu, hana SMS. Mpigie simu. Ombi bado linasubiri NDIYO au HAPANA.`,
  commands_locked: "SAUTI: Amri za SMS zimesimamishwa kwa usalama (majaribio mengi). Zifungue tena kwenye programu ya Sauti.",
  suggestion_sent: (id) => `Sawa. Ujumbe wako kwa mgeni wa ${id} umetumwa. Ombi bado linasubiri NDIYO au HAPANA.`,
  need_code: (id) => `Tuma HAPANA ${id} pamoja na namba uliyopewa kwenye SMS.`,
  suggestion_limit: (id) => `Ujumbe mwingi kwa ${id}. Jibu NDIYO au HAPANA.`,
});

export const DEFAULTS = Object.freeze({
  codeTtlMs: 24 * 3600_000, codeDigits: 6, maxCodeAttempts: 5,
  // Warden F2: global daily budgets. Exceeding one locks SMS commands until Noor re-enables them in the app.
  maxProposalsPerDay: 10, maxWrongCodesPerDay: 10,
  // Noor's free-text suggestion to a tourist ("A 482113 nitachelewa kidogo"): capped length and count per proposal.
  maxSuggestionChars: 300, maxSuggestionsPerProposal: 5,
});
/**
 * Tourist-facing proposal kinds: answering one sends the tourist a message on Noor's behalf, so a suggestion
 * ("<ID> <code> <text>") is accepted only on these, and HAPANA on these needs the one-time code too (Carter).
 */
export const TOURIST_FACING_KINDS = new Set(["booking_request"]);
const SUGGEST_COUNT_KV = "proposal.suggestions.";
export const LOCK_KV = "commands.locked";
const BUDGET_KV = "commands.budget";
const UNKNOWN_KV = "commands.unknown_senders";

const dayOf = (now) => now.toISOString().slice(0, 10);
function bump(store, key, now) {
  const today = dayOf(now);
  const b = store.getKV(key, {});
  const next = b.day === today ? { ...b } : { day: today };
  return next;
}
/** Re-enable SMS commands: only from the app, inside Noor's PIN session (never by SMS). */
export function unlockCommands(store) { store.setKV(LOCK_KV, null); }
export function commandsLocked(store) { return store.getKV(LOCK_KV, null); }

/**
 * Spend one unit of the owner-proposal budget (warden F2) shared by SMS commands and the voice agent's
 * owner-proposals (voice_api.mjs). Returns false, and spends nothing, once the day's budget is used up.
 * CHOICE: unlike an SMS command, an exhausted budget on the voice path refuses without locking SMS commands, so a
 * spoofed caller id cannot switch off Noor's SMS commands; the next SMS command over budget still locks them.
 */
export function chargeOwnerProposal(store, { now = new Date(), maxProposalsPerDay = DEFAULTS.maxProposalsPerDay } = {}) {
  const b = bump(store, BUDGET_KV, now);
  const used = b.proposals ?? 0;
  if (used >= maxProposalsPerDay) return false;
  b.proposals = used + 1;
  store.setKV(BUDGET_KV, b);
  return true;
}

/** Is the proposal's one-time code still usable (issued, unused, not voided, not expired)? Read-only. */
export function codeActive(store, shortId, now = new Date()) {
  const rec = store.getKV(CODE_KV + shortId);
  if (!rec || rec.used || rec.voided || !rec.hash) return false;
  return Math.max(store.getKV(CLOCK_KV, 0), now.getTime()) < rec.expires_at;
}

/** A booking request filed on a voice call: there is no SMS address for the guest. */
function bookingWithoutSms(row) {
  if (row?.kind !== "booking_request") return false;
  try { return !JSON.parse(row.body).tourist_ref; } catch { return false; }
}
const SCRYPT = { N: 1 << 14, r: 8, p: 1 };
const CODE_KV = "proposal.code.";
const CLOCK_KV = "clock.high_water_ms";

// Codex review (C): expiry is checked against the highest time ever observed, persisted, so a clock rollback can
// never make an expired code valid again.
function observedNowMs(store, now) {
  const hw = Math.max(store.getKV(CLOCK_KV, 0), now.getTime());
  store.setKV(CLOCK_KV, hw);
  return hw;
}
const SEQ_KV = "proposals.next_seq";
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O (read as 1, 0 on a small screen)

// ---------------------------------------------------------------------------------------------------------
// Phone numbers.
/** Kenyan-style normalisation to digits with country code: "+254 700 000 002", "0700000002" -> "254700000002". */
export function normalizePhone(raw) {
  let d = String(raw ?? "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (/^0\d{9}$/.test(d)) d = "254" + d.slice(1);
  return /^\d{8,15}$/.test(d) ? d : null;
}

function isOwner(store, from) {
  const owner = normalizePhone(store.getKV("owner.phone"));
  const sender = normalizePhone(from);
  if (!owner || !sender) return false;
  const a = createHash("sha256").update(owner).digest();
  const b = createHash("sha256").update(sender).digest();
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------------------------------------
// Proposals and one-time codes.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
/** Content digest of a proposal: binds a code to exactly this kind + body. */
export function proposalDigest(kind, body) {
  return createHash("sha256").update(canonical({ kind, body })).digest("hex");
}

function encodeId(n) {
  let s = "";
  let x = n;
  do { s = ID_ALPHABET[x % ID_ALPHABET.length] + s; x = Math.floor(x / ID_ALPHABET.length) - 1; } while (x >= 0);
  return s;
}

function codeHash(shortId, digest, code, salt) {
  return scryptSync(`sauti.sms-approval.v1\n${shortId}\n${digest}\n${code}`, salt, 32, SCRYPT);
}

/**
 * Issue (or re-issue) the one-time code of a pending proposal. A re-issue voids the previous code.
 * Returns the code in clear ONCE, for the read-back SMS; only its hash is stored.
 */
export function issueCode(store, shortId, { now = new Date(), codeTtlMs = DEFAULTS.codeTtlMs, codeDigits = DEFAULTS.codeDigits } = {}) {
  if (!Number.isInteger(codeDigits) || codeDigits < 4 || codeDigits > 8) throw new Error("codeDigits must be 4-8");
  const row = store.db.prepare("SELECT kind, digest, state, body FROM proposals WHERE short_id = ?").get(shortId);
  if (!row || row.state !== "proposed") throw new Error("proposal not pending");
  const digest = proposalDigest(row.kind, JSON.parse(row.body));
  if (digest !== row.digest) throw new Error("proposal digest mismatch");
  const code = String(randomInt(0, 10 ** codeDigits)).padStart(codeDigits, "0");
  const salt = randomBytes(16);
  store.setKV(CODE_KV + shortId, {
    salt: salt.toString("base64"),
    hash: codeHash(shortId, digest, code, salt).toString("base64"),
    digest,
    expires_at: observedNowMs(store, now) + codeTtlMs,
    attempts: 0,
    used: false,
  });
  return { code, expires_at: new Date(now.getTime() + codeTtlMs).toISOString() };
}

/** Create a pending proposal with a fresh short id and its one-time code. */
export function createProposal(store, kind, body, opts = {}) {
  const now = opts.now ?? new Date();
  const digest = proposalDigest(kind, body);
  const shortId = store.transaction(() => {
    let seq = store.getKV(SEQ_KV, 0);
    let id;
    do { id = encodeId(seq++); } while (store.db.prepare("SELECT 1 FROM proposals WHERE short_id = ?").get(id));
    store.setKV(SEQ_KV, seq);
    store.db.prepare(
      "INSERT INTO proposals (short_id, kind, digest, state, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, kind, digest, "proposed", JSON.stringify(body), now.toISOString());
    return id;
  });
  const { code, expires_at } = issueCode(store, shortId, { ...opts, now });
  return { short_id: shortId, kind, digest, code, expires_at };
}

// Shared by redeemCode (NDIYO: spends the code) and verifyCode (a suggestion: does not spend it). Both run the same
// scrypt + timingSafeEqual comparison and count a wrong code toward the same per-proposal lockout.
function checkCode(store, shortId, code, { now, maxCodeAttempts, consume }) {
  const row = store.db.prepare("SELECT short_id, kind, digest, state, body FROM proposals WHERE short_id = ?").get(shortId);
  if (!row || row.state !== "proposed") return { ok: false, reason: "not_pending" };
  const rec = store.getKV(CODE_KV + shortId);
  if (!rec) return { ok: false, reason: "no_code" };
  if (rec.used) return { ok: false, reason: "used" };
  if (rec.attempts >= maxCodeAttempts) return { ok: false, reason: "locked" };
  if (observedNowMs(store, now) >= rec.expires_at) return { ok: false, reason: "expired" };
  let current;
  try { current = proposalDigest(row.kind, JSON.parse(row.body)); } catch { return { ok: false, reason: "digest_changed" }; }
  if (current !== row.digest || current !== rec.digest) return { ok: false, reason: "digest_changed" };

  const expected = Buffer.from(rec.hash, "base64");
  const got = codeHash(shortId, current, String(code), Buffer.from(rec.salt, "base64"));
  const match = got.length === expected.length && timingSafeEqual(got, expected);

  return store.transaction(() => {
    const fresh = store.getKV(CODE_KV + shortId);
    if (!fresh || fresh.used || fresh.hash !== rec.hash) return { ok: false, reason: "used" };
    if (!match) {
      const attempts = fresh.attempts + 1;
      if (attempts >= maxCodeAttempts) {
        store.setKV(CODE_KV + shortId, { used: false, voided: "too_many_attempts", attempts, digest: fresh.digest, expires_at: 0, salt: "", hash: "" });
        return { ok: false, reason: "locked" };
      }
      store.setKV(CODE_KV + shortId, { ...fresh, attempts });
      return { ok: false, reason: "wrong_code" };
    }
    if (!consume) {
      const still = store.db.prepare("SELECT 1 FROM proposals WHERE short_id = ? AND state = 'proposed' AND digest = ?").get(shortId, current);
      return still ? { ok: true, row } : { ok: false, reason: "not_pending" };
    }
    const r = store.db.prepare(
      "UPDATE proposals SET state = 'approved' WHERE short_id = ? AND state = 'proposed' AND digest = ?",
    ).run(shortId, current);
    if (r.changes !== 1) return { ok: false, reason: "not_pending" };
    store.setKV(CODE_KV + shortId, { used: true, used_at: now.toISOString(), digest: current, attempts: fresh.attempts, expires_at: 0, salt: "", hash: "" });
    return { ok: true, row: { ...row, state: "approved" } };
  });
}

/**
 * Check "NDIYO <id> <code>" (caller has already checked the sender). On success the proposal becomes
 * "approved" and the code is spent, in one transaction. Never throws on bad input.
 * @returns {{ ok: true, row } | { ok: false, reason: "not_pending"|"no_code"|"expired"|"used"|"digest_changed"|"locked"|"wrong_code" }}
 */
export function redeemCode(store, shortId, code, { now = new Date(), maxCodeAttempts = DEFAULTS.maxCodeAttempts } = {}) {
  return checkCode(store, shortId, code, { now, maxCodeAttempts, consume: true });
}

/**
 * Check a proposal's one-time code WITHOUT spending it (Noor's free-text suggestion "<ID> <code> <text>": the
 * proposal stays pending and the same code still approves or rejects it). Same constant-time comparison; a wrong
 * code counts toward the same per-proposal lockout. Never throws on bad input.
 * @returns {{ ok: true, row } | { ok: false, reason: "not_pending"|"no_code"|"expired"|"used"|"digest_changed"|"locked"|"wrong_code" }}
 */
export function verifyCode(store, shortId, code, { now = new Date(), maxCodeAttempts = DEFAULTS.maxCodeAttempts } = {}) {
  return checkCode(store, shortId, code, { now, maxCodeAttempts, consume: false });
}

/** Discard a pending proposal and its code. */
export function rejectProposal(store, shortId) {
  return store.transaction(() => {
    const row = store.db.prepare("SELECT short_id, kind, state FROM proposals WHERE short_id = ?").get(shortId);
    if (!row || row.state !== "proposed") return null;
    store.db.prepare("UPDATE proposals SET state = 'rejected' WHERE short_id = ? AND state = 'proposed'").run(shortId);
    store.db.prepare("DELETE FROM kv WHERE k = ?").run(CODE_KV + shortId);
    return row;
  });
}

// ---------------------------------------------------------------------------------------------------------
// Parsing.
const SW_NUMBER_WORDS = new Set([
  "moja", "mbili", "tatu", "nne", "tano", "sita", "saba", "nane", "tisa",
  "mmoja", "wawili", "watatu", "wanne", "watano", "wanane",
  "kumi", "ishirini", "thelathini", "arobaini", "hamsini", "sitini", "sabini", "themanini", "tisini",
  "mia", "elfu", "laki", "milioni", "na",
]);
const CURRENCY_WORDS = new Set(["kes", "ksh", "ksh.", "kshs", "sh", "sh.", "shs", "shilingi", "/="]);
const WEEKDAY_INDEX = { jumapili: 0, jumatatu: 1, jumanne: 2, jumatano: 3, alhamisi: 4, ijumaa: 5, jumamosi: 6 };

function eatToday(now) {
  const d = new Date(now.getTime() + EAT_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), weekday: d.getUTCDay() };
}
const iso = (y, m, d) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const addDays = (y, m, d, n) => { const t = new Date(Date.UTC(y, m - 1, d + n)); return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };

/** "12/10", "12.10.2026", "2026-10-12", "leo", "kesho", "jumamosi" -> ISO date today-or-later (EAT), else null. */
export function parseCommandDate(tok, now = new Date()) {
  const t = String(tok ?? "").toLowerCase();
  const today = eatToday(now);
  const todayIso = iso(today.y, today.m, today.d);
  let out = null;
  if (t === "leo") out = todayIso;
  else if (t === "kesho") out = addDays(today.y, today.m, today.d, 1);
  else if (t in WEEKDAY_INDEX) out = addDays(today.y, today.m, today.d, (WEEKDAY_INDEX[t] - today.weekday + 7) % 7);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(t)) out = t;
  else {
    const m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(t);
    if (m) {
      const [d, mo] = [Number(m[1]), Number(m[2])];
      if (m[3]) out = iso(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), mo, d);
      else {
        out = iso(today.y, mo, d); // no year: the next occurrence
        if (out < todayIso) out = iso(today.y + 1, mo, d);
      }
    }
  }
  if (!out || !parseIsoDate(out) || out < todayIso) return null;
  return out;
}

/** Digits or Swahili number words only ("2000", "2,000", "elfu mbili", "KES 1500"), one number, else null. */
export function parseNumberWords(toks, { allowCurrency = false } = {}) {
  const kept = [];
  for (const raw of toks) {
    const t = raw.toLowerCase();
    if (allowCurrency && CURRENCY_WORDS.has(t)) continue;
    const digits = t.replace(/\/=$/, "");
    if (/^\d+$/.test(digits) || /^\d{1,3}([,.]\d{3})+$/.test(digits)) kept.push(digits);
    else if (SW_NUMBER_WORDS.has(t)) kept.push(t);
    else return null;
  }
  if (!kept.length || kept[0] === "na" || kept[kept.length - 1] === "na") return null;
  // Digits stand alone: the core parser would add "2000 500" up to 2500.
  if (kept.some((t) => /\d/.test(t)) && kept.length !== 1) return null;
  const nums = findNumbers(kept.join(" "));
  return nums.length === 1 ? nums[0] : null;
}

const ID_RE = /^[A-Z]{1,3}$/;
const CODE_RE = /^\d{4,8}$/;
const VERBS = new Set(["MSAADA", "NDIYO", "HAPANA", "FUNGA", "FUNGUA", "NAFASI", "BEI"]);
// "<ID> <code> <free text>": the text is taken from the message as written (not re-joined tokens).
const SUGGEST_RE = /^([A-Za-z]{1,3})\s+(\d{4,8})\s+(\S[\s\S]*)$/;

/**
 * Noor's free text for a tourist, cleaned: control/bidi/invisible characters removed, whitespace collapsed to
 * single spaces, capped at `max` code points. Empty -> null.
 */
export function sanitizeSuggestion(raw, max = DEFAULTS.maxSuggestionChars) {
  const one = sanitizeText(String(raw ?? "").replace(/\s+/g, " "), max).text.trim();
  return one.length ? one : null;
}

/** Pure parse of an SMS into { verb, ... } or null. */
export function parseSms(text, now = new Date()) {
  const toks = String(text ?? "").normalize("NFKC").replace(/[.!?]+\s*$/, "").trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  const verb = toks[0].toUpperCase();
  const args = toks.slice(1);
  if (!VERBS.has(verb)) {
    // Suggestion: "A 482113 nitachelewa kidogo". Never a verb word, so "BEI 2000 1234" stays a (bad) BEI.
    const m = SUGGEST_RE.exec(String(text).normalize("NFKC").trim());
    if (!m || !ID_RE.test(m[1].toUpperCase())) return null;
    const suggestion = sanitizeSuggestion(m[3]);
    return suggestion ? { verb: "SUGGEST", id: m[1].toUpperCase(), code: m[2], text: suggestion } : null;
  }
  switch (verb) {
    case "MSAADA":
      return args.length === 0 ? { verb } : null;
    case "NDIYO": {
      if (args.length !== 2) return null;
      const id = args[0].toUpperCase();
      return ID_RE.test(id) && CODE_RE.test(args[1]) ? { verb, id, code: args[1] } : null;
    }
    case "HAPANA": {
      // A code is not needed (except on tourist-facing proposals, checked in handleOwnerSms); keep it when given.
      if (args.length < 1 || args.length > 2 || (args[1] && !CODE_RE.test(args[1]))) return null;
      const id = args[0].toUpperCase();
      return ID_RE.test(id) ? { verb, id, ...(args[1] ? { code: args[1] } : {}) } : null;
    }
    case "FUNGA":
    case "FUNGUA": {
      if (args.length !== 1) return null;
      const date = parseCommandDate(args[0], now);
      return date ? { verb, kind: verb === "FUNGA" ? "close_day" : "reopen_day", change: { date } } : null;
    }
    case "NAFASI": {
      const n = parseNumberWords(args);
      return Number.isInteger(n) && n >= 1 && n <= 200 ? { verb, kind: "capacity", change: { capacity_per_tour: n } } : null;
    }
    case "BEI": {
      const n = parseNumberWords(args, { allowCurrency: true });
      return Number.isInteger(n) && n >= 1 && n <= 1_000_000
        ? { verb, kind: "price", change: { price_per_person: { amount_minor: n * 100, currency: "KES" } } } : null;
    }
    default:
      return null;
  }
}

/** The read-back SMS for a proposal: what exactly will happen, and how to confirm it. */
export function readback(kind, change, shortId, code) {
  const what = {
    close_day: () => `Ufunge ${swDateShort(change.date)} kwenye tovuti zote?`,
    reopen_day: () => `Ufungue ${swDateShort(change.date)} kwenye tovuti zote?`,
    capacity: () => `Nafasi ziwe ${change.capacity_per_tour} kwa kila ziara kwenye tovuti zote?`,
    price: () => `Bei iwe KES ${change.price_per_person.amount_minor / 100} kwa mgeni kwenye tovuti zote?`,
  }[kind];
  if (!what) throw new Error("unknown proposal kind");
  return `SAUTI: ${what()} Jibu NDIYO ${shortId} ${code} au HAPANA ${shortId}.`;
}

// ---------------------------------------------------------------------------------------------------------
/**
 * Handle one inbound SMS.
 * @param store openStore() result
 * @param {{ from: string, text: string }} sms
 * @returns {{ command: object|null, reply: string, recipient: string, sensitive: boolean }}
 *   Send `reply` to `recipient` through the outbox; `sensitive: true` (a read-back carrying a code) must be
 *   enqueued with { sensitive: true }. `recipient` is the enrolled number from kv for the owner, never the
 *   inbound address. `command` is null whenever nothing should happen.
 */
export function handleOwnerSms(store, sms, opts = {}) {
  const now = opts.now ?? new Date();
  if (!isOwner(store, sms?.from)) {
    // Warden F1: never reply to an unknown sender (SMS-pumping). Count it, store no number.
    const u = bump(store, UNKNOWN_KV, now);
    u.count = (u.count ?? 0) + 1;
    store.setKV(UNKNOWN_KV, u);
    return { command: null, reply: null, recipient: null, sensitive: false };
  }
  if (commandsLocked(store)) return { command: null, reply: null, recipient: null, sensitive: false };
  const owner = store.getKV("owner.phone");
  const out = (reply, command = null, sensitive = false) => ({ command, reply, recipient: owner, sensitive });
  const lockNow = (reason) => {
    store.setKV(LOCK_KV, { reason, since: now.toISOString() });
    return { command: { type: "commands_locked", reason }, reply: REPLIES.commands_locked, recipient: owner, sensitive: false };
  };
  const budget = () => bump(store, BUDGET_KV, now);
  // A failed code check: counts toward the global daily wrong-code budget (warden F2), then a fixed reply.
  const codeFailure = (r, id) => {
    if (r.reason !== "not_pending") {
      const b = budget();
      b.wrong_codes = (b.wrong_codes ?? 0) + 1;
      store.setKV(BUDGET_KV, b);
      if (b.wrong_codes > (opts.maxWrongCodesPerDay ?? DEFAULTS.maxWrongCodesPerDay)) return lockNow("wrong_codes");
    }
    if (r.reason === "locked") return out(REPLIES.locked(id));
    if (r.reason === "not_pending") return out(REPLIES.not_pending(id));
    return out(REPLIES.not_understood);
  };
  const parsed = parseSms(sms.text, now);
  if (!parsed) return out(REPLIES.not_understood);

  switch (parsed.verb) {
    case "MSAADA":
      return out(REPLIES.help);
    case "NDIYO": {
      const r = redeemCode(store, parsed.id, parsed.code, { now, maxCodeAttempts: opts.maxCodeAttempts });
      if (!r.ok) return codeFailure(r, parsed.id);
      return out(bookingWithoutSms(r.row) ? REPLIES.approved_call_back(parsed.id) : REPLIES.approved(parsed.id, r.row.kind), {
        type: "approve", proposal_id: parsed.id, kind: r.row.kind, digest: r.row.digest,
        change: JSON.parse(r.row.body), via: "sms_one_time_code", approved_at: now.toISOString(),
      });
    }
    case "SUGGEST": {
      // Only tourist-facing proposals take a suggestion; checked before the code so no attempt is counted.
      const pending = store.db.prepare("SELECT kind, body FROM proposals WHERE short_id = ? AND state = 'proposed'").get(parsed.id);
      const kind = pending?.kind;
      if (!kind) return out(REPLIES.not_pending(parsed.id));
      if (!TOURIST_FACING_KINDS.has(kind)) return out(REPLIES.not_understood);
      // Nowhere to relay her words (voice request): say so before the code is checked, so no attempt is counted.
      if (bookingWithoutSms(pending)) return out(REPLIES.no_sms_contact(parsed.id));
      const r = verifyCode(store, parsed.id, parsed.code, { now, maxCodeAttempts: opts.maxCodeAttempts });
      if (!r.ok) return codeFailure(r, parsed.id);
      const sent = store.getKV(SUGGEST_COUNT_KV + parsed.id, 0);
      if (sent >= (opts.maxSuggestionsPerProposal ?? DEFAULTS.maxSuggestionsPerProposal)) return out(REPLIES.suggestion_limit(parsed.id));
      store.setKV(SUGGEST_COUNT_KV + parsed.id, sent + 1);
      return out(REPLIES.suggestion_sent(parsed.id), {
        type: "suggest", proposal_id: parsed.id, kind, digest: r.row.digest, text: parsed.text,
        via: "sms_one_time_code", suggested_at: now.toISOString(),
      });
    }
    case "HAPANA": {
      const kind = store.db.prepare("SELECT kind FROM proposals WHERE short_id = ? AND state = 'proposed'").get(parsed.id)?.kind;
      if (kind && TOURIST_FACING_KINDS.has(kind)) {
        // Declining sends the tourist a reply on Noor's behalf: the code is required, and it is checked, not spent
        // (rejectProposal below deletes it).
        if (!parsed.code) return out(REPLIES.need_code(parsed.id));
        const r = verifyCode(store, parsed.id, parsed.code, { now, maxCodeAttempts: opts.maxCodeAttempts });
        if (!r.ok) return codeFailure(r, parsed.id);
      }
      const callBack = bookingWithoutSms(store.db.prepare("SELECT kind, body FROM proposals WHERE short_id = ?").get(parsed.id));
      const row = rejectProposal(store, parsed.id);
      if (!row) return out(REPLIES.not_pending(parsed.id));
      return out(callBack ? REPLIES.rejected_call_back(parsed.id) : REPLIES.rejected(parsed.id), { type: "reject", proposal_id: parsed.id, kind: row.kind, rejected_at: now.toISOString() });
    }
    default: {
      const b = budget();
      b.proposals = (b.proposals ?? 0) + 1;
      store.setKV(BUDGET_KV, b);
      if (b.proposals > (opts.maxProposalsPerDay ?? DEFAULTS.maxProposalsPerDay)) return lockNow("too_many_proposals");
      const p = createProposal(store, parsed.kind, parsed.change, { ...opts, now });
      return out(readback(parsed.kind, parsed.change, p.short_id, p.code), {
        type: "propose", proposal_id: p.short_id, kind: parsed.kind, digest: p.digest, change: parsed.change,
        expires_at: p.expires_at,
      }, true);
    }
  }
}
