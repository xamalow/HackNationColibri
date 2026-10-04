/**
 * Canonical value of one number token, so a translation can be compared by VALUE (codex-mobile #48):
 * - "9:30" (a time) stays as written;
 * - "2,000" / "2.000" / "2000" are the same integer: every group after the first has exactly 3 digits;
 * - "1.5" / "1,5" are the same decimal, and differ from "15": a last group that is not 3 digits is a decimal part.
 * Ambiguous forms resolve to the reading that keeps the most digits apart ("1.500" -> 1500), so a doubtful
 * translation fails the check and is hidden rather than shown as reliable.
 */
export function canonicalNumber(token: string): string {
  if (token.includes(':')) return token;
  const groups = token.split(/[.,]/);
  if (groups.length === 1) return String(Number(token));
  const last = groups[groups.length - 1];
  if (groups.slice(1).every((g) => g.length === 3)) return String(Number(groups.join('')));
  const intPart = groups.slice(0, -1).join('');
  return `${Number(intPart)}.${last}`;
}

export const numbersOf = (s: string): string[] => (s.match(/\d+(?:[.,:]\d+)*/g) ?? []).map(canonicalNumber);

/** Same numbers, same number of times: a dropped, added, duplicated or changed number (or decimal) fails. */
export function sameNumbers(original: string, translated: string): boolean {
  const a = numbersOf(original).sort();
  const b = numbersOf(translated).sort();
  return a.length === b.length && a.every((d, i) => d === b[i]);
}
