/**
 * Bookings and arrivals (v1 scope accepted 2026-10-03 23:37Z).
 *
 * A visitor asks for a date and a party size. Code, not a model, checks the
 * farm sheet (open days, hours, capacity, price) and the seats already
 * confirmed on that slot, then proposes ONE exact book_slot action for Noor.
 * Her approval of that envelope confirms the booking and blocks the seats;
 * the confirmation message to the visitor is a separate send_message action
 * with its own approval. Arrival and no-show are owner records; nothing is
 * sent. Anything the sheet does not say (no price, no capacity, a closed day)
 * is a question for a person, never a guess.
 */

import type { ApprovalRecord } from "./approval.js";
import { reconcileSlot, type SlotRequest, validateAppointment } from "./calendar.js";
import type { Sha256 } from "./canon.js";
import { formatTimestamp } from "./clock.js";
import { type ActionEnvelope, type Recipient, sealEnvelope, verifyEnvelope } from "./envelope.js";
import type { FactRevision, FarmSheet, Weekday } from "./facts.js";
import type { Money } from "./money.js";
import { unexplainedNumbers } from "./proposals.js";

export interface BookingRequest {
  request_id: string;
  visitor_name: string;
  /** How to reach the visitor: the channel they wrote on. */
  contact: Recipient;
  /** Absolute local date, YYYY-MM-DD, in the farm's time zone. */
  date: string;
  /** Local start time HH:MM; defaults to the farm's opening time. */
  time?: string;
  party_size: number;
  /** Source message the request came from, when there is one (evidence for the preview). */
  source_id?: string;
}

export type BookingState = "tentative" | "confirmed" | "declined" | "cancelled";
export type ArrivalRecord = "arrived" | "no_show";

export interface Booking {
  booking_id: string;
  request: BookingRequest;
  slot_id: string;
  slot_start: string;
  slot_end: string;
  price: Money;
  fact_revision: number;
  state: BookingState;
  arrival: ArrivalRecord | null;
}

export type CapacityFailureReason = "missing_fact" | "closed_day" | "outside_hours" | "unsupported_time" | "bad_date" | "bad_party_size" | "no_capacity";

export type CapacityVerdict =
  | { ok: true; remaining_after: number; slot_id: string; slot_start: string; slot_end: string; price: Money }
  | { ok: false; reason: CapacityFailureReason; detail: string };

const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function weekdayOf(date: string): Weekday | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return WEEKDAYS[d.getUTCDay()] ?? null;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

/**
 * Code answers "can we take this party on this date?" from the farm sheet and the
 * confirmed seats. The farm sheet describes ONE tour per open day (capacity_per_tour,
 * hours start..end), so the canonical slot is the date and every confirmed party
 * that day shares the capacity. A requested time that is not the tour's start is a
 * clarification, not a second slot (codex review, 2026-10-03 23:59Z).
 */
export function checkCapacity(sheet: FarmSheet, confirmed: readonly Booking[], request: BookingRequest, timezone = "Africa/Nairobi"): CapacityVerdict {
  if (!Number.isInteger(request.party_size) || request.party_size < 1) return { ok: false, reason: "bad_party_size", detail: "party size must be a whole number of at least 1" };
  if (sheet.capacity_per_tour === null || sheet.price_per_person_kes === null) {
    return { ok: false, reason: "missing_fact", detail: "the farm sheet has no capacity or no price yet; ask Noor (farm setup)" };
  }
  if (sheet.days === null || sheet.hours === null) return { ok: false, reason: "missing_fact", detail: "the farm sheet has no days or hours yet; ask Noor (farm setup)" };
  const tourStart = sheet.hours.start.slice(0, 5);
  const tourEnd = sheet.hours.end.slice(0, 5);
  const appointment = validateAppointment({ date: request.date, time: request.time ?? tourStart, timezone });
  if (!appointment.ok) return { ok: false, reason: "bad_date", detail: appointment.detail };
  const weekday = weekdayOf(request.date);
  if (!weekday || !sheet.days.includes(weekday)) return { ok: false, reason: "closed_day", detail: `the farm does not take visitors on ${weekday ?? request.date}` };
  const start = appointment.time;
  if (minutes(start) < minutes(tourStart) || minutes(start) >= minutes(tourEnd)) {
    return { ok: false, reason: "outside_hours", detail: `tours run ${tourStart} to ${tourEnd}` };
  }
  if (start !== tourStart) {
    return { ok: false, reason: "unsupported_time", detail: `the tour on ${request.date} starts at ${tourStart}; ask the visitor whether ${tourStart} works` };
  }
  const slot_id = request.date;
  const taken = confirmed.filter((b) => b.state === "confirmed" && b.slot_id === slot_id).reduce((n, b) => n + b.request.party_size, 0);
  const remaining = sheet.capacity_per_tour - taken;
  if (request.party_size > remaining) return { ok: false, reason: "no_capacity", detail: `${remaining} of ${sheet.capacity_per_tour} seats left on ${slot_id}` };
  const price: Money = { amount_minor: sheet.price_per_person_kes * request.party_size * 100, currency: "KES", exponent: 2 };
  return { ok: true, remaining_after: remaining - request.party_size, slot_id, slot_start: tourStart, slot_end: tourEnd, price };
}

