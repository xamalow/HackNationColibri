import * as Crypto from 'expo-crypto';
import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { enrollOwner, formatTimestamp, startSession } from '@sauti/core';
import { bytesToHex } from '../crypto/hash';
import { appendAudit, coreDb, getDeviceId, OWNER_ID, readClock, readOwner, TENANT_ID } from './coreDb';

/**
 * Sauti PIN (Carter 2026-10-03 23:48 UTC): 4 digits, distinct from the phone passcode a helper may know.
 * Verifier = PBKDF2-HMAC-SHA256, 16-byte random salt (Domain recipe); the PIN itself is never stored or logged.
 * Lockout only, no recovery code (Cosme): 5 wrong entries -> 15 min, doubling each further round, on the
 * monotonic high-water clock; nothing is erased by a lockout. A forgotten PIN means a deliberate factory reset.
 */
export const PIN_ITERATIONS = 600_000;
const MAX_ATTEMPTS = 5;
const BASE_LOCK_MS = 15 * 60 * 1000;

export const isValidPin = (pin: string): boolean => /^\d{4}$/.test(pin);

async function derive(pin: string, saltHex: string, iterations: number): Promise<string> {
  const salt = Uint8Array.from(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  return bytesToHex(await pbkdf2Async(nobleSha256, utf8ToBytes(pin), salt, { c: iterations, dkLen: 32 }));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function isEnrolled(): Promise<boolean> {
  return (await readOwner()) !== null;
}

/** First launch: register this phone as Noor's trusted device and store only the PIN verifier. */
export async function enrollPin(pin: string): Promise<{ ok: true; ms: number } | { ok: false; error: string }> {
  if (!isValidPin(pin)) return { ok: false, error: 'pin_must_be_4_digits' };
  if (await isEnrolled()) return { ok: false, error: 'already_enrolled' };
  const deviceId = await getDeviceId();
  const enrolled = enrollOwner({ tenant_id: TENANT_ID, owner_id: OWNER_ID, device_id: deviceId, allowed_unlock: ['pin'] });
  if (!enrolled.ok) return { ok: false, error: enrolled.errors.join('; ') };
  const salt = bytesToHex(await Crypto.getRandomBytesAsync(16));
  const started = Date.now();
  const hash = await derive(pin, salt, PIN_ITERATIONS);
  const ms = Date.now() - started;
  const t = enrolled.trusted;
  const clock = await readClock();
  const db = await coreDb();
  await db.execute(
    `INSERT INTO sauti_owner (tenant_id, owner_id, device_ids_json, allowed_unlock_json, max_session_age_ms, revoked_sessions_json,
       pin_salt, pin_hash, pin_iterations, failed_attempts, lock_round, lock_until_ms, enrolled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?);`,
    [t.tenant_id, t.owner_id, JSON.stringify([...t.trusted_device_ids]), JSON.stringify([...t.allowed_unlock]),
      t.max_session_age_ms, '[]', salt, hash, PIN_ITERATIONS, formatTimestamp(clock.effectiveMs)],
  );
  await appendAudit({ at: formatTimestamp(clock.effectiveMs), action_id: '-', event: 'owner_enrolled', detail: `pbkdf2 ${PIN_ITERATIONS} iterations, ${ms} ms` });
  return { ok: true, ms };
}

export type UnlockResult =
  | { ok: true }
  | { ok: false; reason: 'not_enrolled' | 'locked' | 'wrong_pin' | 'clock_suspect' | 'session_refused'; lockedUntilMs?: number; attemptsLeft?: number };

/** Verify the PIN on this trusted device and open a fresh owner session for the core to read. */
export async function unlockWithPin(pin: string): Promise<UnlockResult> {
  const owner = await readOwner();
  if (!owner) return { ok: false, reason: 'not_enrolled' };
  const clock = await readClock();
  if (clock.suspect) return { ok: false, reason: 'clock_suspect' };
  const now = clock.effectiveMs;
  if (owner.lockUntilMs > now) return { ok: false, reason: 'locked', lockedUntilMs: owner.lockUntilMs };

  const db = await coreDb();
  const candidate = isValidPin(pin) ? await derive(pin, owner.pinSalt, owner.pinIterations) : '';
  if (!candidate || !constantTimeEqual(candidate, owner.pinHash)) {
    const failed = owner.failedAttempts + 1;
    if (failed >= MAX_ATTEMPTS) {
      const round = owner.lockRound + 1;
      const until = now + BASE_LOCK_MS * 2 ** (round - 1);
      await db.execute('UPDATE sauti_owner SET failed_attempts = 0, lock_round = ?, lock_until_ms = ? WHERE tenant_id = ?;', [round, until, TENANT_ID]);
      await appendAudit({ at: formatTimestamp(now), action_id: '-', event: 'pin_locked', detail: `round ${round}` });
      return { ok: false, reason: 'locked', lockedUntilMs: until };
    }
    await db.execute('UPDATE sauti_owner SET failed_attempts = ? WHERE tenant_id = ?;', [failed, TENANT_ID]);
    await appendAudit({ at: formatTimestamp(now), action_id: '-', event: 'pin_wrong' });
    return { ok: false, reason: 'wrong_pin', attemptsLeft: MAX_ATTEMPTS - failed };
  }

  const deviceId = await getDeviceId();
  const started = startSession({ trusted: owner.trusted, device_id: deviceId, unlock: 'pin', session_id: `s-${Crypto.randomUUID()}`, nowMs: now });
  if (!started.ok) return { ok: false, reason: 'session_refused' };
  await db.transaction(async (tx) => {
    await tx.execute('UPDATE sauti_owner SET failed_attempts = 0, lock_round = 0 WHERE tenant_id = ?;', [TENANT_ID]);
    await tx.execute(
      'INSERT INTO sauti_session (tenant_id, session_json) VALUES (?, ?) ON CONFLICT(tenant_id) DO UPDATE SET session_json = excluded.session_json;',
      [TENANT_ID, JSON.stringify(started.session)],
    );
  });
  return { ok: true };
}
