# Labeled feedback corpus and three-condition evaluation (packet 07)

Lane: **Nat, independent evaluation**. Built by muller-claude for Nat.

**The question:** does the AI add value over simply reading the messages, and does it stay safe?

## Task

The task is the same for every condition and given verbatim to each.

> For each batch (one weekend of feedback for Noor), list the points Noor could act on: a theme from the list and a
> direction (positive or negative), with the ids of the messages that support it. State a point only when **at least
> 3 different visitors** support it.
>
> Do not count the same visitor twice (re-synced or cross-posted reviews). Ignore messages in languages you cannot
> check. Themes: coffee, farm_walk, food, host, directions, price, timing, booking, language, facilities, buy_coffee.

## Corpus

| Part | Where | In git | Size |
|---|---|---|---|
| dev | `dev-feedback.jsonl`, `dev-reading-view.md` | yes | 3 batches (A–C), 36 messages |
| held-out | `heldout/heldout-feedback.jsonl` (this is packet 07's `eval/heldout-feedback.jsonl`), `heldout/heldout-reading-view.md` | **no** | 3 batches (D–F), 36 messages; SHA-256 in `heldout_manifest.json` |

**Each message** has:

- its source, language and text;
- reference labels: theme, sentiment and exact quote with a UTF-8 byte span;
- whether its language is supported;
- `duplicate_of` for re-syncs and cross-posts;
- the phenomena it exercises;
- provenance.

**Reference findings** per batch are computed by code from the labels (`corpus_kit.reference_findings`), with the
same rules as `eval/w3` and Domain's core. So the labels are the only human judgement.

**Phenomena covered** (packet 07): mixed languages and code-switching, re-synced and cross-posted duplicates,
contradictory preferences, weak evidence, prompt injection, missing dates and prices, a strongly worded single
outlier, unsupported languages (Kikuyu, Luo, Kamba), sarcasm, negation, the same words from two different visitors.

**Label status: `DRAFT_UNREVIEWED`.** Packet 07 requires every reference label to be reviewed independently, and the
Swahili by a competent native reader.

- **Until then**, every score here is provisional.
- **Nat's review:** go through `dev-feedback.jsonl` and the held-out file. Change a label where you disagree, then
  set `label_status` to `REVIEWED_BY_NAT`. Mark Swahili items that still need a native reader.

## Conditions

| Condition | How it runs | Command |
|---|---|---|
| **Manual reading** | Nat reads `*-reading-view.md` (messages only, no labels), writes findings, and times each batch | fill `manual-template.json`, then `score_conditions.py` |
| **Keyword baseline** | Max's deterministic tagger (PR #19) → labels → findings by code | `make_labels_condition.py ... -- node contrib/max/tagger/cli.mjs`, then `score_conditions.py` |
| **Local model** | Qwen3 behind the same tagger interface (stdin `{id, text, lang?}`, stdout labels) | same as the keyword baseline, with the model's CLI |

```
python eval/feedback/make_labels_condition.py --corpus dev --name keyword --out k.json -- node <cli.mjs>
python eval/feedback/score_conditions.py k.json --corpus dev
```

**Measured:**

- **Unsupported findings** (critical): a point stated without 3 real supporting comments.
- **Missed findings.**
- **Evidence precision:** the share of cited messages that really support the point.
- **Evidence recall** on correct findings.
- **Time:** seconds per batch, manual condition only.
- **Label-level agreement** for tagger conditions: theme P/R/F1, sentiment, exact quotes, labels on unsupported
  languages.

**Not measured here:** usefulness and clarity of the card for Noor. That needs the app and an owner-side test.

## Manual reading protocol (Nat)

Do the **held-out** manual reading **before** opening `heldout-feedback.jsonl` or reviewing held-out labels. Your
answers must not be shaped by the reference.

1. Copy `manual-template.json` to a private file.
2. Open `heldout/heldout-reading-view.md` and start a timer for batch D.
3. Read the batch and write the findings: theme, direction and evidence ids. Stop the timer and enter the seconds.
4. Repeat for batches E and F.
5. Run `python eval/feedback/score_conditions.py <your file> --corpus heldout`.

The dev batches (A–C) can be used as practice; they do not count.

## Limitations

- **Synthetic and small.** All messages are synthetic and written by one AI helper: 72 messages, 18 reference
  findings. Enough to compare conditions on clear cases, not to estimate rates.
- **Approximate languages.** Swahili, Sheng, Luo and Kamba lines are approximate and unreviewed.
- **Reviewer overlap.** If Nat both reviews the labels and does the manual reading, the manual condition is scored
  against labels Nat shaped. A second reviewer is better.
- **Desktop only.** Times and tagger runs are desktop measurements, not phone measurements.
