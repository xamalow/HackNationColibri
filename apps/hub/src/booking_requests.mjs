// A tourist asks to book (SMS today; the voice agent calls requestBooking with the same event shape).
//
//   tourist text --parseBookingRequest (code, never a model)--> date + party size, or "ask the tourist"
//                --core checkCapacity + Noor's closed days--> unavailable (with the reason), or
//                --createProposal("booking_request") + one-time code--> Noor's Swahili read-back SMS
//   Noor: "NDIYO A 482113" | "HAPANA A 482113" | "A 482113 <her words>"  (commands.mjs: enrolled number + code)
//                --decideBookingRequest--> confirmed booking + tourist SMS | declined SMS | relay of her words
//
// Rules:
// - Never guess: a missing or ambiguous date / party size gets a fixed "please tell us" reply, no proposal.
// - Every fact sent to Noor or the tourist comes from structured fields computed here (date, party size, KES total
//   from the farm sheet). Tourist text is never put in any outbound message (tourist_replies.mjs, notify.mjs rules).
// - Nothing is booked without Noor's NDIYO + one-time code; on approval capacity is checked AGAIN (it may have
//   changed since the proposal) and the booking is written in one store transaction.
// - The tourist's phone number (tourist_ref) is kept in the proposal body only to address the replies; it is not
//   copied into the booking row and never sent to Noor.
//
// SWAHILI REVIEW STATUS: UNREVIEWED (read-back and owner notes below).
import { CLOSED_DAYS_KV } from "./hub.mjs";
import { confirmedOn, FARM_TIMEZONE, seatsTaken } from "./bookings.mjs";
import { createProposal, proposalDigest, sanitizeSuggestion } from "./commands.mjs";
import { checkCapacity } from "./core.mjs";
import { normalizePhone, sanitizeText } from "./intake/sms.mjs";
import { EAT_OFFSET_MS, firstName, gsm7Length, isGsm7, parseIsoDate, SMS_SINGLE_SEGMENT, swDateShort } from "./notify.mjs";
import { blockedDays } from "./publish.mjs";
import { renderTouristReply, replyLang } from "./tourist_replies.mjs";

export const PROPOSAL_KIND = "booking_request";
export const DEFAULT_LIMITS = Object.freeze({
  // A tourist SMS creates a proposal and an SMS to Noor: bound both (SMS pumping, annoyance).
  maxProposalsPerDay: 30,
  maxPendingPerTourist: 2,
  maxParty: 200,
});
const BUDGET_KV = "booking_requests.budget";
const EVENT_KV = "booking_requests.event.";
const OUTCOME_KV = "booking_requests.outcome.";
const VOICE_CALL_KV = "booking_requests.voice_call.";

// ---------------------------------------------------------------------------------------------------------
// Language: contrib/max/langid (franc). It needs `npm ci --prefix contrib/max/langid`; without it every text is
// "und" (fail closed: English template + lang_fallback flag), never a guess.
let langid = null;
try {
  langid = await import("../../../contrib/max/langid/detect_language.mjs");
} catch {
  langid = null;
}
export const LANGID_AVAILABLE = Boolean(langid);

/**
 * @param {string} text tourist text
 * @param {string} [declared] a language the source declares (e.g. the voice agent's speech recogniser)
 * @returns {{ lang: "en"|"de"|"fr"|"sw", detected: string, reason: string, fallback: boolean }}
 *   `lang` is the reply language; `fallback: true` when it is English only because nothing better was known.
 */
// B15 (muller-claude): langid r2 abstains on short German requests (margin below its refusal threshold, tuned so
// Bantu look-alikes are not counted as Swahili). That refusal is right for COUNTING feedback by language; for choosing
// a polite reply template, distinctive function words are evidence too. Used only when langid abstains, never to
// override it, and never for counting. A language needs 2+ hits and a lead of 2 over every other one.
const REPLY_CUES = {
  de: ["wir", "sind", "können", "konnen", "koennen", "möchten", "mochten", "personen", "hallo", "danke", "bitte", "samstag",
    "sonntag", "freitag", "montag", "dienstag", "mittwoch", "donnerstag", "oktober", "und", "ist", "uns", "besuchen", "kaffeefarm"],
  fr: ["nous", "sommes", "pouvons", "personnes", "bonjour", "merci", "samedi", "dimanche", "vendredi", "lundi", "mardi",
    "mercredi", "jeudi", "octobre", "est", "pour", "visiter", "ferme", "voudrions", "avec"],
  sw: ["watu", "tarehe", "habari", "tunaweza", "tungependa", "jumamosi", "jumapili", "ijumaa", "sisi", "asante", "karibu",
    "shamba", "kutembelea", "tafadhali", "wageni"],
  en: ["we", "are", "can", "could", "people", "hello", "thanks", "thank", "the", "and", "saturday", "sunday", "friday",
    "october", "visit", "farm", "would", "like", "us"],
};
export function replyLanguageHint(text) {
  const words = String(text ?? "").toLowerCase().normalize("NFC").match(/\p{L}+/gu) ?? [];
  const hits = Object.entries(REPLY_CUES).map(([l, cues]) => [l, words.filter((w) => cues.includes(w)).length]);
  const [best, second] = hits.sort((a, b) => b[1] - a[1]);
  return best[1] >= 2 && best[1] - second[1] >= 2 ? best[0] : null;
}

