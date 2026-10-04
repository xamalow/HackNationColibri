// Noor's read-only SMS queries: the hub always answers her, in Swahili, from the store.
//
// SWAHILI REVIEW STATUS: UNREVIEWED (every reply below).
//
// Rules this module keeps:
// - Only Noor's enrolled number (kv "owner.phone", compared with commands.normalizePhone) gets an answer;
//   any other sender -> null (never reply to an unknown number: SMS pumping, warden F1).
// - Read-only: no code, no proposal, no write to the store. A query can never change anything.
// - Every number, date and status is computed here from the store and the farm sheet (code, never a model).
//   Dates are rendered with notify's helpers; replies are GSM-7 and at most 2 SMS segments.
// - Anything it does not recognise (commands, MSAADA, free text) -> null: the command parser handles it.
//
// Queries (case and space tolerant, a trailing "?" or "." is ignored):
//   LEO | KESHO          today's / tomorrow's visitors: bookings, party sizes, platform, seats left
//   RATIBA               next 7 days: booked/capacity per day, closed and blocked days
//   WAGENI <date>        visitors on a day (12/10, 12/10/2026, 2026-10-12, leo, kesho)
//   BEI | NAFASI         current price per person / capacity per tour
//   MAONI                last feedback summary (kv feedback.last_summary) or "Hakuna maoni mapya"
import { createHash, timingSafeEqual } from "node:crypto";
import { listBookings } from "./bookings.mjs";
import { normalizePhone } from "./commands.mjs";
import { CLOSED_DAYS_KV, SHEET_OVERRIDES_KV } from "./hub.mjs";
import { EAT_OFFSET_MS, firstName, gsm7Length, isGsm7, parseIsoDate, swDateShort } from "./notify.mjs";
import { blockedDays } from "./publish.mjs";

export const FEEDBACK_KV = "feedback.last_summary";
/** Two concatenated GSM-7 segments (153 septets each once a UDH is present). */
export const MAX_REPLY_SEPTETS = 2 * 153;

export const QUERY_REPLIES = Object.freeze({
  no_feedback: "SAUTI MAONI: Hakuna maoni mapya.",
  bad_date: "SAUTI: Tarehe haieleweki. Mfano: WAGENI 12/10 au WAGENI 2026-10-12.",
});

const WEEKDAY_CODES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]; // getUTCDay order, as in the farm sheet
const PLATFORM_SMS = {
  getyourguide: "GYG", gyg: "GYG", airbnb: "Airbnb", booking: "Booking.com", "booking.com": "Booking.com",
  booking_com: "Booking.com", phone: "simu", voice: "simu", sms: "SMS", whatsapp: "WhatsApp",
};
/** Unknown platform strings are never echoed. */
const platformSms = (p) => PLATFORM_SMS[String(p ?? "").trim().toLowerCase()] ?? "tovuti";

// ---------------------------------------------------------------------------------------------------------
// Dates (East Africa Time).
const isoOf = (t) => t.toISOString().slice(0, 10);
const eatToday = (now) => isoOf(new Date(now.getTime() + EAT_OFFSET_MS));
function addDays(iso, n) {
  const p = parseIsoDate(iso);
  return isoOf(new Date(Date.UTC(p.y, p.m - 1, p.d + n)));
}
const pad = (n) => String(n).padStart(2, "0");

/**
 * "12/10" (nearest such day to today: a past or a coming one), "12/10/2026", "12.10.26", "2026-10-12", "leo",
 * "kesho" -> ISO date, else null. Past days are allowed (who came last week?).
 */
