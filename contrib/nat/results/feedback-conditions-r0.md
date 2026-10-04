# Three-condition evaluation r0: keyword baseline (Max's deterministic tagger, PR #19 @ cab5b36)

Corpus: `eval/feedback` (dev 36 messages, held-out 36 private), labels **DRAFT_UNREVIEWED**, so every number here is provisional until Nat's review. Manual reading and local model: **not run yet**.

| Corpus | Tagger input | Findings correct | UNSUPPORTED | Missed | Evidence precision | Label F1 (P / R) | Sentiment acc. | Exact quotes |
|---|---|---|---|---|---|---|---|---|
| dev | no language given (detector decides) | 1/6 | 0 | 5 | 1.0 | 0.783 (0.9 / 0.692) | 0.704 | 30/30 |
| dev | true language given (upper bound) | 1/6 | 0 | 5 | 1.0 | 0.88 (0.917 / 0.846) | 0.697 | 36/36 |
| heldout | no language given (detector decides) | 0/6 | 0 | 6 | None | 0.691 (0.792 / 0.613) | 0.632 | 24/24 |
| heldout | true language given (upper bound) | 0/6 | 0 | 6 | None | 0.781 (0.758 / 0.806) | 0.56 | 33/33 |

**Reading:**

- **Safe but nearly useless at the finding level.** The tagger never states a point without support (0 unsupported findings, every quote exact, no labels on unsupported languages), but it recovers only 1 of 12 reference findings.
- **Label F1 overstates usefulness.** 0.78-0.88 label F1 becomes 1/6 findings, because a finding needs 3 comments on the same side and each missed label or wrong sentiment drops a theme below the threshold.
- **Where it fails (dev, inspectable):** implicit complaints labeled neutral ('the matatu driver doesn't know your farm', 'A bit pricey', 'asked if they could buy coffee'); paraphrased themes missed ('Noor explained every step' is not tagged host; German 'kaum gefunden' is not tagged directions).
- **Without a declared language** the detector refuses more messages (7 of 36 dev, 10 of 36 held-out excluded), which lowers recall further: short and Swahili messages go to a person.

**Next:** Nat's manual reading on the held-out (blind, timed) and the local model behind the same interface. Only then can the question 'does the AI add value' be answered.
