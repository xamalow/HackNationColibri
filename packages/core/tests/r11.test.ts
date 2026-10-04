/**
 * Contract r1.1 + core r4 (2026-10-04): the tourism-office hub.
 *
 * Carter's guardrail 3: an SMS "NDIYO" is not an approval by itself. It counts
 * only from Noor's enrolled number AND with the per-proposal one-time code the
 * hub sent in its own read-back SMS; expiring, single-use, bound to the
 * proposal digest. Alerts never trigger actions. Muller's spoof fixtures gate
 * this: spoofed number with a valid code, reused or expired code, code from
 * proposal A on B, content changed after the code was sent.
 */

import { randomBytes as nodeRandomBytes } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { alertDigest, sealOwnerAlert, validateOwnerAlert, verifyOwnerAlert, type OwnerAlert } from "../src/alert.js";
import { approveExact, decideApproval, decideRejection, validateApprovalRecord, type AuthenticatedSession, type TrustedOwner } from "../src/approval.js";
import { constantTimeEqual, issueApprovalCode, parseSmsReply, randomDigits, verifyApprovalCode, type CodeChallenge } from "../src/approval-code.js";
import { digest, ENVELOPE_DOMAIN } from "../src/canon.js";
import { enrollOwner, revokeAllSessions, startSession } from "../src/enrollment.js";
import { sealEnvelope, verifyEnvelope, type ActionEnvelope } from "../src/envelope.js";
import { checkDispatch } from "../src/outbox.js";
import { findNumbers, parseAmount } from "../src/swahili.js";
import { clockAt, FIXTURES, loadJson, MemoryStore, sha256, storedAction, TENANT } from "./helpers.js";

const randomBytes = (n: number): Uint8Array => new Uint8Array(nodeRandomBytes(n));
const BASIC_PHONE = "demo-basic-phone-001"; // the hub's opaque id for Noor's enrolled number; the number itself is never in a record
const STRANGER = "unknown-sender-7781";

/** The hub tenant's registry: one enrolled basic phone, SMS-code approval only, short sessions. */
const HUB_TRUSTED: TrustedOwner = {
  tenant_id: TENANT,
  owner_id: "demo-noor-001",
  trusted_device_ids: new Set([BASIC_PHONE]),
  allowed_unlock: new Set(["sms_code"]),
  max_session_age_ms: 5 * 60 * 1000,
  revoked_session_ids: new Set(),
};

function voiceEnvelope(): ActionEnvelope {
  return loadJson<ActionEnvelope>(join(FIXTURES, "good", "send_message_voice.json"));
}

/** A second proposal (B) with different content, so codes and sessions can be cross-checked. */
function otherEnvelope(): ActionEnvelope {
  const env = voiceEnvelope();
  const { digest: _d, ...body } = env;
  const sealed = sealEnvelope({ ...body, action_id: "6b6b6b6b-1234-4abc-9def-0123456789ab", payload: { ...env.payload, body: env.payload.body + " Karibu tena." } }, sha256);
  if (!sealed.ok) throw new Error(sealed.errors.join("; "));
  return sealed.value;
}

const T0 = "2026-10-04T08:10:00Z";

function issued(env = voiceEnvelope(), at = T0) {
  const r = issueApprovalCode({ tenant_id: TENANT, action_id: env.action_id, digest: env.digest, challengeId: "challenge-0001", clock: clockAt(at), randomBytes, sha256 });
  if (!r.ok) throw new Error(r.detail);
  return r;
}

/** Same length, every digit different: a wrong code of the right shape. */
function wrongCode(code: string): string {
  return code.replace(/[0-9]/g, (d) => String((Number(d) + 1) % 10));
}

