# Native dependency pins and CI

Platform integration pins, 3 October 2026. Package metadata and desktop checks are verified; each native change still needs an iPhone build and the recorded device gate.

| Dependency | Exact version | Basis |
|---|---|---|
| Expo | 57.0.26 | SDK 57 |
| React | 19.2.3 | Expo's bundled module list |
| React Native | 0.86.3 | Expo's bundled module list |
| expo-dev-client | 57.0.19 | Expo's bundled module list |
| expo-sms | 57.0.2 | Expo's bundled module list |
| react-native-worklets | 0.10.1 | Expo's bundled module list |
| react-native-reanimated | 4.5.1 | Expo's bundled module list; requires worklets 0.10.x |
| llama.rn | 0.12.9 | Audited stable npm package |
| whisper.rn | 0.7.4 | Audited stable npm package, MIT |
| @op-engineering/op-sqlite | 18.2.5 | SQLCipher native storage |
| TypeScript, root / Mobile | 6.0.3 | SDK 57 and typescript-eslint peer range |

SDK versions above come from the published expo@57.0.26 bundledNativeModules.json. Root overrides keep workspace installs on those versions. Mobile owns its manifest and must declare speech/SMS dependencies; an override alone does not install them. Keep child locks aligned when declarations change. Unconstrained optional peers previously selected worklets 0.13.0, outside Expo module-core's peer range; use the pinned SDK pair for native installation.

## Installation and native artifacts

[Expo's SDK matrix](https://docs.expo.dev/versions/latest/) requires Node 22.13+, iOS 16.4+ and Xcode 26.4+ for SDK 57. Cosme reports Xcode 26.6 and a signed Release build installed/launched on an iPhone 15 Pro/iOS 26.3.1 from Mobile 784142f, 66 MB without the model. That result does not validate these new speech/SMS pins or prove offline inference, memory limits, radio states or encrypted restart. Record those separately in the Mobile device evidence.

Install native dependencies from the repository root with npm ci so root overrides and op-sqlite.sqlcipher=true apply. CI uses --ignore-scripts to avoid native framework/model downloads. For a native build, [llama.rn](https://github.com/mybigday/llama.rn) 0.12.9 runs install/download-native-artifacts.js; its explicit download:native-artifacts script can complete that step if the initial install skipped scripts. Record resulting artifact versions before prebuild/CocoaPods.

Platform inspected the exact [whisper.rn 0.7.4 npm archive](https://www.npmjs.com/package/whisper.rn/v/0.7.4): it contains the arm64/simulator ios/rnwhisper.xcframework, has no postinstall script, and supplies no Expo config plugin. Its podspec defaults to the bundled framework; RNWHISPER_BUILD_FROM_SOURCE=1 is the explicit source-build alternative. Do not apply installation instructions for a later release candidate to this stable archive. Whisper model assets remain separately imported and hash-verified; model quality and speed require phone evidence.

[OP-SQLite's installation guide](https://op-engineering.github.io/op-sqlite/docs/installation/) explains the ancestor package setting. Verify Podfile.lock and the actual SQLCipher version; ordinary SQLite is not encryption evidence. Resolve SQLite linkage before adding expo-sqlite/expo-updates. SQLCipher configuration is a package setting. Mobile owns the Expo/EAS profiles and actual config plugins. Use a standalone internal/release build with local JavaScript and model files for the offline demo.

## Messages composer boundary

Carter's runtime decision is on-phone Whisper and the iPhone Messages composer, with the owner pressing Send. No Azure/LiveKit/ElevenLabs runtime transport is configured.

[Expo SMS](https://docs.expo.dev/versions/latest/sdk/sms/) returns sent, cancelled or unknown; it cannot check final content/recipients or report carrier delivery. The owner can edit the prefilled message in the system composer. Persist the approved prefill and the handoff attempt; do not describe it as proof of the final bytes sent.

Map a reported sent to Core transport sent with the user label **handed to Messages**; do not label it delivered. A proven cancellation becomes failed; an unknown result or crash after handoff becomes send_unknown, with no automatic retry. Persist the local idempotency key before opening the composer. That key protects the local attempt record; it supplies no carrier deduplication guarantee. SQLCipher transaction/crash behavior remains Mobile's implementation and device gate.

## Workspace lock and check tools

The root lock includes Core's unchanged manifest from Domain 8707ee5088e5245a0a978e7637d33a5f1a5517fe and Mobile's manifest from e7294294bf2ef977c401513cb6eb14f8f8164c37. Those sources are owned by their lanes; this Platform slice does not add their source files. Platform generated the lock from clean manifests, with both workspaces in an isolated tree, so npm did not reuse stale peer resolutions. Every changed workspace manifest, including new Core/speech/SMS dependencies in Mobile, needs a root-lock refresh before merge. --workspaces=false filters installation but still validates discovered workspace manifests.

Root lint explicitly selects eslint.config.mjs. ESLint 10 otherwise discovers the nested app config before app dependencies are installed. Root rules handle CommonJS config files and ignore compiled parser-test output. CI independently installs Mobile's child lock, typechecks, runs its local ESLint 9/config, then parser tests. Calling expo lint from the repository currently resolves ancestor ESLint 10, which is incompatible with Expo's React rules. The explicit app-local executable avoids that resolution issue. Core continues using its package-local TypeScript 5.9.3 until its owner's next compiler upgrade; no root override changes it.

The portable Core excludes Node/network imports and direct authority-clock reads. Its single Node-only evaluation entrypoint, src/tools/w3-adapter.ts, is excluded from that portable rule and never imported by Mobile. Native lifecycle scripts, signing and device tests are separate from desktop CI.

Actions use pinned upstream commits, a read-only token and no checkout credentials. The credential guard reports paths/classes without matched values; it checks tracked files, symlinks and size limits. Python checks use clean requirements-ci.txt and PYTHONUTF8=1, including Windows child processes. Required evidence is CI against the final combined revision, plus independent room review.
