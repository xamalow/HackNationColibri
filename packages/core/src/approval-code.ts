/**
 * One-time approval codes for the owner's BASIC phone (r1.1, Carter's guardrail
 * 3, 2026-10-04). A sender id can be spoofed, so an SMS "NDIYO" is never an
 * approval by itself. It counts only when it comes from Noor's enrolled number
 * AND carries the per-proposal code the hub itself sent in its read-back SMS
 * ("Jibu NDIYO B 482193"). The code is random, never stored (only a
 * domain-separated hash bound to tenant, action, content digest and challenge),
 * single-use, expiring, with a lockout. A verified code mints an
 * AuthenticatedSession with unlock "sms_code" that is bound to that one action
 * AND the exact digest it read back (same id, changed content = fresh code);
 * decideApproval refuses it for any other action, and the hub revokes it after
 * the decision.
 *
 * Pure: the host supplies randomness, sha256 and the clock. Nothing here sends
 * an SMS or maps a phone number; the hub maps Noor's E.164 to an opaque
 * device id in TrustedOwner.trusted_device_ids and passes that id in.
 *
 * Strength: with the default 6 digits and 5 attempts, a spoofer who also
 * forges the enrolled number succeeds with probability 5/1,000,000 per
 * challenge (warden, 2026-10-04: aligned with the hub; 4 is the floor),
 * and a hub read of the stored hash is worth nothing without the DB it sits
 * in. Lockout is per challenge: a locked proposal is cancelled and re-proposed
 * with a fresh read-back, so an attacker spamming wrong codes can delay Noor
 * but never approve.
 */

import { type AuthenticatedSession, type TrustedOwner } from "./approval.js";
import { APPROVAL_CODE_DOMAIN, digest, type Sha256 } from "./canon.js";
import { type ClockReading, formatTimestamp, parseTimestamp } from "./clock.js";

export const DEFAULT_CODE_LENGTH = 6;
export const DEFAULT_CODE_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_CODE_MAX_ATTEMPTS = 5;

/** What the hub stores. The code itself is never in it. */
export interface CodeChallenge {
  challenge_id: string;
  tenant_id: string;
  action_id: string;
  /** The envelope digest the read-back SMS described. Content changed after the SMS = this no longer matches. */
  digest: string;
  code_hash: string;
  code_length: number;
  issued_at: string;
  expires_at: string;
  attempts: number;
  max_attempts: number;
  /** Set when a code was accepted; a second use is refused. */
  used_at: string | null;
  /**
   * Set the first time the challenge was SEEN expired. From then on it stays
   * expired even if the wall clock is turned back (codex, 2026-10-04: a 1 s TTL
   * refused at T+2 s must not be accepted again at T). The hub persists this.
   */
  expired_at: string | null;
}

export interface IssueCodeInput {
  tenant_id: string;
  action_id: string;
  digest: string;
  /** Host-generated, unique per read-back. */
  challengeId: string;
  clock: ClockReading;
  /** Cryptographically secure random bytes (node:crypto randomBytes, react-native-quick-crypto, ...). */
  randomBytes: (length: number) => Uint8Array;
  sha256: Sha256;
  ttlMs?: number;
  codeLength?: number;
  maxAttempts?: number;
}

const ID = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function codeHash(tenantId: string, actionId: string, digestHex: string, challengeId: string, code: string, sha256: Sha256): string {
  return digest(APPROVAL_CODE_DOMAIN, { tenant_id: tenantId, action_id: actionId, digest: digestHex, challenge_id: challengeId, code }, sha256);
}

/** Unbiased decimal digits from random bytes (rejection sampling: bytes 250..255 are discarded). */
export function randomDigits(length: number, randomBytes: (n: number) => Uint8Array): string {
  let out = "";
  while (out.length < length) {
    const bytes = randomBytes(length * 2);
    for (const b of bytes) {
      if (b >= 250) continue;
      out += String(b % 10);
      if (out.length === length) break;
    }
  }
  return out;
}

/** Equal-length string compare without early exit on the first differing character. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Issue the code for one proposal. The hub puts `code` into its own read-back
 * SMS and stores `challenge`; the code is not kept anywhere else.
 */
