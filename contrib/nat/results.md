# Nat: evaluation results

Owner: Nat (independent evaluation and failure fixtures, packet 07). Prepared by muller-claude, Nat's helper.

## V1. Phone booking (Max's plan step 1): voice agent, offline and live through the hub, main @ 991ccf8 (2026-10-04)

Suites: `eval/hub_voice/` (README there).

| Suite | Result | Report |
|---|---|---|
| **Live**: `CallState` + `hubclient.py` → hub voice API (#45) over HTTP, Noor's SMS via `hub.ownerSms` | **14 / 14** (43 checks) | `results/hub-voice-live-991ccf8.json` |
| **Offline**: simulated hub, rules that hold whatever the speaker says | **6 / 12** (36 checks) | `results/hub-voice-offline-991ccf8.json` |

**What the live suite shows works.**

- A phone request reaches Noor as a read-back with the total computed by code and a one-time code.
- Only her NDIYO with the code from her number books, and it books once.
- Closed, past, over-capacity and full days are refused by the hub.
- Phone and SMS share one calendar: never more than 10 places are booked.
- Owner mode is selected by caller id, and Noor's spoken yes changes nothing.

Seven of eight injected hub flaws were caught. The eighth is absorbed by the client's key filter, as intended.

**Findings, with fixes proposed in the README.**

- **Severity medium.** A one-time code followed by a period is not redacted from the blackboard. `NDIYO A 482193.`
  is recorded as-is, and the defence-in-depth check misses it too. A one-line regex fix was checked locally.
- **Severity medium.** Kikuyu is served as Swahili by the voice language sidecar.
- **Severity low.** In simulated mode only, filing has no availability check, and the voice fixtures disagree with
  the hub's farm sheet. The live path is correct.
- **Severity low.** The injection cue list misses near-variants. The structural guarantees hold.

**Gaps, reported as observations.**

- **O1.** A phone tourist never hears Noor's answer. She is told to call back a number nobody keeps.
- **O2.** A hub refusal reaches the speaker as a bare "409", so it cannot say why or offer another date.

**PR #54** (hub-voice @ 36699b2, not merged yet):

- Live 14 / 14, offline 6 / 12. **O2 is fixed**: the speaker gives the hub's reason.
- The offline twin now refuses closed, full and over-capacity days; only a past date is still filed.
- **O3, new.** A group larger than the tour hears "that day is full, pick another day".

**Side note.** On Windows, `apps/hub/test/twilio.test.mjs` "413 over 64 KB" failed in 2 of 5 runs (`ECONNRESET` while the
oversized body is still uploading). The other 169 tests passed every time.

## L1b. CORRECTION to L1: the language-ID score was optimistic (2026-10-03, 23:50 UTC)

Max flagged L1 as suspect, and he was right. In FLORES-200 the Kikuyu lines use careful orthography: **5/5 contain
ĩ or ũ**, and Max's r1 detector refuses Kikuyu largely on those letters. On a phone keyboard most people type
without them.

The scorer now has an `--as-typed` condition, which removes diacritics before detection. It is the same 29 private
items, scored on the same detector (Max r1, main 6642402):

| Condition | Critical errors (non-target labeled sw/en/de/fr) | Which |
|---|---|---|
| As published (FLORES orthography) | 2 / 13 | 2 Kamba |
| **As typed, no diacritics** | **7 / 13** | 4 of 5 Kikuyu, 3 of 4 Kamba, all labeled **sw** |
| r0 (eb44394), both conditions, for reference | 9 / 13 | |

**What changes:**

- **L1's verdict is withdrawn.** "Every Kikuyu item is now refused" holds only for carefully spelled text.
- **Use the as-typed number.** Kikuyu typed on a phone is mostly read as Swahili and counted, so 7/13 is the number
  to quote.
- **The fix must not rely on diacritics.** Report both conditions from now on.
- **FLORES is formal translated text.** Real messages also differ in vocabulary and spelling, so even the as-typed
  number may still be optimistic.

Command: `node eval/langid/score_detector.mjs <detect_language.mjs> [heldout.jsonl] --as-typed`

## R4. W3 HELD-OUT, first run, vs Domain core r1 @ 5dacf07 (freeze candidate), 2026-10-03, 23:45 UTC

**Under test:** `core-r1` @ `5dacf07`, the packages/core r1 HANDOFF to Warden, built against frozen contracts r1.0.

- Domain's own suite passes (73/73).
- Run 1 uses Domain's adapter `tools/w3-adapter.js`.
- Run 2 swaps in the product language detector (Max r1, main 6642402) for the adapter's stopword ID.

**Held-out set:** 13 private fixtures, unchanged since the manifest was committed (`run_fixtures.py lint` OK).
Domain had not seen them.

| Set | Run 1: Domain adapter | Run 2: with Max r1 detector |
|---|---|---|
| Dev (control, 37) | 28 pass, 8 partial, 0 fail, 1 not covered | 27 pass, 8 partial, 1 fail (DEV-028, short text → a person, F4), 1 not covered |
| **Held-out (13)** | **10 pass, 3 fail** | **10 pass, 3 fail** (same three) |

### Held-out failures

These three are now disclosed and retired from the held-out set; they move to dev in the next revision.

| Fixture | Scenario | Observed | Kind and ask | Owner |
|---|---|---|---|---|
| HO-001 | The same review cross-posted, differing only in case and spacing | Counted twice: buy_coffee reaches 3 → `supported`, a card on 2 comments | **Count inflation.** The fold key is the exact content hash. Ask: fold on NFC + casefold + whitespace-collapsed text (same author) | Domain; Carter's count-unit decision |
| HO-012 | A Kikuyu comment whose source **declares** `sw` | Trusted as Swahili and counted: coffee reaches 3 → `supported` | **Wrong metadata trusted.** Max r1 refuses this text when it runs, but a declared language skips detection. Ask: run detection on declared sw/en/de/fr too, and send the item to a person when the detector disagrees | Domain + Max |
| HO-010 | Noor says "sitaki kujaribu" ("I don't want to try") | Recorded as **reject** | **Expectation dispute, not a safety failure.** The property under test, never read as a try, holds. The fixture expected nothing recorded; reject is a defensible reading. Held-out files are hash-locked and were not edited. Decision: Nat | Nat |

The 10 passing held-out fixtures are not described here, so they stay blind for the next run.

**Verdict on core r1:**

- **Two real defects.** HO-001 and HO-012 each let a finding reach 3 comments on insufficient evidence, so Noor
  would see a card that the rules say she should not.
- **Everything else holds** on unseen scenarios.

## L1. Language-ID held-out: Max's fixed detector r1 on main @ 6642402 (PR #13), 2026-10-03, 23:35 UTC

The set and the scorer are the same as L0; the texts were not shown to Max.

| Category | n | Correct | Abstained (to a person) | Wrong |
|---|---|---|---|---|
| Kikuyu / Kamba / Luo, full lines | 11 | 10 | – | **1** |
| Kikuyu / Kamba / Luo, first 5 words | 2 | 1 | – | **1** |
| Sheng (acceptable: sw or unsure) | 4 | 3 | 1 | 0 |
| 2–3 word reviews, sw/en/de/fr | 12 | 0 | 12 | 0 |

**Results:**

- **Critical errors fall from 9 to 2 of 13.** Every Kikuyu and Luo item is now refused.
- **The 2 remaining errors are both Kamba** (LID-kam-03, full line; LID-kam-04, first 5 words), labeled **sw**.
  Max's own vectors had no Kamba, so the Kikuyu-specific refusals do not generalize to the next Bantu language.
- **Short reviews:** all still go to a person, which is the documented F4 trade-off. The product should use the
  platform's language field where it exists.

**Verdict:** not yet safe to count a source labeled sw without a declared language. Kamba-speaking visitors' or
neighbours' messages would be read as Swahili. The fix and re-test are Max's; the held-out stays private.

## L0. Language-ID held-out baseline: Max's detector on main @ eb44394 (2026-10-03, 23:30 UTC)

**Set:** [eval/langid](../../eval/langid/README.md), 29 private items, SHA-256 in `eval/langid/heldout_manifest.json`.

- 13 Kikuyu, Kamba and Luo lines from FLORES-200 devtest (CC-BY-SA 4.0). 2 of them are truncated to their first 5
  words.
- 4 synthetic Sheng lines.
- 12 synthetic 2–3 word reviews, 3 each in sw, en, de and fr.

**Under test:** `contrib/max/langid/detect_language.mjs` as merged in #7 (franc 6.2.0 restricted to sw/en/de/fr,
"unsure" under 4 words, score < 0.5 or margin < 0.2). This is the version **before** Max's F2/F4 fix.

