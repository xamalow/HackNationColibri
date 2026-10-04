/**
 * Canonical JSON (RFC 8785) and domain-separated digests.
 *
 * Two devices, or a phone and a server, must compute the same digest for the same
 * envelope, or an approval given on one cannot be checked on the other.
 * JSON.stringify with sorted keys is not a standard and differs across languages
 * in number and string escaping. RFC 8785 is, and the `canonicalize` package is
 * its reference implementation. The Python reference in sauti/core/canon.py uses
 * rfc8785; contracts/fixtures/digest-vectors.json pins that both agree.
 *
 * No floats anywhere: an approval must never depend on how 0.1 was rounded.
 * Envelopes carry integers and strings only.
 */

import canonicalize from "canonicalize";

import { concatBytes, utf8Encode } from "./utf8.js";

export const ENVELOPE_DOMAIN = "sauti.action_envelope.v1";
export const APPROVAL_DOMAIN = "sauti.approval_record.v1";
export const SOURCE_DOMAIN = "sauti.source_text.v1";

/** sha256 over bytes, lowercase hex. Supplied by the host (node:crypto, react-native-quick-crypto, ...). */
export type Sha256 = (bytes: Uint8Array) => string;

export class CanonError extends Error {
  override readonly name = "CanonError";
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function check(value: unknown, path: string): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonError(`${path}: non-finite number`);
    if (!Number.isInteger(value)) throw new CanonError(`${path}: floats are not allowed in envelopes; use integer units`);
    if (Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new CanonError(`${path}: integer outside the exactly representable range`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => check(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) throw new CanonError(`${path}.${key}: undefined is not JSON`);
      check(item, `${path}.${key}`);
    }
    return;
  }
  throw new CanonError(`${path}: unsupported type ${typeof value}`);
}

/** RFC 8785 bytes of a value made of objects, arrays, strings, integers, booleans and null. */
export function canonicalBytes(value: unknown): Uint8Array {
  check(value, "$");
  const text = canonicalize(value);
  if (typeof text !== "string") throw new CanonError("canonicalize produced no output");
  return utf8Encode(text);
}

/** Lowercase hex sha256 over domain || 0x00 || canonical JSON. */
export function digest(domain: string, value: unknown, sha256: Sha256): string {
  if (!domain || domain.includes("\u0000")) throw new CanonError("domain must be non-empty and contain no NUL");
  return sha256(concatBytes(utf8Encode(domain), Uint8Array.of(0), canonicalBytes(value)));
}

/** Digest of an immutable original source text (a review, a message). */
export function sourceTextHash(text: string, sha256: Sha256): string {
  return sha256(concatBytes(utf8Encode(SOURCE_DOMAIN), Uint8Array.of(0), utf8Encode(text)));
}
