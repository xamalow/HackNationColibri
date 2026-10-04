import * as Crypto from 'expo-crypto';
import * as SMS from 'expo-sms';
import {
  approveExact,
  beginDispatch,
  checkDispatch,
  envelopeDigest,
  formatTimestamp,
  recordAcceptance,
  recordFailure,
  recoverAfterRestart,
  revokeExact,
  type StoredAction,
} from '@sauti/core';
import { appendAudit, approvalStore, coreDb, getApprovalAndOutbox, listActions, readClock, saveAction, sha256, TENANT_ID } from './coreDb';
import { unlockWithPin, type UnlockResult } from './pin';
import { isApprovalConflict } from './approvalErrors';

/** At app start: a dispatch interrupted by a crash or force-quit becomes send_unknown, never re-sent blindly. */
export async function recoverInterruptedSends(): Promise<number> {
  let recovered = 0;
  for (const action of await listActions()) {
    if (action.transport !== 'sending') continue;
    await saveAction(recoverAfterRestart(action));
    recovered += 1;
  }
  return recovered;
}

export type ApproveOutcome = { ok: true } | { ok: false; reason: string; unlock?: UnlockResult };

/**
 * Noor approves EXACTLY what she was shown. The digest is recomputed from the envelope the screen rendered;
 * the PIN opens a session; the core checks digest, fact revision, expiry, clock and session, then writes the
 * approval record, the business state and the outbox row in ONE SQLCipher transaction.
 */
export async function approveWithPin(rendered: StoredAction, pin: string): Promise<ApproveOutcome> {
  const unlock = await unlockWithPin(pin);
  if (!unlock.ok) return { ok: false, reason: unlock.reason, unlock };
  const clock = await readClock();
  try {
    const result = await approveExact(await approvalStore(), {
      actionId: rendered.envelope.action_id,
      renderedDigest: envelopeDigest(rendered.envelope, sha256),
      confirmation: 'tap',
      clock,
      approvalId: Crypto.randomUUID(),
      sha256,
    });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  } catch (error) {
    if (isApprovalConflict(error)) return { ok: false, reason: 'approval_conflict' };
    throw error;
  }
}

export async function revokeWithPin(action: StoredAction, pin: string): Promise<ApproveOutcome> {
  const unlock = await unlockWithPin(pin);
  if (!unlock.ok) return { ok: false, reason: unlock.reason, unlock };
  const result = await revokeExact(await approvalStore(), { actionId: action.envelope.action_id, clock: await readClock() });
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

export async function rejectProposal(action: StoredAction): Promise<void> {
  const clock = await readClock();
  await saveAction({ ...action, business: 'rejected' });
  await appendAudit({ at: formatTimestamp(clock.effectiveMs), action_id: action.envelope.action_id, event: 'rejected_by_owner' });
}

async function currentFactRevision(): Promise<number> {
  const db = await coreDb();
  const row = (await db.execute('SELECT revision FROM sauti_facts WHERE tenant_id = ?;', [TENANT_ID])).rows[0];
  return typeof row?.revision === 'number' ? row.revision : 1;
}

export type DispatchOutcome = { ok: true; action: StoredAction } | { ok: false; reason: string };

/**
 * Send ONE approved action, only the pinned bytes the core hands back (check.send).
 * - simulated: accepted locally with a 'simulated:' reference; the UI can never show it as a real send.
 * - sms: opens the iPhone's own Messages screen prefilled; Noor taps Send there (Carter 23:49 UTC).
 *   'sent' = handed to Messages; there is no delivery receipt for this channel.
 */
export async function dispatch(action: StoredAction): Promise<DispatchOutcome> {
  const { approval, outbox } = await getApprovalAndOutbox(action.envelope.action_id);
  const check = checkDispatch({ action, approval, outbox, clock: await readClock(), currentFactRevision: await currentFactRevision(), sha256 });
  if (!check.ok) return { ok: false, reason: `${check.hold}: ${check.detail}` };
  let current = beginDispatch(action);
  await saveAction(current); // persisted BEFORE the provider call
  const channel = action.envelope.recipient.channel;
  try {
    if (channel === 'simulated') {
      current = recordAcceptance(current, `simulated:${Date.now()}`);
    } else if (channel === 'sms') {
      if (!(await SMS.isAvailableAsync())) throw Object.assign(new Error('sms_unavailable'), { provenNotAccepted: true });
      const payload = JSON.parse(check.send.payload_json) as { body: string };
      const { result } = await SMS.sendSMSAsync([check.send.address], payload.body);
      if (result === 'sent') current = recordAcceptance(current, `ios-messages:${Date.now()}`);
      else if (result === 'cancelled') current = recordFailure(current, true);
      else current = recordFailure(current, false); // 'unknown': never assume it was not sent
    } else {
      throw Object.assign(new Error(`channel ${channel} has no adapter in v1`), { provenNotAccepted: true });
    }
  } catch (error) {
    const proven = Boolean((error as { provenNotAccepted?: boolean }).provenNotAccepted);
    current = recordFailure(current, proven);
  }
  await saveAction(current);
  return { ok: true, action: current };
}
