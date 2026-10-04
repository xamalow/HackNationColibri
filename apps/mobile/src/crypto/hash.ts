import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export function sha256Text(value: string): string {
  return bytesToHex(sha256(utf8ToBytes(value)));
}

function strictUtf8Bytes(value: string): Uint8Array {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new RangeError(`lone high surrogate at index ${index}`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new RangeError(`lone low surrogate at index ${index}`);
    }
  }
  return utf8ToBytes(value);
}

/** Frozen Domain source_text.v1 digest: SHA-256(domain || NUL || strict UTF-8 source). */
export function sourceTextHash(value: string): string {
  const prefix = utf8ToBytes('sauti.source_text.v1\u0000');
  const text = strictUtf8Bytes(value);
  const input = new Uint8Array(prefix.length + text.length);
  input.set(prefix);
  input.set(text, prefix.length);
  return bytesToHex(sha256(input));
}

export function newSha256() {
  return sha256.create();
}

export { bytesToHex };