export function issueApprovalCode(input: IssueCodeInput): { ok: true; code: string; challenge: CodeChallenge } | { ok: false; reason: "bad_input" | "clock_suspect"; detail: string } {
  const length = input.codeLength ?? DEFAULT_CODE_LENGTH;
  const ttl = input.ttlMs ?? DEFAULT_CODE_TTL_MS;
  const maxAttempts = input.maxAttempts ?? DEFAULT_CODE_MAX_ATTEMPTS;
  if (!ID.test(input.challengeId)) return { ok: false, reason: "bad_input", detail: "challengeId must be 1..128 of [A-Za-z0-9._-]" };
  if (!ID.test(input.tenant_id) || !ID.test(input.action_id)) return { ok: false, reason: "bad_input", detail: "tenant_id and action_id must be ids" };
  if (!SHA256_HEX.test(input.digest)) return { ok: false, reason: "bad_input", detail: "digest must be 64 lowercase hex" };
  if (!Number.isInteger(length) || length < 4 || length > 8) return { ok: false, reason: "bad_input", detail: "codeLength must be 4..8 digits" };
  if (!Number.isInteger(ttl) || ttl < 60_000 || ttl > 24 * 3600 * 1000) return { ok: false, reason: "bad_input", detail: "ttlMs must be 1 minute .. 24 hours" };
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) return { ok: false, reason: "bad_input", detail: "maxAttempts must be 1..10" };
  if (input.clock.suspect) return { ok: false, reason: "clock_suspect", detail: "hub clock is behind its own high-water mark; no code issued" };
  const code = randomDigits(length, input.randomBytes);
  const challenge: CodeChallenge = {
    challenge_id: input.challengeId,
    tenant_id: input.tenant_id,
    action_id: input.action_id,
    digest: input.digest,
    code_hash: codeHash(input.tenant_id, input.action_id, input.digest, input.challengeId, code, input.sha256),
    code_length: length,
    issued_at: formatTimestamp(input.clock.effectiveMs),
    expires_at: formatTimestamp(input.clock.effectiveMs + ttl),
    attempts: 0,
    max_attempts: maxAttempts,
    used_at: null,
    expired_at: null,
  };
  return { ok: true, code, challenge };
}

export type CodeFailure =
  | "wrong_code"
  | "locked"
  | "expired"
  | "used"
  | "action_mismatch"
  | "digest_mismatch"
  | "device_not_trusted"
  | "unlock_not_allowed"
  | "owner_mismatch"
  | "clock_suspect"
  | "bad_input";

export interface VerifyCodeInput {
  challenge: CodeChallenge;
  /** The proposal the reply names (after the hub resolved "B" to an action id). */
  action_id: string;
  /** The action's CURRENT envelope digest from the store. */
  digest: string;
  /** Digits as typed, whitespace tolerated. */
  code: string;
  /** Opaque device id the hub assigned to the SENDING number. Never the number itself. */
  senderDeviceId: string;
  trusted: TrustedOwner | null;
  clock: ClockReading;
  /** Host-generated id for the session this verification mints. */
  sessionId: string;
  sha256: Sha256;
}

export type VerifyCodeResult =
  | { ok: true; challenge: CodeChallenge; session: AuthenticatedSession }
  | { ok: false; reason: CodeFailure; detail: string; challenge: CodeChallenge };

/**
 * Check a reply. Returns the updated challenge in every case (attempts, used_at)
 * so the hub persists it in the same transaction as the decision. Order: the
 * sender must be an enrolled device BEFORE the code is even compared, so a
 * stranger's guesses cannot burn Noor's attempts; then the challenge must be
 * live and for this exact action and content; then the code.
 */
