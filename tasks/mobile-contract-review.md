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
- Platform pins (Expo SDK 57.0.26, RN 0.86.3, llama.rn 0.12.9, op-sqlite 18.2.5 with SQLCipher enabled) are present on the WIP base `5ddfe35`. Platform PR #26 has merged; main is now at `d336218` with Core in the root lock and TypeScript 6.0.3. The lock still does not include `apps/mobile`; I sent Codex the exact workspace install repro and am leaving root files to Platform.
- The app-local lock supports the current Mac/iPhone smoke build. Root `npm ci --ignore-scripts --workspaces=false` reports missing `@sauti-host/mobile` and its dependencies until Platform refreshes the root lock after adding this workspace.
- Core README requires `BEGIN IMMEDIATE`; op-sqlite 18.2.5's `db.transaction()` starts deferred `BEGIN TRANSACTION`. A host adapter must serialize all operations on the single connection and use an immediate transaction, or Domain/Platform must reconcile the requirement before Mobile claims the guarantee.
- Experience's refreshed handoff defines Leo/Ziara/Shamba and arrival; current Swahili copy is explicitly unreviewed. Render copy from the frozen Experience contract and do not present unreviewed text as approved.
- Transport: follow Domain's latest SMS composer mapping. The composer is user-mediated; “sent” means handed to Messages and never delivered. A crash before result can become `send_unknown`; `delivered` requires a real authenticated receipt and is unreachable for the iOS composer. Never read inbox or silently send.
- Authentication: Core r1 supports PIN or biometric as the owner session unlock. Mobile will use a Sauti PIN session; text-only confirmation cannot authenticate. The UI must keep confirmation distinct from unlock.

## Native and persistence adapter

- Core's SHA port is synchronous: `(bytes: Uint8Array) => lowercase hex`. Noble SHA-256 is compatible with this port. Mobile's current source hash matches `sauti.source_text.v1\0` plus strict UTF-8 source bytes.
- `approveExact(store, {actionId, renderedDigest, confirmation, clock, approvalId, sha256})` reads the action, current fact revision, trusted registry, and current host session inside `ApprovalTx`; the request must never accept owner/session/trust objects.
- `ApprovalTx` needs `getAction`, `getCurrentFactRevision`, `getTrustedOwner`, `getOwnerSession`, `insertApproval`, `insertOutbox`, `updateAction`, `appendAudit`. Rehydrate `ReadonlySet` fields as actual Sets from SQL.
- Persist clock high-water with `high_water_ms` and same-process monotonic time. Read before authority decisions; write inside the same transaction as approval, revocation, or dispatch. A restart with a reset uptime cannot silently forgive a wall-clock rollback.
- Outbox must preserve `payload_json` exactly as written by Core. Call `checkDispatch` immediately before a transport, persist `beginDispatch` before handing off, and use `recoverAfterRestart` for leftover `sending` rows. Never retry `send_unknown` blindly.
- The app's current approval port is an availability placeholder, not an implementation; current DB lacks actions, approvals, owner/session registry, outbox, audit, and clock tables.
- Mobile reviewed Core PR #24 at `e6674be` and posted a consumer +1 in Senti #47561. Warden verified 84 Core tests, 37/37 W3 dev fixtures, 15/15 failure matrix, full CI, and mutation checks. Codex's source +1 is still pending before merge.
- Core r1's source ingest limit is 16 KiB; Mobile now checks encoded UTF-8 byte length before storing. Import language comes from `lang`/`language`/`locale` or remains `und`; it is not language-ID proof.

## Open gates

- Platform must add `apps/mobile` to the root workspace lock. Domain is re-cutting its package-only Core PR #24 on the new main; after it lands, install that exact workspace package and implement/verify the SQLCipher adapter.
- Domain specified on-device first-PIN enrollment in Senti #47561 and will add `enrollOwner()` / `startSession()` to Core r3. Mobile still needs the exact PIN KDF/length and failed-attempt recovery policy before implementing the verifier.
- Mainline deterministic tagger and Experience package must be available before Mobile can consume those APIs; preserve Qwen as proposal-only.
- The direct task specifies Android, while Warden's latest shared-lane instruction targets the iPhone 15 Pro on Cosme's Mac. Cosme built and launched a signed Release app from `784142f` (66 MB, model not bundled), but G1 inference/persistence evidence is still in progress and does not satisfy Android. The iOS runbook is `docs/mobile/IOS_DEVICE_RUNBOOK.md`.
- This Windows PC has no Java, Android SDK/ADB, or attached Android device. No phone inference response, radio-off state, force-close persistence, timing, or memory figure is verified yet.
