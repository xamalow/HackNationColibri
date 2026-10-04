/**
 * The action envelope: one exact action Noor may approve. Everything the owner
 * sees and everything a transport will do is inside it, and the digest binds all
 * of it. This validator mirrors contracts/action-envelope.schema.json field by
 * field; the contract fixtures are run through both so they cannot drift.
 *
 * Hand-written on purpose: the core must run inside a React Native JS engine
 * without eval, which rules out runtime JSON Schema compilers. The schema stays
 * the published truth; this is its executable twin.
 */

import { digest, ENVELOPE_DOMAIN, type Sha256 } from "./canon.js";
import { parseTimestamp } from "./clock.js";
import { type Money, validateMoney } from "./money.js";

export const ENVELOPE_SCHEMA = "sauti.action_envelope";
export const ENVELOPE_SCHEMA_VERSION = "1.0.0";

/** send_message covers replies too (payload.in_reply_to). reply_to_review answers a listing's review. */
export const KINDS = ["send_message", "book_slot", "record_payment", "publish_listing", "reply_to_review"] as const;
export type Kind = (typeof KINDS)[number];

export const CHANNELS = ["sms", "whatsapp", "simulated", "google_business", "getyourguide", "osm", "local"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface Recipient {
  channel: Channel;
  address: string;
  language: string;
}

export interface EvidenceItem {
  source_id: string;
  content_hash: string;
  span: { start: number; end: number };
  quote: string;
}

export interface Preview {
  text: string;
  render_locale: string;
}

export interface Authority {
  level: "owner";
  owner_context_required: true;
}

export interface MessagePayload {
  type: "message";
  body: string;
  body_language: string;
  in_reply_to?: string;
  booking_id?: string;
  template_id?: string;
}

export interface BookSlotPayload {
  type: "book_slot";
  booking_id: string;
  slot_date: string;
  slot_start: string;
  slot_end: string;
  party_size: number;
  price: Money;
}

export interface RecordPaymentPayload {
  type: "record_payment";
  booking_id: string;
  money: Money;
  method: "mpesa" | "cash" | "bank" | "unknown";
  reported_by: "owner";
}

export interface PublishListingPayload {
  type: "publish_listing";
  listing: "google_business" | "getyourguide" | "osm";
  fields: Record<string, string | number | boolean | null>;
}

export type Payload = MessagePayload | BookSlotPayload | RecordPaymentPayload | PublishListingPayload;

export interface ActionEnvelope {
  schema: typeof ENVELOPE_SCHEMA;
  schema_version: typeof ENVELOPE_SCHEMA_VERSION;
  action_id: string;
  tenant_id: string;
  kind: Kind;
  created_at: string;
  valid_until: string;
  fact_revision: number;
  recipient: Recipient;
  payload: Payload;
  evidence: EvidenceItem[];
  preview: Preview;
  authority: Authority;
  digest: string;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BCP47 = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const TENANT = /^[A-Za-z0-9._-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^\d{2}:\d{2}$/;

const PAYLOAD_TYPE_FOR_KIND: Readonly<Record<Kind, Payload["type"]>> = {
  send_message: "message",
  reply_to_review: "message",
  book_slot: "book_slot",
  record_payment: "record_payment",
  publish_listing: "publish_listing",
};

/** Mirrors the allOf binding in the JSON Schema: which channels each kind may use. */
export const CHANNELS_FOR_KIND: Readonly<Record<Kind, readonly Channel[]>> = {
  send_message: ["sms", "whatsapp", "simulated"],
  reply_to_review: ["google_business", "getyourguide", "simulated"],
  book_slot: ["local"],
  record_payment: ["local"],
  publish_listing: ["google_business", "getyourguide", "osm", "simulated"],
};

class Errors {
  readonly list: string[] = [];
  add(path: string, message: string): void {
    this.list.push(`${path}: ${message}`);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function exactKeys(o: Record<string, unknown>, required: readonly string[], optional: readonly string[], path: string, e: Errors): boolean {
  let ok = true;
  for (const k of required) if (!(k in o)) { e.add(`${path}.${k}`, "required"); ok = false; }
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) { e.add(`${path}.${k}`, "unknown member"); ok = false; }
  return ok;
}

function str(o: Record<string, unknown>, k: string, path: string, e: Errors, min: number, max: number, pattern?: RegExp): string | undefined {
  const v = o[k];
  if (typeof v !== "string") { e.add(`${path}.${k}`, "must be a string"); return undefined; }
  if (v.length < min || v.length > max) { e.add(`${path}.${k}`, `length must be ${min}..${max}`); return undefined; }
  if (pattern && !pattern.test(v)) { e.add(`${path}.${k}`, "does not match the required pattern"); return undefined; }
  return v;
}

function int(o: Record<string, unknown>, k: string, path: string, e: Errors, min: number, max: number): number | undefined {
  const v = o[k];
  if (typeof v !== "number" || !Number.isInteger(v)) { e.add(`${path}.${k}`, "must be an integer"); return undefined; }
  if (v < min || v > max) { e.add(`${path}.${k}`, `must be ${min}..${max}`); return undefined; }
  return v;
}

function oneOf<T extends string>(o: Record<string, unknown>, k: string, path: string, e: Errors, allowed: readonly T[]): T | undefined {
  const v = o[k];
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  e.add(`${path}.${k}`, `must be one of ${allowed.join(", ")}`);
  return undefined;
}

function timestamp(o: Record<string, unknown>, k: string, path: string, e: Errors): string | undefined {
  const v = o[k];
  if (typeof v !== "string" || parseTimestamp(v) === null) { e.add(`${path}.${k}`, "must be RFC 3339 UTC with a literal Z, second precision"); return undefined; }
  return v;
}

function money(o: Record<string, unknown>, k: string, path: string, e: Errors): Money | undefined {
  const verdict = validateMoney(o[k]);
  if (!verdict.ok) { e.add(`${path}.${k}`, verdict.detail); return undefined; }
  return verdict.money;
}

function validatePayload(kind: Kind, input: unknown, path: string, e: Errors): Payload | undefined {
  if (!isRecord(input)) { e.add(path, "must be an object"); return undefined; }
  const expected = PAYLOAD_TYPE_FOR_KIND[kind];
  if (input["type"] !== expected) { e.add(`${path}.type`, `must be "${expected}" for kind ${kind}`); return undefined; }
  switch (expected) {
    case "message": {
      if (!exactKeys(input, ["type", "body", "body_language"], ["in_reply_to", "booking_id", "template_id"], path, e)) return undefined;
      const body = str(input, "body", path, e, 1, 4000);
      const lang = str(input, "body_language", path, e, 1, 40, BCP47);
      const out: MessagePayload = { type: "message", body: body ?? "", body_language: lang ?? "" };
      if ("in_reply_to" in input) { const v = str(input, "in_reply_to", path, e, 1, 128); if (v !== undefined) out.in_reply_to = v; }
      if ("booking_id" in input) { const v = str(input, "booking_id", path, e, 0, 128); if (v !== undefined) out.booking_id = v; }
      if ("template_id" in input) { const v = str(input, "template_id", path, e, 0, 64); if (v !== undefined) out.template_id = v; }
      return body !== undefined && lang !== undefined ? out : undefined;
    }
    case "book_slot": {
      if (!exactKeys(input, ["type", "booking_id", "slot_date", "slot_start", "slot_end", "party_size", "price"], [], path, e)) return undefined;
      const booking = str(input, "booking_id", path, e, 1, 128);
      const date = str(input, "slot_date", path, e, 10, 10, DATE);
      const start = str(input, "slot_start", path, e, 5, 5, CLOCK);
      const end = str(input, "slot_end", path, e, 5, 5, CLOCK);
      const party = int(input, "party_size", path, e, 1, 200);
      const price = money(input, "price", path, e);
      if (booking === undefined || date === undefined || start === undefined || end === undefined || party === undefined || price === undefined) return undefined;
      return { type: "book_slot", booking_id: booking, slot_date: date, slot_start: start, slot_end: end, party_size: party, price };
    }
    case "record_payment": {
      if (!exactKeys(input, ["type", "booking_id", "money", "method", "reported_by"], [], path, e)) return undefined;
      const booking = str(input, "booking_id", path, e, 1, 128);
      const m = money(input, "money", path, e);
      const method = oneOf(input, "method", path, e, ["mpesa", "cash", "bank", "unknown"] as const);
      if (input["reported_by"] !== "owner") e.add(`${path}.reported_by`, 'must be "owner": deposits are owner-confirmed records only');
      if (booking === undefined || m === undefined || method === undefined || input["reported_by"] !== "owner") return undefined;
      return { type: "record_payment", booking_id: booking, money: m, method, reported_by: "owner" };
    }
    case "publish_listing": {
      if (!exactKeys(input, ["type", "listing", "fields"], [], path, e)) return undefined;
      const listing = oneOf(input, "listing", path, e, ["google_business", "getyourguide", "osm"] as const);
      const fields = input["fields"];
      if (!isRecord(fields)) { e.add(`${path}.fields`, "must be an object"); return undefined; }
      if (Object.keys(fields).length > 40) { e.add(`${path}.fields`, "at most 40 fields"); return undefined; }
      const out: Record<string, string | number | boolean | null> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isInteger(v))) out[k] = v;
        else { e.add(`${path}.fields.${k}`, "must be string, integer, boolean or null"); return undefined; }
      }
      if (listing === undefined) return undefined;
      return { type: "publish_listing", listing, fields: out };
    }
  }
}

function validateEvidenceItem(input: unknown, path: string, e: Errors): EvidenceItem | undefined {
  if (!isRecord(input)) { e.add(path, "must be an object"); return undefined; }
  if (!exactKeys(input, ["source_id", "content_hash", "span", "quote"], [], path, e)) return undefined;
  const source = str(input, "source_id", path, e, 1, 128);
  const hash = str(input, "content_hash", path, e, 64, 64, SHA256);
  const quote = str(input, "quote", path, e, 1, 2000);
  const span = input["span"];
  let start: number | undefined;
  let end: number | undefined;
  if (!isRecord(span) || !exactKeys(span, ["start", "end"], [], `${path}.span`, e)) { e.add(`${path}.span`, "must be {start, end}"); }
  else {
    start = int(span, "start", `${path}.span`, e, 0, Number.MAX_SAFE_INTEGER);
    end = int(span, "end", `${path}.span`, e, 1, Number.MAX_SAFE_INTEGER);
    if (start !== undefined && end !== undefined && start >= end) e.add(`${path}.span`, "start must be < end");
  }
  if (source === undefined || hash === undefined || quote === undefined || start === undefined || end === undefined || start >= end) return undefined;
  return { source_id: source, content_hash: hash, span: { start, end }, quote };
}

/** Structural validation of an envelope, including its digest field's shape. Does NOT check the digest value; see verifyEnvelopeDigest. */
export function validateEnvelope(input: unknown): Validation<ActionEnvelope> {
  const e = new Errors();
  if (!isRecord(input)) return { ok: false, errors: ["$: must be an object"] };
  const required = ["schema", "schema_version", "action_id", "tenant_id", "kind", "created_at", "valid_until", "fact_revision", "recipient", "payload", "evidence", "preview", "authority", "digest"];
  exactKeys(input, required, [], "$", e);
  if (input["schema"] !== ENVELOPE_SCHEMA) e.add("$.schema", `must be "${ENVELOPE_SCHEMA}"`);
  if (input["schema_version"] !== ENVELOPE_SCHEMA_VERSION) e.add("$.schema_version", `must be "${ENVELOPE_SCHEMA_VERSION}"`);
  const actionId = str(input, "action_id", "$", e, 36, 36, UUID);
  const tenantId = str(input, "tenant_id", "$", e, 1, 64, TENANT);
  const kind = oneOf(input, "kind", "$", e, KINDS);
  const createdAt = timestamp(input, "created_at", "$", e);
  const validUntil = timestamp(input, "valid_until", "$", e);
  if (createdAt !== undefined && validUntil !== undefined && parseTimestamp(validUntil)! <= parseTimestamp(createdAt)!) e.add("$.valid_until", "must be after created_at");
  const factRevision = int(input, "fact_revision", "$", e, 1, Number.MAX_SAFE_INTEGER);
  const digestField = str(input, "digest", "$", e, 64, 64, SHA256);

  let recipient: Recipient | undefined;
  const r = input["recipient"];
  if (!isRecord(r)) e.add("$.recipient", "must be an object");
  else if (exactKeys(r, ["channel", "address", "language"], [], "$.recipient", e)) {
    const channel = oneOf(r, "channel", "$.recipient", e, CHANNELS);
    const address = str(r, "address", "$.recipient", e, 1, 256);
    const language = str(r, "language", "$.recipient", e, 1, 40, BCP47);
    if (channel !== undefined && address !== undefined && language !== undefined) recipient = { channel, address, language };
  }

  const payload = kind !== undefined ? validatePayload(kind, input["payload"], "$.payload", e) : undefined;
  if (kind !== undefined && recipient !== undefined && !CHANNELS_FOR_KIND[kind].includes(recipient.channel)) {
    e.add("$.recipient.channel", `kind ${kind} allows channels ${CHANNELS_FOR_KIND[kind].join(", ")}`);
  }

  const evidence: EvidenceItem[] = [];
  const ev = input["evidence"];
  if (!Array.isArray(ev)) e.add("$.evidence", "must be an array");
  else if (ev.length > 50) e.add("$.evidence", "at most 50 items");
  else ev.forEach((item, i) => { const v = validateEvidenceItem(item, `$.evidence[${i}]`, e); if (v) evidence.push(v); });

  let preview: Preview | undefined;
  const p = input["preview"];
  if (!isRecord(p)) e.add("$.preview", "must be an object");
  else if (exactKeys(p, ["text", "render_locale"], [], "$.preview", e)) {
    const text = str(p, "text", "$.preview", e, 1, 4000);
    const locale = str(p, "render_locale", "$.preview", e, 1, 40, BCP47);
    if (text !== undefined && locale !== undefined) preview = { text, render_locale: locale };
  }

  const a = input["authority"];
  if (!isRecord(a) || !exactKeys(a, ["level", "owner_context_required"], [], "$.authority", e)) e.add("$.authority", "must be {level, owner_context_required}");
  else {
    if (a["level"] !== "owner") e.add("$.authority.level", 'must be "owner"');
    if (a["owner_context_required"] !== true) e.add("$.authority.owner_context_required", "must be true");
  }

  if (e.list.length > 0) return { ok: false, errors: e.list };
  return {
    ok: true,
    value: {
      schema: ENVELOPE_SCHEMA,
      schema_version: ENVELOPE_SCHEMA_VERSION,
      action_id: actionId!,
      tenant_id: tenantId!,
      kind: kind!,
      created_at: createdAt!,
      valid_until: validUntil!,
      fact_revision: factRevision!,
      recipient: recipient!,
      payload: payload!,
      evidence,
      preview: preview!,
      authority: { level: "owner", owner_context_required: true },
      digest: digestField!,
    },
  };
}

/** The digest over everything except the digest member itself. */
export function envelopeDigest(envelope: Omit<ActionEnvelope, "digest"> | ActionEnvelope, sha256: Sha256): string {
  const { digest: _ignored, ...body } = envelope as ActionEnvelope;
  return digest(ENVELOPE_DOMAIN, body, sha256);
}

/** Validate structure AND confirm the digest matches the content. The only entry point an approval may use. */
export function verifyEnvelope(input: unknown, sha256: Sha256): Validation<ActionEnvelope> {
  const v = validateEnvelope(input);
  if (!v.ok) return v;
  const expected = envelopeDigest(v.value, sha256);
  if (expected !== v.value.digest) return { ok: false, errors: [`$.digest: content digest is ${expected}, envelope claims ${v.value.digest}`] };
  return v;
}

/** Build a complete envelope from a body: validates, then fills the digest. */
export function sealEnvelope(body: Omit<ActionEnvelope, "digest">, sha256: Sha256): Validation<ActionEnvelope> {
  const probe = validateEnvelope({ ...body, digest: "0".repeat(64) });
  if (!probe.ok) return probe;
  const sealed: ActionEnvelope = { ...probe.value, digest: envelopeDigest(probe.value, sha256) };
  return { ok: true, value: sealed };
}
