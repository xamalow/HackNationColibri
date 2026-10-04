/**
 * Outbox dispatch rules. The core decides; the host's worker performs the
 * provider call and persists the result. Every function here is pure.
 *
 * The worker sends the PINNED bytes from the OutboxRow written at approval,
 * verified against the immutable ApprovalRecord, never the envelope as it
 * happens to be stored now. Queued means not dispatched. Sent means the
 * provider accepted. Delivered needs an authenticated receipt. A timeout after
 * a possible acceptance is send_unknown and is reconciled, never retried
 * blindly. Receipts never move a state backwards, a cancel that arrives after
 * acceptance cannot recall it, and revocation stops dispatch without hiding
 * carrier truth that arrives later.
 */

import { type ApprovalRecord, type AuthenticatedSession, checkOwnerSession, idempotencyKey, type OutboxRow, type SessionFailure, type StoredAction, type TrustedOwner } from "./approval.js";
import type { Sha256 } from "./canon.js";
import { type ClockReading, formatTimestamp, isExpired } from "./clock.js";
import { envelopeDigest } from "./envelope.js";
import { assertTransport, receiptAllowed } from "./states.js";

export type DispatchHold =
  | "not_approved"
  | "revoked"
  | "no_approval_record"
  | "approval_not_bound"
  | "expired"
  | "clock_suspect"
  | "fact_revision_changed"
  | "digest_mismatch"
  | "needs_reconcile"
  | "already_accepted"
  | "terminal";

/** What the transport may carry: the pinned row, not the live envelope. */
export interface PinnedSend {
  channel: OutboxRow["channel"];
  address: string;
  payload_json: string;
  idempotency_key: string;
  digest: string;
}

export type DispatchDecision = { ok: true; simulated: boolean; send: PinnedSend } | { ok: false; hold: DispatchHold; detail: string };

export interface DispatchCheckInput {
  action: StoredAction;
  /** The immutable approval record for this action, loaded by the worker. */
  approval: ApprovalRecord | null;
  /** The outbox row written in the approval transaction, loaded by the worker. */
  outbox: OutboxRow | null;
  clock: ClockReading;
  currentFactRevision: number;
  sha256: Sha256;
}

/**
 * Re-check authority immediately before a provider call. Expiry and revocation
 * are checked at dispatch, not only at approval, and the bytes to send are the
 * ones the owner approved: approval.digest == outbox.digest == envelope digest
 * recomputed from content. A business flag alone proves nothing.
 */
export function checkDispatch(input: DispatchCheckInput): DispatchDecision {
  const { action, approval, outbox, clock } = input;
  const env = action.envelope;
  if (action.business !== "approved") return { ok: false, hold: "not_approved", detail: `business state ${action.business}` };
  if (action.revoked_at) return { ok: false, hold: "revoked", detail: `revoked at ${action.revoked_at}` };
  if (!approval || !outbox) return { ok: false, hold: "no_approval_record", detail: "approved flag without an approval record and outbox row: integrity error" };
  if (approval.decision !== "approved" || approval.action_id !== env.action_id || outbox.action_id !== env.action_id || outbox.tenant_id !== env.tenant_id) {
    return { ok: false, hold: "approval_not_bound", detail: "approval record or outbox row belongs to another action" };
  }
  if (approval.digest !== outbox.digest) return { ok: false, hold: "approval_not_bound", detail: "outbox row was not written with this approval" };
  if (outbox.idempotency_key !== idempotencyKey(env.tenant_id, env.action_id, approval.digest, input.sha256)) {
    return { ok: false, hold: "approval_not_bound", detail: "outbox idempotency key is not the stable key for this approval: a fresh key per retry would defeat provider deduplication" };
  }
  if (action.transport === "sent" || action.transport === "delivered") return { ok: false, hold: "already_accepted", detail: "provider already accepted this action" };
  if (action.transport === "sending" || action.transport === "send_unknown") {
    return { ok: false, hold: "needs_reconcile", detail: "a previous attempt may have been accepted; look the status up or hold for the owner" };
  }
  if (action.transport !== "queued") return { ok: false, hold: "terminal", detail: `transport state ${action.transport}` };
  if (clock.suspect) return { ok: false, hold: "clock_suspect", detail: "device clock behind its high-water mark; dispatch held" };
  if (isExpired(env.valid_until, clock.effectiveMs)) return { ok: false, hold: "expired", detail: `valid_until ${env.valid_until} passed` };
  if (env.fact_revision !== input.currentFactRevision) {
    return { ok: false, hold: "fact_revision_changed", detail: `built on ${env.fact_revision}, current ${input.currentFactRevision}; held for re-approval` };
  }
  if (env.digest !== approval.digest) return { ok: false, hold: "digest_mismatch", detail: "stored envelope is not the one the owner approved" };
  if (envelopeDigest(env, input.sha256) !== approval.digest) return { ok: false, hold: "digest_mismatch", detail: "stored content no longer matches the approved digest" };
  if (JSON.stringify(env.payload) !== outbox.payload_json || env.recipient.address !== outbox.address || env.recipient.channel !== outbox.channel) {
    return { ok: false, hold: "digest_mismatch", detail: "pinned outbox bytes differ from the stored envelope" };
  }
  return {
    ok: true,
    simulated: outbox.channel === "simulated",
    send: { channel: outbox.channel, address: outbox.address, payload_json: outbox.payload_json, idempotency_key: outbox.idempotency_key, digest: outbox.digest },
  };
}

