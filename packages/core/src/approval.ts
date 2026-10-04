/**
 * Exact approval. Noor approves one envelope, identified by its digest, inside a
 * fresh, unrevoked owner session on a trusted device. The decision is a pure
 * function; persistence happens through a transaction port so that envelope
 * state, approval record and outbox row are written together or not at all.
 *
 * Hash equality proves byte identity, not that a person saw it. The owner
 * session is established by the host's local authentication (PIN, biometric)
 * and read through the transaction port; the caller cannot supply one. Voice or
 * text confirmation is how the owner answers inside that session; it is not the
 * session.
 */

import { APPROVAL_DOMAIN, digest, type Sha256 } from "./canon.js";
import { type ClockReading, formatTimestamp, isExpired, parseTimestamp } from "./clock.js";
import { type ActionEnvelope, verifyEnvelope } from "./envelope.js";
import { type BusinessState, type TransportState } from "./states.js";
import { utf8Encode } from "./utf8.js";

export const APPROVAL_SCHEMA = "sauti.approval_record";
export const APPROVAL_SCHEMA_VERSION = "1.0.0";

/** How the owner SESSION was authenticated. */
export const UNLOCK_METHODS = ["pin", "biometric"] as const;
export type UnlockMethod = (typeof UNLOCK_METHODS)[number];

/** How the owner answered for THIS action inside the session. Informational. */
export const CONFIRMATIONS = ["tap", "voice", "text", "keypad"] as const;
export type Confirmation = (typeof CONFIRMATIONS)[number];

/**
 * The current owner session as the HOST established it (keystore-backed unlock
 * state). Read inside the transaction; never built from request data, model
 * output or transcript text.
 */
export interface AuthenticatedSession {
  tenant_id: string;
  owner_id: string;
  device_id: string;
  unlock: UnlockMethod;
  session_id: string;
  /** RFC 3339 UTC: when the session was authenticated. */
  authenticated_at: string;
}

/** What goes into the approval record. Derived from the session plus the confirmation channel. */
export interface OwnerContext {
  owner_id: string;
  device_id: string;
  unlock: UnlockMethod;
  confirmation?: Confirmation;
  session_id: string;
  authenticated_at: string;
}

/** The tenant's registry of who may approve. Distinct from the session: the session says who is here, the registry says who is allowed. */
export interface TrustedOwner {
  tenant_id: string;
  owner_id: string;
  trusted_device_ids: ReadonlySet<string>;
  allowed_unlock: ReadonlySet<UnlockMethod>;
  /** A session older than this cannot approve; the owner unlocks again. */
  max_session_age_ms: number;
  revoked_session_ids: ReadonlySet<string>;
}

/** Tolerance for an authenticated_at slightly ahead of the effective clock (two clocks on one device). */
export const SESSION_FUTURE_TOLERANCE_MS = 60 * 1000;

export interface ApprovalRecord {
  schema: typeof APPROVAL_SCHEMA;
  schema_version: typeof APPROVAL_SCHEMA_VERSION;
  approval_id: string;
  action_id: string;
  digest: string;
  fact_revision: number;
  decision: "approved" | "rejected";
  decided_at: string;
  owner_context: OwnerContext;
}

export interface StoredAction {
  envelope: ActionEnvelope;
  business: BusinessState;
  transport: TransportState;
  /** Set when the owner revoked after approval. Terminal for business; carrier truth is still recorded. */
  revoked_at: string | null;
  /** Provider reference once accepted; null before. */
  provider_ref: string | null;
  attempts: number;
}

/** The pinned bytes a transport may carry. Written once, in the approval transaction, never updated. */
export interface OutboxRow {
  action_id: string;
  tenant_id: string;
  idempotency_key: string;
  digest: string;
  channel: ActionEnvelope["recipient"]["channel"];
  address: string;
  /** The exact payload the transport will carry: JSON of envelope.payload at approval time. */
  payload_json: string;
  created_at: string;
}

export type ApprovalFailure =
  | "invalid_envelope"
  | "not_proposed"
  | "revoked"
  | "digest_mismatch"
  | "rendered_digest_mismatch"
  | "fact_revision_mismatch"
  | "expired"
  | "clock_suspect"
  | "no_owner_session"
  | "owner_mismatch"
  | "device_not_trusted"
  | "unlock_not_allowed"
  | "session_revoked"
  | "session_time_invalid"
  | "session_stale";

