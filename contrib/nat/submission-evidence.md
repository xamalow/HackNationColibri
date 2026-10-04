# Submission evidence: which claims hold (Nat, independent evaluation)

For Carther, for the video and the written submission. Draft r0, 2026-10-03 23:45 UTC; updated as runs land.
Rule from packet 07: never describe an unrun test as passing, never soften a critical failure.

**Status words** (addendum r1.0):

- **VERIFIED** = an independent test passed on a named revision.
- **MEASURED** = a number with its conditions.
- **OPEN** = a test ran and failed, or partly failed.
- **UNMEASURED** = nobody has tested it yet.
- **UNREVIEWED** = needs a human reviewer.

## Claims you can make

| # | Claim | Status | Evidence (revision) |
|---|---|---|---|
| 1 | The model only proposes; counts, findings and approvals are decided by code | **VERIFIED** | Core r1 @ 5dacf07 validates every model citation (id, hash, UTF-8 span, exact quote) and rejects themes or sentiments outside the catalogue. W3 fixtures R1–R4 in `contrib/nat/results.md` |
| 2 | A finding needs at least 3 distinct comments on the same side; fewer means "not enough feedback" | **VERIFIED, with 2 OPEN defects** | Dev 28/28 on steps 1–5 with Domain's harness language ID; with Max's product detector, DEV-028 (a 2-word review) goes to a person instead. Held-out 10/13: a near-identical cross-post is counted twice (HO-001), and Kikuyu with a declared "sw" is counted (HO-012). Both can show a card on 2 real comments. Fix asked from Domain (R4) |
| 3 | Every quote on a card is the exact text of a real comment | **VERIFIED** | UTF-8 byte spans across accents, ß, emoji; altered quotes, moved spans and mid-character offsets are rejected (dev R1–R4); the held-out run agrees (R4) |
| 4 | A review cannot authorize a send, change a fact or record Noor's choice | **VERIFIED** | DEV-013, DEV-020 (R4); FC-14 |
| 5 | Any change to an approved action voids the approval (recipient, text, facts, language, expiry) | **VERIFIED** | Failure matrix FC-01, FC-12, FC-13 on 5dacf07 (`contrib/nat/results/failure-matrix-core-r1-5dacf07.md`); DEV-019 (stale card) |
| 6 | A crash or restart neither loses nor duplicates a send; an interrupted send becomes "may have been sent", never re-sent blindly | **VERIFIED in the core logic; UNMEASURED on the phone** | FC-02, FC-03, FC-06 pass with an in-memory transactional store. The on-device run (force-quit mid-approval, SQLCipher) is not done |
| 7 | Two requests for the last seat cannot both be confirmed; offline requests stay tentative | **VERIFIED in the core logic** | FC-07 |
| 8 | A helper (the daughter), an untrusted device or a revoked session cannot approve | **VERIFIED in the core logic** | FC-11. Real iOS Keychain/unlock is UNMEASURED |
| 9 | Relative dates, missing time zones and unknown currencies go to a person; money is never rounded or converted | **VERIFIED** | FC-15 |
| 10 | Messages in languages we do not support go to a person | **OPEN** | Language-ID held-out, Max r1 @ 6642402: as typed on a phone (no diacritics), **7 of 13** Kikuyu/Kamba/Luo items are labeled Swahili and would be counted; 2 of 13 only with FLORES's careful spelling (L1b corrects L1). Short reviews (2–3 words) always go to a person (12/12) |

## Claims you cannot make yet

| Claim | Status | What is missing |
|---|---|---|
| "Runs fully offline on a phone" | **UNMEASURED** | No iOS app build yet (Mobile). Needed: airplane-mode run, model load and inference time, RAM, app size and model size on Cosme's iPhone 15 Pro, each labeled with model and iOS version |
| "The local model understands Swahili feedback" | **MEASURED: no** | Max, desktop: Swahili theme F1 is 0.23 for Qwen3 0.6B and 0.35 for 1.7B, against **0.92 for the keyword baseline**. The honest claim is that code and lexicon decide and the model only drafts |
| "Sauti saves Noor time" / "AI adds value over reading the messages" | **UNMEASURED** | The three-condition study (manual reading vs keyword baseline vs local model, same inputs) has not run; owner time and clarity are not measured |
| "The Swahili is correct" | **UNREVIEWED** | 73/73 interface strings and all fixture Swahili are unreviewed by a native speaker. Say "Swahili (not yet reviewed)" on screen |
| "Works with Kikuyu" | **No** | Kikuyu is refused and sent to a person, by design. Say so as a limitation |
| Real SMS/WhatsApp/Google/GetYourGuide sends | **Not built** | Every send in the demo is SIMULATED and must be labeled so |

## Limitations to state in the video

- **Synthetic test data.** Every test comment is synthetic or taken from FLORES-200 (CC-BY-SA 4.0). No real customer
  data was used.
- **Small samples.** 37 dev and 13 held-out W3 scenarios; 29 language-ID items. That is enough to catch systematic
  failures, but not to estimate rates.
- **Model measurements are desktop only.** Max's numbers come from a desktop run, not the phone.
- **Different target phone.** The test phone is an iPhone; Noor's household phone may be Android.

## Reproduce

- **W3 fixtures:** `python eval/w3/run_fixtures.py run --set dev --impl node <core>/packages/core/dist/tools/w3-adapter.js`
- **Failure matrix:** `node contrib/nat/faults/run_failure_cases.mjs <core>/packages/core/dist <core>/contracts`
- **Language ID:** `node eval/langid/score_detector.mjs <detect_language.mjs>`. The held-out texts are on Nat's
  machine; the published manifest holds only their hashes.