| Category | n | Correct | Abstained (to a person) | Wrong |
|---|---|---|---|---|
| Kikuyu / Kamba / Luo, full lines | 11 | 4 | – | **7** |
| Kikuyu / Kamba / Luo, first 5 words | 2 | 0 | – | **2** |
| Sheng (acceptable: sw or unsure) | 4 | 4 | 0 | 0 |
| 2–3 word reviews, sw/en/de/fr | 12 | 0 | 12 | 0 |

**Results:**

- **Critical errors: 9 of 13.** Non-target text was labeled as a supported language, mostly sw, so it would be read
  and counted as Swahili. This confirms R3 finding F2 on independent text.
- **Short reviews:** none of the 12 is answered. Each costs a person's attention (F4).
- **Next:** rerun on Max's fixed commit with the same command. Only aggregates and wrong ids will be published.

```
node eval/langid/score_detector.mjs <checkout>/contrib/max/langid/detect_language.mjs
```

## R3. W3 dev fixtures vs Claude Domain core @ 991f223, three adapters (2026-10-03, 23:10 UTC)

**Under test:** `claude-domain` @ `991f223`, which adds ingest, decision cards and owner choice (ffd2e90), plus
Domain's fixture adapter `packages/core/dist/tools/w3-adapter.js`. Domain's suite passes (68/68). Fixtures are from
`main` (eb44394). The held-out set is **not** run; it waits for the frozen head after the 23:30 UTC freeze (packet
07).

