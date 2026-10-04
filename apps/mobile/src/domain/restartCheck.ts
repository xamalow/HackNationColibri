/**
 * In-app restart check (warden #47810, judged exit criterion "the approved queue survives restart").
 *
 * After a force-close and relaunch, an approved item in Ujumbe (Outbox) must be the same item, with the same digest,
 * still waiting. Pure: the caller supplies the digests and the time this app process started, so node tests can run it.
 */

/** When this JS process started. A force-close + relaunch starts a new process, so anything older came from disk. */
export const PROCESS_STARTED_AT_MS = Date.now();

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
  processStartedAtMs: number;
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
  const survived = Number.isFinite(approvedMs) && approvedMs < input.processStartedAtMs;
  return { kind: survived ? 'survived' : 'same_session', digestOk, waiting };
}

/** First 8 hex characters, for display next to the full digest. */
export const shortDigest = (digest: string) => digest.slice(0, 8);