describe("r1.1: one-time approval codes from the enrolled basic phone", () => {
  it("issues a code the hub never stores: only a domain-separated hash bound to tenant, action, digest and challenge", () => {
    const env = voiceEnvelope();
    const { code, challenge } = issued(env);
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(challenge.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(challenge)).not.toContain(code);
    expect(challenge.action_id).toBe(env.action_id);
    expect(challenge.digest).toBe(env.digest);
    expect(challenge.expires_at).toBe("2026-10-04T08:25:00Z");
    expect(challenge.code_length).toBe(6);
    expect(challenge.attempts).toBe(0);
    expect(challenge.used_at).toBeNull();
    // the same code for another action or content hashes differently
    const other = otherEnvelope();
    const r2 = issueApprovalCode({ tenant_id: TENANT, action_id: other.action_id, digest: other.digest, challengeId: "challenge-0001", clock: clockAt(T0), randomBytes, sha256 });
    expect(r2.ok && r2.challenge.code_hash !== challenge.code_hash).toBe(true);
  });

  it("refuses to issue on a suspect clock or with bad inputs", () => {
    const env = voiceEnvelope();
    const suspect = { ...clockAt(T0), suspect: true };
    expect(issueApprovalCode({ tenant_id: TENANT, action_id: env.action_id, digest: env.digest, challengeId: "c1", clock: suspect, randomBytes, sha256 })).toMatchObject({ ok: false, reason: "clock_suspect" });
    expect(issueApprovalCode({ tenant_id: TENANT, action_id: env.action_id, digest: "nope", challengeId: "c1", clock: clockAt(T0), randomBytes, sha256 })).toMatchObject({ ok: false, reason: "bad_input" });
    expect(issueApprovalCode({ tenant_id: TENANT, action_id: env.action_id, digest: env.digest, challengeId: "c1", clock: clockAt(T0), randomBytes, sha256, codeLength: 3 })).toMatchObject({ ok: false, reason: "bad_input" });
  });

  it("happy path: NDIYO <ref> <code> from the enrolled phone mints a bound sms_code session; approveExact writes an r1.1 record and a voice outbox row", async () => {
    const env = voiceEnvelope();
    const { code, challenge } = issued(env);
    const reply = parseSmsReply(`NDIYO B ${code}`);
    expect(reply.kind).toBe("approve");
    if (reply.kind !== "approve") return;
    expect(reply.ref).toBe("B");
    const verified = verifyApprovalCode({ challenge, action_id: env.action_id, digest: env.digest, code: reply.code, senderDeviceId: BASIC_PHONE, trusted: HUB_TRUSTED, clock: clockAt("2026-10-04T08:12:00Z"), sessionId: "sms-session-0001", sha256 });
    expect(verified.ok, JSON.stringify(verified)).toBe(true);
    if (!verified.ok) return;
    expect(verified.challenge.used_at).toBe("2026-10-04T08:12:00Z");
    expect(verified.session).toMatchObject({ unlock: "sms_code", device_id: BASIC_PHONE, bound_action_id: env.action_id, bound_digest: env.digest, challenge_id: "challenge-0001", owner_id: "demo-noor-001" });

    const store = new MemoryStore();
    store.trusted = HUB_TRUSTED;
    store.session = verified.session; // the hub's transaction reads this; the reply text never becomes the session
    store.actions.set(env.action_id, storedAction(env));
    const result = await approveExact(store, { actionId: env.action_id, renderedDigest: env.digest, clock: clockAt("2026-10-04T08:12:30Z"), approvalId: "22222222-3333-4444-8555-666666666666", sha256 });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.approval.schema_version).toBe("1.1.0");
    expect(result.approval.owner_context).toMatchObject({ unlock: "sms_code", confirmation: "text", challenge_id: "challenge-0001", device_id: BASIC_PHONE });
    expect(validateApprovalRecord(result.approval).ok).toBe(true);
    expect(result.outbox.channel).toBe("voice");
    expect(JSON.parse(result.outbox.payload_json).clip_keys).toEqual(env.payload.clip_keys);
    const dispatch = checkDispatch({ action: result.action, approval: result.approval, outbox: result.outbox, clock: clockAt("2026-10-04T08:13:00Z"), currentFactRevision: 1, sha256 });
    expect(dispatch.ok).toBe(true);
    if (dispatch.ok) expect(dispatch.send.channel).toBe("voice");

    // the session is good for exactly this one decision: the hub revokes it afterwards
    store.trusted = revokeAllSessions(HUB_TRUSTED, [verified.session.session_id]);
    const other = otherEnvelope();
    store.actions.set(other.action_id, storedAction(other));
    const again = await approveExact(store, { actionId: other.action_id, renderedDigest: other.digest, clock: clockAt("2026-10-04T08:13:30Z"), approvalId: "22222222-3333-4444-8555-666666666667", sha256 });
    expect(again.ok).toBe(false);
  });

  it("Muller 1: a spoofed number with the RIGHT code is refused before the code is compared, and burns no attempt", () => {
    const env = voiceEnvelope();
    const { code, challenge } = issued(env);
    const r = verifyApprovalCode({ challenge, action_id: env.action_id, digest: env.digest, code, senderDeviceId: STRANGER, trusted: HUB_TRUSTED, clock: clockAt("2026-10-04T08:12:00Z"), sessionId: "s1", sha256 });
    expect(r).toMatchObject({ ok: false, reason: "device_not_trusted" });
    expect(r.challenge.attempts).toBe(0);
    expect(r.challenge.used_at).toBeNull();
  });

  it("Muller 2: a code is single-use and expires", () => {
    const env = voiceEnvelope();
    const { code, challenge } = issued(env);
    const first = verifyApprovalCode({ challenge, action_id: env.action_id, digest: env.digest, code, senderDeviceId: BASIC_PHONE, trusted: HUB_TRUSTED, clock: clockAt("2026-10-04T08:12:00Z"), sessionId: "s1", sha256 });
    expect(first.ok).toBe(true);
    const replay = verifyApprovalCode({ challenge: first.challenge, action_id: env.action_id, digest: env.digest, code, senderDeviceId: BASIC_PHONE, trusted: HUB_TRUSTED, clock: clockAt("2026-10-04T08:12:05Z"), sessionId: "s2", sha256 });
    expect(replay).toMatchObject({ ok: false, reason: "used" });
    const late = verifyApprovalCode({ challenge, action_id: env.action_id, digest: env.digest, code, senderDeviceId: BASIC_PHONE, trusted: HUB_TRUSTED, clock: clockAt("2026-10-04T08:25:00Z"), sessionId: "s3", sha256 });
    expect(late).toMatchObject({ ok: false, reason: "expired" });
    expect(late.challenge.expired_at).toBe("2026-10-04T08:25:00Z");
    // codex 2026-10-04: once seen expired, a wall clock turned back must not revive the code (the hub persists the returned challenge)
    const turnedBack = verifyApprovalCode({ challenge: late.challenge, action_id: env.action_id, digest: env.digest, code, senderDeviceId: BASIC_PHONE, trusted: HUB_TRUSTED, clock: clockAt("2026-10-04T08:11:00Z"), sessionId: "s4", sha256 });
    expect(turnedBack).toMatchObject({ ok: false, reason: "expired" });
    // and a clock the host itself flags as suspect (behind its high-water mark) is refused outright
    const rolledBack = verifyApprovalCode({ challenge, action_id: env.action_id, digest: env.digest, code, senderDeviceId: BASIC_PHONE, trusted: HUB_TRUSTED, clock: clockAt("2026-10-04T08:11:00Z", Date.parse("2026-10-04T08:25:00Z")), sessionId: "s5", sha256 });
    expect(rolledBack).toMatchObject({ ok: false, reason: "clock_suspect" });
  });

  it("Muller 3: the code for proposal A does not approve proposal B", () => {
    const a = voiceEnvelope();
    const b = otherEnvelope();
    const { code, challenge } = issued(a);
    const r = verifyApprovalCode({ challenge, action_id: b.action_id, digest: b.digest, code, senderDeviceId: BASIC_PHONE, trusted: HUB_TRUSTED, clock: clockAt("2026-10-04T08:12:00Z"), sessionId: "s1", sha256 });
    expect(r).toMatchObject({ ok: false, reason: "action_mismatch" });
  });

  it("Muller 4: content changed after the read-back SMS went out", () => {
    const env = voiceEnvelope();
    const { code, challenge } = issued(env);
    const edited = otherEnvelope(); // same action re-rendered with different content would carry a new digest
    const r = verifyApprovalCode({ challenge, action_id: env.action_id, digest: edited.digest, code, senderDeviceId: BASIC_PHONE, trusted: HUB_TRUSTED, clock: clockAt("2026-10-04T08:12:00Z"), sessionId: "s1", sha256 });
    expect(r).toMatchObject({ ok: false, reason: "digest_mismatch" });
  });

  it("lockout: five wrong codes lock the challenge; the right code is then refused too", () => {
    const env = voiceEnvelope();
    const { code, challenge: c0 } = issued(env);
    let c: CodeChallenge = c0;
    const reasons: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = verifyApprovalCode({ challenge: c, action_id: env.action_id, digest: env.digest, code: wrongCode(code), senderDeviceId: BASIC_PHONE, trusted: HUB_TRUSTED, clock: clockAt("2026-10-04T08:12:00Z"), sessionId: "s1", sha256 });
      expect(r.ok).toBe(false);
      if (!r.ok) reasons.push(r.reason);
      c = r.challenge;
    }
    expect(reasons).toEqual(["wrong_code", "wrong_code", "wrong_code", "wrong_code", "locked"]);
    expect(c.attempts).toBe(5);
    const right = verifyApprovalCode({ challenge: c, action_id: env.action_id, digest: env.digest, code, senderDeviceId: BASIC_PHONE, trusted: HUB_TRUSTED, clock: clockAt("2026-10-04T08:12:10Z"), sessionId: "s2", sha256 });
    expect(right).toMatchObject({ ok: false, reason: "locked" });
  });

  it("a tenant that does not allow sms_code, a suspect clock, or a malformed code are refused", () => {
    const env = voiceEnvelope();
    const { code, challenge } = issued(env);
    const pinOnly: TrustedOwner = { ...HUB_TRUSTED, allowed_unlock: new Set(["pin"]) };
    expect(verifyApprovalCode({ challenge, action_id: env.action_id, digest: env.digest, code, senderDeviceId: BASIC_PHONE, trusted: pinOnly, clock: clockAt(T0), sessionId: "s1", sha256 })).toMatchObject({ ok: false, reason: "unlock_not_allowed" });
    expect(verifyApprovalCode({ challenge, action_id: env.action_id, digest: env.digest, code, senderDeviceId: BASIC_PHONE, trusted: HUB_TRUSTED, clock: { ...clockAt(T0), suspect: true }, sessionId: "s1", sha256 })).toMatchObject({ ok: false, reason: "clock_suspect" });
    const letters = verifyApprovalCode({ challenge, action_id: env.action_id, digest: env.digest, code: "abcd", senderDeviceId: BASIC_PHONE, trusted: HUB_TRUSTED, clock: clockAt(T0), sessionId: "s1", sha256 });
    expect(letters).toMatchObject({ ok: false, reason: "wrong_code" });
    expect(letters.challenge.attempts).toBe(1);
  });

  it("the sms_code session is bound to one action: decideApproval and decideRejection refuse any other; a malformed one is refused outright", () => {
    const a = voiceEnvelope();
    const b = otherEnvelope();
    const { code, challenge } = issued(a);
    const v = verifyApprovalCode({ challenge, action_id: a.action_id, digest: a.digest, code, senderDeviceId: BASIC_PHONE, trusted: HUB_TRUSTED, clock: clockAt(T0), sessionId: "s1", sha256 });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const onB = decideApproval({ action: storedAction(b), renderedDigest: b.digest, currentFactRevision: 1, session: v.session, trusted: HUB_TRUSTED, clock: clockAt("2026-10-04T08:11:00Z"), approvalId: "22222222-3333-4444-8555-666666666668", sha256 });
    expect(onB).toMatchObject({ ok: false, reason: "session_bound_elsewhere" });
    const rejectB = decideRejection(storedAction(b), v.session, HUB_TRUSTED, clockAt("2026-10-04T08:11:00Z"), "22222222-3333-4444-8555-666666666669");
    expect(rejectB).toMatchObject({ ok: false, reason: "session_bound_elsewhere" });
    const rejectA = decideRejection(storedAction(a), v.session, HUB_TRUSTED, clockAt("2026-10-04T08:11:00Z"), "22222222-3333-4444-8555-666666666669");
    expect(rejectA.ok).toBe(true);
    if (rejectA.ok) expect(rejectA.approval.schema_version).toBe("1.1.0");
    // codex (2026-10-04): the SAME action id with changed content is another envelope; the code approved A's bytes, not B's
    const sameIdNewContent = sealEnvelope({ ...(({ digest: _d, ...rest }) => rest)(a), payload: { ...a.payload, body: a.payload.body + " Bei imeongezeka." } }, sha256);
    expect(sameIdNewContent.ok).toBe(true);
    if (sameIdNewContent.ok) {
      expect(sameIdNewContent.value.action_id).toBe(a.action_id);
      const swapped = decideApproval({ action: storedAction(sameIdNewContent.value), renderedDigest: sameIdNewContent.value.digest, currentFactRevision: 1, session: v.session, trusted: HUB_TRUSTED, clock: clockAt("2026-10-04T08:11:00Z"), approvalId: "22222222-3333-4444-8555-666666666668", sha256 });
      expect(swapped).toMatchObject({ ok: false, reason: "session_bound_elsewhere" });
      expect(decideRejection(storedAction(sameIdNewContent.value), v.session, HUB_TRUSTED, clockAt("2026-10-04T08:11:00Z"), "22222222-3333-4444-8555-666666666669")).toMatchObject({ ok: false, reason: "session_bound_elsewhere" });
    }
    const noDigest: AuthenticatedSession = { ...v.session };
    delete (noDigest as Partial<AuthenticatedSession>).bound_digest;
    expect(decideApproval({ action: storedAction(a), renderedDigest: a.digest, currentFactRevision: 1, session: noDigest, trusted: HUB_TRUSTED, clock: clockAt("2026-10-04T08:11:00Z"), approvalId: "22222222-3333-4444-8555-666666666668", sha256 })).toMatchObject({ ok: false, reason: "session_malformed" });
    const malformed: AuthenticatedSession = { ...v.session, bound_action_id: undefined as unknown as string };
    delete (malformed as Partial<AuthenticatedSession>).bound_action_id;
    expect(decideApproval({ action: storedAction(a), renderedDigest: a.digest, currentFactRevision: 1, session: malformed, trusted: HUB_TRUSTED, clock: clockAt("2026-10-04T08:11:00Z"), approvalId: "22222222-3333-4444-8555-666666666668", sha256 })).toMatchObject({ ok: false, reason: "session_malformed" });
  });

  it("PIN sessions are unchanged by r1.1: their records still say 1.0.0 and carry no challenge", () => {
    const env = voiceEnvelope();
    const store = new MemoryStore();
    store.actions.set(env.action_id, storedAction(env));
    const TRUSTED = store.trusted!;
    const SESSION: AuthenticatedSession = { ...store.session!, authenticated_at: "2026-10-04T08:09:00Z" };
    expect(SESSION.unlock).toBe("pin");
    const r = decideApproval({ action: storedAction(env), renderedDigest: env.digest, currentFactRevision: 1, session: SESSION, trusted: TRUSTED, clock: clockAt("2026-10-04T08:11:00Z"), approvalId: "22222222-3333-4444-8555-666666666668", sha256 });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) {
      expect(r.approval.schema_version).toBe("1.0.0");
      expect("challenge_id" in r.approval.owner_context).toBe(false);
    }
  });

  it("startSession never mints an sms_code session; only verifyApprovalCode does", () => {
    const enrolled = enrollOwner({ tenant_id: TENANT, owner_id: "demo-noor-001", device_id: BASIC_PHONE, allowed_unlock: ["sms_code"] });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;
    expect(startSession({ trusted: enrolled.trusted, device_id: BASIC_PHONE, unlock: "sms_code", session_id: "s1", nowMs: Date.parse(T0) })).toMatchObject({ ok: false, reason: "unlock_not_allowed" });
  });

  it("reply grammar is strict: bare ndiyo, a missing code or trailing chatter are unknown", () => {
    expect(parseSmsReply("ndiyo")).toEqual({ kind: "unknown" });
    expect(parseSmsReply("NDIYO B")).toEqual({ kind: "unknown" });
    expect(parseSmsReply("ndiyo b 48 21")).toEqual({ kind: "approve", ref: "B", code: "4821" });
    expect(parseSmsReply("  Ndiyo A 123456 ")).toEqual({ kind: "approve", ref: "A", code: "123456" });
    expect(parseSmsReply("NDIYO B 4821 asante")).toEqual({ kind: "unknown" });
    expect(parseSmsReply("HAPANA B")).toEqual({ kind: "reject", ref: "B" });
    expect(parseSmsReply("hapana b 4821")).toEqual({ kind: "unknown" });
    expect(parseSmsReply("sawa, ndiyo B 4821")).toEqual({ kind: "unknown" });
    expect(parseSmsReply("")).toEqual({ kind: "unknown" });
  });

  it("random digits are digits of the asked length; constant-time compare is exact", () => {
    for (const n of [4, 6, 8]) expect(randomDigits(n, randomBytes)).toMatch(new RegExp(`^[0-9]{${n}}$`));
    // rejection sampling: a byte of 250..255 is skipped, 0..249 maps evenly
    const only255 = (len: number) => new Uint8Array(len).fill(255);
    const mixed = (() => { let calls = 0; return (len: number) => (calls++ === 0 ? only255(len) : new Uint8Array(len).fill(13)); })();
    expect(randomDigits(4, mixed)).toBe("3333");
    expect(constantTimeEqual("abcd", "abcd")).toBe(true);
    expect(constantTimeEqual("abcd", "abce")).toBe(false);
    expect(constantTimeEqual("abcd", "abc")).toBe(false);
  });
});

