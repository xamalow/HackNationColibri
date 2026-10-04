// Booking notifications from GetYourGuide, Airbnb (Experiences) and Booking.com -> HubEvent kind "booking".
//
// WE HAVE NOT SEEN REAL NOTIFICATION E-MAILS. The formats below are SYNTHETIC: they carry the fields such
// e-mails contain (booking reference, activity, date, time, participants, lead traveler) as "Label: value"
// lines in a plain-text body. When a real sample is available, add its labels / date style to PLATFORMS and
// a fixture; the parser stays deterministic (regex, no model) and the rules below do not change.
//
//   GetYourGuide  (from *@getyourguide.com)          Airbnb Experiences (from *@airbnb.com)
//     Reference number: GYGK7Q2M4XZ                    Confirmation code: HMXQ4T7B2K
//     Tour: Coffee farm walk with Noor                 Experience: Coffee farm walk with Noor
//     Date: 14 October 2026                            Date: Wednesday, October 14, 2026
//     Time: 09:00                                      Time: 9:00 AM - 12:00 PM
//     Number of participants: 2 x Adults, 1 x Child    Guests: 2
//     Lead traveler: Anna Schmidt                      Guest: Liam O'Brien
//
//   Booking.com Attractions (from *@booking.com)
//     Booking number: 4512.338.902
//     Product: Coffee farm walk with Noor
//     Visit date: 2026-10-14        Start time: 09:00
//     Travellers: 4                 Booker name: Wanjiru Kamau
//
// Rules: a date is accepted only in an unambiguous form (2026-10-14, 14 October 2026, October 14, 2026, with
// an optional weekday that must match); 10/14/2026 is refused. Party size is an integer or a sum of
// "N x Category" / "N adults, M children" parts. ANY required field missing or unreadable -> the e-mail is a
// visitor_message with reason "booking_fields_missing" and the list of missing fields: Noor reads it, the hub
// never guesses a date or a party size. Cancellations and changes are never parsed as new bookings.
//
// The sender check is by domain only; the real mail fetcher MUST verify DKIM/SPF before handing items here.
//
// GYG supplier API: real access needs GetYourGuide supplier approval (we have none), so gygApiSource() reads
// simulated JSON shaped after the public supplier API "book" call ({ data: { gygBookingReference, dateTime,
// bookingItems[{category,count}], travelers[{firstName,lastName}] } }). Verify field names against the
// official spec once approved.
import { simulatedInbound } from "../transports/simulated.mjs";
import { safeToken, sanitizeText, receivedAt, shortHash } from "./sms.mjs";

export const FARM_TZ_OFFSET_MIN = 180; // Africa/Nairobi is UTC+03:00 all year (no DST)
const MAX_BODY = 20000;

/** Per-platform synthetic format: sender domain, label aliases (case-insensitive), reference shape. */
export const PLATFORMS = {
  getyourguide: {
    channel: "email_gyg",
    domain: "getyourguide.com",
    labels: {
      ref: ["Reference number", "Booking reference"],
      activity: ["Tour", "Activity"],
      date: ["Date"],
      time: ["Time", "Start time"],
      party_size: ["Number of participants", "Participants"],
      visitor_name: ["Lead traveler", "Lead traveller", "Main customer"],
    },
    ref: /^GYG[A-Z0-9]{6,12}$/,
  },
  airbnb: {
    channel: "email_airbnb",
    domain: "airbnb.com",
    labels: {
      ref: ["Confirmation code"],
      activity: ["Experience"],
      date: ["Date"],
      time: ["Time"],
      party_size: ["Guests", "Number of guests"],
      visitor_name: ["Guest", "Booked by"],
    },
    ref: /^[A-Z0-9]{8,12}$/,
  },
  booking_com: {
    channel: "email_booking",
    domain: "booking.com",
    labels: {
      ref: ["Booking number", "Reservation number"],
      activity: ["Product", "Attraction"],
      date: ["Visit date", "Date"],
      time: ["Start time", "Time"],
      party_size: ["Travellers", "Travelers", "Number of travellers"],
      visitor_name: ["Booker name", "Lead traveller", "Name"],
    },
    ref: /^(?:\d{3,4}\.\d{3}\.\d{3}|\d{8,12})$/,
  },
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function monthIndex(word) {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return -1;
  return MONTHS.findIndex((m) => m === w || (w.length === 3 && m.startsWith(w)) || (w === "sept" && m === "september"));
}

function weekdayIndex(word) {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return -1;
  return WEEKDAYS.findIndex((d) => d === w || d.startsWith(w));
}

function isoDate(y, m, d) {
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Unambiguous date -> YYYY-MM-DD, or null. Accepts 2026-10-14, "14 October 2026", "October 14, 2026", each with an
 * optional leading weekday that must agree with the date. Numeric d/m/y forms are refused (10/12 is ambiguous).
 */
export function parseDate(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim().replace(/\s+/g, " ");
  let weekday = -1;
  const wm = /^([A-Za-z]+)\.?,?\s+(.*)$/.exec(s);
  if (wm && weekdayIndex(wm[1]) >= 0 && monthIndex(wm[1]) < 0) {
    weekday = weekdayIndex(wm[1]);
    s = wm[2];
  }
  let date = null;
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) date = isoDate(+m[1], +m[2], +m[3]);
  else if ((m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+\.?),?\s+(\d{4})$/.exec(s))) {
    const mo = monthIndex(m[2]);
    date = mo >= 0 ? isoDate(+m[3], mo + 1, +m[1]) : null;
  } else if ((m = /^([A-Za-z]+\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s))) {
    const mo = monthIndex(m[1]);
    date = mo >= 0 ? isoDate(+m[3], mo + 1, +m[2]) : null;
  }
  if (!date) return null;
  if (weekday >= 0 && new Date(`${date}T00:00:00Z`).getUTCDay() !== weekday) return null; // contradicting weekday: never pick one
  return date;
}

