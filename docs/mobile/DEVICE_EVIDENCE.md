# Mobile offline inference and persistence evidence

## Current status

**Partial native build only; G1 evidence is still in progress.** Cosme reports in Senti #47559 a signed Release build from `wip/mobile-skeleton@784142f`, 66 MB with no model bundled, installed and launched on the physical iPhone 15 Pro. Carter's signing agreement was accepted. This proves native compile/install/launch only: no radio-off Qwen response, imported model hash, inference timing, memory peak, SQLCipher version, or force-quit/relaunch marker has been reported. The direct Mobile task specifies Android; Warden's shared-lane target is iPhone, and that run does not satisfy the separate Android request. Follow [the iPhone runbook](IOS_DEVICE_RUNBOOK.md) for the shared-lane G1 run.

Fill this page only with observations captured on the named physical device. Desktop measurements and simulator runs do not satisfy the offline-phone gate.

## Run record

| Field | Observed value |
| --- | --- |
| Target / lane decision | Android is the direct task target; Warden selected iPhone 15 Pro for the shared Senti lane |
| Device model and SoC | iPhone 15 Pro reported; SoC not recorded |
| OS version / build | iOS 26.3.1 reported; build number not recorded |
| Physical device identifier | Not recorded in git; use a non-sensitive label |
| App commit / native build ID | `784142f`; signed Xcode Release build succeeded (66 MB, model not bundled), installed and launched; exact Xcode build number not reported |
| Runtime and native backend | llama.rn 0.12.9 configured; on-device inference not yet reported |
| Model | Qwen3 0.6B Q8_0 candidate; not yet imported on the phone |
| Model file bytes / SHA-256 | Expected 639,446,688 / `9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031` from manifest; verify actual imported device file |
| Model load time | Not measured |
| Prompt evaluation time | Not measured |
| Generation time / tokens per second | Not measured |
| Peak process memory | Not measured |
| Wi-Fi, cellular, Bluetooth state | Not reported; G1 run in progress |
| SQLCipher version | App displays PRAGMA result after a native DB open; device value not reported |
| Restart marker before force-close | Not measured |
| Restart marker after force-close/relaunch | Not measured |
| Evidence artifacts | Cosme reported build/install/launch in Senti; no G1 screenshots or profiler trace reported |

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
