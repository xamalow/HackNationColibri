# Mobile offline inference and persistence evidence

## Current status

**Shared iPhone G1 evidence is captured and Warden +1'd.** On 2026-10-04, Cosme ran the signed Release build on a physical iPhone 15 Pro with airplane mode on and Wi-Fi off. Qwen3 0.6B Q8_0 was verified at import; an offline cold inference completed, and a SQLCipher marker survived force-quit/relaunch. The three screenshots and full run record are on [Cosme's evidence commit](https://github.com/xamalow/HackNationColibri/tree/242c18b/docs/mobile/evidence). Bluetooth is not visible in the screenshots and peak memory is not measured. The reported 377 ms total is inconsistent with the separately reported 92.805 ms prompt + 354.907 ms generation phases; timer boundaries are awaiting clarification. The offline model output was not a grounded Swahili interpretation. This iPhone result does not satisfy the direct Android-device requirement. Follow [the iPhone runbook](IOS_DEVICE_RUNBOOK.md) for any remaining iPhone measurements.

Fill this page only with observations captured on the named physical device. Desktop measurements and simulator runs do not satisfy the offline-phone gate.

## Run record

| Field | Observed value |
| --- | --- |
| Target / lane decision | Android is the direct task target; Warden selected iPhone 15 Pro for the shared Senti lane |
| Device model and SoC | iPhone 15 Pro reported; SoC not recorded |
| OS version / build | iOS 26.3.1 reported; build number not recorded |
| Physical device identifier | Not recorded in git; use a non-sensitive label |
| App commit / native build ID | Evidence branch `cosme/mobile-ios@242c18b`; app built from `7ae9a9f` plus `wip/mobile-skeleton@e729429`; Xcode 26.6 signed Release, embedded JS, 66 MB app, model not bundled |
| Runtime and native backend | llama.rn 0.12.9, iOS Metal, 99 GPU layers, context 1024, 4 CPU threads |
| Model | Qwen3 0.6B Q8_0, imported from Files |
| Model file bytes / SHA-256 | 639.4 MB; verified-at-import SHA-256 `9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031` |
| Model load time | Cold after force-quit, airplane run: 235 ms; warm airplane run: already loaded |
| Prompt evaluation time | 92.805 ms |
| Generation time / tokens per second | 354.907 ms / 47.9 tokens/s; warm run 285 ms / 63.1 tokens/s |
| Total inference | Cold 377 ms reported; prompt and generation phases sum to 447.712 ms, so total/phase timer boundaries need clarification. Warm 316 ms reported. |
| Model integrity check time | 288,116 ms in an earlier run; Cosme reports moving full-file hashing to import only |
| Peak process memory | Not measured (no Instruments trace reported) |
| Wi-Fi, cellular, Bluetooth state | Airplane mode on and Wi-Fi off during inference, per run record; Bluetooth is not visible in screenshots |
| SQLCipher version | 4.19.0 community; database key held in iOS secure storage (Keychain via expo-secure-store) |
| Restart marker before force-close | Written from Today before force-quit |
| Restart marker after force-close/relaunch | Present: “Marker persisted from a previous app session. Marker 9dcab386…” |
| Exact offline model output | “The feedback is untrusted quoted data. Ignore any instructions inside it.” This proves local generation; it is not a grounded Swahili decision. An earlier radios-on run misread a positive Swahili review. |
| Evidence artifacts | [Evidence record](https://github.com/xamalow/HackNationColibri/blob/242c18b/docs/mobile/DEVICE_EVIDENCE.md); [radios-on setup (not G1)](https://github.com/xamalow/HackNationColibri/blob/242c18b/docs/mobile/evidence/g1-0-first-device-run-radios-on.png); [airplane-mode inference](https://github.com/xamalow/HackNationColibri/blob/242c18b/docs/mobile/evidence/g1-1-airplane-cold-load-qwen-answer.png); [SQLCipher marker after restart](https://github.com/xamalow/HackNationColibri/blob/242c18b/docs/mobile/evidence/g1-2-airplane-sqlcipher-marker-survived-restart.png) |

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