export function detectTouristLanguage(text, declared = null) {
  if (!langid) return { lang: "en", detected: "und", reason: "langid_unavailable", fallback: true };
  const supported = ["en", "de", "fr", "sw"];
  if (declared && supported.includes(declared)) {
    const c = langid.checkDeclared(text, declared);
    if (c.verdict !== "disagree") return { lang: declared, detected: c.detected.lang, reason: `declared_${c.verdict}`, fallback: false };
    if (supported.includes(c.detected.lang)) return { lang: c.detected.lang, detected: c.detected.lang, reason: "declared_disagree", fallback: false };
    return { lang: "en", detected: c.detected.lang, reason: "declared_disagree", fallback: true };
  }
  const d = langid.detectLanguage(text);
  if (supported.includes(d.lang)) return { lang: d.lang, detected: d.lang, reason: d.reason, fallback: false };
  const hint = d.lang === "und" ? replyLanguageHint(text) : null;
  if (hint) return { lang: hint, detected: d.lang, reason: `reply_hint_${hint}`, fallback: false };
  return { lang: "en", detected: d.lang, reason: d.reason, fallback: true };
}

// ---------------------------------------------------------------------------------------------------------
// Parsing (port of sauti/lang/extract.py, branch w2-answer-tourist, with the fixes noted inline).
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10,
  november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10,
  nov: 11, dec: 12,
  januar: 1, februar: 2, marz: 3, mai: 5, juni: 6, juli: 7, oktober: 10, dezember: 12,
  janvier: 1, fevrier: 2, mars: 3, avril: 4, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11,
  decembre: 12,
  januari: 1, februari: 2, machi: 3, aprili: 4, mei: 5, julai: 7, agosti: 8, septemba: 9, oktoba: 10, novemba: 11,
  desemba: 12,
};
// getUTCDay numbering (Sunday = 0).
const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonnabend: 6,
  dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6,
  jumapili: 0, jumatatu: 1, jumanne: 2, jumatano: 3, alhamisi: 4, ijumaa: 5, jumamosi: 6,
};
const RELATIVE = {
  today: 0, tomorrow: 1, heute: 0, morgen: 1, ubermorgen: 2,
  "aujourd'hui": 0, demain: 1, "apres-demain": 2, leo: 0, kesho: 1, keshokutwa: 2,
};
// "Guten Morgen", "am Morgen" mean morning, not tomorrow.
const MORGEN_NOT_TOMORROW = new Set(["guten", "am", "jeden", "den", "heute"]);
// A dotted number after these is a clock time ("at 10.30"), not a date.
const TIME_LEADS = new Set(["at", "um", "a", "vers", "saa", "ab", "from", "des"]);
const OR_WORDS = new Set(["or", "oder", "ou", "au", "ama"]);
const TIME_TAILS = new Set(["pm", "uhr", "h", "hrs", "heures", "asubuhi", "mchana", "jioni"]);

const SW_UNITS = { moja: 1, mbili: 2, tatu: 3, nne: 4, tano: 5, sita: 6, saba: 7, nane: 8, tisa: 9 };
const SW_PEOPLE_UNITS = { mmoja: 1, wawili: 2, watatu: 3, wanne: 4, watano: 5, wanane: 8 };
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  ein: 1, eine: 1, eins: 1, zwei: 2, drei: 3, vier: 4, funf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10,
  elf: 11, zwolf: 12,
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11,
  douze: 12,
  ...SW_UNITS, ...SW_PEOPLE_UNITS, kumi: 10,
};
// "wir sind zu dritt" (added: not in extract.py).
const ZU_FORMS = { zweit: 2, dritt: 3, viert: 4, funft: 5, sechst: 6, siebt: 7, acht: 8 };
const PEOPLE_NOUNS = {
  people: "all", persons: "all", person: "all", guests: "all", visitors: "all", pax: "all",
  personen: "all", leute: "all", gaste: "all", besucher: "all",
  personnes: "all", personne: "all", invites: "all", visiteurs: "all",
  watu: "all", wageni: "all", mtu: "all", mgeni: "all",
  adults: "adults", adult: "adults", erwachsene: "adults", adultes: "adults", adulte: "adults",
  children: "children", child: "children", kids: "children", kinder: "children", kind: "children",
  enfants: "children", enfant: "children", watoto: "children", mtoto: "children",
};
// Swahili puts the number after the noun ("watu wanne"): read after first (fix: "tarehe 12 watu 4" is 4).
const SW_NOUNS = new Set(["watu", "wageni", "mtu", "mgeni", "watoto", "mtoto"]);
const GROUP_LEADS = [
  ["we", "are"], ["we're"], ["group", "of"], ["family", "of"], ["party", "of"], ["for"],
  ["wir", "sind"], ["zu"], ["gruppe", "von"], ["nous", "sommes"], ["pour"], ["groupe", "de"],
  ["sisi", "ni"], ["tuko"], ["tutakuwa"],
];
const WEAK_LEADS = new Set(["for", "pour", "zu"]);

