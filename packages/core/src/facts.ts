/**
 * Owner facts (the farm sheet) and how they change (W3 step 6 -> W5).
 *
 * Facts have revisions. A "try" on a decision card leads to Noor DICTATING
 * the new value in her own words; code parses it into the one field the theme
 * maps to. The change is read back and applied only after her explicit yes to
 * that exact read-back, on the revision it was proposed against: a fact change
 * made elsewhere in between voids it. Applying a change writes the new
 * revision, the approval record and the listing drafts (one per channel, never
 * published) as ONE bundle the host commits in one transaction. No value ever
 * comes from a review, a model or a transcript the owner did not dictate.
 */

import { type AuthenticatedSession, checkOwnerSession, type OwnerContext, type TrustedOwner } from "./approval.js";
import { digest, type Sha256 } from "./canon.js";
import { type ClockReading, formatTimestamp } from "./clock.js";
import type { Choice } from "./decisions.js";
import { parseAmount, parseConfirmation, parseHours, timeToString } from "./swahili.js";

export const FACTS_DOMAIN = "sauti.farm_sheet.v1";
export const FACT_CHANGE_DOMAIN = "sauti.fact_change.v1";

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** Mirrors sauti/farm_sheet.py. null = "Noor has not told us". */
export interface FarmSheet {
  price_per_person_kes: number | null;
  capacity_per_tour: number | null;
  days: Weekday[] | null;
  hours: { start: string; end: string } | null;
  directions_sw: string | null;
  inclusions_sw: string[] | null;
}

export type FactField = keyof FarmSheet;

export interface FactRevision {
  revision: number;
  sheet: FarmSheet;
  content_hash: string;
  /** e.g. "w1_voice", "w3_step6", "w1_setup" */
  source: string;
  created_at: string;
}

/** Validated by Nat (eval/w3/README.md). Themes outside this table have no field and go to a person. */
export const THEME_FIELD: Readonly<Record<string, FactField>> = {
  directions: "directions_sw",
  price: "price_per_person_kes",
  timing: "hours",
  food: "inclusions_sw",
};

export function fieldForTheme(theme: string): FactField | null {
  return THEME_FIELD[theme] ?? null;
}

export function factsHash(sheet: FarmSheet, sha256: Sha256): string {
  return digest(FACTS_DOMAIN, sheet, sha256);
}

export function makeRevision(sheet: FarmSheet, revision: number, source: string, nowMs: number, sha256: Sha256): FactRevision {
  return { revision, sheet, content_hash: factsHash(sheet, sha256), source, created_at: formatTimestamp(nowMs) };
}

export type FactValue = FarmSheet[FactField];

const WEEKDAYS_SET: ReadonlySet<string> = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

/**
 * The farm setup screen (Shamba) submits a sheet; code validates every field,
 * no model involved. A field left empty is null ("Noor has not told us").
 */
export function validateFarmSheet(input: unknown): { ok: true; sheet: FarmSheet } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, errors: ["$: must be an object"] };
  const o = input as Record<string, unknown>;
  const known = ["price_per_person_kes", "capacity_per_tour", "days", "hours", "directions_sw", "inclusions_sw"];
  for (const k of Object.keys(o)) if (!known.includes(k)) errors.push(`$.${k}: unknown field`);
  const intOrNull = (k: string, min: number, max: number): number | null => {
    const v = o[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      errors.push(`$.${k}: must be a whole number ${min}..${max}`);
      return null;
    }
    return v;
  };
  const price = intOrNull("price_per_person_kes", 1, 1_000_000);
  const capacity = intOrNull("capacity_per_tour", 1, 200);
  let days: Weekday[] | null = null;
  if (o["days"] !== undefined && o["days"] !== null) {
    if (!Array.isArray(o["days"]) || o["days"].length === 0 || !o["days"].every((d) => typeof d === "string" && WEEKDAYS_SET.has(d))) errors.push("$.days: must be a non-empty list of mon..sun");
    else days = [...new Set(o["days"] as Weekday[])];
  }
  let hours: FarmSheet["hours"] = null;
  if (o["hours"] !== undefined && o["hours"] !== null) {
    const h = o["hours"] as Record<string, unknown>;
    if (typeof h !== "object" || typeof h["start"] !== "string" || typeof h["end"] !== "string" || !CLOCK.test(h["start"]) || !CLOCK.test(h["end"])) errors.push("$.hours: must be {start, end} as HH:MM:SS");
    else if (h["end"] <= h["start"]) errors.push("$.hours: tour must end after it starts");
    else hours = { start: h["start"], end: h["end"] };
  }
  let directions: string | null = null;
  if (o["directions_sw"] !== undefined && o["directions_sw"] !== null) {
    const d = o["directions_sw"];
    if (typeof d !== "string" || d.trim().split(/\s+/).length < 3 || d.length > 2000) errors.push("$.directions_sw: at least three words, at most 2000 characters");
    else directions = d.trim();
  }
  let inclusions: string[] | null = null;
  if (o["inclusions_sw"] !== undefined && o["inclusions_sw"] !== null) {
    const list = o["inclusions_sw"];
    if (!Array.isArray(list) || !list.every((s) => typeof s === "string" && s.trim().length > 1 && s.length <= 200)) errors.push("$.inclusions_sw: a list of short texts");
    else inclusions = (list as string[]).map((s) => s.trim());
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, sheet: { price_per_person_kes: price, capacity_per_tour: capacity, days, hours, directions_sw: directions, inclusions_sw: inclusions } };
}

