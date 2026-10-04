# iPhone 15 Pro offline smoke runbook

## Read this first: the 2026-10-04 demo build (Gemma 4 E2B)

The rest of this file is the earlier Qwen3 smoke procedure. For the demo, these steps replace its branch, signing and model steps:

1. **Code:** `main` at `584e15a` or later (`git pull`). Not `wip/mobile-skeleton`. Older builds refuse the E2B Q4_0 file.
2. **Signing with a free Apple account (Personal Team):** set `SAUTI_PERSONAL_TEAM=1` for the prebuild, then pick the
   Personal Team in Xcode (Signing & Capabilities):

   ```sh
   cd apps/mobile
   SAUTI_PERSONAL_TEAM=1 npx expo prebuild -p ios --clean
   npx pod-install
   xed ios
   ```

   `apps/mobile/app.config.js` then drops the increased-memory-limit and extended-virtual-addressing entitlements and
   signs as `com.sautihost.mobile.personal` (override with `SAUTI_BUNDLE_ID=...`). A Personal Team cannot sign that
   memory entitlement or reuse a bundle id registered by another team. With Carter's paid team, leave the variable unset:
   the config is then exactly `app.json`.
3. **Model file on the Mac:** `gemma-4-E2B-it-Q4_0.gguf` from
   `https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/b4243c156154b6dca9324415f8c7ccc098b4aed1/gemma-4-E2B-it-Q4_0.gguf`.
   Check it before copying: 2,841,481,184 bytes and `shasum -a 256` =
   `8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52` (`data/model-manifest.json`).
4. **Side-load over USB** (the method `apps/mobile/src/models/gemma.ts` documents). Launch the app once first so its
   container exists, find the phone's id with `xcrun devicectl list devices`, then run (one line):

   ```sh
   xcrun devicectl device copy to --device <device id> --domain-type appDataContainer --domain-identifier com.sautihost.mobile.personal --source gemma-4-E2B-it-Q4_0.gguf --destination Documents/models/gemma/gemma-4-E2B-it-Q4_0.gguf
   ```

   Use `com.sautihost.mobile` (or your `SAUTI_BUNDLE_ID`) if you signed without the Personal Team switch.
5. **In the app:** Leo (Today) → **Ukaguzi wa Gemma 4 (Gemma 4 check)**. It must show "Gemma 4 E2B (Q4_0)", 2.84 GB.
   Tap **Thibitisha SHA-256 kamili (Verify full SHA-256)** once (a few minutes), then **Pakia na tafsiri (Load and
   translate)**. Gemma will not load before the full check passes.

Not run from this Windows checkout. The config switch was checked with `npx expo config --type prebuild`: with the
variable, both entitlements are gone and the bundle id changes, even with `NODE_ENV=production`; without it, the config
equals `app.json`.

## Earlier procedure: Qwen3 smoke run

This runbook is for Cosme's Mac and the shared iPhone 15 Pro. It is a procedure, not a device result; none of the steps below has been run from this Windows checkout. Warden's latest shared-lane instruction selects iPhone, while the direct task text also requests Android. Do not report Android evidence from this iPhone run.

The smoke run proves only that the pinned llama.rn app can answer locally with radios off and that an SQLCipher row survives force-quit/relaunch. It does not prove the pending Domain approval/queue workflow.

## Mac build

Requirements from the current pins: macOS with Xcode 26.4 or newer (Cosme reports Xcode 26.6), Node 22.13 or newer, CocoaPods, the iPhone 15 Pro on iOS 26.3.1, Developer Mode, and a signing team available in Xcode. Expo SDK 57's versioned reference lists iOS 16.4+ and Xcode 26.4+.

1. Clone or use a separate worktree so local changes on the Mac are preserved. Check out the latest pushed `wip/mobile-skeleton` branch and record `git rev-parse HEAD`.
2. In the repository root, run:

   ```sh
   cd apps/mobile
   npm ci --workspaces=false --ignore-scripts --no-audit
   ```

   The app-local lock is the bootstrap install source for this smoke build. Platform PR #26 adds the Core workspace and aligns root TypeScript, but its root lock does not include `apps/mobile`; a coordinated root-lock refresh for Mobile is still required before integration. Do not change root files from this lane.

