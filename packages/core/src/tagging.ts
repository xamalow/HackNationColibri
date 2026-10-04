/**
 * The model's output, read as data.
 *
 * The local model returns labels: a message id, a theme, a sentiment, a quote
 * and UTF-8 byte offsets. This module turns that untrusted structure into
 * TaggedItems the evidence layer can validate, and names what it could not
 * read. Unreadable output (not JSON, wrong shape, missing fields) is a
 * structured-output failure: nothing is counted and a person is asked. The
 * harness and the product share this code; neither is allowed to synthesise
 * the failure on its own.
 */

import type { Sha256 } from "./canon.js";
import { type AskAPerson, type SourceText, type SummaryOptions, summarizeThemesReport, type TaggedItem, type ThemeReport } from "./evidence.js";

export interface ModelLabel {
  message_id: string;
  theme: string;
  sentiment: string;
  quote: string;
  start: number;
  end: number;
}

export type LabelRejectReason = "malformed_label" | "duplicate_message" | "unknown_source";

export interface RejectedLabel {
  message_id: string;
  theme: string;
  reason: LabelRejectReason;
}

export interface ParsedModelOutput {
  /** True when the output as a whole could not be read. `tagged` is then empty. */
  malformed: boolean;
  tagged: TaggedItem[];
  rejected: RejectedLabel[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asLabel(v: unknown): ModelLabel | null {
  if (!isRecord(v)) return null;
  const { message_id, theme, sentiment, quote, start, end } = v;
  if (typeof message_id !== "string" || typeof theme !== "string" || typeof sentiment !== "string" || typeof quote !== "string") return null;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  return { message_id, theme, sentiment, quote, start: start as number, end: end as number };
}

/**
 * Accepts the raw model result: either an object {status: "ok", labels: [...]}
 * or anything else (a string, a partial JSON, {status: "malformed"}), which is
 * a structured-output failure. Labels that point at unknown or duplicate
 * sources are rejected individually; theme and sentiment are checked later
 * against the catalogue by the evidence layer.
 */
export function parseModelOutput(raw: unknown, sources: ReadonlyMap<string, SourceText>, duplicateSourceIds: ReadonlySet<string> = new Set()): ParsedModelOutput {
  let labels: unknown[] | null = null;
  if (Array.isArray(raw)) labels = raw;
  else if (isRecord(raw) && raw["status"] === "ok" && Array.isArray(raw["labels"])) labels = raw["labels"] as unknown[];
  else if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) labels = parsed;
      else if (isRecord(parsed) && Array.isArray(parsed["labels"])) labels = parsed["labels"] as unknown[];
    } catch {
      labels = null;
    }
  }
  if (labels === null) return { malformed: true, tagged: [], rejected: [] };

  const tagged: TaggedItem[] = [];
  const rejected: RejectedLabel[] = [];
  for (const item of labels) {
    const label = asLabel(item);
    if (!label) {
      const r = isRecord(item) ? item : {};
      rejected.push({ message_id: String(r["message_id"] ?? "?"), theme: String(r["theme"] ?? "?"), reason: "malformed_label" });
      continue;
    }
    if (duplicateSourceIds.has(label.message_id)) {
      rejected.push({ message_id: label.message_id, theme: label.theme, reason: "duplicate_message" });
      continue;
    }
    const source = sources.get(label.message_id);
    if (!source) {
      rejected.push({ message_id: label.message_id, theme: label.theme, reason: "unknown_source" });
      continue;
    }
    tagged.push({ theme: label.theme, sentiment: label.sentiment, evidence: { source_id: label.message_id, content_hash: source.content_hash, span: { start: label.start, end: label.end }, quote: label.quote } });
  }
  return { malformed: false, tagged, rejected };
}

export interface FeedbackAnalysis extends ThemeReport {
  parse: ParsedModelOutput;
}

/**
 * Parse, validate, count. When the model output is unreadable, every stored
 * source is named in one ask-a-person entry and no theme is produced.
 */
export function analyzeFeedback(modelOutput: unknown, sources: ReadonlyMap<string, SourceText>, sha256: Sha256, options: SummaryOptions = {}, duplicateSourceIds: ReadonlySet<string> = new Set()): FeedbackAnalysis {
  const parse = parseModelOutput(modelOutput, sources, duplicateSourceIds);
  if (parse.malformed) {
    const ask: AskAPerson = { reason: "structured_output_failure", detail: "the model output could not be read; nothing was counted", about: [...sources.keys()].sort() };
    return { parse, themes: [], rejected_tags: [], ask_a_person: [ask] };
  }
  const report = summarizeThemesReport(parse.tagged, sources, sha256, options);
  return { parse, ...report };
}