export function parseQueryDate(tok, now = new Date()) {
  const t = String(tok ?? "").trim().toLowerCase();
  const today = eatToday(now);
  if (t === "leo") return today;
  if (t === "kesho") return addDays(today, 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return parseIsoDate(t) ? t : null;
  const m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(t);
  if (!m) return null;
  const [d, mo] = [Number(m[1]), Number(m[2])];
  if (m[3]) {
    const iso = `${m[3].length === 2 ? 2000 + Number(m[3]) : m[3]}-${pad(mo)}-${pad(d)}`;
    return parseIsoDate(iso) ? iso : null;
  }
  const y = Number(today.slice(0, 4));
  const dist = (iso) => Math.abs(Date.parse(iso) - Date.parse(today));
  const candidates = [y - 1, y, y + 1].map((yy) => `${yy}-${pad(mo)}-${pad(d)}`).filter((iso) => parseIsoDate(iso));
  if (!candidates.length) return null;
  return candidates.reduce((best, iso) => (dist(iso) < dist(best) ? iso : best));
}

// ---------------------------------------------------------------------------------------------------------
// Facts from the store (read-only).
/** The sheet as the hub runs it: approved capacity/price overrides applied, without mutating `sheet`. */
function effectiveSheet(store, sheet) {
  return { ...(sheet ?? {}), ...store.getKV(SHEET_OVERRIDES_KV, {}) };
}

/** Everything a reply says about one day, computed by code. */
export function dayFacts(store, sheet, date) {
  const s = effectiveSheet(store, sheet);
  const p = parseIsoDate(date);
  const rows = listBookings(store).filter((b) => b.slot_id === date || b.request?.date === date);
  const confirmed = rows.filter((b) => b.state === "confirmed");
  const booked = confirmed.reduce((n, b) => n + (Number.isInteger(b.request?.party_size) ? b.request.party_size : 0), 0);
  const capacity = Number.isInteger(s.capacity_per_tour) ? s.capacity_per_tour : null;
  return {
    date,
    closed: Boolean(store.getKV(CLOSED_DAYS_KV, {})[date]),
    blocked: Boolean(blockedDays(store)[date]),
    tour_day: Array.isArray(s.days) ? s.days.includes(WEEKDAY_CODES[p.weekday]) : null,
    capacity,
    booked,
    left: capacity === null ? null : Math.max(0, capacity - booked),
    confirmed: confirmed.map((b) => ({
      party_size: b.request.party_size, platform: platformSms(b.platform === "direct" ? b.channel : b.platform), name: firstName(b.request?.visitor_name),
    })),
    conflicts: rows.filter((b) => b.state === "conflict").length,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Rendering.
/** Join head + as many items as fit + tail within 2 segments; a "+N" marker says how many were left out. */
function fitList(head, items, tail = "") {
  const build = (list, more) => [head, list.join("; ") + (more ? `; +${more} zaidi` : "") + (list.length || more ? "." : ""), tail]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  let n = items.length;
  let out = build(items, 0);
  while (gsm7Length(out) > MAX_REPLY_SEPTETS && n > 0) {
    n -= 1;
    out = build(items.slice(0, n), items.length - n);
  }
  return out;
}

function finish(text) {
  if (!isGsm7(text)) throw new Error("owner query reply is not GSM-7");
  if (gsm7Length(text) > MAX_REPLY_SEPTETS) throw new Error("owner query reply exceeds 2 SMS segments");
  return text;
}

const status = (f) => (f.closed ? "imefungwa" : f.blocked ? "imezuiwa (tovuti)" : f.tour_day === false ? "si siku ya ziara" : null);

function dayReport(label, f) {
  const head = `SAUTI ${label} ${swDateShort(f.date)}:`;
  const st = status(f);
  const people = f.confirmed.map((b) => `${b.name ? `${b.name} ` : ""}watu ${b.party_size} (${b.platform})`);
  const summary = f.confirmed.length
    ? `Wageni ${f.confirmed.length}, watu ${f.booked}.`
    : "Hakuna wageni.";
  const seats = st
    ? `Siku ${st}.`
    : f.capacity === null ? "Nafasi bado hazijawekwa." : `Nafasi ${f.left} kati ya ${f.capacity} zimebaki.`;
  const conflict = f.conflicts ? `Migongano ${f.conflicts}: angalia Sauti.` : "";
  return finish(fitList(`${head} ${summary}`, people, `${seats} ${conflict}`));
}

function ratiba(store, sheet, now) {
  const today = eatToday(now);
  const items = [];
  for (let i = 0; i < 7; i++) {
    const f = dayFacts(store, sheet, addDays(today, i));
    const st = status(f);
    let line = `${swDateShort(f.date)} `;
    if (st) line += st.toUpperCase() + (f.booked ? ` (watu ${f.booked})` : "");
    else line += f.capacity === null ? `watu ${f.booked}` : `${f.booked}/${f.capacity}`;
    if (f.conflicts) line += ` mgongano ${f.conflicts}`;
    items.push(line);
  }
  return finish(fitList("SAUTI RATIBA (watu/nafasi):", items));
}

/** Feedback summary from the store, made GSM-7 and cut to fit; null when there is nothing to say. */
function feedbackSummary(raw) {
  const text = typeof raw === "string" ? raw : raw && typeof raw === "object" ? (raw.text_sw ?? raw.summary ?? raw.text) : null;
  if (typeof text !== "string") return null;
  const plain = text.normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, "\"").replace(/[–—]/g, "-");
  const clean = [...plain].map((ch) => (isGsm7(ch) && ch !== "\n" && ch !== "\r" ? ch : " ")).join("").replace(/\s+/g, " ").trim();
  return clean || null;
}

function maoni(store) {
  const summary = feedbackSummary(store.getKV(FEEDBACK_KV, null));
  if (!summary) return QUERY_REPLIES.no_feedback;
  const head = "SAUTI MAONI: ";
  let body = summary;
  while (gsm7Length(head + body) > MAX_REPLY_SEPTETS) body = body.slice(0, -4).trimEnd() + "...";
  return finish(head + body);
}

// ---------------------------------------------------------------------------------------------------------
function isOwner(store, from) {
  const owner = normalizePhone(store.getKV("owner.phone"));
  const sender = normalizePhone(from);
  if (!owner || !sender) return false;
  const a = createHash("sha256").update(owner).digest();
  const b = createHash("sha256").update(sender).digest();
  return timingSafeEqual(a, b);
}

/**
 * Answer one of Noor's read-only queries.
 * @param store openStore() result (only read)
 * @param sheet validated farm sheet (approved overrides in kv "sheet.overrides" are applied on top)
 * @param {{ from: string, text: string }} sms
 * @param {Date} [now]
 * @returns {{ reply: string, recipient: string, query: string } | null} null: not Noor, or not a query.
 *   Send `reply` to `recipient` (the enrolled number from kv, never the inbound address) through the outbox.
 */
export function answerOwnerQuery(store, sheet, { from, text } = {}, now = new Date()) {
  if (!isOwner(store, from)) return null;
  const toks = String(text ?? "").normalize("NFKC").replace(/[.!?]+\s*$/, "").trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  const verb = toks[0].toUpperCase();
  const args = toks.slice(1);
  const recipient = store.getKV("owner.phone");
  const out = (reply) => ({ reply, recipient, query: verb });
  const s = effectiveSheet(store, sheet);
  const today = eatToday(now);

  if (verb === "WAGENI") {
    if (args.length !== 1) return out(QUERY_REPLIES.bad_date);
    const date = parseQueryDate(args[0], now);
    return out(date ? dayReport("WAGENI", dayFacts(store, sheet, date)) : QUERY_REPLIES.bad_date);
  }
  if (args.length) return null; // "BEI 2000", "NAFASI 8" are commands (proposals), not queries
  switch (verb) {
    case "LEO": return out(dayReport("LEO", dayFacts(store, sheet, today)));
    case "KESHO": return out(dayReport("KESHO", dayFacts(store, sheet, addDays(today, 1))));
    case "RATIBA": return out(ratiba(store, sheet, now));
    case "BEI":
      return out(finish(Number.isInteger(s.price_per_person_kes)
        ? `SAUTI BEI: KES ${s.price_per_person_kes} kwa mgeni mmoja.`
        : "SAUTI BEI: Bei bado haijawekwa."));
    case "NAFASI":
      return out(finish(Number.isInteger(s.capacity_per_tour)
        ? `SAUTI NAFASI: watu ${s.capacity_per_tour} kwa kila ziara.`
        : "SAUTI NAFASI: Nafasi bado hazijawekwa."));
    case "MAONI": return out(maoni(store));
    default: return null; // MSAADA, commands, free text: the command parser answers
  }
}

/**
 * Wiring helper (hub.mjs is not edited here): a query is answered through the outbox; anything else goes to the
 * hub's command path (hub.ownerSms), which answers with its own fixed replies.
 * @param {{ store, sheet, outbox, hub }} deps
 */
export async function routeOwnerSms({ store, sheet, outbox, hub }, sms, now = new Date()) {
  const q = answerOwnerQuery(store, sheet, sms, now);
  if (!q) return { query: null, ...(await hub.ownerSms(sms)) };
  outbox.enqueue({ channel: "sms", recipient: q.recipient, body: q.reply, cause_id: `query:${q.query}:${now.toISOString()}` });
  await outbox.dispatch();
  return { query: q.query, reply_sent: true };
}