/** Clock time -> HH:MM (24 h), or null. "09:00", "9:00 AM", "9 am", and the start of a range "9:00 AM - 12:00 PM". */
export function parseTime(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().split(/\s*(?:-|–|—|to)\s+/i)[0].trim();
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const ap = m[3]?.toLowerCase().replace(/\./g, "");
  if (m[2] === undefined && !ap) return null; // a bare "9" is not a time
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "am" && h === 12) h = 0;
    if (ap === "pm" && h !== 12) h += 12;
  } else if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Party size -> integer 1..200, or null. "4", "4 guests", "2 x Adults, 1 x Child", "2 adults and 1 child". */
export function parsePartySize(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/\s+/g, " ");
  let n = null;
  let m;
  if ((m = /^(\d{1,3})(?: (?:guests?|people|persons?|participants?|travell?ers?|pax))?$/i.exec(s))) n = Number(m[1]);
  else {
    const parts = s.split(/\s*(?:,|;|\band\b|\+)\s*/i).filter(Boolean);
    let sum = 0;
    for (const p of parts) {
      const pm = /^(\d{1,3})\s*(?:x\s*)?[A-Za-z][A-Za-z ()0-9-]*$/i.exec(p);
      if (!pm) return null;
      sum += Number(pm[1]);
    }
    n = parts.length > 0 ? sum : null;
  }
  return n !== null && Number.isInteger(n) && n >= 1 && n <= 200 ? n : null;
}