export type ApproveResult =
  | { ok: true; action: StoredAction; approval: ApprovalRecord; outbox: OutboxRow }
  | { ok: false; reason: ApprovalFailure; detail: string };

export interface ApproveInput {
  action: StoredAction;
  /** Digest of what was actually rendered to the owner, computed by the host from the rendered envelope. */
  renderedDigest: string;
  currentFactRevision: number;
  /** Host-established session, read inside the transaction. null = nobody is unlocked. */
  session: AuthenticatedSession | null;
  trusted: TrustedOwner | null;
  confirmation?: Confirmation;
  clock: ClockReading;
  approvalId: string;
  sha256: Sha256;
}

/** Stable key: same tenant + action + content always yields the same key, so a retry can never double-send. Full 64 hex. */
export function idempotencyKey(tenantId: string, actionId: string, envelopeDigestHex: string, sha256: Sha256): string {
  return sha256(utf8Encode(`${tenantId}|${actionId}|${envelopeDigestHex}`));
}

/**
 * Key for a provider with a length cap. The first 32 hex characters are 128 bits
 * of the same sha256, stable for the same inputs. Below 32 characters there is no
 * safe derivation; the adapter must keep its own mapping table instead.
 */
export function providerKey(idempotencyKey64: string, maxLength: number): string {
  if (!/^[0-9a-f]{64}$/.test(idempotencyKey64)) throw new RangeError("expected a 64-hex idempotency key");
  if (maxLength >= 64) return idempotencyKey64;
  if (maxLength >= 32) return idempotencyKey64.slice(0, 32);
  throw new RangeError(`provider key cap ${maxLength} is below 128 bits; keep a mapping table instead`);
}

function fail(reason: ApprovalFailure, detail: string): ApproveResult {
  return { ok: false, reason, detail };
}

export type SessionFailure = Extract<ApprovalFailure, "no_owner_session" | "owner_mismatch" | "device_not_trusted" | "unlock_not_allowed" | "session_revoked" | "session_time_invalid" | "session_stale">;

/**
 * Is this host-established session allowed to act for this tenant right now?
 * Used by approval, rejection and revocation alike.
 */
export function checkOwnerSession(tenantId: string, session: AuthenticatedSession | null, trusted: TrustedOwner | null, clock: ClockReading): { ok: true } | { ok: false; reason: SessionFailure; detail: string } {
  if (!session) return { ok: false, reason: "no_owner_session", detail: "nobody is unlocked on this device" };
  if (!trusted) return { ok: false, reason: "owner_mismatch", detail: "no trusted owner registered for this tenant" };
  if (trusted.tenant_id !== tenantId || session.tenant_id !== tenantId) return { ok: false, reason: "owner_mismatch", detail: "session or registry is for another tenant" };
  if (trusted.owner_id !== session.owner_id) return { ok: false, reason: "owner_mismatch", detail: "session does not belong to this tenant's registered owner" };
  if (!trusted.trusted_device_ids.has(session.device_id)) return { ok: false, reason: "device_not_trusted", detail: `device ${session.device_id} is not in the trusted list` };
  if (!trusted.allowed_unlock.has(session.unlock)) return { ok: false, reason: "unlock_not_allowed", detail: `unlock method ${session.unlock} is not allowed` };
  if (trusted.revoked_session_ids.has(session.session_id)) return { ok: false, reason: "session_revoked", detail: `session ${session.session_id} was revoked` };
  const authAt = parseTimestamp(session.authenticated_at);
  if (authAt === null) return { ok: false, reason: "session_time_invalid", detail: "authenticated_at is not a valid timestamp" };
  if (authAt > clock.effectiveMs + SESSION_FUTURE_TOLERANCE_MS) return { ok: false, reason: "session_time_invalid", detail: "authenticated_at is in the future" };
  if (clock.effectiveMs - authAt > trusted.max_session_age_ms) return { ok: false, reason: "session_stale", detail: `owner session is older than ${trusted.max_session_age_ms} ms; unlock again` };
  return { ok: true };
}

function ownerContextOf(session: AuthenticatedSession, confirmation: Confirmation | undefined): OwnerContext {
  const ctx: OwnerContext = {
    owner_id: session.owner_id,
    device_id: session.device_id,
    unlock: session.unlock,
    session_id: session.session_id,
    authenticated_at: session.authenticated_at,
  };
  if (confirmation !== undefined) ctx.confirmation = confirmation;
  return ctx;
}