describe("r1.1: owner alerts inform and never act", () => {
  function goodAlert(): OwnerAlert {
    return loadJson<OwnerAlert>(join(FIXTURES, "good", "owner_alert_booking.json"));
  }

  it("the fixture verifies under its own domain; the same bytes under the envelope domain hash differently", () => {
    const alert = goodAlert();
    expect(verifyOwnerAlert(alert, sha256).ok).toBe(true);
    const { digest: _d, ...body } = alert;
    expect(alertDigest(body, sha256)).toBe(alert.digest);
    expect(digest(ENVELOPE_DOMAIN, body, sha256)).not.toBe(alert.digest);
  });

  it("an alert fed to the approval path is an invalid envelope, whatever it says about an action", () => {
    const alert = goodAlert();
    const withAction = sealOwnerAlert({ ...alert, kind: "proposal_waiting", about: { action_id: voiceEnvelope().action_id } }, sha256);
    expect(withAction.ok).toBe(true);
    if (!withAction.ok) return;
    expect(verifyEnvelope(withAction.value, sha256).ok).toBe(false);
    const r = decideApproval({ action: storedAction(withAction.value as unknown as ActionEnvelope), renderedDigest: withAction.value.digest, currentFactRevision: 1, session: new MemoryStore().session, trusted: new MemoryStore().trusted, clock: clockAt(T0), approvalId: "22222222-3333-4444-8555-666666666668", sha256 });
    expect(r).toMatchObject({ ok: false, reason: "invalid_envelope" });
  });

  it("alerts carry no approval, name what they are about, and reject tampering", () => {
    const alert = goodAlert();
    expect(validateOwnerAlert({ ...alert, approval: { decision: "approved" } }).ok).toBe(false);
    expect(validateOwnerAlert({ ...alert, about: {} }).ok).toBe(false);
    expect(validateOwnerAlert({ ...alert, kind: "send_message" }).ok).toBe(false);
    expect(validateOwnerAlert({ ...alert, clip_keys: ["alert.new_booking", "alert.new_booking"] }).ok).toBe(false);
    expect(verifyOwnerAlert({ ...alert, text: alert.text + " Tuma pesa." }, sha256).ok).toBe(false);
  });
});