/** Record the attempt BEFORE the provider call, so a crash mid-call leaves `sending`, which forces reconciliation. */
export function beginDispatch(action: StoredAction): StoredAction {
  assertTransport(action.transport, "sending");
  return { ...action, transport: "sending", attempts: action.attempts + 1 };
}

/**
 * At process start, or when a dispatch lease expires: a row still in `sending`
 * had its call interrupted. Nobody knows whether the provider accepted, so it is
 * send_unknown, to be reconciled, never requeued blindly.
 */
export function recoverAfterRestart(action: StoredAction): StoredAction {
  if (action.transport !== "sending") return action;
  return { ...action, transport: "send_unknown" };
}

/** Provider accepted. For the simulated channel the reference is prefixed so the UI can never show it as a real send. */
export function recordAcceptance(action: StoredAction, providerRef: string): StoredAction {
  assertTransport(action.transport, "sent");
  const simulated = action.envelope.recipient.channel === "simulated";
  const ref = simulated && !providerRef.startsWith("simulated:") ? `simulated:${providerRef}` : providerRef;
  return { ...action, transport: "sent", provider_ref: ref };
}

/**
 * The provider call ended without a usable acceptance.
 * `provenNotAccepted` must be true only for errors that prove nothing was sent
 * (connection refused before the request, a 4xx with no message id). Anything
 * ambiguous (timeout, 5xx after the body went out, lost response) is send_unknown.
 */
export function recordFailure(action: StoredAction, provenNotAccepted: boolean): StoredAction {
  const to = provenNotAccepted ? "failed" : "send_unknown";
  assertTransport(action.transport, to);
  return { ...action, transport: to };
}

export const DEFAULT_RETRY_BUDGET = 5;

/** Bounded retry with the same idempotency key. Only from a PROVEN failure, and only while still approved. */
export function retry(action: StoredAction, budget: number = DEFAULT_RETRY_BUDGET): StoredAction | null {
  if (action.business !== "approved") return null;
  if (action.transport !== "failed") return null;
  if (action.attempts >= budget) return null;
  assertTransport(action.transport, "queued");
  return { ...action, transport: "queued" };
}

export interface ProviderReceipt {
  /** Provider's own event id, unique per callback. Used to drop duplicates. */
  provider_event_id: string;
  provider_ref: string;
  status: "sent" | "delivered" | "failed_proven";
}

export interface ReceiptOutcome {
  action: StoredAction;
  applied: boolean;
  reason: "applied" | "duplicate" | "wrong_reference" | "would_regress" | "not_dispatched";
  /** The seen-set to persist together with `action`, in one transaction. Unchanged unless applied. */
  seen: ReadonlySet<string>;
}

/**
 * Apply an authenticated provider receipt. Pure: the input seen-set is never
 * mutated; the returned one must be persisted atomically with the action.
 * Bindings are validated BEFORE the duplicate check, so a receipt rejected for a
 * wrong reference does not poison a corrected retry. Monotonic by rank; a
 * delivered receipt may arrive before sent and is applied, because delivery
 * proves acceptance. Receipts are recorded in ANY business state once a dispatch
 * happened: revoking an action while it was sending must not hide the fact that
 * the carrier accepted it. Authentication of the callback is the host's job and
 * must happen before this is called.
 */
