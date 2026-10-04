# @sauti/core (Claude Domain lane)

Portable TypeScript domain core for Sauti Host. Pure functions plus one transaction port. No network, no model call, no provider SDK, no clock reads of its own: the host passes time, hashing and storage in.

Built against `contracts/` revision 1.0.0. `tests/contract.test.ts` loads the shared fixtures and digest vectors, so this package and the Python reference (`sauti/core/canon.py`) cannot drift apart silently.

```
npm install
npm run typecheck
npx vitest run
```

## What the host (Mobile, sync service) must provide

| Port | Why | Notes |
|---|---|---|
| `Sha256` `(bytes: Uint8Array) => hex` | digests | node:crypto in tests; react-native-quick-crypto or an equivalent native module on the phone. Must be SHA-256 over raw bytes. |
| `ApprovalStore.transaction(fn)` | exact approval | One database transaction (`BEGIN IMMEDIATE` on SQLite/SQLCipher). If `fn` throws, nothing it wrote persists. `insertApproval` must be unique per `action_id`; `insertOutbox` unique per `idempotency_key`. |
| `ClockState.highWaterMs` | monotonic time | Persist the highest wall clock ever observed and feed it to `observeClock` on every read. The reading's `suspect` flag holds approval and dispatch. |
| trusted owner registry | owner authentication | `TrustedOwner` (registered owner id, trusted device ids, allowed unlock methods, max session age, revoked session ids) comes from the device's local authentication, never from request data or model output. `OwnerContext.authenticated_at` is when the session was unlocked; voice/text are confirmations inside it. |
| restart hook | abandoned dispatch | At process start call `recoverAfterRestart` on every `sending` row: it becomes `send_unknown`, to be reconciled, never requeued blindly. |

## Flow

```ts
import { sealEnvelope, envelopeDigest, approveExact, revokeExact, observeClock, checkDispatch,
         beginDispatch, recordAcceptance, recordFailure, recoverAfterRestart, applyReceipt,
         ingestMessages, analyzeFeedback, buildDecisionCards, recordChoice } from "@sauti/core";

// 1. Build a proposal. Code fills every field; the model only suggested spans and a template.
const sealed = sealEnvelope(bodyWithoutDigest, sha256);         // validates, then sets digest
if (!sealed.ok) show(sealed.errors);                            // never hash an invalid envelope

// 2. Render the card from the envelope and hash what was rendered.
const renderedDigest = envelopeDigest(renderedEnvelope, sha256); // must equal sealed.value.digest

// 3. Noor taps approve, after local owner unlock. The request carries NO owner: the store's
//    getOwnerSession(tenant) is read inside the transaction and checked against the trusted registry.
const clock = observeClock(persistedClockState, Date.now(), monotonicNowMs /* optional, trusted elapsed time */);
persist(clock.state);                                            // the high-water mark must survive restarts
const result = await approveExact(store, { actionId, renderedDigest, confirmation: "tap", clock, approvalId: uuid(), sha256 });
// result.ok === false carries an enumerated reason: rendered_digest_mismatch, fact_revision_mismatch,
// expired, clock_suspect, no_owner_session, device_not_trusted, session_stale, ... Show it; never retry blindly.

// 3b. Noor changes her mind: same session rules, same transaction boundary.
const revoked = await revokeExact(store, { actionId, clock });  // recalled only when nothing was in flight

// 4. Worker, later, with signal. Load the IMMUTABLE approval record and outbox row for the action.
const check = checkDispatch({ action, approval, outbox, clock, currentFactRevision, sha256 });
if (!check.ok) hold(check.hold);                                 // expired / revoked / fact_revision_changed / needs_reconcile / digest_mismatch
let a = beginDispatch(action);                                   // persist BEFORE the provider call
try { a = recordAcceptance(a, await provider.send(check.send)); } // send ONLY check.send: the pinned bytes and stable key
catch (e) { a = recordFailure(a, provesNoAcceptance(e)); }      // failed (retry with same key) or send_unknown (reconcile)
// At process start: for every row in `sending`, a = recoverAfterRestart(a)  -> send_unknown, never requeued blindly

// 5. Receipts: authenticated by the host first, then
const out = applyReceipt(a, receipt, seenProviderEventIds);     // pure; duplicate / would_regress / wrong_reference leave both unchanged
persistTogether(out.action, out.seen);                          // action and seen-set in ONE transaction
```

