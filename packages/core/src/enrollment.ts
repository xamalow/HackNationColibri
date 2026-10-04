/**
 * First-run trust bootstrap.
 *
 * There is no owner before the first Sauti PIN is set, so enrollment IS that
 * first set-up: the host generates the tenant (farm), owner and device ids,
 * stores only a salt and hash of the PIN, and writes the TrustedOwner row and
 * an audit line in one transaction. Every later PIN entry that verifies creates
 * an AuthenticatedSession. The trust anchor ("whoever completes first-run setup
 * on this phone is the owner") is a stated demo limitation; a second device or
 * a cooperative-issued enrollment code is a later phase. The PIN itself never
 * reaches this package. Recovery (Cosme, 2026-10-04): wrong entries lock approval
 * for 15 minutes, doubling; a forgotten PIN means a factory reset and a fresh
 * enrollment, never an in-place recovery.
 */

import type { AuthenticatedSession, TrustedOwner, UnlockMethod } from "./approval.js";
import { formatTimestamp } from "./clock.js";

export const DEFAULT_SESSION_MAX_AGE_MS = 15 * 60 * 1000;

export interface EnrollmentInput {
  tenant_id: string;
  owner_id: string;
  device_id: string;
  /** Unlock methods this tenant allows. v1: ["pin"]. */
  allowed_unlock?: readonly UnlockMethod[];
  max_session_age_ms?: number;
}

const ID = /^[A-Za-z0-9._-]{1,128}$/;

/** The TrustedOwner row the host writes at enrollment, together with the PIN hash and an "owner_enrolled" audit line. */
export function enrollOwner(input: EnrollmentInput): { ok: true; trusted: TrustedOwner } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  for (const [k, v] of Object.entries({ tenant_id: input.tenant_id, owner_id: input.owner_id, device_id: input.device_id })) {
    if (typeof v !== "string" || !ID.test(v)) errors.push(`${k}: must be 1..128 of [A-Za-z0-9._-]`);
  }
  const unlock = input.allowed_unlock ?? ["pin"];
  if (unlock.length === 0) errors.push("allowed_unlock: at least one method");
  const maxAge = input.max_session_age_ms ?? DEFAULT_SESSION_MAX_AGE_MS;
  if (!Number.isInteger(maxAge) || maxAge < 60_000 || maxAge > 24 * 3600 * 1000) errors.push("max_session_age_ms: 1 minute .. 24 hours");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    trusted: {
      tenant_id: input.tenant_id,
      owner_id: input.owner_id,
      trusted_device_ids: new Set([input.device_id]),
      allowed_unlock: new Set(unlock),
      max_session_age_ms: maxAge,
      revoked_session_ids: new Set(),
    },
  };
}

export interface SessionStartInput {
  trusted: TrustedOwner;
  device_id: string;
  unlock: UnlockMethod;
  /** Random, host-generated, unique per unlock. */
  session_id: string;
  nowMs: number;
}

/**
 * After the host verified the PIN (or biometric) on a trusted device, the
 * session the core will accept. Refuses a device outside the registry or a
 * method the tenant does not allow, so a buggy host cannot mint a session the
 * approval path would then reject anyway.
 */
export function startSession(input: SessionStartInput): { ok: true; session: AuthenticatedSession } | { ok: false; reason: "device_not_trusted" | "unlock_not_allowed" | "bad_session_id"; detail: string } {
  if (!input.trusted.trusted_device_ids.has(input.device_id)) return { ok: false, reason: "device_not_trusted", detail: `device ${input.device_id} is not enrolled for this tenant` };
  if (input.unlock === "sms_code") return { ok: false, reason: "unlock_not_allowed", detail: "sms_code sessions are minted only by verifyApprovalCode after a valid one-time code from the enrolled phone" };
  if (!input.trusted.allowed_unlock.has(input.unlock)) return { ok: false, reason: "unlock_not_allowed", detail: `${input.unlock} is not an allowed unlock for this tenant` };
  if (typeof input.session_id !== "string" || !ID.test(input.session_id)) return { ok: false, reason: "bad_session_id", detail: "session_id must be a non-empty id" };
  return {
    ok: true,
    session: {
      tenant_id: input.trusted.tenant_id,
      owner_id: input.trusted.owner_id,
      device_id: input.device_id,
      unlock: input.unlock,
      session_id: input.session_id,
      authenticated_at: formatTimestamp(input.nowMs),
    },
  };
}

/**
 * CHANGE PIN (inside a valid session) or lock-out escalation: every session so far is
 * revoked; the host also cancels pending approvals and keeps facts, bookings and history.
 * A FORGOTTEN PIN is not this: Cosme's product rule (2026-10-04 00:36 UTC) is a factory
 * reset outside the approval flow that wipes the local database and the device id and
 * enrolls again with new tenant/owner/device ids; nothing carries over.
 */
export function revokeAllSessions(trusted: TrustedOwner, sessionIds: Iterable<string>): TrustedOwner {
  const revoked = new Set(trusted.revoked_session_ids);
  for (const id of sessionIds) revoked.add(id);
  return { ...trusted, revoked_session_ids: revoked };
}
