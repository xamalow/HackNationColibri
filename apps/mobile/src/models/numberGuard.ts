type NumberToken = {
  raw: string;
  canonical: string | null;
};

const TOKEN_PATTERN = /\d+(?:[.,:]\d+)*/gu;
const SIGN_CHARS = new Set(['+', '-', '−']);

function blocksSign(value: string | undefined): boolean {
  return value !== undefined && /[\d+\-−]/u.test(value);
}

function canonicalDigits(value: string): string {
  return value.replace(/^0+(?=\d)/u, '');
}

function canonicalDecimal(sign: string, whole: string, fraction: string): string {
  const normalizedWhole = canonicalDigits(whole);
  const normalizedFraction = fraction.replace(/0+$/u, '');
  return `n:${sign}${normalizedWhole}${normalizedFraction ? `.${normalizedFraction}` : ''}`;
}

function validGroupedInteger(value: string, separator: ',' | '.'): string | null {
  const groups = value.split(separator);
  if (
    groups.length < 2 || !/^\d{1,3}$/u.test(groups[0] ?? '') ||
    groups.slice(1).some((group) => !/^\d{3}$/u.test(group))
  ) return null;
  return canonicalDigits(groups.join(''));
}

function canonicalNumber(raw: string): string | null {
  const sign = raw[0] === '-' || raw[0] === '−' ? '-' : raw[0] === '+' ? '+' : '';
  const unsigned = sign ? raw.slice(1) : raw;
  if (unsigned.includes(':')) return null; // Times are only accepted when their spelling is unchanged.

  const commas = [...unsigned.matchAll(/,/gu)].map((match) => match.index ?? -1);
  const dots = [...unsigned.matchAll(/\./gu)].map((match) => match.index ?? -1);
  if (commas.length === 0 && dots.length === 0) return `n:${sign}${canonicalDigits(unsigned)}`;

  if (commas.length > 0 && dots.length > 0) {
    const decimalSeparator = (commas.at(-1) ?? -1) > (dots.at(-1) ?? -1) ? ',' : '.';
    const groupingSeparator = decimalSeparator === ',' ? '.' : ',';
    const decimalAt = unsigned.lastIndexOf(decimalSeparator);
    const whole = unsigned.slice(0, decimalAt);
    const fraction = unsigned.slice(decimalAt + 1);
    if (!/^\d+$/u.test(fraction) || !whole.includes(groupingSeparator)) return null;
    const groupedWhole = validGroupedInteger(whole, groupingSeparator);
    return groupedWhole === null ? null : canonicalDecimal(sign, groupedWhole, fraction);
  }

  const separator = commas.length > 0 ? ',' : '.';
  const positions = commas.length > 0 ? commas : dots;
  if (positions.length > 1) {
    const grouped = validGroupedInteger(unsigned, separator);
    return grouped === null ? null : `n:${sign}${grouped}`;
  }

  const decimalAt = positions[0] ?? -1;
  const whole = unsigned.slice(0, decimalAt);
  const fraction = unsigned.slice(decimalAt + 1);
  if (!/^\d+$/u.test(whole) || !/^\d+$/u.test(fraction)) return null;

  // A single separator followed by three digits can mean either decimal or grouping.
  // Preserve the exact token, but reject attempts to compare it with a changed spelling.
  if (fraction.length === 3 && whole.length <= 3) return null;
  return canonicalDecimal(sign, whole, fraction);
}

function readNumbers(text: string): NumberToken[] {
  const values: NumberToken[] = [];
  TOKEN_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const start = match.index ?? 0;
    const numeric = match[0];
    const signCandidate = text[start - 1];
    const beforeSign = text[start - 2];
    const hasSign = signCandidate !== undefined && SIGN_CHARS.has(signCandidate) && !blocksSign(beforeSign);
    const raw = `${hasSign ? signCandidate : ''}${numeric}`;
    values.push({ raw, canonical: canonicalNumber(raw) });
  }
  return values;
}

/**
 * Conservatively checks that a translation preserved each numeric token in the same order.
 * It uses decimal strings rather than Number, so large values never round in JavaScript.
 */
export function sameNumbers(source: string, candidate: string): boolean {
  const expected = readNumbers(source);
  const actual = readNumbers(candidate);
  if (expected.length !== actual.length) return false;

  return expected.every((token, index) => {
    const other = actual[index];
    if (!other) return false;
    if (token.raw === other.raw) return true;
    return token.canonical !== null && token.canonical === other.canonical;
  });
}
