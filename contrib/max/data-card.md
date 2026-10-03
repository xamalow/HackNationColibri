# Data card: Max lane dev set (`contrib/max/devset/feedback_dev.jsonl`)

| Field | Value |
|---|---|
| Purpose | Development set for the Qwen3 0.6B extraction experiments in this lane: themes, sentiment, exact evidence quotes |
| Status | **SYNTHETIC**. Every item has `"synthetic": true`. Not real visitors, reviews, guides or Noor |
| Author | xam-claude (Claude, for Max), 2026-10-03. Not a native Swahili speaker |
| Size | 40 items: 16 Swahili, 10 English, 7 German, 7 French |
| Source types | direct_review, google_review, getyourguide_review, tourist_message, guide_note, noor_note (labels only, nothing was collected from these platforms) |
| Labels | `gold`: list of `{theme, sentiment, quote}`; each `quote` is checked by code to be an exact substring of `text` |
| Theme list | coffee, farm_walk, guide, host, directions, food, price, timing, booking, facilities. **PROPOSED** for this experiment; Domain/Nat own the product theme list |
| Special items | 3 instruction-injection items (sw, en, de: "ignore your rules..."), 3 items with no theme, 7 items with two themes |
| License | Team-authored, may be reused inside the project |
| Relation to Nat's eval | **Independent.** This is a dev set used to build the harness and tune prompts. It must not be used as, or mixed into, Nat's held-out set (`eval/`), which stays unseen by this lane |

## What it does not cover

- **Native Swahili.** Every Swahili sentence was written by a non-native model and is listed as UNREVIEWED in
  `contrib/max/language-review.csv`. Results on the Swahili subset measure the model on *plausible* Swahili, not on
  how visitors, guides or Noor actually write or speak.
- Sheng, code-switching beyond one item, spelling mistakes, SMS abbreviations, voice-transcript errors (Whisper output).
- Kikuyu, and any language other than sw/en/de/fr.
- Long reviews (all items are 1-2 sentences), sarcasm, reviews that mix several visits.
- Real label disagreement: one annotator, no inter-annotator agreement measured. Some theme boundaries are judgment
  calls (a roasting demo is `farm_walk`, not `coffee`; a long wait before the tour is `timing`).
- Real distribution of themes: the balance here is chosen for testing, not observed.

## Other data used in this lane

None yet. Candidate public sets for later experiments, with their licenses as stated by their hosts (verify before use):
MASSIVE sw-KE (CC-BY-4.0, intent utterances, not feedback), FLORES-200 (CC-BY-SA-4.0, translation benchmark sentences,
not tourism), Common Voice Swahili (CC0, read speech, not rural accented spontaneous speech).