/** Pure decision. Every check the approval transaction must make, in order. The schema and digest gate runs HERE, not only in callers. */
export function decideApproval(input: ApproveInput): ApproveResult {
  const { action, session, trusted, clock, sha256 } = input;
  const env = action.envelope;
  if (action.business !== "proposed") return fail("not_proposed", `business state is ${action.business}`);
  if (action.revoked_at) return fail("revoked", `revoked at ${action.revoked_at}`);
  const verified = verifyEnvelope(env, sha256);
  if (!verified.ok) {
    const structural = verified.errors.some((m) => !m.startsWith("$.digest:"));
    return structural ? fail("invalid_envelope", verified.errors.join("; ")) : fail("digest_mismatch", "stored envelope content does not match its digest: it was edited");
  }
  if (input.renderedDigest !== env.digest) return fail("rendered_digest_mismatch", "the owner was shown something other than this envelope");
  if (env.fact_revision !== input.currentFactRevision) {
    return fail("fact_revision_mismatch", `envelope built on fact revision ${env.fact_revision}, current is ${input.currentFactRevision}`);
  }
  if (clock.suspect) return fail("clock_suspect", "device clock is behind its own high-water mark; approval held");
  if (isExpired(env.valid_until, clock.effectiveMs)) return fail("expired", `valid_until ${env.valid_until} has passed`);
  const who = checkOwnerSession(env.tenant_id, session, trusted, clock);
  if (!who.ok) return fail(who.reason, who.detail);

  const decidedAt = formatTimestamp(clock.effectiveMs);
  const approval: ApprovalRecord = {
    schema: APPROVAL_SCHEMA,
    schema_version: APPROVAL_SCHEMA_VERSION,
    approval_id: input.approvalId,
    action_id: env.action_id,
    digest: env.digest,
    fact_revision: env.fact_revision,
    decision: "approved",
    decided_at: decidedAt,
    owner_context: ownerContextOf(session!, input.confirmation),
  };
  const outbox: OutboxRow = {
    action_id: env.action_id,
    tenant_id: env.tenant_id,
    idempotency_key: idempotencyKey(env.tenant_id, env.action_id, env.digest, sha256),
    digest: env.digest,
    channel: env.recipient.channel,
    address: env.recipient.address,
    payload_json: JSON.stringify(env.payload),
    created_at: decidedAt,
  };
  const next: StoredAction = { ...action, business: "approved", transport: "queued" };
  return { ok: true, action: next, approval, outbox };
}

export function approvalRecordDigest(record: ApprovalRecord, sha256: Sha256): string {
  return digest(APPROVAL_DOMAIN, record, sha256);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Structural twin of contracts/approval-record.schema.json, for records read back from storage or a sync peer. */
export function validateApprovalRecord(input: unknown): { ok: true; value: ApprovalRecord } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, errors: ["$: must be an object"] };
  const r = input as Record<string, unknown>;
  const required = ["schema", "schema_version", "approval_id", "action_id", "digest", "fact_revision", "decision", "decided_at", "owner_context"];
  for (const k of required) if (!(k in r)) errors.push(`$.${k}: required`);
  for (const k of Object.keys(r)) if (!required.includes(k)) errors.push(`$.${k}: unknown member`);
  if (r["schema"] !== APPROVAL_SCHEMA) errors.push(`$.schema: must be "${APPROVAL_SCHEMA}"`);
  if (r["schema_version"] !== APPROVAL_SCHEMA_VERSION) errors.push(`$.schema_version: must be "${APPROVAL_SCHEMA_VERSION}"`);
  if (typeof r["approval_id"] !== "string" || !UUID.test(r["approval_id"])) errors.push("$.approval_id: must be a uuid");
  if (typeof r["action_id"] !== "string" || !UUID.test(r["action_id"])) errors.push("$.action_id: must be a uuid");
  if (typeof r["digest"] !== "string" || !SHA256_HEX.test(r["digest"])) errors.push("$.digest: must be 64 lowercase hex");
  if (typeof r["fact_revision"] !== "number" || !Number.isInteger(r["fact_revision"]) || r["fact_revision"] < 1 || r["fact_revision"] > Number.MAX_SAFE_INTEGER) errors.push("$.fact_revision: must be a positive safe integer");
  if (r["decision"] !== "approved" && r["decision"] !== "rejected") errors.push('$.decision: must be "approved" or "rejected"');
  if (typeof r["decided_at"] !== "string" || parseTimestamp(r["decided_at"]) === null) errors.push("$.decided_at: must be RFC 3339 UTC with a literal Z");
  const oc = r["owner_context"];
  if (typeof oc !== "object" || oc === null || Array.isArray(oc)) errors.push("$.owner_context: must be an object");
  else {
    const o = oc as Record<string, unknown>;
    const ocRequired = ["owner_id", "device_id", "unlock", "session_id", "authenticated_at"];
    for (const k of ocRequired) if (!(k in o)) errors.push(`$.owner_context.${k}: required`);
    for (const k of Object.keys(o)) if (!ocRequired.includes(k) && k !== "confirmation") errors.push(`$.owner_context.${k}: unknown member`);
    for (const k of ["owner_id", "device_id", "session_id"]) {
      const v = o[k];
      if (typeof v !== "string" || v.length < 1 || v.length > 128) errors.push(`$.owner_context.${k}: must be a non-empty string`);
    }
    if (!(UNLOCK_METHODS as readonly string[]).includes(o["unlock"] as string)) errors.push(`$.owner_context.unlock: must be one of ${UNLOCK_METHODS.join(", ")}; voice or text confirmation alone never authenticates`);
    if ("confirmation" in o && !(CONFIRMATIONS as readonly string[]).includes(o["confirmation"] as string)) errors.push(`$.owner_context.confirmation: must be one of ${CONFIRMATIONS.join(", ")}`);
    if (typeof o["authenticated_at"] !== "string" || parseTimestamp(o["authenticated_at"]) === null) errors.push("$.owner_context.authenticated_at: must be RFC 3339 UTC with a literal Z");
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as ApprovalRecord };
}