export function verifyApprovalCode(input: VerifyCodeInput): VerifyCodeResult {
  const c = input.challenge;
  const refuse = (reason: CodeFailure, detail: string, challenge: CodeChallenge = c): VerifyCodeResult => ({ ok: false, reason, detail, challenge });
  if (!ID.test(input.sessionId)) return refuse("bad_input", "sessionId must be 1..128 of [A-Za-z0-9._-]");
  if (input.clock.suspect) return refuse("clock_suspect", "hub clock is behind its own high-water mark; reply held");
  if (!input.trusted) return refuse("owner_mismatch", "no trusted owner registered for this tenant");
  if (input.trusted.tenant_id !== c.tenant_id) return refuse("owner_mismatch", "challenge and registry are for different tenants");
  if (!input.trusted.trusted_device_ids.has(input.senderDeviceId)) return refuse("device_not_trusted", "reply did not come from the owner's enrolled phone");
  if (!input.trusted.allowed_unlock.has("sms_code")) return refuse("unlock_not_allowed", "this tenant does not allow SMS-code approval");
  if (c.used_at !== null) return refuse("used", `code already used at ${c.used_at}`);
  if (c.expired_at !== null) return refuse("expired", `code was seen expired at ${c.expired_at}; expiry is permanent`);
  if (c.attempts >= c.max_attempts) return refuse("locked", `challenge locked after ${c.attempts} wrong codes; cancel and re-propose`);
  const expiresAt = parseTimestamp(c.expires_at);
  if (expiresAt === null) return refuse("bad_input", "challenge expires_at is not a timestamp");
  if (input.clock.effectiveMs >= expiresAt) {
    // Record the observation so a later, earlier-looking clock cannot revive the code. The hub persists the returned challenge.
    return refuse("expired", `code expired at ${c.expires_at}`, { ...c, expired_at: formatTimestamp(input.clock.effectiveMs) });
  }
  if (input.action_id !== c.action_id) return refuse("action_mismatch", "this code was issued for another proposal");
  if (input.digest !== c.digest) return refuse("digest_mismatch", "the proposal changed after the code was sent; a new read-back is needed");
  const typed = input.code.replace(/\s+/g, "");
  const attempted: CodeChallenge = { ...c, attempts: c.attempts + 1 };
  if (!/^[0-9]+$/.test(typed) || typed.length !== c.code_length) {
    return refuse(attempted.attempts >= c.max_attempts ? "locked" : "wrong_code", "code must be exactly the digits from the read-back SMS", attempted);
  }
  const expected = c.code_hash;
  const actual = codeHash(c.tenant_id, c.action_id, c.digest, c.challenge_id, typed, input.sha256);
  if (!constantTimeEqual(expected, actual)) {
    return refuse(attempted.attempts >= c.max_attempts ? "locked" : "wrong_code", `wrong code (${attempted.attempts} of ${c.max_attempts})`, attempted);
  }
  const now = formatTimestamp(input.clock.effectiveMs);
  const used: CodeChallenge = { ...attempted, used_at: now };
  const session: AuthenticatedSession = {
    tenant_id: c.tenant_id,
    owner_id: input.trusted.owner_id,
    device_id: input.senderDeviceId,
    unlock: "sms_code",
    session_id: input.sessionId,
    authenticated_at: now,
    bound_action_id: c.action_id,
    bound_digest: c.digest,
    challenge_id: c.challenge_id,
  };
  return { ok: true, challenge: used, session };
}

export type SmsReply =
  | { kind: "approve"; ref: string; code: string }
  | { kind: "reject"; ref: string }
  | { kind: "unknown" };

/**
 * Noor's reply grammar, strict on purpose: "NDIYO <ref> <code>" approves,
 * "HAPANA <ref>" rejects, anything else (a bare "ndiyo", a chat, a forwarded
 * message) is unknown and the hub answers with its fixed help text. The ref is
 * the short label from the read-back ("A", "B"); the hub resolves it to the
 * action id before calling verifyApprovalCode.
 */
export function parseSmsReply(text: string): SmsReply {
  const m = /^\s*(ndiyo|hapana)\s+([a-z0-9]{1,8})(?:\s+([0-9 ]{4,17}))?\s*$/i.exec(text ?? "");
  if (!m) return { kind: "unknown" };
  const word = m[1]!.toLowerCase();
  const ref = m[2]!.toUpperCase();
  if (word === "hapana") return m[3] === undefined ? { kind: "reject", ref } : { kind: "unknown" };
  if (m[3] === undefined) return { kind: "unknown" };
  const code = m[3].replace(/\s+/g, "");
  if (code.length < 4 || code.length > 8) return { kind: "unknown" };
  return { kind: "approve", ref, code };
}
