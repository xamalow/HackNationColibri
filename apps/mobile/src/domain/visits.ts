import * as Crypto from 'expo-crypto';
import {
  beginDispatch,
  confirmBooking,
  formatTimestamp,
  proposeBooking,
  proposeBookingMessage,
  recordAcceptance,
  recordArrival,
  type Booking,
  type BookingRequest,
  type StoredAction,
} from '@sauti/core';
import { appendAudit, coreDb, getApprovalAndOutbox, insertProposedAction, readClock, saveAction, sha256, TENANT_ID } from './coreDb';
import { readFacts } from './farm';
import { bi, biBoth } from './w3';

async function ensureTable(): Promise<void> {
  const db = await coreDb();
  await db.execute(`CREATE TABLE IF NOT EXISTS sauti_bookings (
    booking_id TEXT PRIMARY KEY NOT NULL, action_id TEXT NOT NULL, state TEXT NOT NULL, booking_json TEXT NOT NULL, created_at TEXT NOT NULL);`);
}

export async function listBookings(): Promise<Booking[]> {
  await ensureTable();
  const db = await coreDb();
  return (await db.execute('SELECT booking_json FROM sauti_bookings ORDER BY created_at DESC;')).rows.map((r) => JSON.parse(String(r.booking_json)) as Booking);
}

async function saveBooking(b: Booking, actionId: string): Promise<void> {
  await ensureTable();
  const db = await coreDb();
  await db.execute(
    `INSERT INTO sauti_bookings (booking_id, action_id, state, booking_json, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(booking_id) DO UPDATE SET state = excluded.state, booking_json = excluded.booking_json;`,
    [b.booking_id, actionId, b.state, JSON.stringify(b), formatTimestamp(Date.now())],
  );
}

const reasonText = (): Record<string, string> => ({
  missing_fact: bi('Taarifa za shamba hazijakamilika (bei, idadi, siku au saa). Jaza Shamba langu kwanza.', 'Farm details are incomplete (price, capacity, days or hours). Fill My farm first.'),
  closed_day: bi('Hupokei wageni siku hii.', 'You do not receive visitors on this day.'),
  outside_hours: bi('Saa hii iko nje ya saa za ziara.', 'This time is outside your tour hours.'),
  unsupported_time: bi('Saa hii haieleweki. Sitaikisia.', 'This time is unclear. I will not guess it.'),
  bad_date: bi('Tarehe haiko wazi. Sitaikisia.', 'The date is not clear. I will not guess it.'),
  bad_party_size: bi('Idadi ya wageni si sahihi.', 'The number of visitors is not valid.'),
  no_capacity: bi('Siku hii imejaa.', 'This day is full.'),
});

/**
 * A booking request (simulated inbox in v1). Capacity, price and the slot are computed by code from the
 * farm sheet and the confirmed bookings; nothing is blocked until Noor approves the book_slot action.
 */
export async function requestBooking(input: { visitorName: string; date: string; partySize: number; phone: string }): Promise<{ ok: true } | { ok: false; message: string }> {
  const facts = await readFacts();
  if (!facts) return { ok: false, message: reasonText().missing_fact };
  const phone = input.phone.replace(/[^\d+]/g, '');
  const request: BookingRequest = {
    request_id: Crypto.randomUUID(),
    visitor_name: input.visitorName.trim() || 'Mgeni',
    contact: phone ? { channel: 'sms', address: phone, language: 'en' } : { channel: 'simulated', address: 'SIMULATED:visitor', language: 'en' },
    date: input.date.trim(),
    party_size: input.partySize,
  };
  const confirmed = (await listBookings()).filter((b) => b.state === 'confirmed');
  const actionId = Crypto.randomUUID();
  const preview = biBoth(`Hifadhi nafasi: ${request.visitor_name}, tarehe ${request.date}, wageni ${request.party_size}. Itaandikwa kwenye kalenda yako tu; hakuna ujumbe utakaotumwa bila idhini nyingine.`, `Book a slot: ${request.visitor_name}, ${request.date}, ${request.party_size} visitors. Only written to your calendar; no message is sent without another approval.`);
  const result = proposeBooking(
    { request, facts, confirmed, tenant_id: TENANT_ID, action_id: actionId, booking_id: Crypto.randomUUID(), created_at_ms: Date.now(), valid_for_ms: 24 * 3600 * 1000, preview_text: preview, render_locale: 'sw-KE' },
    sha256,
  );
  if (!result.ok) return { ok: false, message: reasonText()[result.reason] ?? `${result.reason}: ${result.detail}` };
  await insertProposedAction(result.envelope, null);
  await saveBooking(result.booking, actionId);
  return { ok: true };
}

