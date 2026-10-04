// Noor's message to one visitor, asked for on a voice call ("nitachelewa kidogo", "tell the 17/10 group to bring
// boots"): the voice agent files it through POST /v1/owner-proposals (voice_api.mjs) as a PROPOSAL of kind
// "visitor_note". Nothing goes to the visitor until Noor answers the read-back from her enrolled phone with
// "NDIYO <ID> <code>"; then hub.runApproved runs executeApprovedVisitorNote, which sends exactly ONE SMS.
//
// Rules:
// - The visitor's number is never taken from the request: it is resolved, at proposal time and again at execution
//   time, from the STORED booking_request proposal the note is about (its tourist_ref). The note proposal body holds
//   only { about_ref, note_kind, text }, so the digest binds exactly what Noor approved.
// - Only a request that is still pending, or that became a confirmed booking, can receive a note; a request taken on
//   a voice call has no SMS address and cannot.
// - Noor's words are relayed quoted and labelled as hers (tourist_replies "relay"), never rewritten.
//
// SWAHILI REVIEW STATUS: UNREVIEWED (read-back below).
import { createProposal, proposalDigest, sanitizeSuggestion } from "./commands.mjs";
import { normalizePhone } from "./intake/sms.mjs";
import { swDateShort } from "./notify.mjs";
import { renderTouristReply } from "./tourist_replies.mjs";

export const KIND = "visitor_note";
export const NOTE_KINDS = Object.freeze(["running_late", "message_to_visitor"]);
export const MAX_NOTE_CHARS = 300;
const REF_RE = /^[A-Z]{1,3}$/;

/** "a", "A", "direct:A" -> "A"; anything else -> null. */
export function noteRef(raw) {
  const s = String(raw ?? "").trim().toUpperCase().replace(/^DIRECT:/, "");
  return REF_RE.test(s) ? s : null;
}

/**
 * The visitor a note is about, from the stored booking_request proposal (never from the request).
 * @returns {{ ok: true, ref, recipient, lang, date } | { ok: false, reason: "unknown_ref"|"no_sms_contact"|"not_open" }}
 */
export function resolveNoteTarget(store, aboutRef) {
  const ref = noteRef(aboutRef);
  if (!ref) return { ok: false, reason: "unknown_ref" };
  const row = store.db.prepare("SELECT kind, state, body FROM proposals WHERE short_id = ?").get(ref);
  if (!row || row.kind !== "booking_request") return { ok: false, reason: "unknown_ref" };
  let body;
  try { body = JSON.parse(row.body); } catch { return { ok: false, reason: "unknown_ref" }; }
  const recipient = normalizePhone(body.tourist_ref);
  if (!recipient) return { ok: false, reason: "no_sms_contact" };
  const booked = store.db.prepare("SELECT 1 FROM bookings WHERE platform = 'direct' AND external_ref = ? AND state = 'confirmed'").get(ref);
  if (row.state !== "proposed" && !(row.state === "approved" && booked)) return { ok: false, reason: "not_open" };
  return { ok: true, ref, recipient, lang: body.lang, date: body.date };
}

/** Noor's read-back: the exact words that will be sent, to which request, and how to approve. */
export function visitorNoteReadback(target, text, shortId, code) {
  return `SAUTI: Mtumie mgeni wa ${target.ref} (${swDateShort(target.date)}) ujumbe huu: "${text}". Jibu NDIYO ${shortId} ${code} au HAPANA ${shortId}.`;
}

/**
 * Create the note proposal. The caller has validated the kind, checked the owner budget and lock, and sends
 * `readback` to Noor's enrolled number with { sensitive: true } (it carries the code).
 * @returns {{ ok: true, short_id, digest, code, expires_at, readback } | { ok: false, reason }}
 */
export function proposeVisitorNote(store, { about_ref, note_kind, text }, { now = new Date() } = {}) {
  if (!NOTE_KINDS.includes(note_kind)) return { ok: false, reason: "invalid_kind" };
  const clean = sanitizeSuggestion(text, MAX_NOTE_CHARS);
  if (!clean) return { ok: false, reason: "empty_text" };
  const target = resolveNoteTarget(store, about_ref);
  if (!target.ok) return target;
  const p = createProposal(store, KIND, { about_ref: target.ref, note_kind, text: clean }, { now });
  return { ok: true, ...p, readback: visitorNoteReadback(target, clean, p.short_id, p.code) };
}

/**
 * hub.runApproved -> here, for a stored proposal Noor approved with her one-time code. Re-reads the proposal (state
 * approved, digest recomputed from the stored body), re-resolves the visitor from the stored booking request, then
 * queues ONE SMS (outbox key: recipient + body + cause, so a re-run never sends twice).
 * @param {{ translator?: (text: string, o: { from: "sw", to: string }) => string|null }} [opts] optional local MT,
 *   labelled as machine translation in the SMS (same rule as Noor's suggestions).
 */
export function executeApprovedVisitorNote(store, outbox, proposalRow, { translator = null } = {}) {
  const row = store.db.prepare("SELECT short_id, kind, digest, state, body FROM proposals WHERE short_id = ?").get(String(proposalRow?.short_id ?? ""));
  if (!row || row.kind !== KIND || row.state !== "approved") return { ok: false, reason: "not_approved" };
  let body;
  try { body = JSON.parse(row.body); } catch { return { ok: false, reason: "digest_changed" }; }
  if (proposalDigest(KIND, body) !== row.digest || (proposalRow.digest !== undefined && proposalRow.digest !== row.digest)) {
    return { ok: false, reason: "digest_changed" };
  }
  const target = resolveNoteTarget(store, body.about_ref);
  if (!target.ok) return { ok: false, reason: target.reason };
  let translation = null;
  if (typeof translator === "function" && target.lang !== "sw") {
    try {
      const t = translator(body.text, { from: "sw", to: target.lang });
      translation = typeof t === "string" ? t : null;
    } catch {
      translation = null;
    }
  }
  const sms = renderTouristReply("relay", target.lang, { owner_text: body.text, translation });
  const q = outbox.enqueue({ channel: "sms", recipient: target.recipient, body: sms, cause_id: `visitor_note:${row.short_id}` });
  return { ok: true, key: q.key, about_ref: target.ref };
}
