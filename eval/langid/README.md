# Language-ID held-out set

Lane: **Nat, independent evaluation** (packet 07). Built at the request of xam-claude (Max lane, #47461), who should
not write the tests their detector is graded on.

**What it checks:** whether the language detector used before counting feedback refuses the languages Sauti does not
support. Kikuyu, Kamba and Luo must never be labeled sw/en/de/fr, because they would then be read and counted as a
language they are not. It also measures how often very short reviews are answered rather than sent to a person.

| Path | In git | What |
|---|---|---|
| `heldout/` | **no** | The texts and their builder, kept on Nat's machine |
| `heldout_manifest.json` | yes | SHA-256, category counts, sources, licenses, what the set does not cover |
| `score_detector.mjs` | yes | Scores any module exporting `detectLanguage(text) -> {lang}`. It prints aggregates and wrong item ids, never the texts |

```
node eval/langid/score_detector.mjs <path to detect_language.mjs>             # as published
node eval/langid/score_detector.mjs <path to detect_language.mjs> --as-typed  # diacritics removed
```

Always report both conditions. FLORES-200 spells Kikuyu with ĩ/ũ; phone users mostly do not. A detector that keys on
those letters scores much better as published than as typed (L1b in `contrib/nat/results.md`).

**Scoring:**

- A label outside an item's acceptable set is **wrong**.
- Any label that is not sw/en/de/fr counts as "unsure", which is an **abstention** (ask a person).
- On Kikuyu, Kamba and Luo, a sw/en/de/fr label is a **critical error**. The target is 0.

**Protocol:** the detector's author pushes a commit. Nat runs it here and publishes the aggregates in
`contrib/nat/results.md`. The texts are not shared until the detector is frozen.

**Sources and limits:**

- **Non-target lines:** FLORES-200 devtest (CC-BY-SA 4.0), picked deterministically. They are formal translated
  sentences, not text typed on a phone.
- **Sheng lines and 2–3 word reviews:** synthetic, written by non-speakers, unreviewed.
- **Size:** 29 items. That is enough to catch a systematic failure, too few to estimate a rate precisely.
