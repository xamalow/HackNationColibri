/**
 * Owner alerts: notifications TO Noor (a booking arrived, a visitor wrote, a
 * call was missed, a proposal is waiting). An alert informs; it acts on
 * nobody's behalf. That is a type-level fact, not a lexicon rule: an alert is
 * not an action envelope, has no recipient, payload, authority or approval,
 * and lives under its own digest domain. verifyEnvelope and decideApproval
 * reject one by construction, so nothing an alert says can queue a send.
 *
 * Facts in the text come from code (date, party size, platform), never from a
 * model or a translation. Delivery state (SMS sent, call placed) is the hub's
 * own row beside the alert; the alert itself is immutable and digest-proven.
 * Mirrors contracts/owner-alert.schema.json (r1.1).
 */

import { digest, OWNER_ALERT_DOMAIN, type Sha256 } from "./canon.js";
import { parseTimestamp } from "./clock.js";
import { CLIP_KEY, type Validation } from "./envelope.js";

export const OWNER_ALERT_SCHEMA = "sauti.owner_alert";
export const OWNER_ALERT_SCHEMA_VERSION = "1.1.0";

export const ALERT_KINDS = ["booking_received", "booking_cancelled", "visitor_message", "voicemail", "missed_call", "proposal_waiting"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface AlertAbout {
  booking_id?: string;
  /** The hub intake event (call, SMS, e-mail) this alert reports. */
  event_id?: string;
  /** For proposal_waiting: the envelope Noor may approve. Naming it grants nothing. */
  action_id?: string;
}

export interface OwnerAlert {
  schema: typeof OWNER_ALERT_SCHEMA;
  schema_version: typeof OWNER_ALERT_SCHEMA_VERSION;
  alert_id: string;
  tenant_id: string;
  kind: AlertKind;
  about: AlertAbout;
  created_at: string;
  /** Exactly what the owner's SMS says. Code-generated from facts. */
  text: string;
  text_language: string;
  /** Clips the alert call plays, in order; empty when there is no call. */
  clip_keys: string[];
  digest: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BCP47 = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const TENANT = /^[A-Za-z0-9._-]+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural twin of the JSON Schema. Does not check the digest value; see verifyOwnerAlert. */
export function validateOwnerAlert(input: unknown): Validation<OwnerAlert> {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["$: must be an object"] };
  const required = ["schema", "schema_version", "alert_id", "tenant_id", "kind", "about", "created_at", "text", "text_language", "clip_keys", "digest"];
  for (const k of required) if (!(k in input)) errors.push(`$.${k}: required`);
  for (const k of Object.keys(input)) if (!required.includes(k)) errors.push(`$.${k}: unknown member`);
  if (input["schema"] !== OWNER_ALERT_SCHEMA) errors.push(`$.schema: must be "${OWNER_ALERT_SCHEMA}"`);
  if (input["schema_version"] !== OWNER_ALERT_SCHEMA_VERSION) errors.push(`$.schema_version: must be "${OWNER_ALERT_SCHEMA_VERSION}"`);
  const alertId = input["alert_id"];
  if (typeof alertId !== "string" || !UUID.test(alertId)) errors.push("$.alert_id: must be a uuid");
  const tenant = input["tenant_id"];
  if (typeof tenant !== "string" || tenant.length < 1 || tenant.length > 64 || !TENANT.test(tenant)) errors.push("$.tenant_id: must be 1..64 of [A-Za-z0-9._-]");
  const kind = input["kind"];
  if (typeof kind !== "string" || !(ALERT_KINDS as readonly string[]).includes(kind)) errors.push(`$.kind: must be one of ${ALERT_KINDS.join(", ")}`);
  const about: AlertAbout = {};
  const ab = input["about"];
  if (!isRecord(ab)) errors.push("$.about: must be an object");
  else {
    if (Object.keys(ab).length === 0) errors.push("$.about: must name at least one of booking_id, event_id, action_id");
    for (const [k, v] of Object.entries(ab)) {
      if (k === "booking_id" || k === "event_id") {
        if (typeof v !== "string" || v.length < 1 || v.length > 128) errors.push(`$.about.${k}: must be 1..128 characters`);
        else about[k] = v;
      } else if (k === "action_id") {
        if (typeof v !== "string" || !UUID.test(v)) errors.push("$.about.action_id: must be a uuid");
        else about.action_id = v;
      } else errors.push(`$.about.${k}: unknown member`);
    }
  }
  const createdAt = input["created_at"];
  if (typeof createdAt !== "string" || parseTimestamp(createdAt) === null) errors.push("$.created_at: must be RFC 3339 UTC with a literal Z, second precision");
  const text = input["text"];
  if (typeof text !== "string" || text.length < 1 || text.length > 600) errors.push("$.text: must be 1..600 characters");
  const lang = input["text_language"];
  if (typeof lang !== "string" || !BCP47.test(lang)) errors.push("$.text_language: must be a BCP 47 tag");
  const clips = input["clip_keys"];
  const clipKeys: string[] = [];
  if (!Array.isArray(clips)) errors.push("$.clip_keys: must be an array");
  else {
    if (clips.length > 20) errors.push("$.clip_keys: at most 20 clips");
    clips.forEach((c, i) => {
      if (typeof c !== "string" || c.length < 1 || c.length > 64 || !CLIP_KEY.test(c)) errors.push(`$.clip_keys[${i}]: must be a clip id (lowercase letters, digits, . _ -)`);
      else clipKeys.push(c);
    });
    if (new Set(clipKeys).size !== clipKeys.length) errors.push("$.clip_keys: must be unique");
  }
  const dg = input["digest"];
  if (typeof dg !== "string" || !SHA256.test(dg)) errors.push("$.digest: must be 64 lowercase hex");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schema: OWNER_ALERT_SCHEMA,
      schema_version: OWNER_ALERT_SCHEMA_VERSION,
      alert_id: alertId as string,
      tenant_id: tenant as string,
      kind: kind as AlertKind,
      about,
      created_at: createdAt as string,
      text: text as string,
      text_language: lang as string,
      clip_keys: clipKeys,
      digest: dg as string,
    },
  };
}

/** The digest over everything except the digest member itself, under the alert's own domain. */
export function alertDigest(alert: Omit<OwnerAlert, "digest"> | OwnerAlert, sha256: Sha256): string {
  const { digest: _ignored, ...body } = alert as OwnerAlert;
  return digest(OWNER_ALERT_DOMAIN, body, sha256);
}

/** Validate structure AND confirm the digest matches the content (an alert read back from storage or a sync peer). */
export function verifyOwnerAlert(input: unknown, sha256: Sha256): Validation<OwnerAlert> {
  const v = validateOwnerAlert(input);
  if (!v.ok) return v;
  const expected = alertDigest(v.value, sha256);
  if (expected !== v.value.digest) return { ok: false, errors: [`$.digest: content digest is ${expected}, alert claims ${v.value.digest}`] };
  return v;
}

/** Build a complete alert from a body: validates, then fills the digest. */
export function sealOwnerAlert(body: Omit<OwnerAlert, "digest">, sha256: Sha256): Validation<OwnerAlert> {
  const probe = validateOwnerAlert({ ...body, digest: "0".repeat(64) });
  if (!probe.ok) return probe;
  return { ok: true, value: { ...probe.value, digest: alertDigest(probe.value, sha256) } };
}