function normalize(text) {
  return String(text ?? "").normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")
    .replace(/[’‘`]/g, "'")
    .replace(/apres demain/g, "apres-demain")
    .replace(/kesho kutwa/g, "keshokutwa");
}
const TOKEN_RE = /\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\.?|\d{1,2}(?:st|nd|rd|th|er|e)\b|\d+|[a-z'][a-z'-]*/g;
const tokens = (text) => normalize(text).match(TOKEN_RE) ?? [];

const isoOf = (y, m, d) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const addDays = (iso, n) => {
  const p = parseIsoDate(iso);
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return isoOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};
const validIso = (y, m, d) => (parseIsoDate(isoOf(y, m, d)) ? isoOf(y, m, d) : null);

/** Local (EAT) calendar date of an instant. */
export function eatDate(at) {
  const t = at instanceof Date ? at.getTime() : Date.parse(String(at ?? ""));
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + EAT_OFFSET_MS);
  return isoOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function future(month, day, ref, year) {
  if (year != null) return validIso(year > 99 ? year : 2000 + year, month, day);
  const y = Number(ref.slice(0, 4));
  const c = validIso(y, month, day);
  if (c && c >= ref) return c;
  return validIso(y + 1, month, day);
}

function ordinal(tok) {
  const m = /^(\d{1,2})(?:st|nd|rd|th|er|e|\.)?$/.exec(tok ?? "");
  return m && Number(m[1]) >= 1 && Number(m[1]) <= 31 ? Number(m[1]) : null;
}

function numericDate(tok, ref, lang) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) {
    const p = parseIsoDate(tok);
    return { dates: p ? [tok] : [], ambiguous: false };
  }
  const m = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\.?$/.exec(tok);
  if (!m) return { dates: [], ambiguous: false };
  let a = Number(m[1]);
  let b = Number(m[2]);
  const year = m[3] ? Number(m[3]) : null;
  // An English (or unidentified) writer may be American (month first): 03/04 cannot be decided.
  if ((lang === "en" || !["de", "fr", "sw"].includes(lang)) && a <= 12 && b <= 12 && a !== b) return { dates: [], ambiguous: true };
  if (b > 12 && a <= 12) {
    // 10/20 can only be month first. With a dot it is a clock time ("14.30", "10.30"), not a date (fix).
    if (m[0].includes(".")) return { dates: [], ambiguous: false };
    [a, b] = [b, a];
  }
  const d = future(b, a, ref, year);
  return { dates: d ? [d] : [], ambiguous: false };
}

/**
 * The single tour date asked for. `received` is the ISO date (EAT) the tourist wrote on.
 * Explicit dates and relative days must agree on one date; a weekday name must match it (else ambiguous).
 * @returns {{ date: string|null, ambiguous: boolean }}
 */
export function parseRequestDate(text, received, lang = null) {
  const toks = tokens(text);
  const fixed = new Set();
  const weekdays = new Set();
  let ambiguous = false;
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (/[./-]/.test(tok) && /^\d/.test(tok)) {
      if (TIME_LEADS.has(toks[i - 1]) || TIME_TAILS.has(toks[i + 1])) continue;
      const r = numericDate(tok, received, lang);
      r.dates.forEach((d) => fixed.add(d));
      ambiguous ||= r.ambiguous;
    } else if (tok in MONTHS) {
      // A month word counts only with a day number next to it ("may we come" is not May).
      const before = toks.slice(Math.max(0, i - 2), i).filter((t) => t !== "of");
      let day = before.length ? ordinal(before[before.length - 1]) : null;
      if (day === null) day = ordinal(toks[i + 1]);
      // "12 or 13 October", "12 oder 13. Oktober", "12 ou 13 octobre", "tarehe 12 au 13 Oktoba": two dates (added).
      else if (OR_WORDS.has(toks[i - 2]) && ordinal(toks[i - 3]) !== null) ambiguous = true;
      else if (ordinal(toks[i - 2]) !== null && toks[i - 1] !== undefined && ordinal(toks[i - 1]) !== null) ambiguous = true; // "12-13 October"
      let year = null;
      for (const t of toks.slice(i + 1, i + 3)) if (/^20\d{2}$/.test(t)) year = Number(t);
      const d = day !== null ? future(MONTHS[tok], day, received, year) : null;
      if (d) fixed.add(d);
    } else if (tok in RELATIVE) {
      if (tok === "morgen" && MORGEN_NOT_TOMORROW.has(toks[i - 1])) continue;
      fixed.add(addDays(received, RELATIVE[tok]));
    } else if (tok in WEEKDAYS) {
      weekdays.add(WEEKDAYS[tok]);
    }
  }
  if (ambiguous || fixed.size > 1 || weekdays.size > 1) return { date: null, ambiguous: true };
  const [wd] = weekdays;
  if (fixed.size === 1) {
    const [d] = fixed;
    if (wd !== undefined && parseIsoDate(d).weekday !== wd) return { date: null, ambiguous: true };
    return { date: d, ambiguous: false };
  }
  if (wd !== undefined) {
    const ahead = ((wd - parseIsoDate(received).weekday + 7) % 7) || 7; // next occurrence, never today
    return { date: addDays(received, ahead), ambiguous: false };
  }
  return { date: null, ambiguous: false };
}

const numberOf = (tok) => (tok !== undefined && /^\d+$/.test(tok) ? Number(tok) : (NUMBER_WORDS[tok] ?? null));

/** Number of visitors. Adults and children add up; two different totals are ambiguous. */
export function parsePartySize(text, { maxParty = DEFAULT_LIMITS.maxParty } = {}) {
  const toks = tokens(text);
  const byGroup = { all: new Set(), adults: new Set(), children: new Set() };
  const ok = (n) => n !== null && n >= 1 && n <= maxParty;
  for (let i = 0; i < toks.length; i++) {
    const group = PEOPLE_NOUNS[toks[i]];
    if (!group) continue;
    const before = i > 0 ? numberOf(toks[i - 1]) : null;
    const after = numberOf(toks[i + 1]);
    const n = SW_NOUNS.has(toks[i]) ? (after ?? before) : (before ?? after);
    if (ok(n)) byGroup[group].add(n);
  }
  for (const lead of GROUP_LEADS) {
    const k = lead.length;
    for (let i = 0; i + k < toks.length; i++) {
      if (!lead.every((w, j) => toks[i + j] === w)) continue;
      const nxtTok = toks[i + k];
      if (lead[0] === "zu" && nxtTok in ZU_FORMS) { byGroup.all.add(ZU_FORMS[nxtTok]); continue; }
      const n = numberOf(nxtTok);
      if (!ok(n)) continue;
      const nxt = toks[i + k + 1];
      if (nxt !== undefined && nxt in PEOPLE_NOUNS) continue; // "we are 2 adults": counted by its noun
      // "for 4" alone is weak ("for 2 hours", "for 12 October"): kept only at the end of the text.
      if (k === 1 && WEAK_LEADS.has(lead[0]) && nxt !== undefined) continue;
      byGroup.all.add(n);
    }
  }
  if (Object.values(byGroup).some((s) => s.size > 1)) return { party_size: null, ambiguous: true };
  const one = (s) => (s.size ? [...s][0] : null);
  if (byGroup.adults.size || byGroup.children.size) {
    const total = (one(byGroup.adults) ?? 0) + (one(byGroup.children) ?? 0);
    if (byGroup.all.size && one(byGroup.all) !== total) return { party_size: null, ambiguous: true };
    return ok(total) ? { party_size: total, ambiguous: false } : { party_size: null, ambiguous: true };
  }
  return { party_size: one(byGroup.all), ambiguous: false };
}

/**
 * @param {string} text tourist text (untrusted data)
 * @param {{ lang?: string, received?: Date|string }} opts lang: the tourist language (en/de/fr/sw; anything else is
 *   treated as unknown, so 03/04 stays ambiguous); received: when the tourist wrote (relative days count from it, EAT)
 * @returns {{ date: string|null, party_size: number|null, date_ambiguous: boolean, party_ambiguous: boolean,
 *   ambiguous: boolean, missing: ("date"|"party_size")[] }}
 */
export function parseBookingRequest(text, { lang = null, received = new Date() } = {}) {
  const ref = typeof received === "string" && /^\d{4}-\d{2}-\d{2}$/.test(received) ? received : eatDate(received);
  if (!ref) throw new Error("invalid received date");
  const d = parseRequestDate(text, ref, lang);
  const p = parsePartySize(text);
  const missing = [];
  if (!d.date) missing.push("date");
  if (!p.party_size) missing.push("party_size");
  return {
    date: d.date, party_size: p.party_size, date_ambiguous: d.ambiguous, party_ambiguous: p.ambiguous,
    ambiguous: d.ambiguous || p.ambiguous, missing,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Noor's read-back (Swahili, GSM-7, one segment when possible). Facts only from the proposal body.
const LANG_SW = { en: "Kiingereza", de: "Kijerumani", fr: "Kifaransa", sw: "Kiswahili" };

export function ownerReadback(body, shortId, code) {
  const party = body.party_size === 1 ? "mtu 1" : `watu ${body.party_size}`;
  const lang = body.lang_fallback ? "lugha?" : (LANG_SW[body.lang] ?? "lugha?");
  const facts = `anaomba ${party}, ${swDateShort(body.date)}, KES ${body.price_kes_total}.`;
  // A voice request has no SMS address for the guest: no "<ujumbe>" form, and Noor is told to call back.
  const answer = body.tourist_ref
    ? `Jibu NDIYO ${shortId} ${code}, HAPANA ${shortId} ${code}, au ${shortId} ${code} <ujumbe>`
    : `Alipiga simu, hana SMS: mpigie simu. Jibu NDIYO ${shortId} ${code} au HAPANA ${shortId} ${code}`;
  const withName = body.visitor_first_name ? `SAUTI: Mgeni ${body.visitor_first_name} (${lang}) ${facts} ${answer}` : null;
  const plain = `SAUTI: Mgeni (${lang}) ${facts} ${answer}`;
  const sms = withName && gsm7Length(withName) <= SMS_SINGLE_SEGMENT ? withName : plain;
  if (!isGsm7(sms)) throw new Error("read-back SMS is not GSM-7");
  return sms;
}

// ---------------------------------------------------------------------------------------------------------
// Availability.
const dayClosedByNoor = (store, date) => Boolean(store.getKV(CLOSED_DAYS_KV, {})[date] || blockedDays(store)[date]);
const nowClock = (now) => {
  const d = new Date(now.getTime() + EAT_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Can `party_size` people come on `date` (tour start of the farm sheet)? Code only.
 * @returns {{ ok: true, price_kes_total: number, start: string, end: string, remaining_after: number }
 *         | { ok: false, reason: "closed_day"|"day_closed"|"full"|"hours"|"too_late"|"ask"|"missing_fact", facts: object, detail: string }}
 */
export function checkAvailability(store, sheet, { date, party_size, request_id = "availability", now = new Date() }) {
  const today = eatDate(now);
  const start = sheet.hours?.start?.slice(0, 5) ?? null;
  const end = sheet.hours?.end?.slice(0, 5) ?? null;
  if (!parseIsoDate(date)) return { ok: false, reason: "ask", facts: {}, detail: "invalid date" };
  if (date < today || (date === today && start && nowClock(now) >= minutesOf(start))) {
    return { ok: false, reason: "too_late", facts: { date }, detail: "the tour on that day has started or is past" };
  }
  if (dayClosedByNoor(store, date)) return { ok: false, reason: "day_closed", facts: { date }, detail: "Noor closed this day" };
  const request = {
    request_id, visitor_name: "visitor", contact: { channel: "local", address: "visitor", language: "und" },
    date, party_size, source_id: request_id,
  };
  const v = checkCapacity(sheet, confirmedOn(store, date), request, FARM_TIMEZONE);
  if (v.ok) {
    return { ok: true, price_kes_total: v.price.amount_minor / 100, start: v.slot_start, end: v.slot_end, remaining_after: v.remaining_after };
  }
  switch (v.reason) {
    case "closed_day": return { ok: false, reason: "closed_day", facts: { date, open_days: sheet.days }, detail: v.detail };
    case "no_capacity": {
      const left = Math.max(0, sheet.capacity_per_tour - seatsTaken(store, date));
      return { ok: false, reason: "full", facts: { date, seats_left: left }, detail: v.detail };
    }
    case "outside_hours":
    case "unsupported_time": return { ok: false, reason: "hours", facts: { date, start, end }, detail: v.detail };
    case "bad_date":
    case "bad_party_size": return { ok: false, reason: "ask", facts: {}, detail: v.detail };
    default: return { ok: false, reason: "missing_fact", facts: {}, detail: v.detail };
  }
}

// ---------------------------------------------------------------------------------------------------------
// The tourist's request.
function pendingFor(store, touristRef) {
  return store.db.prepare("SELECT body FROM proposals WHERE kind = ? AND state = 'proposed'").all(PROPOSAL_KIND)
    .filter((r) => { try { return JSON.parse(r.body).tourist_ref === touristRef; } catch { return false; } }).length;
}

/**
 * Handle a tourist's booking request. Pure decision + store writes (proposal, counters); sends nothing: the caller
 * enqueues `owner_sms` to `owner_recipient` with { sensitive: true } (it carries the code) and the tourist replies
 * to `tourist_recipient`.
 * @param store openStore() result
 * @param sheet validated farm sheet
 * @param {{ event: import("./intake/sms.mjs").HubEvent & { visitor_name?: string }, now?: Date, limits?: object }} args
 *   event: kind "visitor_message" with `from` (E.164) and `text`; optional `lang` declared by the source and
 *   `visitor_name` (the voice agent may know it).
 * @returns {{ action: "ask_tourist", reply, tourist_recipient, lang, lang_fallback, missing, ambiguous }
 *   | { action: "unavailable", reply, tourist_recipient, reason, lang, lang_fallback, date, party_size }
 *   | { action: "proposed", proposal_id, owner_sms, owner_recipient, owner_sms_sensitive: true, tourist_ack,
 *       tourist_recipient, expires_at, lang, lang_fallback, body }
 *   | { action: "duplicate", proposal_id }
 *   | { action: "needs_owner", reason, reply, tourist_recipient, lang }   (no proposal: limits, no owner, sheet gap)
 *   | { action: "ignored", reason }}                                       (not a visitor message / no reply address)
 */
export function requestBooking(store, sheet, { event, now = new Date(), limits = {} } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  if (event?.kind !== "visitor_message") return { action: "ignored", reason: "not_a_visitor_message" };
  const tourist = normalizePhone(event.from);
  if (!tourist) return { action: "ignored", reason: "no_reply_address" };
  const prior = store.getKV(EVENT_KV + event.id);
  if (prior) return { action: "duplicate", proposal_id: prior };

  const { text } = sanitizeText(event.text);
  const lg = detectTouristLanguage(text, event.lang ?? null);
  const lang = replyLang(lg.lang);
  const base = { tourist_recipient: tourist, lang, lang_fallback: lg.fallback };
  const ask = (extra = {}) => ({ action: "ask_tourist", reply: renderTouristReply("ask_details", lang), ...base, ...extra });

  const parsed = parseBookingRequest(text, { lang: lg.fallback ? null : lang, received: event.received_at ?? now });
  if (parsed.ambiguous || parsed.missing.length) return ask({ missing: parsed.missing, ambiguous: parsed.ambiguous });
  const { date, party_size } = parsed;

  if (date < eatDate(now)) return ask({ missing: ["date"], ambiguous: false }); // a past date: ask, do not guess
  const avail = checkAvailability(store, sheet, { date, party_size, request_id: event.id, now });
  if (!avail.ok) {
    if (avail.reason === "ask") return ask({ missing: ["date"], ambiguous: false });
    if (avail.reason === "missing_fact") {
      return { action: "needs_owner", reason: "missing_fact", reply: renderTouristReply("holding", lang), ...base };
    }
    return {
      action: "unavailable", reason: avail.reason, date, party_size,
      reply: renderTouristReply("unavailable", lang, { reason: avail.reason, ...avail.facts }), ...base,
    };
  }

  const owner = store.getKV("owner.phone");
  const holding = (reason) => ({ action: "needs_owner", reason, reply: renderTouristReply("holding", lang), ...base });
  if (!owner) return holding("no_owner_enrolled");
  if (pendingFor(store, tourist) >= lim.maxPendingPerTourist) return holding("tourist_pending_limit");
  const day = eatDate(now);
  const budget = store.getKV(BUDGET_KV, {});
  const count = budget.day === day ? budget.count ?? 0 : 0;
  if (count >= lim.maxProposalsPerDay) return holding("daily_limit");
  store.setKV(BUDGET_KV, { day, count: count + 1 });

  const body = {
    date, time: avail.start, party_size, price_kes_total: avail.price_kes_total,
    tourist_ref: tourist, lang, lang_fallback: lg.fallback, channel: String(event.channel ?? "sms").slice(0, 16),
    visitor_first_name: firstName(event.visitor_name), source_event_id: String(event.id).slice(0, 128),
  };
  const p = createProposal(store, PROPOSAL_KIND, body, { now });
  store.setKV(EVENT_KV + event.id, p.short_id);
  return {
    action: "proposed", proposal_id: p.short_id, owner_sms: ownerReadback(body, p.short_id, p.code), owner_recipient: owner,
    owner_sms_sensitive: true, tourist_ack: renderTouristReply("ack", lang, { date, party_size }), expires_at: p.expires_at,
    ...base, body,
  };
}

/**
 * A booking request taken by the voice agent on a call (POST /v1/proposals, voice_api.mjs). The agent already
 * asked the date and the party size, so they arrive structured (validated by the caller); availability, price and
 * the proposal are decided here by code, exactly as for an SMS request. There is NO reply address: the caller id is
 * never recorded, so tourist_ref is null, nothing is ever sent to the guest, and Noor's read-back says to call back.
 * Sends nothing: the caller enqueues `owner_sms` to `owner_recipient` with { sensitive: true }.
 * @param {{ booking: { date: string, party_size: number, visitor_name?: string, language?: string }, call_id: string,
 *           now?: Date, limits?: object }} args
 * @returns {{ action: "proposed", proposal_id, digest, owner_sms, owner_recipient, expires_at, body }
 *   | { action: "duplicate", proposal_id }
 *   | { action: "unavailable", reason, facts }
 *   | { action: "invalid", reason }
 *   | { action: "needs_owner", reason }}
 */
export function requestVoiceBooking(store, sheet, { booking, call_id, now = new Date(), limits = {} } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const { date, party_size } = booking ?? {};
  if (!parseIsoDate(date)) return { action: "invalid", reason: "date" };
  if (!Number.isInteger(party_size) || party_size < 1 || party_size > lim.maxParty) return { action: "invalid", reason: "party_size" };
  const eventId = `voice:${call_id}:${date}:${party_size}`;
  const prior = store.getKV(EVENT_KV + eventId);
  if (prior) return { action: "duplicate", proposal_id: prior };

  const avail = checkAvailability(store, sheet, { date, party_size, request_id: eventId, now });
  if (!avail.ok) {
    if (avail.reason === "ask") return { action: "invalid", reason: "date" };
    if (avail.reason === "missing_fact") return { action: "needs_owner", reason: "missing_fact" };
    return { action: "unavailable", reason: avail.reason, facts: avail.facts };
  }
  const owner = store.getKV("owner.phone");
  if (!owner) return { action: "needs_owner", reason: "no_owner_enrolled" };
  const perCall = store.getKV(VOICE_CALL_KV + call_id, 0);
  if (perCall >= lim.maxPendingPerTourist) return { action: "needs_owner", reason: "call_request_limit" };
  const day = eatDate(now);
  const budget = store.getKV(BUDGET_KV, {});
  const count = budget.day === day ? budget.count ?? 0 : 0;
  if (count >= lim.maxProposalsPerDay) return { action: "needs_owner", reason: "daily_limit" };
  store.setKV(BUDGET_KV, { day, count: count + 1 });
  store.setKV(VOICE_CALL_KV + call_id, perCall + 1);

  const declared = typeof booking.language === "string" ? booking.language.toLowerCase().slice(0, 2) : "";
  const known = ["en", "de", "fr", "sw"].includes(declared);
  const body = {
    date, time: avail.start, party_size, price_kes_total: avail.price_kes_total,
    tourist_ref: null, lang: known ? declared : "en", lang_fallback: !known, channel: "voice",
    visitor_first_name: firstName(booking.visitor_name), source_event_id: eventId.slice(0, 128),
  };
  const p = createProposal(store, PROPOSAL_KIND, body, { now });
  store.setKV(EVENT_KV + eventId, p.short_id);
  return {
    action: "proposed", proposal_id: p.short_id, digest: p.digest, owner_sms: ownerReadback(body, p.short_id, p.code),
    owner_recipient: owner, expires_at: p.expires_at, body,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Noor's decision (the hub calls this after commands.mjs accepted her SMS: enrolled number + one-time code).
const REASON_SW = {
  full: (f) => `imejaa${Number.isInteger(f.seats_left) ? ` (nafasi ${f.seats_left} zimebaki)` : ""}`,
  day_closed: () => "imefungwa",
  closed_day: () => "si siku ya ziara",
  hours: () => "saa haziendani",
  too_late: () => "ziara imeshaanza au imepita",
};

function loadProposal(store, proposalRow) {
  const shortId = String(proposalRow?.short_id ?? "");
  const row = store.db.prepare("SELECT short_id, kind, digest, state, body FROM proposals WHERE short_id = ?").get(shortId);
  if (!row || row.kind !== PROPOSAL_KIND) return { error: "not_a_booking_request" };
  let body;
  try { body = JSON.parse(row.body); } catch { return { error: "digest_mismatch" }; }
  if (proposalDigest(row.kind, body) !== row.digest) return { error: "digest_mismatch" };
  if (proposalRow.digest !== undefined && proposalRow.digest !== row.digest) return { error: "digest_mismatch" };
  return { row, body };
}

/**
 * Apply Noor's decision on a booking_request proposal. Pure function of the store: it writes the booking (approve)
 * and an outcome record; it sends nothing (the caller enqueues `tourist_sms` to `tourist_recipient`, and
 * `owner_sms` to Noor when present).
 *
 * Proposal state expected (re-read from the store, never trusted from the argument):
 *   approve -> "approved" (redeemCode spent the code), reject -> "rejected" (HAPANA), suggest -> "proposed".
 * CHOICE: a suggestion does NOT close the proposal: it stays pending until NDIYO or HAPANA (or the code expires),
 * the same code still answers it, and the tourist is told the request is still open.
 *
 * @param {{ type: "approve" } | { type: "reject" } | { type: "suggest", text: string }} decision
 * @param {Date} [now]
 * @param {{ translator?: (text: string, opts: { from: "sw", to: string }) => string|null }} [opts]
 *   translator: optional, synchronous, local (e.g. Opus-MT already loaded). Without it Noor's words are relayed in
 *   Swahili only. Its output is labelled "machine translation, may contain errors"; a throw or a non-string is ignored.
 * @returns {{ ok: true, decision, proposal_id, tourist_sms, tourist_recipient, booking: object|null,
 *             owner_sms: string|null, already?: true, outcome?: string }
 *         | { ok: false, reason: string }}
 */
export function decideBookingRequest(store, sheet, proposalRow, decision, now = new Date(), opts = {}) {
  const loaded = loadProposal(store, proposalRow);
  if (loaded.error) return { ok: false, reason: loaded.error };
  const { row, body } = loaded;
  const id = row.short_id;
  const lang = replyLang(body.lang);
  // A request taken on a voice call has no SMS address (tourist_ref null): nothing is sent to the guest, Noor's
  // reply tells her to call back (commands.mjs REPLIES.*_call_back).
  const callBack = !body.tourist_ref;
  const out = (extra) => ({
    ok: true, decision: decision?.type, proposal_id: id, tourist_recipient: body.tourist_ref ?? null, booking: null, owner_sms: null,
    ...extra, ...(callBack ? { tourist_sms: null, call_back: true } : {}),
  });

  switch (decision?.type) {
    case "approve": {
      if (row.state !== "approved") return { ok: false, reason: "not_approved" };
      return store.transaction(() => {
        const booking_id = `direct:${id}`;
        const existing = store.db.prepare("SELECT body FROM bookings WHERE platform = 'direct' AND external_ref = ?").get(id);
        if (existing) {
          const b = JSON.parse(existing.body);
          return out({ already: true, outcome: "confirmed", booking: b, tourist_sms: confirmedSms(b, lang) });
        }
        const prior = store.getKV(OUTCOME_KV + id);
        if (prior?.outcome === "unavailable") return out({ already: true, outcome: "unavailable", tourist_sms: prior.tourist_sms, owner_sms: prior.owner_sms });

        // Re-check by code: the day may have filled up or been closed since the proposal.
        const avail = checkAvailability(store, sheet, { date: body.date, party_size: body.party_size, request_id: booking_id, now });
        if (!avail.ok) {
          const reason = ["full", "day_closed", "closed_day", "hours", "too_late"].includes(avail.reason) ? avail.reason : "day_closed";
          const facts = reason === avail.reason ? avail.facts : { date: body.date };
          const tourist_sms = renderTouristReply("unavailable", lang, { reason, ...facts });
          const told = callBack ? "Mgeni hana SMS: mpigie simu." : "Mgeni ameambiwa.";
          const owner_sms = `SAUTI: ${id} haikuthibitishwa: ${swDateShort(body.date)} ${REASON_SW[reason](facts)}. ${told}`;
          store.setKV(OUTCOME_KV + id, { outcome: "unavailable", reason, tourist_sms, owner_sms, at: now.toISOString() });
          return out({ outcome: "unavailable", reason, tourist_sms, owner_sms });
        }
        // Noor approved this exact total (digest-bound); it is honoured even if the sheet price changed since.
        const b = {
          booking_id, platform: "direct", external_ref: id, channel: body.channel,
          request: {
            request_id: id, visitor_name: body.visitor_first_name || "",
            // The tourist's number stays in the proposal; the booking points to it.
            contact: { channel: body.channel, address: `proposal:${id}`, language: lang },
            date: body.date, party_size: body.party_size, source_id: body.source_event_id, time: body.time,
          },
          slot_id: body.date, slot_start: avail.start, slot_end: avail.end,
          price: { amount_minor: body.price_kes_total * 100, currency: "KES", exponent: 2 },
          fact_revision: null, arrival: null, state: "confirmed", approved_via: "sms_one_time_code",
          confirmed_at: now.toISOString(), synthetic: false,
        };
        store.db
          .prepare("INSERT INTO bookings (booking_id, platform, external_ref, date, party_size, state, body) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(booking_id, "direct", id, body.date, body.party_size, "confirmed", JSON.stringify(b));
        store.setKV(OUTCOME_KV + id, { outcome: "confirmed", at: now.toISOString() });
        return out({ outcome: "confirmed", booking: b, tourist_sms: confirmedSms(b, lang) });
      });
    }
    case "reject": {
      if (row.state !== "rejected") return { ok: false, reason: "not_rejected" };
      const tourist_sms = renderTouristReply("declined", lang, { date: body.date });
      const prior = store.getKV(OUTCOME_KV + id);
      if (prior) return out({ already: true, outcome: "declined", tourist_sms });
      store.setKV(OUTCOME_KV + id, { outcome: "declined", at: now.toISOString() });
      return out({ outcome: "declined", tourist_sms });
    }
    case "suggest": {
      if (row.state !== "proposed") return { ok: false, reason: "not_pending" };
      if (callBack) return { ok: false, reason: "no_reply_address" };
      const text = sanitizeSuggestion(decision.text);
      if (!text) return { ok: false, reason: "empty_suggestion" };
      let translation = null;
      if (typeof opts.translator === "function" && lang !== "sw") {
        try {
          const t = opts.translator(text, { from: "sw", to: lang });
          translation = typeof t === "string" ? t : null;
        } catch {
          translation = null;
        }
      }
      return out({
        outcome: "relayed",
        tourist_sms: renderTouristReply("relay", lang, { owner_text: text, translation, date: body.date }),
        machine_translated: Boolean(translation && sanitizeSuggestion(translation)),
      });
    }
    default:
      return { ok: false, reason: "unknown_decision" };
  }
}

function confirmedSms(b, lang) {
  return renderTouristReply("confirmed", lang, {
    date: b.request.date, party_size: b.request.party_size, start: b.slot_start, total_kes: b.price.amount_minor / 100,
  });
}
