// Owner alerts: one Swahili SMS + one voice call (an ordered list of prerecorded clip keys) per hub event.
//
// SWAHILI REVIEW STATUS: UNREVIEWED. Every Swahili string in this file (SMS templates, weekday names,
// number words, the proposed texts in MISSING_CLIPS) was drafted without a native-speaker review.
// Do not ship as validated.
//
// Rules this module keeps:
// - An alert INFORMS Noor. It never approves, sends, books or publishes anything on anyone's behalf, and it
//   never carries an approval code (codes are only in the read-back SMS sent by commands.mjs).
// - Every fact in an alert comes from structured fields (platform enum, ISO date, party size, capacity counts,
//   received_at, proposal short id, a sanitised visitor first name). Numbers and dates are rendered by code
//   here; free text (visitor message bodies, voicemail transcripts, model output, translations) never enters.
// - Spoken numbers are checked against the core Swahili parser (findNumbers) before they are spoken; if the
//   round trip disagrees, the number is NOT spoken and the call points to the SMS instead.
// - SMS is GSM-7 only (no emoji, no accents) and kept to one 160-char segment when possible.
import { readFileSync } from "node:fs";
import { findNumbers } from "./core.mjs";

// ---------------------------------------------------------------------------------------------------------
// Clip catalogue (packages/experience/audio/manifest.json is read, never written).
const MANIFEST_URL = new URL("../../../packages/experience/audio/manifest.json", import.meta.url);
const manifest = JSON.parse(readFileSync(MANIFEST_URL, "utf8"));
export const MANIFEST_KEYS = new Set([...(manifest.copy_clips ?? []), ...(manifest.word_clips ?? [])].map((c) => c.key));

/**
 * Clips this module speaks that are not (yet) in the experience manifest, with the proposed Swahili text
 * (UNREVIEWED). Computed against the manifest at load time: an entry disappears once the experience
 * package adds the key. Calls still list these keys in order; the call assembler must skip a missing clip
 * (and the SMS carries every fact anyway). No audio is invented here.
 */
const NEEDED_CLIPS = [
  ["alert.urgent", "Haraka!", "conflict call opener"],
  ["alert.overbooked", "Wageni wamezidi nafasi.", "conflict call"],
  ["alert.visitor_message", "Mgeni ameandika ujumbe unaosubiri jibu lako.", "visitor_message call"],
  ["alert.voicemail", "Mgeni ameacha ujumbe wa sauti.", "voicemail call"],
  ["alert.missed_call", "Mgeni alipiga simu lakini hakuacha ujumbe.", "missed_call call"],
  ["alert.see_sms", "Maelezo yako kwenye SMS.", "every call closer"],
  ["platform.gyg", "GetYourGuide", "booking source"],
  ["platform.airbnb", "Airbnb", "booking source"],
  ["platform.booking", "Booking.com", "booking source"],
  ["platform.phone", "kwa simu", "booking source"],
  ["platform.sms", "kwa SMS", "booking source"],
  ["word.tarehe", "tarehe", "date: 'tarehe kumi na mbili'"],
  ["word.mtu", "mtu", "one person: 'mtu mmoja'"],
  ["word.watu", "watu", "people count"],
  ["word.nafasi", "nafasi", "capacity count"],
  ["word.mmoja", "mmoja", "people agreement 1"],
  ["word.wawili", "wawili", "people agreement 2"],
  ["word.watatu", "watatu", "people agreement 3"],
  ["word.wanne", "wanne", "people agreement 4"],
  ["word.watano", "watano", "people agreement 5"],
  ["word.wanane", "wanane", "people agreement 8"],
  ["word.jumatatu", "Jumatatu", "weekday"],
  ["word.jumanne", "Jumanne", "weekday"],
  ["word.jumatano", "Jumatano", "weekday"],
  ["word.alhamisi", "Alhamisi", "weekday"],
  ["word.ijumaa", "Ijumaa", "weekday"],
  ["word.jumamosi", "Jumamosi", "weekday"],
  ["word.jumapili", "Jumapili", "weekday"],
];
export const MISSING_CLIPS = Object.freeze(
  NEEDED_CLIPS.filter(([key]) => !MANIFEST_KEYS.has(key))
    .map(([key, text, used_for]) => Object.freeze({ key, text, used_for, review_status: "UNREVIEWED" })),
);
const MISSING_SET = new Set(MISSING_CLIPS.map((c) => c.key));

