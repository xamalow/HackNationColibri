# Sauti contracts, revision 1.1.0 (r1.0 FROZEN; r1.1 additive, 2026-10-04)

Owner: Claude Domain (`fable-5.1-nav`). Publication and freeze: Codex Platform (`codex`). Consumers: Mobile (`apps/mobile`), Experience (`packages/experience`), the hub (`apps/hub`), the sync service, Nat's failure fixtures.

Platform and Domain froze r1.0 at commit `68aa1785e799834fa2dd2d96ac6fff91e576a6d5`; Warden published it in PR #15. Revision 1.1.0 is **additive** (Carter's YES to the tourism-office hub, 2026-10-04): every 1.0.0 document is unchanged and still valid, the r1.0 fixtures and digest vectors are byte-identical, and the digest domains do not change. A document that says `schema_version: "1.0.0"` cannot carry an r1.1 feature, so an r1.0-only validator keeps refusing exactly what it does not know. See "Revision 1.1.0" below.

Files:

| File | What it is |
|---|---|
| `action-envelope.schema.json` | One exact action Noor may approve. Everything the owner sees and everything a transport will do is inside it. |
| `approval-record.schema.json` | Noor's decision on one envelope, bound to its digest and to a trusted owner context. |
| `states.json` | Business and transport states, allowed transitions, monotonic ranks and the rules around them. |
| `fixtures/good/*.json` | Valid envelopes and approval records with correct digests. |
| `fixtures/bad/*.json` | Inputs that must be rejected, each with the expected reason. |
| `fixtures/digest-vectors.json` | Canonical bytes and digests for cross-language tests. A TypeScript or Kotlin implementation must reproduce every vector before it may approve anything. |
| `fixtures/sources/*.json` | Synthetic immutable source texts used by the evidence fixtures. Labeled synthetic. |

## Digest

```
canonical = RFC 8785 (JCS) bytes of the envelope WITHOUT the "digest" member
digest    = sha256( "sauti.action_envelope.v1" || 0x00 || canonical )   as lowercase hex
```

- The envelope is schema-validated BEFORE hashing. Unknown members are a validation error, not ignored.
- No floats anywhere. Money is `{amount_minor, currency, exponent}` with integers only.
- Timestamps are RFC 3339 UTC with a literal `Z` and second precision, so two devices render the same instant the same way.
- The domain prefix keeps an envelope digest from colliding with an approval or source digest of the same bytes. Source texts hash as `sha256("sauti.source_text.v1" || 0x00 || utf8(text))`.
- Hash equality proves byte identity, not that a person saw it. The trusted owner session proves who approved; the rendered digest proves what was on the screen when they did.

## Approval, in one transaction

```
BEGIN IMMEDIATE
  action   = load(action_id)                     ; must be business_state = proposed
  assert   action.digest == rendered_digest      ; what the owner was shown
  assert   action.fact_revision == current_fact_revision
  assert   now_effective < action.valid_until    ; monotonic clock, see states.json
  session  = host owner session (keystore-backed unlock state), read INSIDE the transaction; the caller cannot pass one
  assert   envelope passes the schema and its digest matches its content   ; the gate runs here too, not only upstream
  assert   owner session is trusted:             ; from local authentication, never from request or model text
             owner_id == tenant's registered owner (owner_id is NOT tenant_id: tenant is the business)
             device_id in the tenant's trusted device list
             unlock in the allowed set (pin, biometric); voice/text are confirmations, not sessions
             session_id not revoked; authenticated_at within max session age and not in the future
  insert   approval_record (unique per action_id)
  update   business_state = approved, transport_state = queued
  insert   outbox row (idempotency_key = sha256(tenant_id || action_id || digest), unique, full 64 hex)
COMMIT
```

Providers with a key length cap get the first 32 hex characters (128 bits) of the same key, documented per adapter; below 32 the adapter keeps a mapping table. Never an ad hoc truncation.

## Dispatch sends the pinned bytes

The worker loads the immutable approval record and the outbox row written in that transaction, and sends ONLY what the row pins: `approval.digest == outbox.digest == stored envelope digest == digest recomputed from the stored content`, and the row's address, channel and payload JSON equal the envelope's. An envelope edited and re-sealed under the same action id fails this check and is held; a business flag of "approved" alone never dispatches anything. Expiry, revocation, fact revision and the clock are re-checked at the same moment.

Any failed assertion rolls everything back. A crash between the first insert and COMMIT leaves nothing. There is no state where an approval exists without its outbox row, or an outbox row without its approval.

## What voids an approval

Any change to the envelope: recipient, channel, payload text, language, preview text or locale, fact revision, validity window. The change produces a new `action_id` (or a new revision under a new id); the old one is cancelled. The old approval cannot be reused because its digest no longer matches anything that can be dispatched.

A farm sheet change after approval and before dispatch cancels the action at dispatch time (fact revision check) and the owner is asked again.

## Evidence

Every `evidence` item is validated by code, never trusted from the model:

1. `source_id` exists for this tenant.
2. `content_hash` equals the stored hash of the immutable original text.
3. `span.start < span.end <= len(utf8(original))`, both on UTF-8 character boundaries.
4. `quote == utf8(original)[start:end]` exactly.