export type RejectResult = { ok: true; action: StoredAction; approval: ApprovalRecord } | { ok: false; reason: ApprovalFailure; detail: string };

/** Owner says no. Terminal; no outbox row is ever written. Needs the same owner session as a yes. */
export function decideRejection(action: StoredAction, session: AuthenticatedSession | null, trusted: TrustedOwner | null, clock: ClockReading, approvalId: string, confirmation?: Confirmation): RejectResult {
  if (action.business !== "proposed") return fail("not_proposed", `business state is ${action.business}`) as RejectResult;
  const env = action.envelope;
  const who = checkOwnerSession(env.tenant_id, session, trusted, clock);
  if (!who.ok) return fail(who.reason, who.detail) as RejectResult;
  return {
    ok: true,
    action: { ...action, business: "rejected" },
    approval: {
      schema: APPROVAL_SCHEMA,
      schema_version: APPROVAL_SCHEMA_VERSION,
      approval_id: approvalId,
      action_id: env.action_id,
      digest: env.digest,
      fact_revision: env.fact_revision,
      decision: "rejected",
      decided_at: formatTimestamp(clock.effectiveMs),
      owner_context: ownerContextOf(session!, confirmation),
    },
  };
}

// ---------------------------------------------------------------- persistence port

export interface AuditEntry {
  at: string;
  action_id: string;
  event: string;
  detail?: string;
}

/** One transaction. The host implements this over SQLCipher (BEGIN IMMEDIATE ... COMMIT) or PostgreSQL. */
export interface ApprovalTx {
  getAction(actionId: string): Promise<StoredAction | null>;
  getCurrentFactRevision(tenantId: string): Promise<number>;
  getTrustedOwner(tenantId: string): Promise<TrustedOwner | null>;
  /** The host's current unlocked owner session for this tenant, or null. Keystore-backed; never from request data. */
  getOwnerSession(tenantId: string): Promise<AuthenticatedSession | null>;
  /** Must fail on a second record for the same action_id. */
  insertApproval(record: ApprovalRecord): Promise<void>;
  /** Must fail on a duplicate idempotency_key. */
  insertOutbox(row: OutboxRow): Promise<void>;
  updateAction(action: StoredAction): Promise<void>;
  appendAudit(entry: AuditEntry): Promise<void>;
}

export interface ApprovalStore {
  /** Runs fn atomically: if fn throws, nothing it wrote persists. */
  transaction<T>(fn: (tx: ApprovalTx) => Promise<T>): Promise<T>;
}

