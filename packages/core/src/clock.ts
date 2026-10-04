/**
 * Monotonic time for authority decisions.
 *
 * A device wall clock can be set backwards. If expiry were judged on the wall
 * clock alone, rolling the clock back would resurrect an expired approval, and
 * repeated small rollbacks could keep an almost-expired action alive forever.
 *
 * The store keeps the highest wall-clock value it has ever observed. ANY wall
 * clock behind that mark makes the reading suspect, which holds approval and
 * dispatch. The one way out is trustworthy elapsed time: when the host supplies
 * a monotonic counter (process uptime, CLOCK_MONOTONIC, the OS boot clock), the
 * effective time advances from the high-water mark by the elapsed amount and a
 * wall-clock rollback no longer matters. Persisted state that is not a finite
 * number is corruption and fails closed.
 */

export interface ClockState {
  /** Highest wall-clock value ever observed, ms since epoch. Persisted by the host. */
  highWaterMs: number;
  /** The host's monotonic counter at the moment highWaterMs was recorded, when the host supplies one. */
  monotonicAtHighWaterMs?: number;
}

export interface ClockReading {
  state: ClockState;
  effectiveMs: number;
  /** True when authority must be held: the wall clock went backwards and no trustworthy elapsed time explains it. */
  suspect: boolean;
}

export class ClockStateError extends RangeError {
  override readonly name = "ClockStateError";
}

/** The contract's timestamps have four-digit years: 0000-01-01T00:00:00Z .. 9999-12-31T23:59:59Z. */
export const MAX_TIMESTAMP_MS = Date.UTC(9999, 11, 31, 23, 59, 59);

/** A usable instant: finite, not before the epoch, inside the four-digit-year domain. */
function inDomain(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_TIMESTAMP_MS;
}

/** Monotonic counters are not instants: finite and non-negative is enough, but huge values must not overflow sums. */
function finiteNonNegative(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
}

/**
 * Observe the clocks. `monotonicMs` is optional; when given on consecutive calls
 * it must come from the same source and never decrease.
 */
export function observeClock(state: ClockState, wallMs: number, monotonicMs?: number): ClockReading {
  if (typeof state !== "object" || state === null || !inDomain(state.highWaterMs)) {
    throw new ClockStateError("persisted highWaterMs is not an instant inside the four-digit-year domain; refusing to decide authority");
  }
  if (state.monotonicAtHighWaterMs !== undefined && !finiteNonNegative(state.monotonicAtHighWaterMs)) {
    throw new ClockStateError("persisted monotonicAtHighWaterMs is not a finite non-negative safe number");
  }
  if (!inDomain(wallMs)) throw new ClockStateError("wall clock reading is not an instant inside the four-digit-year domain");
  if (monotonicMs !== undefined && !finiteNonNegative(monotonicMs)) throw new ClockStateError("monotonic reading is not a finite non-negative safe number");

  let effectiveMs: number;
  let suspect: boolean;
  if (monotonicMs !== undefined && state.monotonicAtHighWaterMs !== undefined && monotonicMs >= state.monotonicAtHighWaterMs) {
    // Trustworthy elapsed time: authority time advances from the mark regardless of the wall clock.
    const elapsed = monotonicMs - state.monotonicAtHighWaterMs;
    effectiveMs = Math.max(wallMs, state.highWaterMs + elapsed);
    suspect = false;
  } else {
    effectiveMs = Math.max(wallMs, state.highWaterMs);
    suspect = wallMs < state.highWaterMs; // any rollback, no tolerance
  }
  // A computed instant outside the domain (overflow, absurd elapsed time) is corruption, not a far future.
  if (!inDomain(effectiveMs)) throw new ClockStateError("computed effective time left the four-digit-year domain; refusing to decide authority");
  const next: ClockState = { highWaterMs: effectiveMs };
  if (monotonicMs !== undefined) next.monotonicAtHighWaterMs = monotonicMs;
  return { state: next, effectiveMs, suspect };
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/** Strict RFC 3339 UTC second-precision timestamp to ms, or null. Rejects 2026-02-30 and 24:00. */
export function parseTimestamp(text: string): number | null {
  const m = TIMESTAMP.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map((x) => Number(x)) as [number, number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  if (back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== s) return null;
  return ms;
}

export function formatTimestamp(ms: number): string {
  if (!inDomain(ms)) throw new ClockStateError("cannot format a time outside the four-digit-year domain");
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new ClockStateError("cannot format an invalid date");
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
}

/** True when the action's validity window has closed at the effective time. */
export function isExpired(validUntil: string, effectiveMs: number): boolean {
  const until = parseTimestamp(validUntil);
  if (until === null) return true; // an unparseable expiry is treated as expired: fail closed
  return effectiveMs >= until;
}
