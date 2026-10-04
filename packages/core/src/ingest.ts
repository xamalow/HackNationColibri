/**
 * Immutable source ingest. A review or message enters the system once, keeps
 * its original text and hash forever, and is never overwritten by a display
 * copy. Duplicates (same source and external id) are reported, not re-stored,
 * so a second sync after a restart cannot inflate anything downstream.
 */

import { type Sha256, sourceTextHash } from "./canon.js";
import type { SourceText } from "./evidence.js";

export const SOURCE_TYPES = ["direct_review", "google_review", "getyourguide_review", "tourist_message", "noor_note", "guide_note"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export interface IncomingMessage {
  id: string;
  source: string;
  external_id: string;
  received_at: string;
  text: string;
  author?: string;
  /** What the source declares. Not proof of the language. */
  lang?: string;
}

export interface StoredSource extends SourceText {
  source_type: SourceType;
  external_id: string;
  received_at: string;
  author?: string;
}

export type IngestReason = "invalid_message" | "unknown_source_type";

export interface IngestResult {
  sources: Map<string, StoredSource>;
  /** Ids of later copies of an already stored (source, external_id). First copy wins. */
  duplicates: string[];
  rejected: Array<{ message_id: string; reason: IngestReason }>;
}

export const MAX_SOURCE_BYTES = 16 * 1024;

function isNonEmptyString(v: unknown, max = 4096): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

/**
 * Store what is well formed, report what is not. Never throws on model or sync input.
 * `existing` is what the store already holds: a later sync of the same (source, external_id) is a duplicate.
 */
export function ingestMessages(messages: readonly unknown[], sha256: Sha256, existing: ReadonlyMap<string, StoredSource> = new Map()): IngestResult {
  const result: IngestResult = { sources: new Map(), duplicates: [], rejected: [] };
  const seenExternal = new Set<string>();
  for (const s of existing.values()) seenExternal.add(`${s.source_type}|${s.external_id}`);
  for (const raw of messages) {
    const m = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<IncomingMessage>;
    const id = isNonEmptyString(m.id, 128) ? m.id : null;
    if (id === null) {
      result.rejected.push({ message_id: String((m as { id?: unknown }).id ?? "?"), reason: "invalid_message" });
      continue;
    }
    if (!isNonEmptyString(m.source, 64) || !isNonEmptyString(m.external_id, 256) || typeof m.text !== "string" || m.text.trim().length === 0 || m.text.length > MAX_SOURCE_BYTES || !isNonEmptyString(m.received_at, 40)) {
      result.rejected.push({ message_id: id, reason: "invalid_message" });
      continue;
    }
    if (!(SOURCE_TYPES as readonly string[]).includes(m.source)) {
      result.rejected.push({ message_id: id, reason: "unknown_source_type" });
      continue;
    }
    const externalKey = `${m.source}|${m.external_id}`;
    if (seenExternal.has(externalKey) || result.sources.has(id) || existing.has(id)) {
      result.duplicates.push(id);
      continue;
    }
    seenExternal.add(externalKey);
    const stored: StoredSource = {
      source_id: id,
      text: m.text,
      content_hash: sourceTextHash(m.text, sha256),
      source_type: m.source as SourceType,
      external_id: m.external_id,
      received_at: m.received_at,
    };
    if (isNonEmptyString(m.author, 256)) stored.author = m.author;
    if (isNonEmptyString(m.lang, 40)) stored.language = m.lang;
    result.sources.set(id, stored);
  }
  return result;
}
