export type DispatchCandidate = {
  business: string;
  transport: string;
  envelope: { recipient: { channel: string } };
};

export type RetryAction<T> = (action: T) => T | null;

export type PreparedDispatch<T> =
  | { ok: true; action: T; retried: boolean }
  | { ok: false; reason: 'retry_limit' };

/** Only a Core retry transition may turn a proven failure back into a dispatchable action. */
export function prepareDispatchAction<T extends DispatchCandidate>(action: T, retryAction: RetryAction<T>): PreparedDispatch<T> {
  if (action.transport !== 'failed') return { ok: true, action, retried: false };
  const retried = retryAction(action);
  return retried ? { ok: true, action: retried, retried: true } : { ok: false, reason: 'retry_limit' };
}

/** Whether the Outbox should render an actionable Send control for this exact persisted state. */
export function canDispatchAction<T extends DispatchCandidate>(action: T, retryAction: RetryAction<T>): boolean {
  if (action.business !== 'approved' || action.envelope.recipient.channel === 'local') return false;
  if (action.transport === 'queued') return true;
  return action.transport === 'failed' && retryAction(action) !== null;
}
