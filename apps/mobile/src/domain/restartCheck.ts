/**
 * In-app restart check (warden #47810, judged exit criterion "the approved queue survives restart").
 *
 * After a force-close and relaunch, an approved item in Ujumbe (Outbox) must be the same item, with the same digest,
 * still waiting. Pure: the caller supplies the digests and the time this app process started, so node tests can run it.
 */

export type RestartCheckInput = {
  /** Digest recomputed now from the stored envelope. */
  envelopeDigest: string;
  /** The digest the approval record names. */
  approvalDigest: string | null;
  /** The digest pinned in the outbox row, written in the same transaction as the approval. */
  outboxDigest: string | null;
  /** approval.decided_at (ISO 8601). */
  approvedAt: string | null;
  transport: string;
  /** From src/domain/processStart.ts, taken at app boot. */
  processStartedAtMs: number;
  /** True when this JS process approved the action itself: never a restart proof, whatever the clocks say. */
  approvedThisProcess: boolean;
};

export type RestartCheck =
  | { kind: 'not_approved' }
  /** Approved during this app session: nothing to prove yet; force-close and reopen. */
  | { kind: 'same_session'; digestOk: boolean; waiting: boolean }
  /** Approved before this app session started, so it was read back from the encrypted database. */
  | { kind: 'survived'; digestOk: boolean; waiting: boolean };

export function restartCheck(input: RestartCheckInput): RestartCheck {
  if (!input.approvalDigest || !input.approvedAt) return { kind: 'not_approved' };
  const digestOk =
    input.approvalDigest === input.envelopeDigest && input.outboxDigest !== null && input.outboxDigest === input.envelopeDigest;
  const waiting = input.transport === 'queued';
  const approvedMs = Date.parse(input.approvedAt);
  // decided_at has whole seconds and the boot time has milliseconds: a same-second approval never counts.
  const survived = !input.approvedThisProcess && Number.isFinite(approvedMs) && approvedMs + 1000 <= input.processStartedAtMs;
  return { kind: survived ? 'survived' : 'same_session', digestOk, waiting };
}

/** First 8 hex characters, for display next to the full digest. */
export const shortDigest = (digest: string) => digest.slice(0, 8);
