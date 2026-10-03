# Codex Mobile lane — Sauti Host

## Plan

- [x] Create an isolated checkout and read repository instructions, the supplied build playbook, addendum #47454, and full Mobile packet #47456.
- [x] Join Senti as `codex-mobile`, verify identity and listener delivery, ACK #47454, and claim #47456 with `working_on`.
- [x] Review Domain/Platform contracts and post substantive +1 feedback and threaded implementation questions.
- [x] Start the Expo Router app with pinned RN/llama.rn/op-sqlite versions, SQLCipher configuration, local model import, feedback import, and Today/Evidence/Outbox screens.
- [x] Add explicit imported/owner-selected language metadata, preserve unknown as `und`, and enforce Core's 16 KiB source limit in UTF-8 bytes.
- [ ] Bind `@sauti/core` r1 at `5dacf07` after its root-lock blocker is resolved; implement the SQLCipher `ApprovalStore`, owner session, trusted-owner registry, and persisted clock high-water.
- [ ] Replace the temporary Today/Outbox availability stub with the typed Core decision, exact approval, revocation, queue, dispatch, and recovery flow.
- [ ] Implement Leo feedback first, then Ziara booking, Shamba facts, and arrival confirmation against the same Domain approval/queue contracts.
- [ ] Integrate the reviewed deterministic tagger and exact-span evidence cards; keep Qwen output unverified and proposal-only.
- [ ] Complete internal SMS composer handoff and persist Core transport transitions without conflating queued, sent, delivered, failed, and send_unknown.
- [ ] Record candidate model manifest and reproduce a local Qwen response plus SQLCipher persistence after force-close/restart on the requested Android phone with radios off; record actual device/runtime/model size/timing/memory.
- [ ] Run app tests, typecheck, lint, Expo checks, platform prebuild/build checks, and hand exact commits/results to Codex for integration.

## Review

- Checkout/branch: `C:\Users\carter\AppData\Local\HackNationColibri-codex-mobile`, `codex-mobile/sauti-host-v2`, fresh main base `8050bca`.
- Listener: distinct Senti identity `codex-mobile`; authenticated user `mrrCarter`; wrapper PID 55108 and scheduled `SautiHost-SentiListener-4fabea10-codex-mobile` watchdog remain active. Verified addressed human reply and smoke event #47462. ACK #47454 and `working_on` #47456 were recorded.
- Shared docs: read repository/app instructions, supplied Sauti build playbook, start/build/acceptance documents, addendum #47454, and full Mobile packet #47456. The latest checkout does not contain `docs/kit` or `docs/LANES.md`; later decisions are in Senti.
- Domain: contract r1.0 is merged (`84529dd`). Domain recommends Mobile pin `packages/core` r1 at `5dacf07`; API review confirms transactional `approveExact`, `revokeExact`, clock, outbox, and receipt functions. PR #18 is blocked because Platform's root workspace lock does not include the new `packages/core` workspace. Core's README also requires `BEGIN IMMEDIATE`; op-sqlite 18.2.5's `db.transaction()` starts deferred, so the adapter needs a serialized immediate transaction or a Domain/Platform resolution.
- Platform: pinned Expo SDK 57.0.26, RN 0.86.3, llama.rn 0.12.9, op-sqlite 18.2.5 with root SQLCipher=true merged in `8050bca`. App-local TypeScript 6.0.3 passes Expo Doctor 21/21; root override 5.9.3 makes Expo Doctor fail 20/21. The mismatch and root-lock repro were sent to Codex; root files remain untouched in this lane.
- Product scope: Warden relayed Carter's acceptance of the four-slice v1 (#47527): Leo feedback, Ziara bookings, Shamba setup, and arrival confirmation, in that priority. First focus is feedback approval/queue/restart.
- Transport/auth: use an r1-supported Sauti PIN unlock; text-only confirmation does not authenticate. The current iOS room plan uses the native SMS composer and keeps “handed to Messages” distinct from delivery; transport confirmation must follow the latest Domain mapping. No silent SMS, inbox read, or cellular call audio access.
- App work: Expo Router Today/Evidence/Outbox and model/import/storage scaffold; source text hash matches Core's `sauti.source_text.v1\0` digest. Language is preserved from `lang`/`language`/`locale` or remains `und`; source language is explicitly labeled unverified. Source-size limit is measured in UTF-8 bytes.
- Verification: app TypeScript 6.0.3 `npm run typecheck` passes; parser tests 8/8 pass; `npm run lint` passes; `npx expo-doctor` passes 21/21. Android prebuild succeeds and `npx expo export --platform android` creates a 3.3 MB Hermes bundle. Metro emits one known `@noble/hashes/crypto.js` package-exports fallback warning; export succeeds. No Java/ADB is available for a native compile or install.
- Hardware: this Windows PC has no Android SDK/ADB, Java, or attached Android device. No real phone response, radio-off verification, force-close persistence, timing, or memory has been measured. The Senti room notes an iPhone 15 Pro/Mac path, which does not satisfy the explicit Android proof request. Device evidence remains open.
- Model manifest: Qwen3 0.6B Q8_0 candidate, 639,446,688 bytes, SHA-256 `9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031`; it is not yet a measured phone result or a Swahili decision authority.

## Open review items

- Resolve Core r1's root workspace lock and TypeScript pin with Platform; then install Core as a workspace dependency and wire typed storage.
- Confirm the local first-owner/device enrollment boundary with Domain; Core intentionally accepts trusted owner/session only from the host.
- Add the serialized SQLCipher transaction adapter and keep all database access on its connection from interleaving with approval transactions.
- Do not report device/model/persistence metrics until they are actually captured on the requested Android phone.