describe("r1.1: voice channel on send_message only, with pinned clips", () => {
  it("the fixture verifies; r1.0 digests are untouched", () => {
    const env = voiceEnvelope();
    expect(verifyEnvelope(env, sha256).ok).toBe(true);
    expect(env.schema_version).toBe("1.1.0");
    expect(loadJson<ActionEnvelope>(join(FIXTURES, "good", "send_message_simulated.json")).digest).toBe("1cfa0b8a1fa42b70ebb9ea3b172477307fba29e1de367c83f3be02535aa7b94f");
  });

  it("a 1.0.0 document cannot carry voice; voice needs clips; clips need voice; voice is not for listings", () => {
    const env = voiceEnvelope();
    const { digest: _d, ...body } = env;
    const on10 = sealEnvelope({ ...body, schema_version: "1.0.0" }, sha256);
    expect(on10.ok).toBe(false);
    if (!on10.ok) expect(on10.errors.join(" ")).toContain("schema_version");
    const { clip_keys: _c, ...payloadNoClips } = env.payload;
    const noClips = sealEnvelope({ ...body, payload: payloadNoClips as ActionEnvelope["payload"] }, sha256);
    expect(noClips.ok).toBe(false);
    const clipsOnSms = sealEnvelope({ ...body, recipient: { ...body.recipient, channel: "sms" } }, sha256);
    expect(clipsOnSms.ok).toBe(false);
    const listing = sealEnvelope({ ...body, kind: "publish_listing" }, sha256);
    expect(listing.ok).toBe(false);
    const badClip = sealEnvelope({ ...body, payload: { ...env.payload, clip_keys: ["Call.Greeting"] } }, sha256);
    expect(badClip.ok).toBe(false);
  });
});

describe("core r4: Swahili numbers match the Python reference (hub finding 2026-10-04)", () => {
  it("hundreds with tens, adjacent digits, clock hours", () => {
    expect(findNumbers("mia moja na hamsini")).toEqual([150]);
    expect(findNumbers("BEI 2000 500")).toEqual([2000, 500]);
    expect(parseAmount("elfu mbili mia tano")).toBe(2500);
    expect(findNumbers("elfu moja na moja")).toEqual([1001]);
    expect(findNumbers("elfu mia moja")).toEqual([100000]);
    expect(findNumbers("saa tatu asubuhi")).toEqual([]);
    expect(findNumbers("watu wawili saa tatu")).toEqual([2]);
    expect(parseAmount("Bei mpya ni shilingi elfu moja na mia tano kwa mtu")).toBe(1500);
    expect(parseAmount("laki moja na elfu hamsini")).toBe(150000);
    expect(parseAmount("elfu kumi na tano")).toBe(15000);
    expect(findNumbers("mia tano na ishirini na tano")).toEqual([525]);
  });
});