function cleanName(raw) {
  if (typeof raw !== "string") return null;
  const s = sanitizeText(raw, 100).text.replace(/\s+/g, " ").trim();
  return /\p{L}/u.test(s) ? s : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** First "Label: value" line for any alias; undefined if no such line. */
function field(body, aliases) {
  for (const a of aliases) {
    const m = new RegExp(`^[ \\t]*${escapeRe(a)}[ \\t]*:[ \\t]*(.+?)[ \\t]*$`, "im").exec(body);
    if (m) return m[1];
  }
  return undefined;
}

function senderDomain(from) {
  if (typeof from !== "string") return null;
  const m = /<([^<>\s]+)>\s*$/.exec(from) ?? /^\s*([^<>\s]+)\s*$/.exec(from);
  const at = m ? m[1].lastIndexOf("@") : -1;
  return at > 0 ? m[1].slice(at + 1).toLowerCase() : null;
}

/** Which platform sent this e-mail (exact domain or a subdomain of it), or null. */
export function detectPlatform(from) {
  const d = senderDomain(from);
  if (!d) return null;
  for (const [platform, spec] of Object.entries(PLATFORMS)) if (d === spec.domain || d.endsWith(`.${spec.domain}`)) return platform;
  return null;
}

// Status wording only: policy text such as "Free cancellation up to 24 hours before" must not trip it.
const CANCEL_SUBJECT = /\bcancel/i;
const CANCEL_BODY = /\b(?:has been|was|is now|were|been) cancel+ed\b|\bcancel+ation (?:confirmed|notice|request)\b|^[ \t]*(?:booking|reservation) cancel+ed\b/im;
const CHANGE_SUBJECT = /\b(?:changed|modified|updated|amended|rebooked)\b/i;
const CHANGE_BODY = /\b(?:has been|was) (?:changed|modified|updated|amended|rebooked)\b|\b(?:booking|reservation) (?:change|modification|amendment)\b/i;

function flagged(base, reason, extra = {}) {
  return { ...base, kind: "visitor_message", reason, ...extra };
}

/**
 * One notification e-mail -> HubEvent. Inbound item:
 *   { synthetic, kind: "email", message_id?, from, subject?, received_at, body }
 * @returns {import("./sms.mjs").HubEvent}
 */
export function parsePlatformEmail(item, { now } = {}) {
  const body = sanitizeText(item?.body, MAX_BODY).text;
  const subject = sanitizeText(item?.subject, 300).text;
  const platform = detectPlatform(item?.from);
  const spec = platform ? PLATFORMS[platform] : null;
  const channel = spec ? spec.channel : "email";
  const mid = safeToken(typeof item?.message_id === "string" ? item.message_id.replace(/^<|>$/g, "") : null);
  const id = `${channel}:${mid ?? shortHash(item?.from, subject, body)}`;
  const preview = sanitizeText(`${subject}\n\n${body}`).text;
  const base = { id, channel, received_at: receivedAt(item?.received_at, now), synthetic: item?.synthetic === true };
  if (!spec) return flagged(base, "unknown_sender", { text: preview });
  if (CANCEL_SUBJECT.test(subject) || CANCEL_BODY.test(body)) return flagged(base, "platform_cancellation", { platform, text: preview });
  if (CHANGE_SUBJECT.test(subject) || CHANGE_BODY.test(body)) return flagged(base, "platform_change", { platform, text: preview });

  const L = spec.labels;
  const missing = [];
  const rawRef = field(body, L.ref)?.trim().toUpperCase();
  const ref = rawRef && spec.ref.test(rawRef) ? rawRef : null;
  if (!ref) missing.push("ref");
  const date = parseDate(field(body, L.date));
  if (!date) missing.push("date");
  const rawTime = field(body, L.time);
  const time = rawTime === undefined ? undefined : parseTime(rawTime);
  if (time === null) missing.push("time"); // a time line we cannot read is not silently dropped
  const party_size = parsePartySize(field(body, L.party_size));
  if (party_size === null) missing.push("party_size");
  const visitor_name = cleanName(field(body, L.visitor_name));
  if (!visitor_name) missing.push("visitor_name");
  if (missing.length > 0) return flagged(base, "booking_fields_missing", { platform, missing, text: preview });

  const activity = cleanName(field(body, L.activity));
  const booking = { platform, ref, date, party_size, visitor_name };
  if (time) booking.time = time;
  if (activity) booking.activity = activity;
  return { ...base, kind: "booking", booking };
}

/** "2026-10-14T09:00:00+03:00" (offset REQUIRED) -> farm-local { date, time }, or null. */
export function localDateTime(raw, offsetMin = FARM_TZ_OFFSET_MIN) {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(raw.trim());
  if (!m) return null; // no offset: we would have to guess the zone
  if (!isoDate(+m[1], +m[2], +m[3]) || +m[4] > 23 || +m[5] > 59) return null;
  const ms = Date.parse(raw.trim());
  if (Number.isNaN(ms)) return null;
  const local = new Date(ms + offsetMin * 60_000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

/**
 * One simulated GYG supplier-API booking -> the same HubEvent as the e-mail path (platform "getyourguide", so a
 * booking seen by mail AND API has the same (platform, ref) and is stored once). Item:
 *   { synthetic, kind: "gyg_api", received_at, data: { gygBookingReference, dateTime, bookingItems, travelers, productId? } }
 */
export function parseGygApiBooking(item, { now } = {}) {
  const d = item?.data && typeof item.data === "object" ? item.data : {};
  const rawRef = typeof d.gygBookingReference === "string" ? d.gygBookingReference.trim().toUpperCase() : "";
  const ref = PLATFORMS.getyourguide.ref.test(rawRef) ? rawRef : null;
  const id = `gyg_api:${ref ?? shortHash(JSON.stringify(d))}`;
  const base = { id, channel: "gyg_api", received_at: receivedAt(item?.received_at, now), synthetic: item?.synthetic === true };
  const missing = [];
  if (!ref) missing.push("ref");
  const when = localDateTime(d.dateTime);
  if (!when) missing.push("date");
  let party_size = null;
  if (Array.isArray(d.bookingItems) && d.bookingItems.length > 0 && d.bookingItems.every((b) => Number.isInteger(b?.count) && b.count >= 0)) {
    const n = d.bookingItems.reduce((s, b) => s + b.count, 0);
    if (n >= 1 && n <= 200) party_size = n;
  }
  if (party_size === null) missing.push("party_size");
  const t0 = Array.isArray(d.travelers) ? d.travelers[0] : null;
  const visitor_name = cleanName([t0?.firstName, t0?.lastName].filter((x) => typeof x === "string").join(" "));
  if (!visitor_name) missing.push("visitor_name");
  if (missing.length > 0) {
    return flagged(base, "booking_fields_missing", { platform: "getyourguide", missing, text: sanitizeText(JSON.stringify(d)).text });
  }
  return { ...base, kind: "booking", booking: { platform: "getyourguide", ref, date: when.date, time: when.time, party_size, visitor_name } };
}

/** Simulated GYG API source (fixtures folder). The real adapter would poll / receive the supplier API instead. */
export function gygApiSource(folder) {
  const inbound = simulatedInbound(folder);
  return { name: "gyg_api_simulated", fetchEvents: (opts) => inbound.fetch().map((it) => parseGygApiBooking(it, opts)) };
}

/** Simulated mailbox source: notification e-mails from a fixtures folder. */
export function platformMailSource(folder) {
  const inbound = simulatedInbound(folder);
  return { name: "platform_mail_simulated", fetchEvents: (opts) => inbound.fetch().map((it) => parsePlatformEmail(it, opts)) };
}
