/**
 * Capacity and appointments.
 *
 * Two offline devices cannot both confirm the last slot. Requests made away from
 * the authoritative calendar are tentative until reconciled; reconciliation is
 * deterministic and confirms at most the remaining capacity.
 *
 * Appointments are absolute: a local date, a local time and an IANA time zone.
 * "Saturday", "next week" or a 6/7 date are clarifications, not bookings.
 */

export interface SlotCapacity {
  slot_id: string;
  capacity: number;
}

export interface ConfirmedReservation {
  booking_id: string;
  party_size: number;
}

export interface SlotRequest {
  booking_id: string;
  slot_id: string;
  party_size: number;
  /** RFC 3339 UTC. Earlier requests win ties; booking_id breaks remaining ties so the result is reproducible. */
  requested_at: string;
  /** "authoritative" = made on the one authoritative calendar; "tentative" = made offline elsewhere. */
  authority: "authoritative" | "tentative";
}

export type ReservationState = "confirmed" | "tentative" | "declined";

export interface ReservationOutcome {
  booking_id: string;
  state: ReservationState;
  reason: "confirmed" | "already_confirmed" | "not_authoritative" | "no_capacity" | "invalid_party_size";
}

/**
 * Reconcile requests against one slot. Already-confirmed reservations keep their
 * seats. Tentative requests are never confirmed here; they are returned as
 * tentative for the authoritative device (or the owner) to decide with the
 * remaining capacity visible.
 */
export function reconcileSlot(slot: SlotCapacity, confirmed: readonly ConfirmedReservation[], requests: readonly SlotRequest[]): ReservationOutcome[] {
  let remaining = slot.capacity - confirmed.reduce((n, c) => n + c.party_size, 0);
  const confirmedIds = new Set(confirmed.map((c) => c.booking_id));
  const ordered = [...requests]
    .filter((r) => r.slot_id === slot.slot_id)
    .sort((a, b) => (a.requested_at < b.requested_at ? -1 : a.requested_at > b.requested_at ? 1 : a.booking_id < b.booking_id ? -1 : a.booking_id > b.booking_id ? 1 : 0));
  const out: ReservationOutcome[] = [];
  const seen = new Set<string>();
  for (const r of ordered) {
    if (seen.has(r.booking_id)) continue; // a duplicate request for the same booking counts once
    seen.add(r.booking_id);
    if (confirmedIds.has(r.booking_id)) {
      out.push({ booking_id: r.booking_id, state: "confirmed", reason: "already_confirmed" });
      continue;
    }
    if (!Number.isInteger(r.party_size) || r.party_size < 1) {
      out.push({ booking_id: r.booking_id, state: "declined", reason: "invalid_party_size" });
      continue;
    }
    if (r.authority !== "authoritative") {
      out.push({ booking_id: r.booking_id, state: "tentative", reason: "not_authoritative" });
      continue;
    }
    if (r.party_size <= remaining) {
      remaining -= r.party_size;
      out.push({ booking_id: r.booking_id, state: "confirmed", reason: "confirmed" });
    } else {
      out.push({ booking_id: r.booking_id, state: "declined", reason: "no_capacity" });
    }
  }
  return out;
}

export interface AppointmentInput {
  date?: string | null;
  time?: string | null;
  timezone?: string | null;
}

export type AppointmentVerdict =
  | { ok: true; date: string; time: string; timezone: string }
  | { ok: false; clarify: "date" | "time" | "timezone"; detail: string };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;
const IANA = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/;

/** An appointment is only an appointment when all three parts are absolute. Otherwise ask one bounded question. */
export function validateAppointment(input: AppointmentInput): AppointmentVerdict {
  const d = input.date ?? "";
  const m = DATE.exec(d);
  if (!m) return { ok: false, clarify: "date", detail: "need an absolute date YYYY-MM-DD, not a weekday or a relative day" };
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, day));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== day) {
    return { ok: false, clarify: "date", detail: `${d} is not a calendar date` };
  }
  const t = input.time ?? "";
  const tm = TIME.exec(t);
  if (!tm || Number(tm[1]) > 23 || Number(tm[2]) > 59) return { ok: false, clarify: "time", detail: "need a clock time HH:MM" };
  const tz = input.timezone ?? "";
  if (!IANA.test(tz)) return { ok: false, clarify: "timezone", detail: "need an IANA time zone such as Africa/Nairobi" };
  return { ok: true, date: d, time: t, timezone: tz };
}