export type ParsedValue = { ok: true; value: NonNullable<FactValue> } | { ok: false; reason: "no_readable_value"; detail: string };

/** Code reads the dictated value for a field. Anything unreadable is a refusal, never a guess. */
export function parseDictatedValue(field: FactField, transcript: string): ParsedValue {
  const text = transcript.replace(/\s+/g, " ").trim();
  switch (field) {
    case "price_per_person_kes": {
      const amount = parseAmount(text);
      if (amount === null || amount < 1 || amount > 1_000_000) return { ok: false, reason: "no_readable_value", detail: "no price between 1 and 1,000,000 shillings was said" };
      return { ok: true, value: amount };
    }
    case "capacity_per_tour": {
      const n = parseAmount(text);
      if (n === null || n < 1 || n > 200) return { ok: false, reason: "no_readable_value", detail: "no head count between 1 and 200 was said" };
      return { ok: true, value: n };
    }
    case "hours": {
      const hours = parseHours(text);
      if (!hours) return { ok: false, reason: "no_readable_value", detail: "need a start and an end time, end after start" };
      return { ok: true, value: { start: timeToString(hours.start), end: timeToString(hours.end) } };
    }
    case "directions_sw": {
      const cleaned = text.replace(/[ .,;]+$/g, "");
      if (cleaned.split(" ").length < 3 || cleaned.length > 2000) return { ok: false, reason: "no_readable_value", detail: "directions need at least three words" };
      return { ok: true, value: cleaned };
    }
    case "inclusions_sw": {
      const items = text.split(/,|;|\bpamoja na\b|\bna\b/).map((s) => s.trim().replace(/[ .]+$/g, "")).filter((s) => s.length > 1);
      if (items.length === 0) return { ok: false, reason: "no_readable_value", detail: "no inclusions were said" };
      return { ok: true, value: items };
    }
    case "days":
      return { ok: false, reason: "no_readable_value", detail: "weekday changes are made in farm setup (W1), not from a card" };
  }
}

export interface FactChangeProposal {
  theme: string;
  field: FactField;
  value: NonNullable<FactValue>;
  /** The farm sheet revision the change was proposed against. */
  from_revision: number;
  from_hash: string;
  /** What is read back to Noor before her yes. Template; Experience owns reviewed copy. */
  readback: string;
  digest: string;
}

export type ProposeFactChangeResult =
  | { ok: true; proposal: FactChangeProposal }
  | { ok: false; reason: "no_try_decision" | "no_field_for_theme" | "no_readable_value"; detail: string };

