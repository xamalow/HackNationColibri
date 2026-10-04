const DECIMAL_BLOCKS = [
  0x0030, 0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66,
  0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946,
  0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0,
  0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30, 0x11066, 0x110f0, 0x11136, 0x111d0,
  0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0, 0x11730, 0x118e0, 0x11950, 0x11c50, 0x11d50,
  0x11da0, 0x16a60, 0x16ac0, 0x16b50, 0x1d7ce, 0x1e140, 0x1e2f0, 0x1e950, 0x1fbf0,
];

type Rune = { codePoint: number; digit: number | null; word: boolean };

function digitValue(codePoint: number): number | null {
  for (const start of DECIMAL_BLOCKS) {
    const offset = codePoint - start;
    if (offset >= 0 && offset < (start === 0x1d7ce ? 50 : 10)) return offset % 10;
  }
  return null;
}

function toRunes(text: string): Rune[] {
  const runes: Rune[] = [];
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const rune = String.fromCodePoint(codePoint);
    runes.push({
      codePoint,
      digit: digitValue(codePoint),
      // Python's Unicode \w is letters, numbers and underscore. Combining marks
      // are not alphanumeric under str.isalnum(), so they are intentionally omitted.
      word: rune === '_' || /[\p{L}\p{N}]/u.test(rune),
    });
    index += rune.length;
  }
  return runes;
}

function normalizedNumbers(text: string): string[] {
  const runes = toRunes(text);
  const separators = new Set([0x002c, 0x002e, 0x0020, 0x00a0, 0x202f]);
  const skipped = new Set<number>();
  for (let index = 1; index + 3 < runes.length; index++) {
    if (!separators.has(runes[index].codePoint) || runes[index - 1].digit === null) continue;
    if (runes[index + 1].digit === null || runes[index + 2].digit === null || runes[index + 3].digit === null) continue;
    if (index + 4 < runes.length && runes[index + 4].word) continue;
    skipped.add(index);
  }

  const numbers: string[] = [];
  let current = '';
  const flush = () => {
    if (!current) return;
    numbers.push(current.replace(/^0+(?=\d)/, ''));
    current = '';
  };
  for (let index = 0; index < runes.length; index++) {
    if (skipped.has(index)) continue;
    const digit = runes[index].digit;
    if (digit === null) flush();
    else current += String(digit);
  }
  flush();
  return numbers.sort((left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0));
}

/** Exact port of contrib/max/translation_eval.py::number_guard (Unicode decimal digits). */
export function numberGuard(source: string, translation: string): boolean {
  const sourceNumbers = normalizedNumbers(source);
  const translatedNumbers = normalizedNumbers(translation);
  return sourceNumbers.length === translatedNumbers.length && sourceNumbers.every((value, index) => value === translatedNumbers[index]);
}