/**
 * After Noor approved a book_slot action: confirm the booking on this (authoritative) phone, record the
 * local calendar write as the action's transport, then prepare the visitor message as a SEPARATE proposal.
 */
export async function afterBookSlotApproved(action: StoredAction): Promise<{ ok: true } | { ok: false; reason: string }> {
  await ensureTable();
  const db = await coreDb();
  const row = (await db.execute('SELECT booking_json FROM sauti_bookings WHERE action_id = ?;', [action.envelope.action_id])).rows[0];
  if (!row) return { ok: false, reason: 'booking_not_found' };
  const booking = JSON.parse(String(row.booking_json)) as Booking;
  const facts = await readFacts();
  const { approval } = await getApprovalAndOutbox(action.envelope.action_id);
  if (!facts || !approval) return { ok: false, reason: 'facts_or_approval_missing' };
  const confirmed = (await listBookings()).filter((b) => b.state === 'confirmed');
  const result = confirmBooking({
    booking, envelope: action.envelope, approval, tenant_id: TENANT_ID, sheet: facts.sheet, current_fact_revision: facts.revision,
    confirmed, authoritative: true, requested_at: formatTimestamp((await readClock()).effectiveMs), sha256,
  });
  if (!result.ok) return { ok: false, reason: `${result.reason}: ${result.detail}` };
  await saveBooking(result.booking, action.envelope.action_id);
  await saveAction(recordAcceptance(beginDispatch(action), 'local:calendar'));

  const b = result.booking;
  const price = String(b.price.amount_minor / 10 ** b.price.exponent);
  // Experience has no booking template yet (asked xam-claude); English for the visitor, UNREVIEWED.
  const body = `Hello ${b.request.visitor_name}, your coffee farm visit on ${b.request.date} at ${b.slot_start} for ${b.request.party_size} is confirmed. Price: KES ${price} per person. Noor`;
  const message = proposeBookingMessage(
    {
      booking: b,
      template: { template_id: 'booking.confirmed.en.v0', body, body_language: 'en', preview_text: biBoth(`Ujumbe kwa mgeni: ${body}`, `Message to the visitor: ${body}`), render_locale: 'sw-KE' },
      tenant_id: TENANT_ID, action_id: Crypto.randomUUID(), fact_revision: facts.revision, created_at_ms: Date.now(), valid_for_ms: 24 * 3600 * 1000,
    },
    sha256,
  );
  if (!message.ok) return { ok: false, reason: `${message.reason}: ${message.detail}` };
  await insertProposedAction(message.envelope, null);
  return { ok: true };
}

export async function markArrival(booking: Booking, status: 'arrived' | 'no_show'): Promise<{ ok: boolean; reason?: string }> {
  const result = recordArrival(booking, status);
  if (!result.ok) return { ok: false, reason: result.detail };
  await ensureTable();
  const db = await coreDb();
  const row = (await db.execute('SELECT action_id FROM sauti_bookings WHERE booking_id = ?;', [booking.booking_id])).rows[0];
  await saveBooking(result.booking, String(row?.action_id ?? '-'));
  await appendAudit({ at: formatTimestamp(Date.now()), action_id: String(row?.action_id ?? '-'), event: `arrival_${status}` });
  return { ok: true };
}
