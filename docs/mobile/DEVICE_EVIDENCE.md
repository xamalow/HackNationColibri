# Mobile offline inference and persistence evidence

## Current status

**G1 PASSED on the physical iPhone 15 Pro (2026-10-04 ~00:39–00:41 UTC), run by Cosme with cosme-claude.**
Airplane mode on, Wi-Fi off during inference (Wi-Fi was briefly on earlier only to AirDrop the model and the
synthetic feedback file, before the offline run). The model was cold-loaded after a force-quit, answered locally,
and an SQLCipher marker written before the force-quit was read back after relaunch. Screenshots in `evidence/`.

Honest limits: peak memory not measured (no Instruments trace yet); the model's paraphrase was poor (it echoed a
prompt instruction; an earlier radios-on run misread Swahili), which is consistent with Max's desktop finding that
Qwen3 0.6B must not decide anything; Bluetooth state is not visible in the screenshots.

## Run record

| Field | Observed value |
| --- | --- |
| Target | iPhone 15 Pro (iPhone16,1), shared-lane target per Carter |
| OS version | iOS 26.3.1 |
| Physical device identifier | Not recorded in git |
| App commit / native build | `cosme/mobile-ios` @ the commit that adds this file (built from `7ae9a9f` + merge of `wip/mobile-skeleton@e729429`); Xcode 26.6, signed Release, embedded JS bundle (no Metro), 66 MB app, model not bundled |
| Runtime and native backend | llama.rn 0.12.9, Metal, n_gpu_layers 99, n_ctx 1024, 4 CPU threads |
| Model | Qwen3 0.6B Q8_0, Apache-2.0, imported from Files (AirDrop) |
| Model file bytes / SHA-256 | 639.4 MB / `9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031`, verified at import (full hash took 288,116 ms on device in an earlier run, now done once at import) |
| Cold model load (airplane) | **235 ms** |
| Prompt evaluation | 92.8 ms |
| Generation / tokens per second | 354.9 ms / **47.9 tok/s** (warm run in airplane: 285 ms, 63.1 tok/s) |
| Total inference | **377 ms** (cold), 316 ms (warm). Clock: JS `Date.now()` around llama.rn `completion()`. Prompt/generation phases come from llama.cpp's own timers (`result.timings`) and are NOT nested in the JS wall time; do not sum them (92.8 + 354.9 ≠ 377) |
| Peak process memory | Not measured |
| Wi-Fi, cellular, Bluetooth state | Airplane mode on, Wi-Fi off during inference (per Cosme + status bar); Bluetooth not shown |
| SQLCipher version | **4.19.0 community**, key in iOS secure storage (Keychain via expo-secure-store) |
| Restart marker before force-close | written (`Write persistence marker`) |
| Restart marker after force-close/relaunch | **present**: "Marker persisted from a previous app session. Marker 9dcab386…" |
| Evidence artifacts | `evidence/g1-0-first-device-run-radios-on.png` (first run, radios on, NOT G1), `evidence/g1-1-airplane-cold-load-qwen-answer.png`, `evidence/g1-2-airplane-sqlcipher-marker-survived-restart.png` |

## Android procedure

1. Record the phone model, OS build, app commit, native runtime/backend, and exact model manifest revision before running. Import the model from a local file and require the app's expected byte count and SHA-256 to match.
2. Put the device fully offline: enable airplane mode, then separately verify Wi-Fi and Bluetooth are off (both can be re-enabled while airplane mode remains on). Confirm cellular is disconnected. Capture the device status without including personal notifications or identifiers.
3. With the radios still off, import a small CSV/JSON feedback fixture from local device storage. Confirm the original source text and content hash appear in Evidence.
4. Run the local Qwen suggestion on that source. Capture the exact displayed output and on-device runtime timings. Label it unverified; it must not become a theme, source quote, approval, or outgoing text automatically.
5. Measure peak app memory during model load and generation using the platform profiler. Record tool/version, sampling interval, and peak PSS/RSS; keep profiler control over USB if needed while confirming radios remain off.
6. On Today, record the SQLCipher version and write a persistence marker. Force-stop the app, launch it again, and confirm the same marker appears as from a previous app session.
7. Record screenshots/logs with no customer text, credentials, signing information, or personal device identifiers. Keep raw evidence local until it is reviewed for secrets.

## Interpretation limits

- This app does not fetch models or send feedback during inference. The model must be selected from local storage; there is no online fallback.
- Qwen is a proposal-only diagnostic. The W3 decision must come from the frozen deterministic Domain logic and exact source evidence; owner approval must use Domain's frozen `approveExact` API and transactional encrypted store.
- Model load time is reported only on the run that actually loaded the model. Later warm runs display that the model was already loaded.
- Memory is intentionally not guessed by JavaScript. Capture it with Android Studio/ADB or Xcode Instruments on the real phone.