export interface ApproveExactRequest {
  actionId: string;
  renderedDigest: string;
  confirmation?: Confirmation;
  clock: ClockReading;
  approvalId: string;
  sha256: Sha256;
}

export interface RevokeExactRequest {
  actionId: string;
  clock: ClockReading;
}

export type RevokeExactResult =
  | { ok: true; action: StoredAction; recalled: boolean; note: string }
  | { ok: false; reason: ApprovalFailure | "nothing_to_cancel"; detail: string };

/**
 * Revoke inside one transaction, with the owner session read from the store. The
 * action's new state and the audit line are written together. Carrier truth that
 * arrives later is still recorded by applyReceipt.
 */
export async function revokeExact(store: ApprovalStore, req: RevokeExactRequest): Promise<RevokeExactResult> {
  return store.transaction(async (tx) => {
    const action = await tx.getAction(req.actionId);
    if (!action) return { ok: false, reason: "invalid_envelope", detail: `no action ${req.actionId}` };
    const tenantId = action.envelope.tenant_id;
    const [trusted, session] = await Promise.all([tx.getTrustedOwner(tenantId), tx.getOwnerSession(tenantId)]);
    const who = checkOwnerSession(tenantId, session, trusted, req.clock);
    if (!who.ok) {
      await tx.appendAudit({ at: formatTimestamp(req.clock.effectiveMs), action_id: req.actionId, event: "revocation_refused", detail: `${who.reason}: ${who.detail}` });
      return { ok: false, reason: who.reason, detail: who.detail };
    }
    if (req.clock.suspect) {
      await tx.appendAudit({ at: formatTimestamp(req.clock.effectiveMs), action_id: req.actionId, event: "revocation_refused", detail: "clock_suspect" });
      return { ok: false, reason: "clock_suspect", detail: "device clock is behind its own high-water mark; revocation held" };
    }
    if (action.business !== "approved") return { ok: false, reason: "nothing_to_cancel", detail: `business state ${action.business}` };
    const revokedAt = formatTimestamp(req.clock.effectiveMs);
    const inFlight = action.transport === "sending" || action.transport === "send_unknown";
    const accepted = action.transport === "sent" || action.transport === "delivered";
    if (accepted) {
      await tx.appendAudit({ at: revokedAt, action_id: req.actionId, event: "cancel_requested_after_acceptance" });
      return { ok: true, action, recalled: false, note: "cancel_requested_after_acceptance" };
    }
    const next: StoredAction = { ...action, business: "revoked", revoked_at: revokedAt };
    await tx.updateAction(next);
    const note = inFlight ? "revoked_dispatch_stopped_carrier_truth_pending" : "revoked_before_dispatch";
    await tx.appendAudit({ at: revokedAt, action_id: req.actionId, event: note });
    return { ok: true, action: next, recalled: !inFlight, note };
  });
}

/**
 * Approve inside one transaction. The owner session is read from the store, not
 * from the request. Returns the refusal instead of throwing so the UI can explain
 * it; nothing is written before the decision passes, so a refusal leaves only an
 * audit line.
 */
export async function approveExact(store: ApprovalStore, req: ApproveExactRequest): Promise<ApproveResult> {
  return store.transaction(async (tx) => {
    const action = await tx.getAction(req.actionId);
    if (!action) return fail("invalid_envelope", `no action ${req.actionId}`);
    const tenantId = action.envelope.tenant_id;
    const [currentFactRevision, trusted, session] = await Promise.all([
      tx.getCurrentFactRevision(tenantId),
      tx.getTrustedOwner(tenantId),
      tx.getOwnerSession(tenantId),
    ]);
    const input: ApproveInput = { action, renderedDigest: req.renderedDigest, currentFactRevision, session, trusted, clock: req.clock, approvalId: req.approvalId, sha256: req.sha256 };
    if (req.confirmation !== undefined) input.confirmation = req.confirmation;
    const result = decideApproval(input);
    if (!result.ok) {
      await tx.appendAudit({ at: formatTimestamp(req.clock.effectiveMs), action_id: req.actionId, event: "approval_refused", detail: `${result.reason}: ${result.detail}` });
      return result;
    }
    await tx.insertApproval(result.approval);
    await tx.insertOutbox(result.outbox);
    await tx.updateAction(result.action);
    await tx.appendAudit({ at: result.approval.decided_at, action_id: req.actionId, event: "approval_and_outbox_committed" });
    return result;
  });
}