// ---------------------------------------------------------------------------------------------------------
// Dates and numbers rendered by code (UNREVIEWED Swahili).
const WEEKDAYS = ["Jumapili", "Jumatatu", "Jumanne", "Jumatano", "Alhamisi", "Ijumaa", "Jumamosi"]; // getUTCDay order
const UNIT_WORDS = ["", "moja", "mbili", "tatu", "nne", "tano", "sita", "saba", "nane", "tisa"];
const TEN_WORDS = ["", "kumi", "ishirini", "thelathini", "arobaini", "hamsini", "sitini", "sabini", "themanini", "tisini"];
// Noun-class 1/2 agreement for people: only 1-5 and 8 change ("watu wanne", but "watu sita").
const PEOPLE_FORM = { moja: "mmoja", mbili: "wawili", tatu: "watatu", nne: "wanne", tano: "watano", nane: "wanane" };
/** Hub-local time zone: East Africa Time, UTC+3, no daylight saving. */
export const EAT_OFFSET_MS = 3 * 3600_000;

/** Strict ISO calendar date -> { y, m, d, weekday } or null (rejects 2026-02-30). */
export function parseIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ""));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { y, m: mo, d, weekday: t.getUTCDay() };
}

/** "2026-10-10" -> "Jumamosi 10/10" (day/month, no year). */
export function swDateShort(iso) {
  const p = parseIsoDate(iso);
  if (!p) throw new Error("invalid date");
  return `${WEEKDAYS[p.weekday]} ${p.d}/${p.m}`;
}

export function swWeekday(iso) {
  const p = parseIsoDate(iso);
  if (!p) throw new Error("invalid date");
  return WEEKDAYS[p.weekday];
}

/** Integer 0 < n < 1 000 000 -> Swahili number words (base numerals). */
export function swNumberWords(n) {
  if (!Number.isInteger(n) || n <= 0 || n >= 1_000_000) throw new Error("number out of range");
  if (n < 10) return [UNIT_WORDS[n]];
  if (n < 100) return n % 10 ? [TEN_WORDS[Math.floor(n / 10)], "na", UNIT_WORDS[n % 10]] : [TEN_WORDS[n / 10]];
  const tail = (r) => (r ? ["na", ...swNumberWords(r)] : []);
  if (n < 1000) return ["mia", UNIT_WORDS[Math.floor(n / 100)], ...tail(n % 100)];
  if (n < 100_000) return ["elfu", ...swNumberWords(Math.floor(n / 1000)), ...tail(n % 1000)];
  return ["laki", ...swNumberWords(Math.floor(n / 100_000)), ...tail(n % 100_000)];
}

/** Words for a count of people: 4 -> ["wanne"], 12 -> ["kumi","na","wawili"], 6 -> ["sita"]. */
export function swPeopleWords(n) {
  const w = swNumberWords(n);
  const last = w[w.length - 1];
  if (PEOPLE_FORM[last]) w[w.length - 1] = PEOPLE_FORM[last];
  return w;
}

/** Number clips, only if the core parser reads the words back as exactly n; otherwise null (do not speak it). */
function numberClips(n, people = false, parse = findNumbers) {
  let words;
  try { words = people ? swPeopleWords(n) : swNumberWords(n); } catch { return null; }
  const back = parse(words.join(" "));
  if (back.length !== 1 || back[0] !== n) return null;
  return words.map((w) => `word.${w}`);
}

// ---------------------------------------------------------------------------------------------------------
// Structured-field sanitising.
const PLATFORMS = {
  gyg: { sms: "GYG", clip: "platform.gyg" },
  getyourguide: { sms: "GYG", clip: "platform.gyg" },
  airbnb: { sms: "Airbnb", clip: "platform.airbnb" },
  booking: { sms: "Booking.com", clip: "platform.booking" },
  "booking.com": { sms: "Booking.com", clip: "platform.booking" },
  booking_com: { sms: "Booking.com", clip: "platform.booking" },
  phone: { sms: "simu", clip: "platform.phone" },
  voice: { sms: "simu", clip: "platform.phone" },
  sms: { sms: "SMS", clip: "platform.sms" },
  whatsapp: { sms: "WhatsApp", clip: "platform.sms" },
};
/** Unknown platform strings are never echoed. */
function platformOf(p) {
  return PLATFORMS[String(p ?? "").trim().toLowerCase()] ?? { sms: "tovuti", clip: null };
}

