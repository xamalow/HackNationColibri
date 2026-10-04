/**
 * When this JS process booted, and which actions it approved itself (warden review of #97).
 *
 * Imported FIRST by src/app/_layout.tsx, so the time is taken at app boot, not when a lazily loaded screen first
 * renders. The set is the clock-free guard: an action approved by this process can never count as "survived a restart".
 */
export const PROCESS_STARTED_AT_MS = Date.now();

const approvedThisProcess = new Set<string>();

export function markApprovedThisProcess(actionId: string): void {
  approvedThisProcess.add(actionId);
}

export function wasApprovedThisProcess(actionId: string): boolean {
  return approvedThisProcess.has(actionId);
}