## Feedback to decision (W3 steps 1 to 5)

```ts
const stored = ingestMessages(incoming, sha256, existingSources);          // immutable originals; (source, external_id) duplicates reported
// language id (a separate step) writes SourceText.language; "und"/"unsure" means ask a person
const analysis = analyzeFeedback(modelOutput, sources, sha256, {           // model output read as DATA
  allowedThemes: CATALOGUE, supportedLanguages: new Set(["sw", "en", "de", "fr"]) });
// analysis.themes: unique COMMENT counts (cross-posts folded), supporting side >= 3, dissent named, conflicting -> ask
// analysis.ask_a_person: structured_output_failure / unsupported_language / contradictory_reviews / evidence_invalid
const cards = buildDecisionCards(analysis, sha256);                        // only with enough evidence; digest-bound to the evidence set
const choice = recordChoice({ shownCard, currentCard, transcript, asrUncertain }); // explicit try/reject/ask_someone only; stale card refused
```

Text inside a source is data. Nothing in this package reads instructions from it.

## Files

| Module | Owns |
|---|---|
| `utf8.ts` | strict UTF-8 encode/decode, byte-boundary checks |
| `canon.ts` | RFC 8785 canonical bytes, domain-separated digests, source text hash |
| `envelope.ts` | envelope types, structural validation mirroring the JSON Schema, `sealEnvelope`, `verifyEnvelope` |
| `money.ts` | integer minor units, ISO 4217 exponents, unknown currency = clarification |
| `states.ts` | business and transport states, transitions, monotonic receipt rule, recall rule |
| `clock.ts` | monotonic high-water clock, strict RFC 3339 timestamps, expiry |
| `approval.ts` | `decideApproval` (pure), `approveExact` (transactional), rejection, idempotency key |
| `approval-code.ts` | r1.1: one-time approval codes for the owner's basic phone (`issueApprovalCode`, `verifyApprovalCode`, `parseSmsReply`); hashed, digest-bound, single-use, expiring, lockout; mints the action-bound `sms_code` session |
| `alert.ts` | r1.1: owner alerts (`validateOwnerAlert`, `sealOwnerAlert`, `verifyOwnerAlert`), own digest domain; never an envelope, so never an action |
| `outbox.ts` | dispatch re-check, sending / sent / failed / send_unknown, receipts, cancel after acceptance, truthful labels |
| `evidence.ts` | span validation, unique comment counts with cross-post folding, theme verdicts, ask-a-person |
| `tagging.ts` | the model's output read as data: label parsing, structured-output failure |
| `ingest.ts` | immutable sources, duplicate detection by (source, external_id) |
| `decisions.ts` | decision cards bound to their evidence, the owner's explicit choice |
| `calendar.ts` | slot reconciliation (at most the remaining capacity, tentative offline requests), absolute appointments |
| `proposals.ts` | from a decision card to one exact follow-up envelope; refuses numbers with no source in facts, counts, quotes or the recipient address |
| `swahili.ts` | amounts, clock times and yes/no parsed by code (reduced port of the Python W1 reference) |
| `facts.ts` | farm sheet revisions, `validateFarmSheet` for the setup screen, W3 step 6 fact changes (dictated value parsed by code, applied only on an explicit yes on the same revision, listing drafts never published) |
| `bookings.ts` | capacity check from the farm sheet and confirmed seats, one exact `book_slot` proposal, confirmation on the authoritative calendar, visitor message, arrival record |
| `tools/w3-adapter.ts` | Node-only harness for Nat's fixtures (`SAUTI_TAGGER_MODULE` swaps in a real tagger); not exported by the package |

## Bookings and farm setup (v1 scope, 2026-10-03)

