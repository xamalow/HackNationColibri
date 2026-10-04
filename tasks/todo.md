# Codex Mobile lane — Sauti Host

## Plan

- [x] Create an isolated checkout and read repository instructions, the supplied build playbook, addendum #47454, and full Mobile packet #47456.
- [x] Join Senti as `codex-mobile`, verify identity and listener delivery, ACK #47454, and claim #47456 with `working_on`.
- [x] Review Domain/Platform contracts and post substantive +1 feedback and threaded implementation questions.
- [x] Answer Max's iOS translation-runtime question with primary-source artifact/runtime limits and a gated A+D recommendation.
- [x] Draft the iPhone 15 Pro offline smoke runbook; preserve the direct Android request as a separate, unmet device-evidence gate.
- [x] Start the Expo Router app with pinned RN/llama.rn/op-sqlite versions, SQLCipher configuration, local model import, feedback import, and Today/Evidence/Outbox screens.
- [x] Add explicit imported/owner-selected language metadata, preserve unknown as `und`, and enforce Core's 16 KiB source limit in UTF-8 bytes.
- [ ] Bind the Domain-reviewed, package-only Core revision after Platform #26 lands and Domain re-cuts PR #24; implement the SQLCipher `ApprovalStore`, owner session, trusted-owner registry, and persisted clock high-water against its frozen r1 contract.
- [ ] Replace the temporary Today/Outbox availability stub with the typed Core decision, exact approval, revocation, queue, dispatch, and recovery flow.
- [ ] Implement Leo feedback first, then Ziara booking, Shamba facts, and arrival confirmation against the same Domain approval/queue contracts.
- [ ] Integrate the reviewed deterministic tagger and exact-span evidence cards; keep Qwen output unverified and proposal-only.
- [ ] Complete internal SMS composer handoff and persist Core transport transitions without conflating queued, sent, delivered, failed, and send_unknown.
- [ ] Implement Sauti PIN enrollment/unlock against Domain's first-owner boundary and Core r3 constructors; PIN KDF/length and five-failure behavior details are still pending from Domain.
- [ ] Finish G1 on the iPhone 15 Pro: import the candidate model, run Qwen with radios off, and prove SQLCipher marker persistence after force-close/restart; record actual model size/timing/memory. Cosme's signed Release build/install from `784142f` succeeded; direct Android evidence remains unmet.
- [x] Re-run app typecheck, parser tests, lint, Expo Doctor, Android prebuild/export, and iOS JS export after exact Expo pins.
- [x] Commit and push the exact native pins, synthetic fixture, iOS runbook, and evidence/status updates to `wip/mobile-skeleton` (`60eb7ed`).
- [ ] Get Platform to refresh the root workspace lock for both `packages/core` and `apps/mobile`; PR #26 merged to main with Core only. Domain is re-cutting Core PR #24 package-only on the new main.
- [ ] Compile/install the native iOS app and capture physical iPhone 15 Pro evidence; separately resolve the original Android device request.

## Review

