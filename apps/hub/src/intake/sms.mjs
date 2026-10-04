// Inbound tourist SMS / WhatsApp -> HubEvent kind "visitor_message".
// The text is untrusted DATA: it is cleaned (control and bidi characters stripped, NFC, capped) and stored,
// never interpreted as an instruction. Nothing here books anything: a booking request in an SMS is a
// visitor_message that bookings.mjs answers with { action: "needs_owner" }.
//
// Inbound item (simulated transport, real Africa's Talking / WhatsApp adapters map to the same shape):
//   { synthetic: true, kind: "sms" | "whatsapp", message_id?: string, from: "+2547...", to?: string,
//     received_at: RFC 3339, text: string }
import { createHash } from "node:crypto";

export const MAX_TEXT_CHARS = 2000;

// C0 controls except \t and \n, DEL, C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// Bidi overrides, embeddings, isolates, marks (Trojan Source), plus invisible zero-width characters and BOM.
// ZWJ (U+200D) and ZWNJ (U+200C) are kept: emoji sequences and some scripts need them.
const INVISIBLE = /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * Clean untrusted text for storage and display. Returns the text and whether it was cut.
 * @param {unknown} raw
 * @param {number} [max]
 * @returns {{ text: string, truncated: boolean }}
 */
export function sanitizeText(raw, max = MAX_TEXT_CHARS) {
  let s = typeof raw === "string" ? raw : "";
  s = s.toWellFormed().replace(/\r\n?/g, "\n").normalize("NFC").replace(CONTROL, "").replace(INVISIBLE, "");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const chars = Array.from(s); // code points: never cut a surrogate pair in half
  if (chars.length <= max) return { text: s, truncated: false };
  return { text: chars.slice(0, max).join(""), truncated: true };
}

/** Short stable hash for ids. */
export function shortHash(...parts) {
  return createHash("sha256").update(parts.map((p) => String(p ?? "")).join("\u0000")).digest("hex").slice(0, 24);
}

/** A provider id becomes part of our id only if it is a plain token. */
export function safeToken(v) {
  return typeof v === "string" && /^[A-Za-z0-9._:@-]{1,128}$/.test(v) ? v : null;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Received time as given by the transport when it is a valid RFC 3339 timestamp, otherwise the hub's own clock. */
export function receivedAt(v, now = () => new Date()) {
  if (typeof v === "string" && RFC3339.test(v) && !Number.isNaN(Date.parse(v))) return v;
  return now().toISOString();
}

/**
 * Sender phone number in E.164 (WhatsApp "whatsapp:+254..." prefix removed). null when it is not a number:
 * the hub then cannot reply on that channel and says so (reason "no_reply_address").
 */
export function normalizePhone(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^whatsapp:/i, "").replace(/[\s()-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : null;
}

/**
 * @typedef {object} HubEvent
 * @property {string} id
 * @property {"visitor_message"|"booking"|"voicemail"|"missed_call"} kind
 * @property {string} channel
 * @property {string} received_at
 * @property {string} [text]
 * @property {string} [lang]
 * @property {string|null} [from]
 * @property {{platform: string, ref: string, date: string, time?: string, party_size: number, visitor_name: string}} [booking]
 * @property {string} [reason]
 * @property {boolean} synthetic
 */

/**
 * One inbound SMS / WhatsApp item -> HubEvent. The id is derived from the provider message id when there is
 * one, otherwise from (channel, sender, received_at, text), so a redelivered message gets the same id.
 * @returns {HubEvent}
 */
export function smsToEvent(item, { now } = {}) {
  const channel = item?.kind === "whatsapp" ? "whatsapp" : "sms";
  const { text, truncated } = sanitizeText(item?.text);
  const from = normalizePhone(item?.from);
  const at = receivedAt(item?.received_at, now);
  const mid = safeToken(item?.message_id);
  const id = mid ? `${channel}:${mid}` : `${channel}:${shortHash(channel, item?.from, item?.received_at, item?.text)}`;
  /** @type {HubEvent} */
  const ev = { id, kind: "visitor_message", channel, received_at: at, from, text, synthetic: item?.synthetic === true };
  if (truncated) ev.truncated = true;
  if (!from) ev.reason = "no_reply_address";
  if (text.length === 0) ev.reason = "empty_message";
  return ev;
}

/** A batch of inbound items -> unique events (same id twice in a batch is kept once; the store dedupes across batches). */
export function smsBatchToEvents(items, opts = {}) {
  const seen = new Set();
  const out = [];
  for (const it of items ?? []) {
    const ev = smsToEvent(it, opts);
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    out.push(ev);
  }
  return out;
}
