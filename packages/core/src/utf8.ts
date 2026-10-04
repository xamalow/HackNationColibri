/**
 * Minimal, strict UTF-8 encode/decode.
 *
 * Why not TextEncoder/TextDecoder: evidence spans are UTF-8 BYTE offsets into an
 * immutable original, and the core must be able to say "this offset is not on a
 * character boundary" on every runtime, including a React Native JS engine
 * without the Encoding API. Strict decoding (no replacement characters) is what
 * makes "quote equals the exact slice" a real check.
 */

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        i++;
      } else {
        throw new RangeError(`lone high surrogate at index ${i}`);
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      throw new RangeError(`lone low surrogate at index ${i}`);
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}

/** Strict decode. Returns null on any malformed sequence instead of U+FFFD. */
export function utf8DecodeStrict(bytes: Uint8Array): string | null {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let cp: number;
    let need: number;
    if (b0 < 0x80) {
      cp = b0;
      need = 0;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      cp = b0 & 0x1f;
      need = 1;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      cp = b0 & 0x0f;
      need = 2;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      cp = b0 & 0x07;
      need = 3;
    } else {
      return null;
    }
    for (let k = 1; k <= need; k++) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (b & 0x3f);
    }
    // Reject overlong forms, surrogates and out-of-range code points.
    if (need === 2 && cp < 0x800) return null;
    if (need === 3 && (cp < 0x10000 || cp > 0x10ffff)) return null;
    if (cp >= 0xd800 && cp <= 0xdfff) return null;
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

/** True when `offset` is 0, the end, or the first byte of a UTF-8 sequence. */
export function isCharBoundary(bytes: Uint8Array, offset: number): boolean {
  if (offset === 0 || offset === bytes.length) return true;
  if (offset < 0 || offset > bytes.length) return false;
  const b = bytes[offset]!;
  return (b & 0xc0) !== 0x80;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new RangeError("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
