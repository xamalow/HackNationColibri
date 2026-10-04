export type DispatchGateResult<T> = { accepted: true; value: T } | { accepted: false };

export function shouldRecoverInterruptedDispatch(actionId: string, transport: string, activeActionIds: ReadonlySet<string>): boolean {
  return transport === 'sending' && !activeActionIds.has(actionId);
}

/** Prevents the same approved action from reaching a provider twice in one process at once. */
export async function withDispatchGuard<T>(
  activeActionIds: Set<string>,
  actionId: string,
  dispatch: () => Promise<T>,
): Promise<DispatchGateResult<T>> {
  if (!actionId.trim()) throw new Error('An action ID is required.');
  if (activeActionIds.has(actionId)) return { accepted: false };
  activeActionIds.add(actionId);
  try {
    return { accepted: true, value: await dispatch() };
  } finally {
    activeActionIds.delete(actionId);
  }
}