export interface BookingProposalInput {
  request: BookingRequest;
  facts: FactRevision;
  confirmed: readonly Booking[];
  tenant_id: string;
  action_id: string;
  booking_id: string;
  created_at_ms: number;
  valid_for_ms: number;
  /** Exactly what Noor is shown. Experience owns reviewed copy; the core checks numbers elsewhere. */
  preview_text: string;
  render_locale: string;
  timezone?: string;
}

export type BookingProposalResult =
  | { ok: true; envelope: ActionEnvelope; booking: Booking }
  | { ok: false; reason: CapacityFailureReason; detail: string }
  | { ok: false; reason: "invalid_envelope"; detail: string; errors: string[] };

/** One exact book_slot action plus the tentative booking it would confirm. Nothing is blocked until Noor approves. */
export function proposeBooking(input: BookingProposalInput, sha256: Sha256): BookingProposalResult {
  const check = checkCapacity(input.facts.sheet, input.confirmed, input.request, input.timezone);
  if (!check.ok) return { ok: false, reason: check.reason, detail: check.detail };
  const booking: Booking = {
    booking_id: input.booking_id,
    request: input.request,
    slot_id: check.slot_id,
    slot_start: check.slot_start,
    slot_end: check.slot_end,
    price: check.price,
    fact_revision: input.facts.revision,
    state: "tentative",
    arrival: null,
  };
  const sealed = sealEnvelope(
    {
      schema: "sauti.action_envelope",
      schema_version: "1.0.0",
      action_id: input.action_id,
      tenant_id: input.tenant_id,
      kind: "book_slot",
      created_at: formatTimestamp(input.created_at_ms),
      valid_until: formatTimestamp(input.created_at_ms + input.valid_for_ms),
      fact_revision: input.facts.revision,
      recipient: { channel: "local", address: "owner", language: input.request.contact.language },
      payload: { type: "book_slot", booking_id: input.booking_id, slot_date: input.request.date, slot_start: check.slot_start, slot_end: check.slot_end, party_size: input.request.party_size, price: check.price },
      evidence: [],
      preview: { text: input.preview_text, render_locale: input.render_locale },
      authority: { level: "owner", owner_context_required: true },
    },
    sha256,
  );
  if (!sealed.ok) return { ok: false, reason: "invalid_envelope", detail: "the booking proposal does not satisfy the contract", errors: sealed.errors };
  return { ok: true, envelope: sealed.value, booking };
}

export interface ConfirmBookingInput {
  booking: Booking;
  /** The stored envelope the owner approved. Verified (schema + digest) here again. */
  envelope: ActionEnvelope;
  /** The immutable approval record for that envelope. */
  approval: ApprovalRecord;
  tenant_id: string;
  sheet: FarmSheet;
  current_fact_revision: number;
  confirmed: readonly Booking[];
  authoritative: boolean;
  requested_at: string;
  sha256: Sha256;
}

export type ConfirmBookingResult =
  | { ok: true; booking: Booking }
  | { ok: false; reason: "not_tentative" | "envelope_invalid" | "approval_not_bound" | "envelope_mismatch" | "fact_revision_changed" | "not_authoritative" | "no_capacity"; detail: string };

/**
 * Noor approved the book_slot envelope (through approveExact). Confirm the booking
 * on the authoritative calendar. The COMPLETE stored booking is bound to the exact
 * approved action: tenant, action digest, approval record, slot date, start, end,
 * party size, price and fact revision must all match, and the seats are re-checked
 * against what is confirmed NOW, because other bookings may have landed since the
 * proposal. Offline devices stay tentative (see calendar.reconcileSlot).
 */
