# Native dependency pins and CI

Platform pins for the first native build attempt, 3 October 2026. Package publication and peer metadata have been checked; native compatibility and the real iPhone gate remain UNRUN.

| Dependency | Exact version |
|---|---|
| Expo | 57.0.26 |
| React | 19.2.3 |
| React Native | 0.86.3 |
| expo-dev-client | 57.0.19 |
| llama.rn | 0.12.9 (stable; npm's latest currently points at a release candidate) |
| @op-engineering/op-sqlite | 18.2.5 |
| TypeScript (root / Mobile) | 6.0.3 |

React, RN and dev-client pins are taken from the published Expo 57.0.26 `bundledNativeModules.json`, not selected independently. [Expo's matrix](https://docs.expo.dev/versions/latest/) requires Node 22.13+, iOS 16.4+ and Xcode 26.4+ for SDK 57. Cosme reports Xcode 26.6 selected, first-launch setup complete, and an iPhone 15 Pro on iOS 26.3.1 paired with Developer Mode. Carter's company signing team is visible in Xcode; the first actual app build/signing attempt is pending Mobile's project handoff. Platform's desktop checks use Node 22.23.1.

Mobile owns its manifest/config and declares these exact versions. Root npm overrides enforce them. Root `op-sqlite.sqlcipher=true` supplies the compilation setting for hoisted native dependencies; [OP-SQLite's installation guide](https://op-engineering.github.io/op-sqlite/docs/installation/) explains why its podspec reads the ancestor manifest. Check `Podfile.lock` and the native SQLCipher result; ordinary SQLite is not evidence of encryption. Avoid adding `expo-sqlite`/`expo-updates` without resolving the documented SQLite linkage conflicts.

[llama.rn](https://github.com/mybigday/llama.rn) requires the RN New Architecture at these versions. CI deliberately ignores dependency lifecycle scripts and does not download native frameworks or model weights. The native host must complete the pinned package's required artifact installation before CocoaPods/build; record those revisions and verify the model manifest hash. A successful package install is not a successful iOS build.

Use a native Expo development client for connected debugging. The airplane-mode demo needs a standalone internal/release build with JavaScript and model assets available locally; a development launcher waiting for Metro cannot satisfy it. Mobile owns the Expo/EAS profiles and native config plugins actually required by the pinned packages. OP-SQLite's SQLCipher flag is a package setting, not an invented config plugin.

The root lockfile records the check tools and the upcoming `@sauti/core` manifest/dependency closure from Domain `a4c5e323bc8886e13e6810aea50147df290fa427` (its package/lock manifests are unchanged from `core-r1` `5dacf07`). Platform generated this lock with workspaces enabled in an isolated integration tree, then validated root frozen installs with Core both absent and present. `--workspaces=false` controls which packages install; it still validates every discovered workspace against the root lock. Every new or changed workspace manifest therefore needs a coordinated root-lock refresh before merge, including Mobile. CI explicitly installs/checks Core through its own package lock when present and reports its absence otherwise. Native signing/build/device checks remain a separate recorded handoff.

Root TypeScript is 6.0.3, matching Mobile's Expo SDK 57 requirement and the installed typescript-eslint peer range. Core keeps its exact 5.9.3 package-local compiler while its owner validates a later upgrade. No root TypeScript override forces the app onto the Core compiler.

The portable Core source forbids Node/network dependencies and direct authority-clock reads. `packages/core/src/tools/w3-adapter.ts` is the single documented Node-only evaluation entrypoint, excluded from that portable lint rule and not exported by the Core entrypoint. Mobile imports the Core entrypoint, never this evaluation harness.

Actions are pinned to upstream commit SHAs with a read-only token and no checkout credentials, following [GitHub's workflow guidance](https://docs.github.com/en/actions/reference/security/secure-use). The credential guard detects specific key shapes, rejects tracked symlinks/oversized files, and reports filenames/classes without matched values; it is a baseline guard, not a comprehensive secret detector. Omar Gate remains the next independent PR integration.

Python reference checks install only `requirements-ci.txt` in a clean environment. On Windows, set `PYTHONUTF8=1` before invoking pytest so child CLI output matches the evaluation runner's explicit UTF-8 decoding; CI sets the same environment. Platform validated 114 reference/evaluation tests in that isolated environment, alongside root frozen install, lint and guard tests. The first [hosted CI run](https://github.com/xamalow/HackNationColibri/actions/runs/37161160532) passed at foundation revision `c1a940b`; its absent-Core step explicitly reports that no Core pass is claimed. PR integration still requires review and a run against the combined main/head.