- Checkout/branch: `C:\Users\carter\AppData\Local\HackNationColibri-codex-mobile`, branch `wip/mobile-skeleton`, based on main `5ddfe35`; WIP commits `784142f` and `44aa0a6` are pushed.
- Listener: distinct Senti identity `codex-mobile`; Senti reports one active local listener process (PID 41588 at last check). ACK #47454 and `working_on` #47456 were recorded. Recent threaded replies #47553 and #47545 were delivered to the room.
- Shared docs: read repository/app instructions, supplied Sauti build playbook, start/build/acceptance documents, addendum #47454, and full Mobile packet #47456. The latest checkout does not contain `docs/kit` or `docs/LANES.md`; later decisions are in Senti.
- Domain: contract r1.0 is merged (`84529dd`). Core r1 at `5dacf07` is the reviewed API baseline for transactional `approveExact`, `revokeExact`, clock, outbox, and receipt functions. Warden says PR #18 can close; Core r2 PR #24 is at `e6674be`, Warden verified it, and Mobile posted a consumer +1 in #47561. It awaits Codex's source +1. Core's README requires `BEGIN IMMEDIATE`; op-sqlite 18.2.5's `db.transaction()` starts deferred, so the adapter needs a serialized immediate transaction or a Domain/Platform resolution.
- Platform: main advanced to `d336218` after PR #26 (Core root-lock closure, TypeScript 6.0.3), reviewed tagger, Experience, failure-matrix, and translation-eval merges. The root lock still does not include this `apps/mobile` workspace. The app-local lock remains the iOS smoke bootstrap. Root lock ownership stays with Platform; the exact missing Mobile workspace repro and follow-up were posted in #47519 and #47529.
- Product scope: Warden relayed Carter's acceptance of the four-slice v1 (#47527): Leo feedback, Ziara bookings, Shamba setup, and arrival confirmation, in that priority. First focus is feedback approval/queue/restart.
- Transport/auth: use an r1-supported Sauti PIN unlock; text-only confirmation does not authenticate. The current iOS room plan uses the native SMS composer and keeps “handed to Messages” distinct from delivery; transport confirmation must follow the latest Domain mapping. No silent SMS, inbox read, or cellular call audio access.
- App work: Expo Router Today/Evidence/Outbox and model/import/storage scaffold; source text hash matches Core's `sauti.source_text.v1\0` digest. Language is preserved from `lang`/`language`/`locale` or remains `und`; source language is explicitly labeled unverified. Source-size limit is measured in UTF-8 bytes. Face ID/device-unlock config has been removed per Carter's Sauti-only PIN decision.
- Verification after a clean app-local install: `npm run typecheck`, `npm test` (8 parser tests), `npm run lint`, and `npx expo-doctor` pass (21/21). Android prebuild succeeds; iOS and Android JS exports succeed (3.0 MB iOS, 3.3 MB Android). Both exports emit the known `@noble/hashes/crypto.js` package-exports fallback warning. `npm ci` exits 0 with an optional `react-native-worklets` peer override warning and dependency deprecation notices. iOS prebuild explicitly skips native project generation on Windows and instructs to run on macOS/Linux; no Xcode build was performed here.
- Handoff: feature commit `60eb7ed` on `origin/wip/mobile-skeleton` publishes the exact pins, fixture, iPhone runbook, and evidence notes. Status event #47543 was confirmed; Max's runtime question and Warden/Codex handoffs were posted in #47553, #47545, and #47529.
- Hardware: this Windows PC has no Android SDK/ADB, Java, or attached Android device. Cosme completed a signed Release build from commit `784142f` (66 MB, model not bundled), installed and launched on the iPhone 15 Pro; the paid-team PLA is accepted. G1 is now in progress, but no Qwen response, radio state, force-quit persistence, timing, or memory result has been reported. This partial evidence is committed in `7611c19`; the device gate remains open.
- Model manifest: Qwen3 0.6B Q8_0 candidate, 639,446,688 bytes, SHA-256 `9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031`; it is not yet a measured phone result or a Swahili decision authority.

## Open review items

- Resolve the root workspace lock with Platform, then install the Domain-reviewed Core package revision as a workspace dependency and wire typed storage.
- Domain specified first-run enrollment: one SQLCipher transaction generates tenant/owner/device UUIDs, stores device_id in Keychain, writes the PIN verifier, TrustedOwner, and `owner_enrolled` audit row; later sessions last 15 minutes and five bad attempts/reset revoke them. Core r3 will add constructors. PIN KDF/length and exact failed-attempt recovery behavior remain open.
- Add the serialized SQLCipher transaction adapter and keep all database access on its connection from interleaving with approval transactions.
- Do not report device/model/persistence metrics until they are actually captured on a named physical phone. The iPhone shared-lane run does not satisfy the direct Android request.
