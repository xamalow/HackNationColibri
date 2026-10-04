/** Number tokens in a text: "2,000" and "2000" are the same token; "9:30" stays one token. */
export const numbersOf = (s: string): string[] => (s.match(/\d+(?:[.,:]\d+)*/g) ?? []).map((d) => d.replace(/[.,]/g, ''));

/** Same numbers, same number of times (codex-mobile #48): a dropped, added, duplicated or changed number fails. */
export function sameNumbers(original: string, translated: string): boolean {
  const a = numbersOf(original).sort();
  const b = numbersOf(translated).sort();
  return a.length === b.length && a.every((d, i) => d === b[i]);
}