| Adapter | PASS | PARTIAL | FAIL | NOT COVERED |
|---|---|---|---|---|
| Domain's own (harness stopword language ID) | 27 | 0 | 1 | 0 |
| Domain's own, with Max's `franc` detector (main, contrib/max/langid) swapped in for the harness one | 25 | 0 | 3 | 0 |
| Nat's translation-only adapter (core API only, no language ID) | 13 | 12 | 2 | 1 |

The harness swap was made in a local copy only. Only `detectLanguage` was replaced; nothing else changed.

**Steps 4–5 now work end to end through Domain's adapter.** All of these pass:

- **DEV-016 card checks:** exact quotes, no invented number.
- **DEV-017 to DEV-023:** generic "ndiyo" refused, uncertain transcript refused, stale card voided, and try, reject
  and ask_someone recorded.

### Findings

| # | Kind | Finding | Evidence | Owner |
|---|---|---|---|---|
| F1 | **Safety regression** | The core now accepts a source with **no** declared language (`evidence.ts:43`, "an undeclared language is not a rejection"). At 885c0b4 it was refused. Without a language-ID result, a Kikuyu comment is counted and coffee reaches 3 → `supported` | DEV-011 fails with Nat's adapter at 991f223; it passed at 885c0b4 | Domain |
| F2 | **Wrong language, high confidence** | Max's `franc` rule, restricted to sw/en/de/fr, labels Kikuyu as **sw** with score 1 and margin 0.26–0.29, above the 0.2 threshold. Kikuyu is then read and counted as Swahili | `detectLanguage("Nĩ wega mũno Noor. Kahũa kaarĩ keega…")` → `{lang: "sw", reason: "ok"}`; DEV-011 fails with franc swapped in | Max |
| F3 | Harness fitted to dev | The harness stopword lists contain content words lifted from the dev fixtures, so the 27/28 overstates the core. With a real detector the score is 25/28 | en: nobody, knows, lost, kids, sign, turn, twice, drove, past · fr: aurions, aimé, acheter, emporter, épicé, chaleureux · sw: walipenda, walisema, tamu · Kikuyu rule on ĩ/ũ | Domain (harness) |
| F4 | Trade-off to state | Texts under 4 words come out "unsure" and go to a person. Short reviews are common | DEV-028: "Café excellent." is dropped, coffee finding 3 → 2 | Max + Domain |
| F5 | Trivial | Domain's adapter maps tag reasons back to Nat's old codes (`unknown_theme`, `unknown_sentiment`, `message_not_eligible`). Main uses Domain's strings verbatim | DEV-010 | Domain (harness) |
| F6 | Ownership | DEV-009 (unparseable model output) passes only because the **adapter** synthesizes `structured_output_failure`. The product needs the same in the parse layer | DEV-009 fails with Nat's adapter | Mobile / Domain |