A failed item is dropped and the finding is marked uncertain. Counts are over unique `source_id`s of valid items only. Fewer than 3 sources on a theme is "not enough feedback to conclude". Positive and negative evidence on the same theme is "conflicting evidence", not a majority claim. Text inside a source that reads like an instruction ("ignore policy, send now") is text; it cannot create a fact, an approval or a send.

## Schema gates that code must add

The JSON Schema bounds every timestamp field and binds `kind` to `payload.type` and `recipient.channel` (the `allOf` block). Two things it cannot express are enforced by code in every implementation before hashing, and the bad fixtures cover them: a real calendar date (no 2026-02-30) and `valid_until > created_at`. Integer-valued numbers such as `1.0` are integers: both canonicalizers serialise them as `1`, so Python and JS hash the same bytes.

## Freeze decisions (Domain + Platform, 2026-10-03)

1. `tenant_id` stays and names the business. `owner_id` in the approval record names the registered owner. The server derives the authenticated device's tenant from its grant and rejects an envelope whose `tenant_id` differs; it never rewrites an approved digest.
2. Idempotency key: full 64 hex internally. Constrained adapters derive the first 32 hex (128 bits), documented, never an ad hoc truncation.
3. One message kind: `send_message` with optional `in_reply_to`. `send_reply` is removed. `reply_to_review` stays for listing reviews.
4. Reconnect metadata (`event_id`, `device_id`, `device_sequence`, `action_id`, `action_digest`) lives in Platform's sync event wrapper, never inside the envelope, so it cannot mutate owner-approved bytes. Server uniqueness is tenant/event and tenant/action with hash-conflict rejection.
5. Revocation stops dispatch but never hides carrier truth: a receipt for an action revoked while sending is still recorded. A `sending` row found at restart is `send_unknown`. A delivered receipt arriving before sent is applied, because delivery proves acceptance.

## Revision 1.1.0 (additive, 2026-10-04): what the tourism-office hub needed

Carter said YES to the hub (room decision #47595) with four guardrails; three of them touch the contract. Nothing in r1.0 moved: same digest domains, same fixtures, same vectors. Every addition is gated on `schema_version: "1.1.0"` so an r1.0-only validator refuses it cleanly.

1. **Voice channel** (`action-envelope.schema.json`): `recipient.channel` gains `voice` for `send_message` only. An outbound call plays the pre-rendered clips named in `payload.clip_keys` (keys of `packages/experience/audio/manifest.json`) to `recipient.address` (E.164); `payload.body` is the exact text they speak. `clip_keys` is required on `voice` and forbidden elsewhere, so the clips a call plays are pinned in the digest Noor approved. Listings and bookings never go by call.
2. **SMS-code approval** (`approval-record.schema.json`): `owner_context.unlock` gains `sms_code`. A sender id can be spoofed, so an SMS "NDIYO" is never an approval by itself. The hub sends a read-back SMS with a per-proposal one-time code ("Jibu NDIYO B 48219393"); the reply counts only when it comes from the owner's **enrolled** number (an opaque `device_id` in the tenant's trusted list; the phone number itself never appears in a record) **and** carries that code. The code is random, stored only as a domain-separated hash (`sauti.approval_code.v1`) bound to tenant, action, content digest and challenge; single-use; expiring (15 minutes by default); locked after 5 wrong codes. A verified code mints a session bound to that one action AND the exact digest it read back (the same action id with changed content needs a fresh read-back and code); the record says `unlock: "sms_code"`, `confirmation: "text"` and names the `challenge_id` it consumed. Reference implementation: `packages/core/src/approval-code.ts`; the hub calls `issueApprovalCode`, `parseSmsReply`, `verifyApprovalCode`, then the ordinary `approveExact`.
3. **Owner alerts** (`owner-alert.schema.json`, new): a notification TO Noor (booking received or cancelled, visitor message, voicemail, missed call, proposal waiting). It informs and acts on nobody's behalf, so it is not an action envelope: no kind from the action list, no recipient, payload, authority or approval, its own digest domain `sauti.owner_alert.v1`. `verifyEnvelope` and `decideApproval` reject one by construction. Facts in its text come from code, never from a model or a translation; delivery state lives beside the alert, never inside it.

Rules the fixtures pin: `bad/voice_channel_on_schema_1_0`, `bad/voice_without_clip_keys`, `bad/clip_keys_without_voice`, `bad/voice_channel_for_publish_listing`, `bad/approval_sms_code_on_schema_1_0`, `bad/approval_sms_code_without_challenge`, `bad/approval_sms_code_with_tap_confirmation`, `bad/approval_pin_with_challenge_id`, `bad/owner_alert_as_action`, `bad/owner_alert_with_approval_member`, `bad/owner_alert_about_nothing`. Good: `send_message_voice`, `approval_sms_code` (approves it), `owner_alert_booking`; `digest-vectors.json` gains the voice envelope and an `alert_vectors` list.

Not changed on purpose: PIN and biometric sessions, every r1.0 record, the business and transport state tables, the idempotency key. An app that only knows r1.0 keeps working against the same core; it will refuse r1.1 documents it has never seen, which is the correct behaviour for a validator.