```ts
const sheet = validateFarmSheet(formValues);                      // code-validated; empty fields stay null
const revision = makeRevision(sheet.sheet, previous.revision + 1, "shamba_screen", nowMs, sha256);

const check = checkCapacity(revision.sheet, confirmedBookings, request);   // missing_fact / closed_day / unsupported_time / no_capacity -> ask a person
// One tour per open day: the slot is the date, every confirmed party shares capacity_per_tour.
const proposal = proposeBooking({ request, facts: revision, confirmed, tenant_id, action_id, booking_id, created_at_ms, valid_for_ms, preview_text, render_locale }, sha256);
// Noor approves proposal.envelope through approveExact (result.approval is the record), then in the same transaction:
const confirmed = confirmBooking({ booking: proposal.booking, envelope: result.action.envelope, approval: result.approval, tenant_id, sheet: revision.sheet,
                                   current_fact_revision: revision.revision, confirmed: confirmedBookings, authoritative: isAuthoritativeDevice, requested_at: nowIso, sha256 });
// every bound field (tenant, digest, date, start, end, party, price, fact revision) must match or it refuses
const reply = proposeBookingMessage({ booking: confirmed.booking, template, tenant_id, action_id: uuid(), fact_revision: revision.revision, created_at_ms, valid_for_ms }, sha256); // its own approval
const arrived = recordArrival(confirmed.booking, "arrived");       // owner record, nothing sent

// W3 step 6: Noor said "try" on a card, then dictated the new value
const change = proposeFactChange({ theme, choice: "try", transcript, current: revision }, sha256);   // value parsed by code from HER words only
const renderedDigest = change.proposal.digest;                 // FREEZE this when you speak/show the read-back, like an approval card
const applied = confirmFactChange({ proposal: change.proposal, renderedDigest, transcript: "ndiyo", current: revision, nowMs, session, trusted, clock, tenant_id }, sha256);
// recomputes the proposal digest and read-back, requires renderedDigest == proposal.digest (a yes to A can never apply B),
// checks the sheet hash and revision, needs the owner session;
// applied.revision + applied.approval + applied.drafts (published:false) are written in ONE transaction
```

Owner unlock for all of this is the Sauti PIN session the host establishes (Carter, 2026-10-03 23:48 UTC); the core sees `unlock: "pin"` and refuses anything else.

## The hub (apps/hub) and contract r1.1 (2026-10-04)

The tourism-office hub is another host of this package, with one more way for Noor to approve: her basic phone. Carter's guardrail: an SMS "NDIYO" is never an approval by itself. The hub flow, all through this package:

1. The hub proposes an action as usual (`sealEnvelope`), renders the read-back SMS from it, and calls `issueApprovalCode({tenant_id, action_id, digest, challengeId, clock, randomBytes, sha256})`. It puts `code` in the SMS ("Jibu NDIYO B 482193") and stores `challenge`; the code is never stored.
2. A reply arrives. The hub maps the sending number to the opaque `device_id` it assigned at enrollment (the number never enters a record), parses it with `parseSmsReply`, resolves the ref ("B") to the action, and calls `verifyApprovalCode({challenge, action_id, digest, code, senderDeviceId, trusted, clock, sessionId, sha256})`. Refusals: `device_not_trusted` (checked before the code, so a stranger burns no attempt), `used`, `locked`, `expired`, `action_mismatch`, `digest_mismatch`, `wrong_code`, `unlock_not_allowed`, `clock_suspect`.
3. On success the hub persists the updated challenge and stores the returned `AuthenticatedSession` (unlock `sms_code`, bound to that one action and its digest) where its `ApprovalTx.getOwnerSession` reads it, then calls `approveExact` in the same transaction. `decideApproval` refuses a bound session for any other action and writes an r1.1 record (`schema_version "1.1.0"`, `confirmation "text"`, `challenge_id`). The hub then revokes the session (`revokeAllSessions`).
4. Dispatch is unchanged: `checkDispatch` sends the pinned bytes; the `voice` channel carries `payload.clip_keys` to the clip player.

Owner alerts (`alert.ts`) are how the hub tells Noor something happened. They are not actions: `verifyEnvelope` rejects them, so nothing an alert says can queue a send.

## Not in this package, on purpose

Persistence, encryption, UI, model inference, translation, provider adapters, the sync wire format (Platform's contract). Payments and listings are later phases; the envelope kinds exist so the schema need not change, the workflows do not.
