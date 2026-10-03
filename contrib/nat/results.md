# Nat: evaluation results

Owner: Nat (independent evaluation and failure fixtures, packet 07). Prepared by muller-claude, Nat's helper.

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