export function confirmBooking(input: ConfirmBookingInput): ConfirmBookingResult {
  const { booking, envelope, approval } = input;
  if (booking.state !== "tentative") return { ok: false, reason: "not_tentative", detail: `booking is ${booking.state}` };
  const verified = verifyEnvelope(envelope, input.sha256);
  if (!verified.ok) return { ok: false, reason: "envelope_invalid", detail: verified.errors.join("; ") };
  if (approval.decision !== "approved" || approval.action_id !== envelope.action_id || approval.digest !== envelope.digest) {
    return { ok: false, reason: "approval_not_bound", detail: "the approval record does not approve this exact envelope" };
  }
  if (envelope.tenant_id !== input.tenant_id) return { ok: false, reason: "approval_not_bound", detail: "the approved action belongs to another tenant" };
  const p = envelope.payload;
  const same =
    envelope.kind === "book_slot" &&
    p.type === "book_slot" &&
    p.booking_id === booking.booking_id &&
    p.slot_date === booking.request.date &&
    p.slot_start === booking.slot_start &&
    p.slot_end === booking.slot_end &&
    p.party_size === booking.request.party_size &&
    p.price.amount_minor === booking.price.amount_minor &&
    p.price.currency === booking.price.currency &&
    p.price.exponent === booking.price.exponent &&
    envelope.fact_revision === booking.fact_revision &&
    booking.slot_id === booking.request.date;
  if (!same) return { ok: false, reason: "envelope_mismatch", detail: "the stored booking differs from the approved action in at least one bound field" };
  if (approval.fact_revision !== envelope.fact_revision || input.current_fact_revision !== envelope.fact_revision) {
    return { ok: false, reason: "fact_revision_changed", detail: `approved on fact revision ${envelope.fact_revision}, current is ${input.current_fact_revision}; propose again` };
  }
  if (!input.authoritative) return { ok: false, reason: "not_authoritative", detail: "this device is not the authoritative calendar; the booking stays tentative until reconciled" };
  const sheet = input.sheet;
  const confirmed = input.confirmed;
  const requested_at = input.requested_at;
  const capacity = sheet.capacity_per_tour ?? 0;
  const already = confirmed.filter((b) => b.state === "confirmed" && b.slot_id === booking.slot_id).map((b) => ({ booking_id: b.booking_id, party_size: b.request.party_size }));
  const req: SlotRequest = { booking_id: booking.booking_id, slot_id: booking.slot_id, party_size: booking.request.party_size, requested_at, authority: "authoritative" };
  const [outcome] = reconcileSlot({ slot_id: booking.slot_id, capacity }, already, [req]);
  if (!outcome || outcome.state !== "confirmed") return { ok: false, reason: "no_capacity", detail: outcome?.reason ?? "no outcome" };
  return { ok: true, booking: { ...booking, state: "confirmed" } };
}

export interface BookingMessageTemplate {
  template_id: string;
  body: string;
  body_language: string;
  preview_text: string;
  render_locale: string;
}

export type BookingMessageResult =
  | { ok: true; envelope: ActionEnvelope }
  | { ok: false; reason: "not_confirmed" | "invented_number" | "invalid_envelope"; detail: string; errors?: string[] };

/**
 * The confirmation (or day-before "still coming?") message to the visitor: a separate
 * send_message action with its own approval. The template may contain only numbers that
 * the booking itself establishes (date, time, party size, price, the visitor's address).
 */
export function proposeBookingMessage(
  input: { booking: Booking; template: BookingMessageTemplate; tenant_id: string; action_id: string; fact_revision: number; created_at_ms: number; valid_for_ms: number; owner_fact_numbers?: readonly string[] },
  sha256: Sha256,
): BookingMessageResult {
  const b = input.booking;
  if (b.state !== "confirmed") return { ok: false, reason: "not_confirmed", detail: `booking is ${b.state}; messages go to confirmed visitors only` };
  const allowed = new Set<string>([
    b.request.date,
    ...b.request.date.split("-"),
    b.slot_start,
    b.slot_end,
    String(b.request.party_size),
    String(b.price.amount_minor / 10 ** b.price.exponent),
    String(b.price.amount_minor),
    ...(input.owner_fact_numbers ?? []),
  ]);
  for (const n of b.request.contact.address.match(/\d+(?:[.,:]\d+)*/g) ?? []) allowed.add(n);
  const invented = [...unexplainedNumbers(input.template.body, allowed), ...unexplainedNumbers(input.template.preview_text, allowed)];
  if (invented.length > 0) return { ok: false, reason: "invented_number", detail: `numbers the booking does not establish: ${[...new Set(invented)].join(", ")}` };
  const sealed = sealEnvelope(
    {
      schema: "sauti.action_envelope",
      schema_version: "1.0.0",
      action_id: input.action_id,
      tenant_id: input.tenant_id,
      kind: "send_message",
      created_at: formatTimestamp(input.created_at_ms),
      valid_until: formatTimestamp(input.created_at_ms + input.valid_for_ms),
      fact_revision: input.fact_revision,
      recipient: b.request.contact,
      payload: { type: "message", body: input.template.body, body_language: input.template.body_language, booking_id: b.booking_id, template_id: input.template.template_id },
      evidence: [],
      preview: { text: input.template.preview_text, render_locale: input.template.render_locale },
      authority: { level: "owner", owner_context_required: true },
    },
    sha256,
  );
  if (!sealed.ok) return { ok: false, reason: "invalid_envelope", detail: "the booking message does not satisfy the contract", errors: sealed.errors };
  return { ok: true, envelope: sealed.value };
}

/** Owner record only: arrived or did not show. Nothing is sent, no fact changes. */
export function recordArrival(booking: Booking, status: ArrivalRecord): { ok: true; booking: Booking } | { ok: false; reason: "not_confirmed"; detail: string } {
  if (booking.state !== "confirmed") return { ok: false, reason: "not_confirmed", detail: `booking is ${booking.state}; only confirmed visits get an arrival record` };
  return { ok: true, booking: { ...booking, arrival: status } };
}