**Recommended fixes:**

- **F1 (Domain):** when `supportedLanguages` is set, treat undeclared or `und` as unsupported, so the item goes to
  a person. This is fail-closed.
- **F2 (Max):** run `franc` over its full language set, or add `kik`, and map anything that is not sw/en/de/fr to
  "unsure". Add Kikuyu test vectors.

## R2. W3 dev fixtures vs Claude Domain core @ 885c0b4 (2026-10-03, after Domain's fixes)

**Under test:** `claude-domain` @ `885c0b4`, which includes 80a5519. Domain's suite passes (60/60). The adapter now
passes the catalogue (`allowedThemes`, 11 themes) and `supportedLanguages` (en, sw, de, fr), and uses the core's own
`direction`. The held-out set is still not run, because the core is not frozen.

Two runs, which differ only in the language each message declares:

| Run | PASS | PARTIAL | FAIL | NOT COVERED |
|---|---|---|---|---|
| Strict: a message's language is only what its source declared | 7 | 3 | 17 | 1 |
| `--assume-language-id`: each message declares its true language, as if a perfect upstream identifier existed | 14 | 12 | 1 | 1 |

**Finding 1: no layer identifies the language.** 16 of the 17 strict failures come from this one cause.

- The core rejects a source with no declared language as `unsupported_language`. That is fail-safe, and it is
  right.
- But tourist SMS/WhatsApp messages, direct reviews and notes dictated by Noor or the guide declare no language.
- Today all of them would be sent to a person and never counted. In DEV-001, for example, the directions finding
  drops from 3 comments to 2.
- Decision needed: who sets `SourceText.language`? The options are the tagger (model), a code-only identifier
  (MIT/Apache) or the import layer. Then evaluate that layer.

**Finding 2: one failure remains with language ID assumed, DEV-009.** Unparseable model output (truncated JSON)
has no entry point in the core. A tag outside the catalogue does yield `structured_output_failure`, but output that
never parses into tags yields nothing. Decision needed: does Domain expose a `modelOutputUnreadable(sourceIds)` →
ask-a-person, or does the parse layer (Mobile) own it?

**Fixed since R1** (all pass under `--assume-language-id`):

| Fixture | Fix |
|---|---|
| DEV-010 | The crash is gone; unknown theme and sentiment are rejected (`theme_not_allowed`, `sentiment_not_allowed`) |
| DEV-011 | Kikuyu is rejected as `unsupported_language`, not counted, and goes to a person |
| DEV-026, DEV-027 | The supporting side needs 3 comments |
| DEV-004 | Cross-posts fold by content hash |

Note on DEV-004: Domain folds identical text from **any** author. Two different visitors writing the same short
"Great coffee!" would count once. That undercounts, which is the safe direction. It should still be noted for
Carter's count-unit decision.

**Adapter mapping to note:** the core's `neutral_mentions` (3 or more neutral, no opinion) is reported as
`not_enough_feedback`. Nothing is concluded either way.

**Command:**

```
python eval/w3/run_fixtures.py run --set dev [--assume-language-id] \
  --report contrib/nat/results/w3-dev-vs-domain-885c0b4[-langid].json \
  --impl node contrib/nat/adapters/domain-core-w3.mjs <checkout of 885c0b4>/packages/core/dist
```

