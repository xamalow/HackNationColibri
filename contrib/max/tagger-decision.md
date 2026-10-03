# Theme tagger decision r0: deterministic labels instead of model labels (Max lane)

Status: **MEASURED on DESKTOP**, 2026-10-04, `results/tagger-desktop-r0.json`. Offer (a) in the room, unclaimed
since claude-warden's 23:01 UTC note ("keep code/lexicon as the decider; the model only proposes").

## Why

Qwen3 0.6B and 1.7B cannot label Swahili feedback (theme F1 0.23 and 0.35-0.37 on the same dev set,
[model-decision.md](model-decision.md); 1.7B runs by claude-warden and cosme-claude). A hand-written, auditable
tagger can produce the same output shape the core already validates.

## What

[tagger/tag_feedback.mjs](tagger/tag_feedback.mjs): `tagFeedback([{id, text, lang?}])` returns
`{status: "ok", labels: [{message_id, theme, sentiment, quote, start, end}], untagged: [...]}`. This is
exactly the model output Domain's core parses (`packages/core/src/tagging.ts`), so it can replace or back up the
model with no core change.

- Themes: Nat's 11-theme catalogue (`eval/w3/reference_rules.py`): coffee, farm_walk, food, host, directions,
  price, timing, booking, language, facilities, buy_coffee.
- Clause split on punctuation and contrast words (but, lakini, aber, mais). Each clause naming a theme becomes
  one label whose quote is the clause, an exact slice of the original text, with UTF-8 byte offsets computed by code.
- Sentiment from per-language positive/negative cue lists; both or neither gives `neutral`.
- Swahili is agglutinative: cues are verb roots matched inside words (a-li-tu-**karibisha**, wa-li-**potea**);
  negation prefixes (`^haku`) match only at the start of a word (so c-haku-la stays "food").
- A message whose language is undetermined (`langid/detect_language.mjs` returns `und`) or unsupported gets no
  label (`unsupported_language`), so the core asks a person. Text naming no theme gets `no_theme_found`.
- Instructions inside feedback are just words: there is no code path from text to an action.

## Numbers

| Reference | Messages | Theme F1 | P / R | Sentiment on matched | Quotes exact |
|---|---|---|---|---|---|
| A: Nat's public W3 dev fixtures, labels Nat's reference rules accept | 126 | **0.934** | 0.919 / 0.949 | 0.905 | 161 / 161 |
| B: this lane's dev set (optimistic, tuned on it) | 40 | 0.936 | 0.880 / 1.000 | 0.955 | yes |

By language, A: de 0.96, en 0.92, fr 0.93, sw 1.00 (only 4 Swahili labels). B: de 0.89, en 0.92, fr 0.94,
**sw 0.97** (Qwen3 0.6B on the same items: 0.23; 1.7B: 0.35-0.37).

**Tuning disclosure:** after the first run I made three general fixes while looking at reference B's Swahili
errors (Swahili prefixes, coffee as the object of picking/buying, dropping the generic cues *shamba* and *ujumbe*)
and one at reference A (`^haku` matched inside *chakula*). Before the fixes: A 0.923, B 0.869. Both references
are therefore optimistic. The fair test is Nat's held-out W3 set, run by Nat.

## Known gaps

- Lexicons are short and hand-written; Swahili cues are non-native and UNREVIEWED (see language-review.csv).
- Sarcasm, comparisons ("better than the last farm"), and negation scope beyond the clause are not handled.
- One clause can mention two themes and then carries one sentiment for both.
- Recall depends on vocabulary: a theme described with words not in the list is missed (`no_theme_found`),
  which is the safe failure (nothing counted, nothing invented).

## Validation

```bash
python contrib/max/tagger/eval_tagger.py          # both references, writes results/tagger-desktop-r0.json
node --test contrib/max/tagger/test_tagger.mjs     # 6 tests: exact slices, prefixes, ^haku, und, injection, no theme
node contrib/max/tagger/make_test_vectors.mjs      # test-vectors.json: 170 messages, 212 labels, for the TS port
```
