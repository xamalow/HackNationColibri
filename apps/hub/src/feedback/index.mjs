// Post-visit feedback loop (Max's plan, last step; cosme-claude). The hub asks a tourist for feedback only
// after Noor approved that exact request with her one-time code, reads the replies as DATA, and tells Noor the
// pain points by SMS. Themes come from Max's deterministic tagger; quotes, unique comment counts and the
// "fewer than 3 comments = not enough" rule come from @sauti/core. The model is not involved. The digest is an
// owner alert: it informs Noor and acts on nobody's behalf.
import { createHash } from "node:crypto";
import { analyzeFeedback, buildDecisionCards, ingestMessages, sha256 } from "../core.mjs";
import { createProposal, normalizePhone, proposalDigest, redeemCode } from "../commands.mjs";
import { gsm7Length, isGsm7 } from "../notify.mjs";

export const KIND = "feedback_request";
const REQUESTED_KV = "feedback.requested.";     // + booking_id -> { phone, proposal_id, sent_at }
const PENDING_PHONE_KV = "feedback.pending.";   // + normalized phone -> { booking_id, until }
const SOURCES_KV = "feedback.sources";          // [{ id, from_booking, text, lang, received_at }]
const DIGEST_KV = "feedback.last_digest";       // digest hash of the last report sent to Noor
const REPLY_WINDOW_MS = 14 * 24 * 3600_000;
const SUPPORTED = new Set(["sw", "en", "de", "fr"]);
const EAT_OFFSET_MS = 3 * 3600_000;

/** Swahili theme names for Noor's SMS (UNREVIEWED; Experience copy has no theme.* keys yet). */
export const THEME_SW = Object.freeze({
  coffee: "Kahawa", farm_walk: "Matembezi shambani", guide: "Mwongozo", host: "Ukarimu",
  directions: "Maelekezo ya kufika", food: "Chakula", price: "Bei", timing: "Muda",
  booking: "Kuhifadhi nafasi", facilities: "Huduma", buy_coffee: "Kununua kahawa",
});

/** Fixed request texts in the tourist's language (UNREVIEWED). No numbers, no facts: nothing to invent. */
export const REQUEST_TEXT = Object.freeze({
  en: (name) => `Hello ${name}, thank you for visiting Noor's coffee farm. What did you like, and what could be better? Just reply to this message.`,
  sw: (name) => `Habari ${name}, asante kwa kutembelea shamba la kahawa la Noor. Ulipenda nini, na nini kingeweza kuwa bora? Jibu ujumbe huu tu.`,
  de: (name) => `Hallo ${name}, danke fuer Ihren Besuch auf Noors Kaffeefarm. Was hat Ihnen gefallen, was koennte besser sein? Antworten Sie einfach auf diese Nachricht.`,
  fr: (name) => `Bonjour ${name}, merci pour votre visite de la ferme de cafe de Noor. Qu'avez-vous aime, et que pourrions-nous ameliorer ? Repondez simplement a ce message.`,
});