## R1. W3 dev fixtures vs Claude Domain core @ 8c066ff (2026-10-03)

**Under test:** `packages/core` on `mrrCarter/HackNationColibri` branch `claude-domain`, commit `8c066ff`. Draft, not
frozen, so the held-out set was **not** run. Built with `npm ci && npm run build`; Domain's own suite passes
(45/45).

**Command:**

```
python eval/w3/run_fixtures.py run --set dev --report contrib/nat/results/w3-dev-vs-domain-8c066ff.json \
  --impl node contrib/nat/adapters/domain-core-w3.mjs <checkout>/packages/core/dist
```

**Reproduce** (Node 22+, Python 3.12+ with pydantic and pytest):

```
git fetch https://github.com/mrrCarter/HackNationColibri.git claude-domain
mkdir -p /tmp/domain && git archive 8c066ff packages/core contracts | tar -x -C /tmp/domain
(cd /tmp/domain/packages/core && npm ci && npm run build)
python eval/w3/run_fixtures.py run --set dev --impl node contrib/nat/adapters/domain-core-w3.mjs /tmp/domain/packages/core/dist
```

**Adapter** ([adapters/domain-core-w3.mjs](adapters/domain-core-w3.mjs)): translation only. It calls
`validateEvidenceItem` and `summarizeThemes`. A source id is `source:external_id`, so a re-synced review is the same
source. The core has no API for import, cards or Noor's choice, so the adapter declares those `not_implemented`.

**Sample:** 28 synthetic dev fixtures (hand-written, non-English text unreviewed). Model outputs are simulated, so
this measures the code layer, not the model.

| Result | Count | Fixtures |
|---|---|---|
| PASS | 10 | 002, 005–008, 012, 015, 024, 025, 028 |
| PARTIAL | 11 | 001, 003, 013, 014, 016–018, 020–023 (counts pass; ingest, card or choice not testable in the core) |
| FAIL | 6 | 004, 009, 010, 011, 026, 027 |
| NOT COVERED | 1 | 019 (Noor's choice only) |

### Failures

| Fixture | Expected | Observed at 8c066ff | Kind |
|---|---|---|---|
| DEV-010 | A sentiment outside positive/negative/neutral is rejected; unknown theme `wifi` is rejected | `summarizeThemes` throws `TypeError` (`dist/evidence.js:67`, `bySentiment[t.sentiment]` is undefined). Without that label, theme `wifi` is accepted and counted | **Bug**: one bad model field crashes the summary; no fixed theme list |
| DEV-009 | Unreadable model output → ask a person (`structured_output_failure`) | Nothing: no ask-a-person result | **Gap** vs packet 04 ask-a-person list |
| DEV-011 | Kikuyu source → ask a person (`unsupported_language`); its labels not counted | No ask-a-person; the 2 Kikuyu labels are counted, coffee reaches 3 → `supported` | **Gap** vs packet 04; inflates a finding |
| DEV-026 | 1 positive + 1 negative + 1 neutral → not enough to conclude | `supported_with_dissent`, with no majority side | **Decision** (the rule looks unintended) |
| DEV-027 | 2 negative + 1 positive on price → not enough to act | `supported_with_dissent`: a price complaint backed by 2 comments | **Decision**: does MIN 3 apply to the theme or to the side? |
| DEV-004 | Same author and text on two platforms counts once | Counted twice (3 → `supported`) | **Decision**: Domain chose "comments, not visitors" by design |

What passed matters too:

- **Citations:** nonexistent ids, altered quotes, moved spans, spans splitting a character or past the end are all
  rejected with the right reason.
- **UTF-8 offsets:** they hold across é, ß and emoji.
- **Counting:** duplicates and repeated labels do not inflate counts.
- **Contradictions and outliers:** contradictions go to a person, and a single loud outlier does not flip a finding.

### Not measured yet

- The held-out set, until Domain freezes.
- The three-condition comparison: manual reading, keyword baseline and the local model.
- Owner time and clarity.
- Steps 4–5 (cards, choices).
- The step-6 failure cases.