/** Visitor first name: first word, accents stripped, ASCII letters only, max 12 chars; null if nothing usable. */
export function firstName(raw) {
  const plain = String(raw ?? "").normalize("NFD").replace(/\p{M}/gu, "");
  const word = plain.trim().split(/[\s\-_.,;:]+/)[0] ?? "";
  const letters = word.replace(/[^A-Za-z]/g, "").slice(0, 12);
  if (letters.length < 2) return null;
  return letters[0].toUpperCase() + letters.slice(1).toLowerCase();
}

function posInt(n, max = 10_000) {
  return Number.isInteger(n) && n > 0 && n <= max ? n : null;
}

const SHORT_ID = /^[A-Z]{1,3}$/;
function proposalId(id) {
  const s = String(id ?? "").toUpperCase();
  return SHORT_ID.test(s) ? s : null;
}

/** "2026-10-04T11:05:00Z" -> "14:05" in EAT; null if unparsable. */
function eatClock(iso) {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + EAT_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------------------------
// GSM-7.
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "^{}\\[~]|€\f";
const GSM7_SET = new Set(GSM7_BASIC);
const GSM7_EXT_SET = new Set(GSM7_EXT);
export function isGsm7(s) {
  for (const ch of s) if (!GSM7_SET.has(ch) && !GSM7_EXT_SET.has(ch)) return false;
  return true;
}
/** GSM-7 septet count (extension chars cost 2). */
export function gsm7Length(s) {
  let n = 0;
  for (const ch of s) n += GSM7_EXT_SET.has(ch) ? 2 : 1;
  return n;
}
export const SMS_SINGLE_SEGMENT = 160;

/** Join parts; drop optional parts (from the end of `optional`) until the SMS fits one segment, if it can. */
function fit(required, optional) {
  const opt = [...optional];
  const build = () => [...required.filter(Boolean), ...opt.filter(Boolean)].join(" ");
  let sms = build();
  while (gsm7Length(sms) > SMS_SINGLE_SEGMENT && opt.length) {
    opt.pop();
    sms = build();
  }
  if (!isGsm7(sms)) throw new Error("alert SMS is not GSM-7");
  return sms;
}

// ---------------------------------------------------------------------------------------------------------
// The alert.
/**
 * @param {object} event HubEvent: { id, kind: "booking"|"booking_conflict"|"visitor_message"|"voicemail"|"missed_call",
 *                         channel, received_at, booking?: { platform, date, party_size, visitor_name } }
 * @param {object} [facts] structured facts computed by code: { conflict?: { booked, capacity },
 *                         capacity?: { booked, capacity }, proposal_id?: "C" }
 *                         A "booking" with facts.conflict is treated as a conflict (urgent).
 * @returns {{ sms: string, call: string[], urgent: boolean, missing_clips: string[] }}
 */
/**
 * @param {{ parseNumbers?: (text: string) => number[] }} [opts] the parser spoken numbers are checked against
 *   (default: the core's findNumbers; injectable so the "do not speak it" guard stays tested whatever the core reads).
 */
export function alertOwner(event, facts = {}, { parseNumbers = findNumbers } = {}) {
  if (!event || typeof event !== "object") throw new Error("event required");
  const kind = event.kind === "booking" && facts.conflict ? "booking_conflict" : event.kind;
  const b = event.booking ?? {};
  const date = parseIsoDate(b.date) ? b.date : null;
  const party = posInt(b.party_size, 1000);
  const name = firstName(b.visitor_name);
  const plat = platformOf(b.platform ?? event.channel);
  const pid = proposalId(facts.proposal_id);
  const at = eatClock(event.received_at);

  const dateSms = date ? swDateShort(date) : null;
  const partySms = party ? (party === 1 ? "mtu 1" : `watu ${party}`) : null;
  const dateClips = () => {
    if (!date) return [];
    const p = parseIsoDate(date);
    const day = numberClips(p.d, false, parseNumbers);
    return [`word.${WEEKDAYS[p.weekday].toLowerCase()}`, ...(day ? ["word.tarehe", ...day] : [])];
  };
  const partyClips = () => {
    if (!party) return [];
    const words = numberClips(party, true, parseNumbers);
    if (!words) return [];
    return party === 1 ? ["word.mtu", ...words] : ["word.watu", ...words];
  };

  let sms;
  let call;
  let urgent = false;
  switch (kind) {
    case "booking": {
      const cap = facts.capacity && posInt(facts.capacity.capacity) && Number.isInteger(facts.capacity.booked)
        ? `Nafasi ${facts.capacity.booked} kati ya ${facts.capacity.capacity} zimechukuliwa.` : null; // copy: visits.capacity_line
      sms = fit(
        [`SAUTI: Ziara iliyohifadhiwa (${plat.sms}): ${[dateSms, partySms].filter(Boolean).join(", ")}${name ? `, ${name}` : ""}.`],
        ["Imethibitishwa na tovuti.", cap],
      );
      call = ["visits.booked", ...(plat.clip ? [plat.clip] : []), ...dateClips(), ...partyClips(), "alert.see_sms"];
      break;
    }
    case "booking_conflict": {
      urgent = true;
      const c = facts.conflict ?? {};
      const booked = Number.isInteger(c.booked) && c.booked >= 0 ? c.booked : null;
      const capacity = posInt(c.capacity);
      const over = booked !== null && capacity ? `watu ${booked}, nafasi ${capacity}` : null;
      sms = fit(
        [`SAUTI HARAKA: ${dateSms ?? "Siku"} imezidi${over ? `: ${over}` : ""}.`,
          `Mpya (${plat.sms}): ${[partySms, name].filter(Boolean).join(", ") || "-"}.`],
        [pid ? `Pendekezo ${pid} litakuja kwa SMS.` : "Mpigie mgeni au ofisi."],
      );
      const capClips = capacity ? numberClips(capacity) : null;
      const bookedClips = booked ? numberClips(booked, true) : null;
      call = ["alert.urgent", "alert.overbooked", ...dateClips(),
        ...(bookedClips ? ["word.watu", ...bookedClips] : []), ...(capClips ? ["word.nafasi", ...capClips] : []),
        "alert.see_sms"];
      break;
    }
    case "visitor_message": {
      const req = date || party ? `Ombi: ${[dateSms, partySms].filter(Boolean).join(", ")}.` : null;
      sms = fit(
        [`SAUTI: Ujumbe wa mgeni${name ? ` ${name}` : ""} (${plat.sms}) unasubiri jibu lako.`],
        [req, pid ? `Jibu lililoandaliwa: ${pid}, utapata SMS ya kuthibitisha.` : "Angalia Sauti."],
      );
      call = ["alert.visitor_message", ...(date || party ? ["visits.request", ...dateClips(), ...partyClips()] : []), "alert.see_sms"];
      break;
    }
    case "voicemail": {
      const req = date || party ? `Ombi: ${[dateSms, partySms].filter(Boolean).join(", ")}.` : null;
      sms = fit([`SAUTI: Ujumbe wa sauti wa mgeni${at ? ` saa ${at}` : ""}.`], [req, "Sikiliza kwenye Sauti."]);
      call = ["alert.voicemail", ...(date || party ? ["visits.request", ...dateClips(), ...partyClips()] : []), "alert.see_sms"];
      break;
    }
    case "missed_call": {
      sms = fit([`SAUTI: Mgeni alipiga simu${at ? ` saa ${at}` : ""} bila kuacha ujumbe.`], []);
      call = ["alert.missed_call"];
      break;
    }
    default:
      throw new Error(`unsupported alert kind: ${String(event.kind).slice(0, 32)}`);
  }
  for (const k of call) if (!MANIFEST_KEYS.has(k) && !MISSING_SET.has(k)) throw new Error(`unknown clip ${k}`);
  return { sms, call, urgent, missing_clips: call.filter((k) => MISSING_SET.has(k)) };
}

/**
 * Persist the alert once per event (alerts.event_id is UNIQUE) and queue the SMS and the call to Noor's
 * enrolled number through the outbox. Returns null when the event was already alerted or no owner is enrolled.
 * Nothing here acts on anyone's behalf: the only outbound items go to Noor.
 */
export function queueOwnerAlert(store, outbox, event, facts = {}, { now = new Date() } = {}) {
  const owner = store.getKV("owner.phone");
  if (!owner) return null;
  const alert = alertOwner(event, facts);
  const fresh = store.db.prepare(
    "INSERT OR IGNORE INTO alerts (id, event_id, sms, call, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(`alert-${event.id}`, event.id, alert.sms, JSON.stringify(alert.call), now.toISOString()).changes === 1;
  if (!fresh) return null;
  const sms = outbox.enqueue({ channel: "sms", recipient: owner, body: alert.sms, cause_id: event.id });
  const call = outbox.enqueue({ channel: "call", recipient: owner, body: JSON.stringify(alert.call), cause_id: event.id });
  return { ...alert, keys: [sms.key, call.key] };
}