3. Install the pinned llama.rn native artifacts explicitly, since the install above disabled lifecycle scripts:

   ```sh
   node ./node_modules/llama.rn/install/download-native-artifacts.js
   ```

   llama.rn 0.12.9's release downloader checks SHA-256 before extracting the iOS framework. Record the package version and downloaded artifact hash from the tool output or file. The model file is separate from these native artifacts.

4. Generate the iOS project from app config, install pods, then open the generated workspace:

   ```sh
   npx expo prebuild -p ios
   npx pod-install
   xed ios
   ```

   Keep the generated `ios/` directory local; it is ignored and must not be hand-edited. In Xcode, select the Sauti Host app target and use automatic signing. Use Carter's paid team after the Account Holder accepts Apple's current PLA; while that is blocked, Cosme reported a Personal Team fallback (`com.cosme.sautihost`, seven-day profile, no paid entitlements). Choose the connected iPhone 15 Pro and build/run the Release configuration so the JavaScript bundle is embedded and the app does not depend on Metro.

5. Confirm the app opens and Today reports a non-empty SQLCipher version. If the cipher check is absent or fails, stop the smoke run; do not interpret an ordinary SQLite database as encrypted.

## Prepare the offline run

1. Before disabling radios, copy the Qwen3 0.6B Q8_0 GGUF to the iPhone's local Files storage (Finder file sharing or AirDrop). Avoid an iCloud-only placeholder; the file must be present on device. Its manifest expects 639,446,688 bytes and SHA-256 `9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031`.
2. Import `apps/mobile/tests/fixtures/offline-smoke.csv` from local Files. This is explicitly synthetic test text, not customer feedback. Confirm Evidence shows the original text, source hash, and declared `sw` language marked unverified.
3. Import the GGUF through Today. Wait for byte count and hash verification to finish; the model must appear as installed before radios are turned off.
4. Enable Airplane Mode, then verify Wi-Fi and Bluetooth are also off (iOS allows those radios to be re-enabled while Airplane Mode is active). Confirm cellular is disconnected. Keep the iPhone connected to the Mac by USB for Xcode profiling; do not use a development launcher or Metro.
5. Capture a clean status view showing the radio state without personal notifications, account details, or device identifiers.

## Qwen response, memory, and persistence

1. On Today, tap **Run local suggestion** while the device remains offline. Capture the exact displayed response and its runtime version, platform, model bytes/hash, load time, prompt time, generation time, and tokens/second. Keep it labeled as an unverified model suggestion; it does not ground a theme or authorize a message.
2. During model load and generation, capture the app's high-water memory from Xcode's Debug navigator, or record an Instruments memory trace on the physical device. State the tool/template and capture interval with the peak value. Do not use simulator memory or estimate from JavaScript.
3. On Today, write the encrypted persistence marker and record its displayed prefix. Force-quit the app from the iOS App Switcher, relaunch while radios remain off, and confirm the same marker is shown as persisted from a previous app session with the SQLCipher version still present.
4. Capture the post-relaunch screen. The marker must match before and after; a fresh marker, missing cipher version, or storage error is a failed persistence check.
5. Only after evidence capture, restore radios.

## Evidence to send back

- Branch and exact app commit; generated build configuration and Xcode build number.
- Physical device label (for example, `iPhone 15 Pro`), iOS version/build, Xcode version, and native/runtime package versions.
- Model manifest revision, actual bytes and SHA-256; cold-load and warm-load distinction.
- Exact local response; load/prompt/generation milliseconds and tokens/second.
- Memory peak, profiler/tool/template, and sampling interval.
- Radio status during inference and both restart checks.
- SQLCipher version and the same marker prefix before/after force-quit.
- Screenshots or profiler trace with customer text and personal identifiers removed.

Do not fill in this record from a simulator, desktop inference, or expected values. Add the observations to `DEVICE_EVIDENCE.md` only after Cosme captures them on the physical phone.

## References

- [Expo SDK 57 reference](https://docs.expo.dev/versions/v57.0.0/) (iOS and Xcode minimum versions; CNG configuration).
- [Expo local app development](https://docs.expo.dev/guides/local-app-development/) (prebuild, local native compile, and physical device selection).
- [llama.rn 0.12.9 release and install instructions](https://github.com/mybigday/llama.rn/tree/v0.12.9) (native artifact downloader and iOS framework).
- [Apple: gathering information about memory use](https://developer.apple.com/documentation/xcode/gathering-information-about-memory-use) (Xcode memory report and peak value).