export function applyReceipt(action: StoredAction, receipt: ProviderReceipt, seenEventIds: ReadonlySet<string>): ReceiptOutcome {
  const unchanged = (reason: ReceiptOutcome["reason"]): ReceiptOutcome => ({ action, applied: false, reason, seen: seenEventIds });
  if (action.transport === "none" || action.transport === "queued") return unchanged("not_dispatched");
  if (action.provider_ref !== null && action.provider_ref !== receipt.provider_ref) return unchanged("wrong_reference");
  if (seenEventIds.has(receipt.provider_event_id)) return unchanged("duplicate");
  let next: StoredAction;
  if (receipt.status === "failed_proven") {
    if (action.transport !== "send_unknown") return unchanged("would_regress");
    next = { ...action, transport: "failed" };
  } else {
    if (!receiptAllowed(action.transport, receipt.status)) return unchanged("would_regress");
    next = { ...action, transport: receipt.status, provider_ref: action.provider_ref ?? receipt.provider_ref };
  }
  const seen = new Set(seenEventIds);
  seen.add(receipt.provider_event_id);
  return { action: next, applied: true, reason: "applied", seen };
}

export interface CancelOutcome {
  action: StoredAction;
  /** True only when no acceptance can exist: nothing was ever in flight. */
  recalled: boolean;
  /** Audit text for the host. */
  note: "revoked_before_dispatch" | "revoked_dispatch_stopped_carrier_truth_pending" | "cancel_requested_after_acceptance" | "nothing_to_cancel";
}

export type RevocationResult = { ok: true; outcome: CancelOutcome } | { ok: false; reason: SessionFailure | "clock_suspect"; detail: string };

/**
 * Owner revokes an approved action. Revocation is an owner act: it needs the
 * same host-established owner session as approval, and a trusted clock. Before
 * any dispatch it is a guaranteed recall. While sending or send_unknown, dispatch
 * stops (business revoked) but recall is NOT guaranteed: a late acceptance will
 * still be recorded by applyReceipt and the UI must say so. After acceptance
 * nothing can be recalled.
 */
export function decideRevocation(action: StoredAction, session: AuthenticatedSession | null, trusted: TrustedOwner | null, clock: ClockReading): RevocationResult {
  const who = checkOwnerSession(action.envelope.tenant_id, session, trusted, clock);
  if (!who.ok) return { ok: false, reason: who.reason, detail: who.detail };
  if (clock.suspect) return { ok: false, reason: "clock_suspect", detail: "device clock is behind its own high-water mark; revocation held" };
  return { ok: true, outcome: applyRevocation(action, clock) };
}

/** The pure state transition. Internal: callers go through decideRevocation (owner session) or revokeExact (transaction). */
export function applyRevocation(action: StoredAction, clock: ClockReading): CancelOutcome {
  if (action.business !== "approved") return { action, recalled: false, note: "nothing_to_cancel" };
  const revoked: StoredAction = { ...action, business: "revoked", revoked_at: formatTimestamp(clock.effectiveMs) };
  switch (action.transport) {
    case "none":
    case "queued":
    case "failed":
      return { action: revoked, recalled: true, note: "revoked_before_dispatch" };
    case "sending":
    case "send_unknown":
      return { action: revoked, recalled: false, note: "revoked_dispatch_stopped_carrier_truth_pending" };
    case "sent":
    case "delivered":
      return { action, recalled: false, note: "cancel_requested_after_acceptance" };
  }
}

/** What the UI may say. Never "sent" for queued, never "delivered" for sent, never a real send for simulated. */
export function transportLabel(action: StoredAction): "queued_waiting_for_signal" | "sending" | "sent_simulated" | "sent" | "delivered" | "send_unknown" | "failed" | "not_sent" {
  if (action.transport === "none") return "not_sent";
  if (action.business !== "approved" && (action.transport === "queued" || action.transport === "failed")) return "not_sent";
  switch (action.transport) {
    case "queued":
      return "queued_waiting_for_signal";
    case "sending":
      return "sending";
    case "sent":
      return action.envelope.recipient.channel === "simulated" ? "sent_simulated" : "sent";
    case "delivered":
      return "delivered";
    case "send_unknown":
      return "send_unknown";
    case "failed":
      return "failed";
  }
}
