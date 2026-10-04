export type ExclusiveResult<T> = { accepted: true; value: T } | { accepted: false };

/** Synchronously claims a UI action key so rapid presses cannot run the same async action twice. */
export async function runExclusive<T>(
  active: Set<string>,
  key: string,
  operation: () => Promise<T>,
  onChange?: (activeKeys: Set<string>) => void,
): Promise<ExclusiveResult<T>> {
  if (!key.trim()) throw new Error('An action key is required.');
  if (active.has(key)) return { accepted: false };
  active.add(key);
  onChange?.(new Set(active));
  try {
    return { accepted: true, value: await operation() };
  } finally {
    active.delete(key);
    onChange?.(new Set(active));
  }
}
