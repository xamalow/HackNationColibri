/**
 * From a decision card to one exact follow-up proposal.
 *
 * The card says what visitors said. The owner chose "try". The follow-up is a
 * message to a visitor, built by code from a reviewed template: the body may
 * contain only numbers that exist in the owner's facts, in the card's count or
 * in the quoted comments, so nothing is invented on the way to the envelope.
 * The result is a sealed ActionEnvelope that carries the card's evidence and
 * waits for the owner's exact approval like any other action.
 */

import type { Sha256 } from "./canon.js";
import { formatTimestamp, parseTimestamp } from "./clock.js";
import type { DecisionCard } from "./decisions.js";
import { type ActionEnvelope, type EvidenceItem, type Recipient, sealEnvelope, type Validation } from "./envelope.js";
import { type SourceText, validateEvidenceItem } from "./evidence.js";

export interface FollowUpTemplate {
  template_id: string;
  /** Exact text to send. Reviewed copy belongs to Experience; the core only checks it. */
  body: string;
  body_language: string;
  /** Exactly what the owner will be shown before approving. */
  preview_text: string;
  render_locale: string;
}

export interface FollowUpInput {
  card: DecisionCard;
  sources: ReadonlyMap<string, SourceText>;
  template: FollowUpTemplate;
  recipient: Recipient;
  tenant_id: string;
  /** Host-generated uuid v4. */
  action_id: string;
  fact_revision: number;
  /** Numbers the owner's facts make legitimate, already rendered as they may appear (digits or words). */
  owner_fact_numbers: readonly string[];
  created_at_ms: number;
  valid_for_ms: number;
}

export type FollowUpRefusal = { ok: false; reason: "invented_number" | "card_without_evidence" | "evidence_invalid" | "invalid_envelope" | "bad_time"; detail: string; errors?: string[] };

export type FollowUpResult = { ok: true; envelope: ActionEnvelope } | FollowUpRefusal;

/** Digits (incl. 2,000 / 2.5 / 09:00 as one token) and Swahili number words. A match is a number claim that must have a source. */
const DIGIT = /\d+(?:[.,:]\d+)*/g;
const SW_NUMBER_WORDS = new Set([
  "moja", "mbili", "tatu", "nne", "tano", "sita", "saba", "nane", "tisa", "kumi",
  "ishirini", "thelathini", "arobaini", "hamsini", "sitini", "sabini", "themanini", "tisini",
  "mia", "elfu", "laki", "milioni", "mmoja", "wawili", "watatu", "wanne", "watano", "wanane",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "hundred", "thousand",
]);

/** Every number in `text` that is not in `allowed`. Empty means nothing was invented. */
export function unexplainedNumbers(text: string, allowed: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const m of text.match(DIGIT) ?? []) if (!allowed.has(m)) out.add(m);
  for (const w of text.toLowerCase().match(/[\p{L}]+/gu) ?? []) if (SW_NUMBER_WORDS.has(w) && !allowed.has(w)) out.add(w);
  return [...out].sort();
}

function numbersIn(text: string): string[] {
  return [...(text.match(DIGIT) ?? []), ...(text.toLowerCase().match(/[\p{L}]+/gu) ?? []).filter((w) => SW_NUMBER_WORDS.has(w))];
}

export function proposeFollowUp(input: FollowUpInput, sha256: Sha256): FollowUpResult {
  const { card, template } = input;
  if (card.quotes.length === 0) return { ok: false, reason: "card_without_evidence", detail: "a follow-up must cite the comments it answers" };
  const evidence: EvidenceItem[] = [];
  for (const q of card.quotes) {
    const source = input.sources.get(q.message_id);
    if (!source) return { ok: false, reason: "card_without_evidence", detail: `source ${q.message_id} is not stored` };
    const item: EvidenceItem = { source_id: q.message_id, content_hash: source.content_hash, span: { start: q.start, end: q.end }, quote: q.quote };
    // A card is data too: every quote is re-validated against the original bytes before it may
    // legitimise a number or be sealed into an envelope (codex review, 2026-10-03 23:59Z).
    const v = validateEvidenceItem(item, input.sources, sha256);
    if (!v.ok) return { ok: false, reason: "evidence_invalid", detail: `quote on ${q.message_id} failed ${v.reason}; the card is stale or forged` };
    evidence.push(item);
  }

  // Legitimate numbers: owner facts, the card's count, anything inside the quoted comments, and the
  // digits of the recipient address itself (a phone number is an identifier, not a claim).
  const allowed = new Set<string>([String(card.comment_count), ...numbersIn(input.recipient.address)]);
  for (const f of input.owner_fact_numbers) {
    allowed.add(f);
    for (const n of numbersIn(f)) allowed.add(n); // "elfu mbili" legitimises both words
  }
  for (const q of card.quotes) for (const n of numbersIn(q.quote)) allowed.add(n);
  const invented = unexplainedNumbers(template.body, allowed).concat(unexplainedNumbers(template.preview_text, allowed));
  if (invented.length > 0) return { ok: false, reason: "invented_number", detail: `numbers with no source in facts, counts or quotes: ${[...new Set(invented)].join(", ")}` };

  let created: string;
  let until: string;
  try {
    created = formatTimestamp(input.created_at_ms);
    until = formatTimestamp(input.created_at_ms + input.valid_for_ms);
  } catch (e) {
    return { ok: false, reason: "bad_time", detail: String(e) };
  }
  if ((parseTimestamp(until) ?? 0) <= (parseTimestamp(created) ?? 0)) return { ok: false, reason: "bad_time", detail: "validity window must be positive" };

  const sealed: Validation<ActionEnvelope> = sealEnvelope(
    {
      schema: "sauti.action_envelope",
      schema_version: "1.0.0",
      action_id: input.action_id,
      tenant_id: input.tenant_id,
      kind: "send_message",
      created_at: created,
      valid_until: until,
      fact_revision: input.fact_revision,
      recipient: input.recipient,
      payload: { type: "message", body: template.body, body_language: template.body_language, in_reply_to: card.quotes[0]!.message_id, template_id: template.template_id },
      evidence,
      preview: { text: template.preview_text, render_locale: template.render_locale },
      authority: { level: "owner", owner_context_required: true },
    },
    sha256,
  );
  if (!sealed.ok) return { ok: false, reason: "invalid_envelope", detail: "the proposal does not satisfy the contract", errors: sealed.errors };
  return { ok: true, envelope: sealed.value };
}
