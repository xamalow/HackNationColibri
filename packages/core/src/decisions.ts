/**
 * Decision cards and the owner's choice (W3 steps 4 and 5).
 *
 * A card exists only for a theme with enough evidence. It cites exact validated
 * spans, carries only numbers that come from the counts, and is bound by a
 * digest to the evidence it was built from. The owner's choice is recorded only
 * when it is explicit (try, reject, ask someone), confident, and made on the card
 * that is still current: new evidence changes the digest and voids a pending
 * choice. A choice never changes a fact, creates an approval or fills the outbox;
 * it is a recorded decision that later steps may act on, each with its own
 * approval.
 */

import { digest, type Sha256 } from "./canon.js";
import type { EvidenceItem } from "./envelope.js";
import type { ThemeReport, ThemeSummary } from "./evidence.js";

export const CARD_DOMAIN = "sauti.decision_card.v1";

export const CHOICES = ["try", "reject", "ask_someone"] as const;
export type Choice = (typeof CHOICES)[number];

export interface CardQuote {
  message_id: string;
  quote: string;
  start: number;
  end: number;
}

export interface DecisionCard {
  theme: string;
  /** Binds theme, counts, direction and the exact evidence set. Changes when evidence changes. */
  card_digest: string;
  comment_count: number;
  direction: "positive" | "negative";
  supporting_source_ids: string[];
  dissenting_source_ids: string[];
  quotes: CardQuote[];
  choices: readonly Choice[];
  /** A suggestion to try, never a claim that the owner already offers it. */
  prospective: true;
  /** Template wording with no reviewed Swahili claim. Experience replaces it with reviewed copy. */
  text: string;
  text_review: "unreviewed";
}

function cardEvidence(t: ThemeSummary): EvidenceItem[] {
  const supporting = new Set(t.supporting_source_ids);
  return t.evidence.filter((e) => supporting.has(e.source_id)).sort((a, b) => (a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : a.span.start - b.span.start));
}

/** Only the count appears as a number, so the "no invented number" property holds by construction. */
function templateText(t: ThemeSummary, locale: "sw" | "en"): string {
  const n = t.comment_count;
  // No number words either: "moja" or "one" would read as a count that exists nowhere.
  if (locale === "en") {
    const side = t.direction === "positive" ? "liked" : "had a problem with";
    return `${n} comments: visitors ${side} ${t.theme}. You could try a change, reject this, or ask someone.`;
  }
  const side = t.direction === "positive" ? "walipenda" : "walilalamika kuhusu";
  return `Maoni ${n}: wageni ${side} ${t.theme}. Unaweza kujaribu badiliko, kukataa, au kuuliza mtu.`;
}

export function buildDecisionCards(report: ThemeReport, sha256: Sha256, locale: "sw" | "en" = "sw"): DecisionCard[] {
  const cards: DecisionCard[] = [];
  for (const t of report.themes) {
    if (t.verdict !== "supported" && t.verdict !== "supported_with_dissent") continue;
    if (t.direction !== "positive" && t.direction !== "negative") continue;
    const evidence = cardEvidence(t);
    const bound = {
      theme: t.theme,
      comment_count: t.comment_count,
      direction: t.direction,
      evidence: evidence.map((e) => ({ source_id: e.source_id, content_hash: e.content_hash, start: e.span.start, end: e.span.end })),
      dissent: [...t.dissenting_source_ids],
    };
    cards.push({
      theme: t.theme,
      card_digest: digest(CARD_DOMAIN, bound, sha256),
      comment_count: t.comment_count,
      direction: t.direction,
      supporting_source_ids: [...t.supporting_source_ids],
      dissenting_source_ids: [...t.dissenting_source_ids],
      quotes: evidence.map((e) => ({ message_id: e.source_id, quote: e.quote, start: e.span.start, end: e.span.end })),
      choices: CHOICES,
      prospective: true,
      text: templateText(t, locale),
      text_review: "unreviewed",
    });
  }
  return cards;
}

// ---------------------------------------------------------------- the owner's choice

const TRY = new Set(["jaribu", "tujaribu", "nitajaribu", "najaribu", "try"]);
const REJECT = new Set(["kataa", "nakataa", "nimekataa", "sitaki", "reject"]);
const ASK_PHRASES = ["uliza mtu", "muulize mtu", "nitamuuliza mtu", "niulize mtu", "ask someone", "ask a person", "ask somebody"];
const ASK_WORDS = new Set(["uliza", "muulize", "nitamuuliza"]);

/**
 * An explicit choice, or null. "ndiyo", "sawa", "yes" are not choices: a generic
 * yes cannot pick between three outcomes. Two different choices in one utterance
 * are also null.
 */
export function parseChoice(transcript: string): Choice | null {
  const text = transcript.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const words = text.split(" ");
  const found = new Set<Choice>();
  if (ASK_PHRASES.some((p) => text.includes(p)) || words.some((w) => ASK_WORDS.has(w))) found.add("ask_someone");
  if (words.some((w) => TRY.has(w))) found.add("try");
  if (words.some((w) => REJECT.has(w))) found.add("reject");
  if (found.size !== 1) return null;
  return [...found][0]!;
}

export interface OwnerChoiceInput {
  /** The card the UI showed, exactly as shown. */
  shownCard: DecisionCard;
  /** The card for that theme built from the evidence as it is NOW. Null if the theme no longer has a card. */
  currentCard: DecisionCard | null;
  transcript: string;
  /** The speech recognizer's own doubt. Uncertain audio never records a choice. */
  asrUncertain?: boolean;
}

export interface RecordedChoice {
  theme: string;
  choice: Choice;
  card_digest: string;
}

export type ChoiceRefusal = "asr_uncertain" | "no_explicit_choice" | "card_stale" | "card_gone";

export type ChoiceResult = { ok: true; decision: RecordedChoice } | { ok: false; reason: ChoiceRefusal; detail: string };

export function recordChoice(input: OwnerChoiceInput): ChoiceResult {
  if (input.asrUncertain) return { ok: false, reason: "asr_uncertain", detail: "the recognizer was unsure; ask again" };
  const choice = parseChoice(input.transcript);
  if (!choice) return { ok: false, reason: "no_explicit_choice", detail: "say try, reject or ask someone; a plain yes is not a choice" };
  if (!input.currentCard) return { ok: false, reason: "card_gone", detail: `the ${input.shownCard.theme} card no longer has enough evidence` };
  if (input.currentCard.card_digest !== input.shownCard.card_digest) {
    return { ok: false, reason: "card_stale", detail: "new evidence arrived after the card was shown; the card is redrawn and the question asked again" };
  }
  return { ok: true, decision: { theme: input.shownCard.theme, choice, card_digest: input.shownCard.card_digest } };
}
