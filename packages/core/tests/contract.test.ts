import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { alertDigest, verifyOwnerAlert } from "../src/alert.js";
import { validateApprovalRecord } from "../src/approval.js";
import { canonicalBytes, digest, ENVELOPE_DOMAIN, OWNER_ALERT_DOMAIN, sourceTextHash } from "../src/canon.js";
import { envelopeDigest, sealEnvelope, validateEnvelope, verifyEnvelope, type ActionEnvelope } from "../src/envelope.js";
import { validateEvidence, type SourceText } from "../src/evidence.js";
import { bytesToHex, hexToBytes } from "../src/utf8.js";
import { CONTRACTS, FIXTURES, goodEnvelope, listJson, loadJson, sha256 } from "./helpers.js";

function sources(): Map<string, SourceText> {
  const map = new Map<string, SourceText>();
  for (const path of listJson(join(FIXTURES, "sources"))) {
    const s = loadJson<SourceText>(path);
    map.set(s.source_id, s);
  }
  return map;
}

describe("contract fixtures (shared with the Python reference)", () => {
  const goods = listJson(join(FIXTURES, "good")).map((p) => [p, loadJson<Record<string, unknown>>(p)] as const);

  it.each(goods.filter(([, d]) => d["schema"] === "sauti.action_envelope"))("good envelope %s validates and its digest matches", (_path, data) => {
    const v = verifyEnvelope(data, sha256);
    expect(v.ok, JSON.stringify(v)).toBe(true);
  });

  it.each(listJson(join(FIXTURES, "bad")))("bad fixture %s is rejected", (path) => {
    const c = loadJson<{ reason: string; validate_as?: string; input: Record<string, unknown> }>(path);
    if (c.input["schema"] === "sauti.approval_record") {
      expect(validateApprovalRecord(c.input).ok, c.reason).toBe(false);
      return;
    }
    if (c.input["schema"] === "sauti.owner_alert") {
      expect(verifyEnvelope(c.input, sha256).ok, "an alert is never an action").toBe(false);
      if (c.validate_as !== "action_envelope") expect(verifyOwnerAlert(c.input, sha256).ok, c.reason).toBe(false);
      return;
    }
    const v = verifyEnvelope(c.input, sha256);
    if (!v.ok) return;
    const ev = validateEvidence(v.value.evidence, sources(), sha256);
    expect(ev.rejected.length, c.reason).toBeGreaterThan(0);
  });

  it("good approval record validates and binds to its envelope", () => {
    const approval = loadJson<Record<string, unknown>>(join(FIXTURES, "good", "approval_send_message.json"));
    const env = goodEnvelope();
    const v = validateApprovalRecord(approval);
    expect(v.ok, JSON.stringify(v)).toBe(true);
    expect(approval["action_id"]).toBe(env.action_id);
    expect(approval["digest"]).toBe(env.digest);
  });

  it("r1.1: good alert validates under its own domain and is not an envelope", () => {
    const alert = loadJson<Record<string, unknown>>(join(FIXTURES, "good", "owner_alert_booking.json"));
    const v = verifyOwnerAlert(alert, sha256);
    expect(v.ok, JSON.stringify(v)).toBe(true);
    expect(verifyEnvelope(alert, sha256).ok).toBe(false);
    expect(validateApprovalRecord(alert).ok).toBe(false);
    if (v.ok) {
      const { digest: _d, ...body } = v.value;
      expect(alertDigest(v.value, sha256)).not.toBe(digest(ENVELOPE_DOMAIN, body, sha256));
    }
  });

  it("r1.1: sms_code approval record validates and binds to the voice envelope", () => {
    const approval = loadJson<Record<string, unknown>>(join(FIXTURES, "good", "approval_sms_code.json"));
    const env = loadJson<ActionEnvelope>(join(FIXTURES, "good", "send_message_voice.json"));
    const v = validateApprovalRecord(approval);
    expect(v.ok, JSON.stringify(v)).toBe(true);
    expect(approval["schema_version"]).toBe("1.1.0");
    expect(approval["action_id"]).toBe(env.action_id);
    expect(approval["digest"]).toBe(env.digest);
    expect(env.recipient.channel).toBe("voice");
  });

  it("r1.1: alert vectors reproduce byte for byte under sauti.owner_alert.v1", () => {
    const { alert_vectors } = loadJson<{ alert_vectors: Array<{ alert_without_digest: unknown; canonical_utf8_hex: string; domain: string; digest: string }> }>(join(FIXTURES, "digest-vectors.json"));
    expect(alert_vectors.length).toBeGreaterThan(0);
    for (const v of alert_vectors) {
      expect(bytesToHex(canonicalBytes(v.alert_without_digest))).toBe(v.canonical_utf8_hex);
      expect(v.domain).toBe(OWNER_ALERT_DOMAIN);
      expect(digest(v.domain, v.alert_without_digest, sha256)).toBe(v.digest);
    }
  });

  it("r1.0 fixture digests are frozen: r1.1 is additive", () => {
    expect(goodEnvelope().digest).toBe("1cfa0b8a1fa42b70ebb9ea3b172477307fba29e1de367c83f3be02535aa7b94f");
  });

  it("digest vectors reproduce byte for byte", () => {
    const { vectors } = loadJson<{ vectors: Array<{ envelope_without_digest: unknown; canonical_utf8_hex: string; domain: string; digest: string }> }>(join(FIXTURES, "digest-vectors.json"));
    expect(vectors.length).toBeGreaterThan(0);
    for (const v of vectors) {
      expect(bytesToHex(canonicalBytes(v.envelope_without_digest))).toBe(v.canonical_utf8_hex);
      expect(hexToBytes(v.canonical_utf8_hex).length).toBeGreaterThan(0);
      expect(digest(v.domain, v.envelope_without_digest, sha256)).toBe(v.digest);
      expect(v.domain).toBe(ENVELOPE_DOMAIN);
    }
  });

  it("source fixture hash matches the Python reference", () => {
    for (const s of sources().values()) expect(sourceTextHash(s.text, sha256)).toBe(s.content_hash);
  });

  it("states.json and the TS tables agree", async () => {
    const states = loadJson<{ business_states: string[]; transport_states: string[]; business_transitions: Array<{ from: string; to: string }>; transport_transitions: Array<{ from: string; to: string }>; transport_rank: Record<string, number> }>(join(CONTRACTS, "states.json"));
    const s = await import("../src/states.js");
    expect([...s.BUSINESS_STATES]).toEqual(states.business_states);
    expect([...s.TRANSPORT_STATES]).toEqual(states.transport_states);
    expect(s.BUSINESS_TRANSITIONS.map(([f, t]) => ({ from: f, to: t }))).toEqual(states.business_transitions.map(({ from, to }) => ({ from, to })));
    expect(s.TRANSPORT_TRANSITIONS.map(([f, t]) => ({ from: f, to: t }))).toEqual(states.transport_transitions.map(({ from, to }) => ({ from, to })));
    expect(s.TRANSPORT_RANK).toEqual(states.transport_rank);
  });
});

describe("envelope validation", () => {
  it("rejects unknown members, floats, wrong recipient channel for kind", () => {
    const env = goodEnvelope();
    expect(validateEnvelope({ ...env, extra: 1 }).ok).toBe(false);
    expect(validateEnvelope({ ...env, fact_revision: 1.5 }).ok).toBe(false);
    expect(validateEnvelope({ ...env, recipient: { ...env.recipient, channel: "local" } }).ok).toBe(false);
    expect(validateEnvelope({ ...env, valid_until: env.created_at }).ok).toBe(false);
  });

  it("sealEnvelope produces a digest that verifyEnvelope accepts, and any edit breaks it", () => {
    const { digest: _d, ...body } = goodEnvelope();
    const sealed = sealEnvelope(body, sha256);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(verifyEnvelope(sealed.value, sha256).ok).toBe(true);
    expect(envelopeDigest(sealed.value, sha256)).toBe(sealed.value.digest);
    const edited: ActionEnvelope = { ...sealed.value, preview: { ...sealed.value.preview, text: sealed.value.preview.text + " " } };
    expect(verifyEnvelope(edited, sha256).ok).toBe(false);
  });
});
