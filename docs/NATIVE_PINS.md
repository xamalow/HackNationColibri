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

React, RN and dev-client pins are taken from the published Expo 57.0.26 `bundledNativeModules.json`, not selected independently. [Expo's matrix](https://docs.expo.dev/versions/latest/) requires Node 22.13+, iOS 16.4+ and Xcode 26.4+ for SDK 57. Cosme reports Xcode 26.6; the actual iPhone/iOS still needs confirmation. Platform's desktop checks use Node 22.23.1.

Mobile owns its manifest/config and declares these exact versions. Root npm overrides enforce them. Root `op-sqlite.sqlcipher=true` supplies the compilation setting for hoisted native dependencies; [OP-SQLite's installation guide](https://op-engineering.github.io/op-sqlite/docs/installation/) explains why its podspec reads the ancestor manifest. Check `Podfile.lock` and the native SQLCipher result; ordinary SQLite is not evidence of encryption. Avoid adding `expo-sqlite`/`expo-updates` without resolving the documented SQLite linkage conflicts.

[llama.rn](https://github.com/mybigday/llama.rn) requires the RN New Architecture at these versions. CI deliberately ignores dependency lifecycle scripts and does not download native frameworks or model weights. The native host must complete the pinned package's required artifact installation before CocoaPods/build; record those revisions and verify the model manifest hash. A successful package install is not a successful iOS build.

Use a native Expo development client for connected debugging. The airplane-mode demo needs a standalone internal/release build with JavaScript and model assets available locally; a development launcher waiting for Metro cannot satisfy it. Mobile owns the Expo/EAS profiles and native config plugins actually required by the pinned packages. OP-SQLite's SQLCipher flag is a package setting, not an invented config plugin.

The root lockfile initially records check tools. Existing package lockfiles remain the bootstrap install source until Platform folds the received manifests into one reviewed workspace lock. CI explicitly installs/checks `@sauti/core` when its package lands and reports its absence otherwise. Native signing/build/device checks remain a separate recorded handoff. This workflow does not claim iPhone proof, cloud delivery, language review or Omar Gate approval.

The portable Core source forbids Node/network dependencies and direct authority-clock reads. `packages/core/src/tools/w3-adapter.ts` is the single documented Node-only evaluation entrypoint, excluded from that portable lint rule and not exported by the Core entrypoint. Mobile imports the Core entrypoint, never this evaluation harness.

Actions are pinned to upstream commit SHAs with a read-only token and no checkout credentials, following [GitHub's workflow guidance](https://docs.github.com/en/actions/reference/security/secure-use). The credential guard detects specific key shapes, rejects tracked symlinks/oversized files, and reports filenames/classes without matched values; it is a baseline guard, not a comprehensive secret detector. Omar Gate remains the next independent PR integration.

Python reference checks install only `requirements-ci.txt` in a clean environment. On Windows, set `PYTHONUTF8=1` before invoking pytest so child CLI output matches the evaluation runner's explicit UTF-8 decoding; CI sets the same environment. Platform validated 114 reference/evaluation tests in that isolated environment, alongside root frozen install, lint and guard tests. Hosted CI still needs its first PR run.
