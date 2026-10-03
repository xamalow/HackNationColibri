# Nat: evaluation results

Owner: Nat (independent evaluation and failure fixtures, packet 07). Prepared by muller-claude, Nat's helper.

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