const eatDate = (now) => new Date(now.getTime() + EAT_OFFSET_MS).toISOString().slice(0, 10);
const firstName = (raw) => String(raw ?? "").trim().split(/\s+/)[0]?.replace(/[^\p{L}'-]/gu, "").slice(0, 20) || "";

/**
 * The tourist's number for a booking. SMS-booked (direct) bookings do not store it: their contact address is
 * "proposal:<ID>" and the number stays in that booking_request proposal (booking_requests.mjs).
 */
function contactPhone(store, booking) {
  const addr = String(booking?.request?.contact?.address ?? "");
  const m = /^proposal:([A-Z0-9]{1,8})$/.exec(addr);
  if (!m) return normalizePhone(addr);
  const row = store.db.prepare("SELECT kind, body FROM proposals WHERE short_id = ?").get(m[1]);
  return row?.kind === "booking_request" ? normalizePhone(JSON.parse(row.body).tourist_ref) : null;
}

/**
 * Confirmed visits booked over SMS whose date is before today (farm time), not yet asked for feedback.
 * Platform bookings are skipped: there is no direct channel to a platform guest.
 */
export function dueFeedbackRequests(store, { now = new Date() } = {}) {
  const today = eatDate(now);
  return store.db.prepare("SELECT booking_id, date, body FROM bookings WHERE state = 'confirmed' AND date < ? ORDER BY date, booking_id").all(today)
    .map((r) => ({ booking_id: r.booking_id, date: r.date, ...JSON.parse(r.body) }))
    .filter((b) => b.request?.contact?.channel === "sms" && contactPhone(store, b))
    .filter((b) => store.getKV(REQUESTED_KV + b.booking_id) === null);
}

/**
 * Prepare the request as a proposal. Returns the read-back SMS for Noor (carries the one-time code: enqueue it
 * with { sensitive: true }). Nothing is sent to the tourist here.
 */
export function proposeFeedbackRequest(store, booking, opts = {}) {
  const phone = contactPhone(store, booking);
  if (!phone) throw new Error("booking has no SMS contact");
  const lang = SUPPORTED.has(booking.request.contact.language) ? booking.request.contact.language : "en";
  const name = firstName(booking.request.visitor_name) || (lang === "sw" ? "mgeni" : "there");
  const change = { booking_id: booking.booking_id, recipient: `+${phone}`, language: lang, body: REQUEST_TEXT[lang](name) };
  const p = createProposal(store, KIND, change, opts);
  const who = firstName(booking.request.visitor_name) || "mgeni";
  const readback = `SAUTI: Umtumie ${who} ombi la maoni ya ziara? Jibu NDIYO ${p.short_id} ${p.code} au HAPANA ${p.short_id}.`;
  if (!isGsm7(readback)) throw new Error("read-back is not GSM-7");
  return { ...p, readback, change };
}

/**
 * Crash-safe order (codex restart probe): open the reply window, enqueue (idempotent key), and write the
 * "requested" marker LAST. The marker is the commit point: a crash before it leaves no marker, so recovery redoes
 * all three without a duplicate SMS (same key) and the window is never missing once the request is marked done.
 */
function queueFeedbackRequest(store, outbox, change, proposalId, now) {
  store.setKV(PENDING_PHONE_KV + normalizePhone(change.recipient), { booking_id: change.booking_id, language: change.language, until: new Date(now.getTime() + REPLY_WINDOW_MS).toISOString() });
  const q = outbox.enqueue({ channel: "sms", recipient: change.recipient, body: change.body, cause_id: `feedback:${change.booking_id}` });
  store.setKV(REQUESTED_KV + change.booking_id, { phone: change.recipient, proposal_id: proposalId, queued_at: now.toISOString() });
  return { ok: true, key: q.key };
}

/**
 * Noor's "NDIYO <id> <code>" for a feedback request (the caller already checked her enrolled number, as for
 * every command). The code is redeemed here, the stored proposal digest is re-checked, then ONE SMS to the
 * tourist is queued and the reply window opens. Refused on any mismatch; never sends twice.
 */
export function approveFeedbackRequest(store, outbox, shortId, code, { now = new Date() } = {}) {
  const r = redeemCode(store, shortId, code, { now });
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.row.kind !== KIND) return { ok: false, reason: "wrong_kind" };
  const change = JSON.parse(r.row.body);
  if (proposalDigest(KIND, change) !== r.row.digest) return { ok: false, reason: "digest_changed" };
  if (store.getKV(REQUESTED_KV + change.booking_id) !== null) return { ok: false, reason: "already_requested" };
  return queueFeedbackRequest(store, outbox, change, shortId, now);
}

/**
 * Integration point for hub.mjs: handleOwnerSms already redeemed Noor's one-time code and returned
 * { type: "approve", proposal_id, kind, digest, change }. This re-reads the STORED proposal (state approved,
 * same digest, same change) before queuing the tourist SMS, so a forged or edited command cannot send.
 */
export function executeApprovedFeedbackRequest(store, outbox, command, { now = new Date() } = {}) {
  if (command?.type !== "approve" || command.kind !== KIND) return { ok: false, reason: "not_a_feedback_approval" };
  const row = store.db.prepare("SELECT kind, digest, state, body FROM proposals WHERE short_id = ?").get(command.proposal_id);
  if (!row || row.kind !== KIND || row.state !== "approved") return { ok: false, reason: "not_approved" };
  const change = JSON.parse(row.body);
  if (row.digest !== command.digest || proposalDigest(KIND, change) !== row.digest) return { ok: false, reason: "digest_changed" };
  if (store.getKV(REQUESTED_KV + change.booking_id) !== null) return { ok: false, reason: "already_requested" };
  return queueFeedbackRequest(store, outbox, change, command.proposal_id, now);
}

/**
 * A tourist SMS (HubEvent visitor_message). If it comes from a number we asked for feedback, inside the reply
 * window, its text is stored as a feedback source (data, never instructions) and true is returned.
 */
export function ingestFeedbackReply(store, event, { now = new Date() } = {}) {
  if (event?.kind !== "visitor_message" || typeof event.text !== "string" || !event.text.trim()) return false;
  const phone = normalizePhone(event.from);
  const pending = phone ? store.getKV(PENDING_PHONE_KV + phone) : null;
  if (!pending || new Date(pending.until) < now) return false;
  const sources = store.getKV(SOURCES_KV, []);
  if (sources.some((s) => s.id === event.id)) return true;
  sources.push({ id: event.id, from_booking: pending.booking_id, text: event.text, lang: pending.language, received_at: event.received_at });
  store.setKV(SOURCES_KV, sources);
  return true;
}

/** W3 on the hub: the same core path as the phone app. `tagger` is Max's tagFeedback (injected for tests). */
export function analyzeStoredFeedback(store, tagger) {
  const sources = store.getKV(SOURCES_KV, []);
  const incoming = sources.map((s) => ({ id: s.id, source: "tourist_message", external_id: s.id, received_at: s.received_at, text: s.text, ...(SUPPORTED.has(s.lang) ? { lang: s.lang } : {}) }));
  const ingested = ingestMessages(incoming, sha256);
  const tagged = tagger([...ingested.sources.values()].map((s) => ({ id: s.source_id, text: s.text, lang: s.language })));
  const analysis = analyzeFeedback(tagged, ingested.sources, sha256, { supportedLanguages: SUPPORTED });
  return { analysis, cards: buildDecisionCards(analysis, sha256), comments: ingested.sources.size };
}

const shortQuote = (q) => (typeof q === "string" && q.length <= 60 && isGsm7(q) ? `"${q}"` : null);

/**
 * Noor's pain-point SMS, Swahili, GSM-7, at most 3 segments. Counts are the core's unique comment counts; every
 * quote is an exact span of a stored original, dropped (not cut) if it is long or not GSM-7.
 */
export function painPointSms({ analysis, cards, comments }) {
  const neg = cards.filter((c) => c.direction === "negative");
  const pos = cards.filter((c) => c.direction === "positive");
  const thin = analysis.themes.filter((t) => t.verdict === "insufficient" || t.verdict === "conflicting");
  const name = (t) => THEME_SW[t] ?? t;
  const parts = [`SAUTI: Maoni ya wageni (${comments}).`];
  if (neg.length) {
    parts.push(`Shida: ${neg.map((c) => {
      const q = c.quotes.map((x) => shortQuote(x.quote)).find(Boolean);
      return `${name(c.theme)}, maoni ${c.comment_count}${q ? ` ${q}` : ""}`;
    }).join("; ")}.`);
  } else parts.push("Hakuna shida iliyothibitishwa.");
  if (pos.length) parts.push(`Wanapenda: ${pos.map((c) => `${name(c.theme)} (${c.comment_count})`).join(", ")}.`);
  if (thin.length) parts.push(`Hayatoshi kuamua: ${thin.map((t) => name(t.theme)).join(", ")}.`);
  if (analysis.ask_a_person.length) parts.push("Mengine: muulize mtu.");
  let sms = parts.join(" ");
  if (!isGsm7(sms)) sms = sms.replace(/"[^"]*"/g, "").replace(/\s+/g, " ");
  while (gsm7Length(sms) > 3 * 153 && sms.includes(";")) sms = sms.slice(0, sms.lastIndexOf(";")) + ".";
  if (!isGsm7(sms) || gsm7Length(sms) > 3 * 153) throw new Error("pain-point SMS does not fit 3 GSM-7 segments");
  return sms;
}

/**
 * Queue the digest to Noor's enrolled number, once per distinct report (alerts.event_id is unique).
 * Returns null when there is nothing new, no owner, or no feedback yet.
 */
export function queuePainPointDigest(store, outbox, tagger, { now = new Date() } = {}) {
  const owner = store.getKV("owner.phone");
  if (!owner) return null;
  const report = analyzeStoredFeedback(store, tagger);
  if (report.comments === 0) return null;
  const sms = painPointSms(report);
  const digest = createHash("sha256").update(sms).digest("hex").slice(0, 16);
  if (store.getKV(DIGEST_KV) === digest) return null;
  const eventId = `feedback-digest:${digest}`;
  const fresh = store.db.prepare("INSERT OR IGNORE INTO alerts (id, event_id, sms, call, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(`alert-${eventId}`, eventId, sms, "[]", now.toISOString()).changes === 1;
  if (!fresh) return null;
  const q = outbox.enqueue({ channel: "sms", recipient: owner, body: sms, cause_id: eventId });
  store.setKV(DIGEST_KV, digest);
  return { sms, key: q.key, cards: report.cards.length };
}