function readback(field: FactField, value: NonNullable<FactValue>): string {
  switch (field) {
    case "price_per_person_kes":
      return `Bei mpya: shilingi ${value as number} kwa kila mgeni. Ni sawa?`;
    case "capacity_per_tour":
      return `Idadi mpya ya wageni: ${value as number} kwa ziara moja. Ni sawa?`;
    case "hours": {
      const h = value as { start: string; end: string };
      return `Saa mpya za ziara: kuanzia ${h.start.slice(0, 5)} hadi ${h.end.slice(0, 5)}. Ni sawa?`;
    }
    case "directions_sw":
      return `Maelekezo mapya: ${value as string}. Ni sawa?`;
    case "inclusions_sw":
      return `Ziara itajumuisha: ${(value as string[]).join(", ")}. Ni sawa?`;
    case "days":
      return `Siku mpya: ${(value as string[]).join(", ")}. Ni sawa?`;
  }
}

/**
 * From Noor's "try" and her dictation to a proposal. The theme must map to a
 * field, the choice must be "try", and the dictation must parse; otherwise
 * nothing is proposed and the caller asks a person.
 */
export function proposeFactChange(input: { theme: string; choice: Choice | null; transcript: string; current: FactRevision }, sha256: Sha256): ProposeFactChangeResult {
  if (input.choice !== "try") return { ok: false, reason: "no_try_decision", detail: "only a recorded try on this card can lead to a fact change" };
  const field = fieldForTheme(input.theme);
  if (!field) return { ok: false, reason: "no_field_for_theme", detail: `theme ${input.theme} has no farm sheet field; ask a person` };
  const parsed = parseDictatedValue(field, input.transcript);
  if (!parsed.ok) return parsed;
  const bound = { theme: input.theme, field, value: parsed.value, from_revision: input.current.revision, from_hash: input.current.content_hash };
  return {
    ok: true,
    proposal: { ...bound, readback: readback(field, parsed.value), digest: digest(FACT_CHANGE_DOMAIN, bound, sha256) },
  };
}

export const LISTING_CHANNELS = ["google_business", "getyourguide", "osm"] as const;
export type ListingChannel = (typeof LISTING_CHANNELS)[number];

export interface ListingDraft {
  channel: ListingChannel;
  field: FactField;
  value: NonNullable<FactValue>;
  from_revision: number;
  /** Always false here: publishing is W5's own approval. */
  published: false;
  draft_id: string;
}

export interface FactChangeApproval {
  proposal_digest: string;
  decided_at: string;
  transcript: string;
  /** The owner session that said yes, as for any approval. */
  owner_context: OwnerContext;
}

/** Everything the host writes in ONE transaction: new revision, the approval, the drafts. */
export interface AppliedFactChange {
  revision: FactRevision;
  approval: FactChangeApproval;
  drafts: ListingDraft[];
}

export type ConfirmFactChangeResult =
  | { ok: true; applied: AppliedFactChange }
  | { ok: false; reason: "asr_uncertain" | "no_explicit_yes" | "declined" | "facts_changed" | "proposal_tampered" | "rendered_digest_mismatch" | "facts_corrupt" | "no_owner_session" | "owner_mismatch" | "device_not_trusted" | "unlock_not_allowed" | "session_revoked" | "session_time_invalid" | "session_stale" | "clock_suspect"; detail: string };

/** Recompute what a proposal's digest and read-back must be from its content. */
export function proposalDigest(p: Pick<FactChangeProposal, "theme" | "field" | "value" | "from_revision" | "from_hash">, sha256: Sha256): string {
  return digest(FACT_CHANGE_DOMAIN, { theme: p.theme, field: p.field, value: p.value, from_revision: p.from_revision, from_hash: p.from_hash }, sha256);
}

/**
 * Noor answers the read-back. Only an explicit yes applies the change, and only
 * if (a) the proposal is byte-for-byte the one that was read back: its digest and
 * read-back recompute from its content AND equal `renderedDigest`, the digest the
 * host froze when it actually spoke/showed the read-back (the same binding rule as
 * decideApproval's renderedDigest, so a second proposal on the same revision cannot
 * ride on a yes given to the first), (b) the farm sheet is still the revision the
 * change was proposed against and its hash recomputes, and (c) a trusted owner
 * session is present: a fact change is an owner act like an approval. The host
 * runs this inside the same transaction that writes the bundle.
 */
