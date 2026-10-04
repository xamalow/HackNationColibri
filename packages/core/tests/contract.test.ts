import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { validateApprovalRecord } from "../src/approval.js";
import { canonicalBytes, digest, ENVELOPE_DOMAIN, sourceTextHash } from "../src/canon.js";
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
    const c = loadJson<{ reason: string; input: Record<string, unknown> }>(path);
    if (c.input["schema"] === "sauti.approval_record") {
      expect(validateApprovalRecord(c.input).ok, c.reason).toBe(false);
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
