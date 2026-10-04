# Mobile implementation boundary review

## Accepted v1 flow and scope

1. Import feedback locally and preserve original text plus source identity.
2. Run declared-language review and deterministic theme/evidence checks. Qwen may provide unverified suggestions only.
3. Render the exact outgoing envelope preview and digest.
4. Let the owner explicitly choose try/reject/ask-a-person, then approve the exact action through Domain Core.
5. Persist approval, pinned outbox bytes, action, audit, and clock state in one SQLCipher transaction.
6. Keep business state separate from transport state; sending requires a later owner handoff/provider action and a pre-dispatch recheck.

Accepted slices and priority: Leo feedback + confirm + queue + restart; one Ziara booking; Shamba farm setup; arrival confirmation. All reuse the same Domain approval/queue path.

## Consumer review and partner coordination

- Domain contract r1.0 is merged (`84529dd`). Domain recommends Core r1 at `5dacf07` as Mobile's API pin; Core r2 additions are expected to preserve approval/outbox signatures.
- I +1'd the exact Core r1 handoff and confirmed the transaction port reads the stored action, fact revision, trusted owner, and host-established owner session, then writes approval, pinned outbox row, action, and audit together. I accepted Domain's guidance to persist `ClockState` in SQLCipher and use declared import language or `und`.
- I asked Domain who provisions the initial trusted owner/device registry. Core r1 requires that host data and intentionally does not accept trust from an approval request.
- Platform pins (Expo SDK 57.0.26, RN 0.86.3, llama.rn 0.12.9, op-sqlite 18.2.5 with SQLCipher enabled) are present on the WIP base `5ddfe35`. Platform PR #26 has merged; main is `d336218` with Core in the root lock and TypeScript 6.0.3. The lock still does not include `apps/mobile`; Codex owns the active Platform slice for Mobile root closure/lint CI and Whisper/SMS pins.
- The app-local lock supports the current Mac/iPhone smoke build. Root `npm ci --ignore-scripts --workspaces=false` reports missing `@sauti-host/mobile` and its dependencies until Platform refreshes the root lock after adding this workspace.
- Core README requires `BEGIN IMMEDIATE`; op-sqlite 18.2.5's `db.transaction()` starts deferred `BEGIN TRANSACTION`. A host adapter must serialize all operations on the single connection and use an immediate transaction, or Domain/Platform must reconcile the requirement before Mobile claims the guarantee.
- Experience's refreshed handoff defines Leo/Ziara/Shamba and arrival; current Swahili copy is explicitly unreviewed. Render copy from the frozen Experience contract and do not present unreviewed text as approved.
- Transport: follow Domain's latest SMS composer mapping. The composer is user-mediated; “sent” means handed to Messages and never delivered. A crash before result can become `send_unknown`; `delivered` requires a real authenticated receipt and is unreachable for the iOS composer. Never read inbox or silently send.
- Authentication: Mobile uses the Sauti PIN as the owner session unlock; biometric unlock is not enabled. The UI must keep confirmation distinct from unlock. Core's PIN/session constructors do not perform PIN verification or durable storage; the host owns those duties.

## Native and persistence adapter

- Core's SHA port is synchronous: `(bytes: Uint8Array) => lowercase hex`. Noble SHA-256 is compatible with this port. Mobile's current source hash matches `sauti.source_text.v1\0` plus strict UTF-8 source bytes.
- `approveExact(store, {actionId, renderedDigest, confirmation, clock, approvalId, sha256})` reads the action, current fact revision, trusted registry, and current host session inside `ApprovalTx`; the request must never accept owner/session/trust objects.
- `ApprovalTx` needs `getAction`, `getCurrentFactRevision`, `getTrustedOwner`, `getOwnerSession`, `insertApproval`, `insertOutbox`, `updateAction`, `appendAudit`. Rehydrate `ReadonlySet` fields as actual Sets from SQL.
- Persist clock high-water with `high_water_ms` and same-process monotonic time. Read before authority decisions; write inside the same transaction as approval, revocation, or dispatch. A restart with a reset uptime cannot silently forgive a wall-clock rollback.
- Outbox must preserve `payload_json` exactly as written by Core. Call `checkDispatch` immediately before a transport, persist `beginDispatch` before handing off, and use `recoverAfterRestart` for leftover `sending` rows. Never retry `send_unknown` blindly.
- The app's current approval port is an availability placeholder, not an implementation; current DB lacks actions, approvals, owner/session registry, outbox, audit, and clock tables.
- Mobile reviewed exact Core PR #24 head `8707ee5088e5245a0a978e7637d33a5f1a5517fe` and posted a consumer +1 in Senti #47561 after the rendered-readback binding and enrollment constructors were added. `confirmFactChange` now requires the digest captured from the rendered read-back and rejects a different proposal digest; `enrollOwner`, `startSession`, and `revokeAllSessions` provide host-facing constructors. Codex posted source +1 on this exact head and independently ran typecheck/build plus 87 tests; Warden review/merge remains the Core integration gate. The package does not prove SQLCipher persistence, PIN KDF/verification, or transactional enrollment.
- Core r1's source ingest limit is 16 KiB; Mobile now checks encoded UTF-8 byte length before storing. Import language comes from `lang`/`language`/`locale` or remains `und`; it is not language-ID proof.

## Open gates

- Platform must add `apps/mobile` to the root workspace lock. Codex reports the Mobile root closure/lint CI slice is active. Core PR #24 is at `8707ee5` pending Warden's final review/merge; after it lands and Platform refreshes the root lock, install that exact workspace package and implement/verify the SQLCipher adapter. Warden assigned `apps/mobile` implementation ownership to Cosme, so Mobile's work here is consumer review and coordination.
- Domain specified on-device first-PIN enrollment in Senti #47561 and added `enrollOwner()` / `startSession()` / `revokeAllSessions()` on Core PR #24 head `8707ee5`. PIN is exactly four digits, verified with PBKDF2-HMAC-SHA256 using a 16-byte salt and at least 600k iterations (use existing `@noble/hashes`, no new Argon2 dependency). Cosme's product decision is lockout only: five wrong entries lock for 15 minutes, with the lockout duration doubling in later rounds, measured by the monotonic clock; lockout does not erase data. For a forgotten PIN, Cosme chose a deliberate app reset that wipes pending approvals and local data before re-enrollment, disclosed as a demo limitation; no recovery code is used. A cross-layer question is open: the Core reset comment and earlier Domain proposal say revoke sessions/cancel approvals but keep facts. Confirm whether Cosme's flow is a full factory reset with a new tenant/owner/device (and loss of imported facts/evidence) or an in-place PIN reset that preserves facts.
- The deterministic tagger and Experience r2 are on main; keep Qwen proposal-only and render the exact approved Experience copy.
- The direct task specifies Android, while Warden's shared-lane instruction targets the iPhone 15 Pro on Cosme's Mac. Cosme reported Qwen3 0.6B Q8_0 through llama.rn/Metal at 287 ms load and 3.3 s generation (28.7 tok/s), plus a positive Swahili review that the model misread. The app commit for this inference is unconfirmed. Airplane-mode response/radio evidence, actual model bytes/hash, peak memory, SQLCipher version, and same-row force-close/relaunch proof remain missing; this partial iPhone run does not satisfy Android. The iOS runbook is `docs/mobile/IOS_DEVICE_RUNBOOK.md`.
- This Windows PC has no Java, Android SDK/ADB, or attached Android device. Warden assigned the phone app to Cosme; device evidence must come from that physical-device lane. The direct Android proof remains unmet.