export function confirmFactChange(
  input: {
    proposal: FactChangeProposal;
    /** Digest of the proposal the host read back to Noor, captured at read-back time, not from the proposal passed in. */
    renderedDigest: string;
    transcript: string;
    asrUncertain?: boolean;
    current: FactRevision;
    nowMs: number;
    session: AuthenticatedSession | null;
    trusted: TrustedOwner | null;
    clock: ClockReading;
    tenant_id: string;
  },
  sha256: Sha256,
): ConfirmFactChangeResult {
  if (input.asrUncertain) return { ok: false, reason: "asr_uncertain", detail: "the recognizer was unsure; read back again" };
  const answer = parseConfirmation(input.transcript);
  if (answer === "no") return { ok: false, reason: "declined", detail: "Noor said no; nothing changes" };
  if (answer !== "yes") return { ok: false, reason: "no_explicit_yes", detail: "unclear is never a yes; read back again" };
  const p = input.proposal;
  if (proposalDigest(p, sha256) !== p.digest || readback(p.field, p.value) !== p.readback) {
    return { ok: false, reason: "proposal_tampered", detail: "the proposal's content does not match what was read back; propose again" };
  }
  if (input.renderedDigest !== p.digest) {
    return { ok: false, reason: "rendered_digest_mismatch", detail: "Noor's yes was given to a different read-back than this proposal; read this one back and ask again" };
  }
  const expectedField = fieldForTheme(p.theme);
  if (expectedField !== p.field || !parseDictatedValueShape(p.field, p.value)) {
    return { ok: false, reason: "proposal_tampered", detail: "the proposal's field or value shape is not one this theme can produce" };
  }
  if (factsHash(input.current.sheet, sha256) !== input.current.content_hash) {
    return { ok: false, reason: "facts_corrupt", detail: "the current farm sheet does not match its own hash; refusing to change facts" };
  }
  if (input.current.revision !== p.from_revision || input.current.content_hash !== p.from_hash) {
    return { ok: false, reason: "facts_changed", detail: `the farm sheet moved from revision ${p.from_revision} to ${input.current.revision}; propose again` };
  }
  const who = checkOwnerSession(input.tenant_id, input.session, input.trusted, input.clock);
  if (!who.ok) return { ok: false, reason: who.reason, detail: who.detail };
  if (input.clock.suspect) return { ok: false, reason: "clock_suspect", detail: "device clock is behind its own high-water mark; fact change held" };
  const sheet: FarmSheet = { ...input.current.sheet, [p.field]: p.value };
  const revision = makeRevision(sheet, input.current.revision + 1, "w3_step6", input.nowMs, sha256);
  const drafts: ListingDraft[] = LISTING_CHANNELS.map((channel) => ({
    channel,
    field: p.field,
    value: p.value,
    from_revision: revision.revision,
    published: false,
    draft_id: digest("sauti.listing_draft.v1", { channel, field: p.field, revision: revision.revision, hash: revision.content_hash }, sha256),
  }));
  return { ok: true, applied: { revision, approval: { proposal_digest: p.digest, decided_at: revision.created_at, transcript: input.transcript, owner_context: ownerContextFrom(input.session!) }, drafts } };
}

/** The value must have the shape the field's parser produces; a tampered proposal cannot smuggle another type. */
function parseDictatedValueShape(field: FactField, value: unknown): boolean {
  switch (field) {
    case "price_per_person_kes":
      return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1_000_000;
    case "capacity_per_tour":
      return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 200;
    case "hours":
      return typeof value === "object" && value !== null && /^\d{2}:\d{2}:\d{2}$/.test(String((value as { start?: unknown }).start)) && /^\d{2}:\d{2}:\d{2}$/.test(String((value as { end?: unknown }).end)) && String((value as { end: string }).end) > String((value as { start: string }).start);
    case "directions_sw":
      return typeof value === "string" && value.trim().split(/\s+/).length >= 3 && value.length <= 2000;
    case "inclusions_sw":
      return Array.isArray(value) && value.length > 0 && value.every((s) => typeof s === "string" && s.length > 1);
    case "days":
      return false;
  }
}

function ownerContextFrom(session: AuthenticatedSession): OwnerContext {
  return { owner_id: session.owner_id, device_id: session.device_id, unlock: session.unlock, session_id: session.session_id, authenticated_at: session.authenticated_at, confirmation: "voice" };
}
