# Three-condition evaluation r0: keyword baseline (Max's deterministic tagger, PR #19 @ cab5b36)

Corpus: `eval/feedback` (dev 36 messages, held-out 36 private), labels **DRAFT_UNREVIEWED**, so every number here is provisional until Nat's review. Local model: **not run yet**; manual reading: see r1 below.

## Held-out comparison so far (r1, 2026-10-04 00:10 UTC)

| Condition | Findings correct | UNSUPPORTED | Missed | Contradiction recognized | Evidence precision | Owner time |
|---|---|---|---|---|---|---|
| **Manual reading (Nat), blind** | **6/6** | 1 | 0 | 1/1 | not measured (no ids given) | not measured (not timed) |
| Keyword baseline (Max tagger cab5b36), true language given | 0/6 | 0 | 6 | - | - | - |
| Keyword baseline, no language given | 0/6 | 0 | 6 | - | - | - |
| Local model (Qwen3) | not run | | | | | |

**What it says, on this small synthetic set:**

- **Manual reading finds every reference finding.** It also states one point with too little support: the 3-visitor
  rule was not applied on one theme. The comment behind that point is the prompt-injection message.
- **The keyword tagger never overclaims, but finds none of the held-out findings.** So far the AI pipeline does not
  add value over reading the messages; it only adds safety, and only by staying silent.
- **"Saves Noor time" stays UNMEASURED.** The manual reading was not timed.

**Caveats:**

- Held-out labels were reviewed by Nat on 2026-10-04 (accepted, no change), **after** his blind manual reading. Reviewer and manual reader are the same person. The Swahili still needs a native reader, and the dev labels are still DRAFT.
- Nat, the manual reader, also designed the task.
- There are only 6 reference findings.

## Keyword baseline detail (r0)

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
