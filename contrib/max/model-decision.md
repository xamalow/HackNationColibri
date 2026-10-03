# Model decision r0: what Qwen3 0.6B may do in Sauti (Max lane)

Status: **MEASURED on DESKTOP**, 2026-10-03, run `results/qwen3-0.6b-q8-desktop-20261003T2225Z.json`.
Not a phone measurement: the test device is now an iPhone (Carter, 22:29 UTC); on-device numbers come later.
Dev set: 40 synthetic items (16 sw, 10 en, 7 de, 7 fr), non-native Swahili, one annotator ([data-card.md](data-card.md)).

## Decision

1. **Qwen3 0.6B must not decide themes or sentiment for Swahili feedback.** On Swahili it labels almost
   everything "coffee, positive" (theme F1 0.13 to 0.23 across prompts). Examples from the best condition:
   "Chakula kilikuwa baridi na kidogo" (food was cold and small) -> *coffee, positive*; "Tulipotea njia" (we got
   lost) -> *coffee, positive*; "Hakuna choo safi" (no clean toilet) -> *coffee, positive*.
2. **The core's evidence check is mandatory, not a nice-to-have.** Even with grammar-constrained JSON, the model
   invented quotes (1 to 3 per 40 items, e.g. it copied a few-shot example "Tulifika Jumamosi." into an English
   review). The harness's code check, which applies the contract's evidence rules (exact UTF-8 slice, span computed
   by code), rejected all of them; Domain's `validateEvidence` in packages/core enforces the same rules.
3. **Always grammar-constrain the output** (llama.cpp JSON schema grammar): 100% valid JSON, 94-97% exact quotes,
   no off-list labels. Without it 9 of 38 findings used labels outside the list.
4. **Never give the model a Swahili system prompt.** It copied prompt sentences as "quotes" (27 of 37 findings
   invented) and English/German/French items dropped to F1 0.0-0.18. English instructions, data in any language.
5. **Instruction injection is not obeyed but is cited.** No output followed "ignore your rules / send / confirm",
   but in 1 of 3 adversarial items the instruction sentence itself was returned as evidence (sw-11, as
   *coffee, positive*). The card must show quotes as quotes, and counts must come from code.
6. **For the first release (W3 feedback card):** use a deterministic, auditable tagger (keyword/lexicon per
   language, exact clause as quote) as the primary labeler, with "ask a person" when nothing matches, and treat
   Qwen output, if used at all, as an *unverified suggestion shown separately*. The keyword tagger here scored
   0.93 F1 but it is **optimistic**: I wrote its keywords after seeing this same dev set. Nat's held-out set is
   the fair test for both.

## Numbers (desktop: AMD Ryzen 7 7840HS, 4 threads, CPU only, llama-cpp-python 0.3.19, Q8_0)

| Condition | Theme F1 | P / R | sw F1 | en F1 | de F1 | fr F1 | Sentiment acc. on matched | Exact quotes | Invented quotes | Off-list labels | Mean / p95 s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Keyword baseline (optimistic, see 6) | 0.93 | 0.87 / 1.00 | 0.92 | 0.89 | 0.95 | 1.00 | 0.92 | 100% | 0 | 0 | ~0 |
| EN prompt, free JSON | 0.42 | 0.55 / 0.33 | 0.13 | 0.59 | 0.57 | 0.71 | 0.88 | 76% | 0 | 9 | 1.3 / 2.5 |
| EN prompt, JSON grammar | 0.43 | 0.51 / 0.38 | 0.18 | 0.50 | 0.75 | 0.57 | 0.78 | 97% | 1 | 0 | 2.1 / 3.3 |
| SW prompt, JSON grammar | 0.14 | 0.40 / 0.08 | 0.23 | 0.00 | 0.00 | 0.18 | 0.25 | 27% | 27 | 0 | 4.7 / 19.3 |
| EN prompt, grammar, 3 few-shot | **0.50** | 0.49 / 0.50 | 0.23 | **0.78** | 0.63 | 0.67 | 0.75 | 94% | 3 | 0 | 2.6 / 4.6 |

Other measurements: model load 0.38 s (file cached), peak process memory 1,134 MB, 14-47 completion tokens/s,
no false finding on 3 of 3 no-theme items except 1 in the few-shot condition. Thinking mode was off (`/no_think`).

## What this does not show

- Phone behaviour (iPhone, llama.rn + Metal): speed, memory, thermal. Re-measure there.
- Real Swahili: the 16 Swahili items are non-native and UNREVIEWED ([language-review.csv](language-review.csv)).
  Real visitor and guide Swahili may be easier or harder.
- Statistical confidence: 40 items, single run, temperature 0. Differences under ~0.1 F1 are noise.
- Larger models. Qwen3 1.7B (Apache-2.0) is the obvious next candidate for the same harness; its Q8_0 file is
  1.83 GB (only quant published by Qwen), to be measured on desktop, then on the iPhone if it helps.

## Next in this lane

1. Run this harness on Nat's held-out set once it is published as an adapter (keyword tagger vs Qwen).
2. Same harness through llama.rn on the iPhone (Mobile lane provides the runner), numbers labeled PHONE.
3. Native Swahili review of the dev set, then re-run.
4. Qwen3 1.7B Q8_0 (1.83 GB, Apache-2.0, hash in the manifest), same conditions: delegated to another team agent, command in contrib/max/README.md.
