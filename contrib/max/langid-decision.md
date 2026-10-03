# Language ID decision r0: sources with no declared language (Max lane)

Status: **MEASURED on DESKTOP** (Node 24, laptop), 2026-10-03, run `results/langid-desktop-20261003T2258Z.json`.
Asked by Nat's lane (muller-claude, room #47461): tourist SMS, direct reviews and Noor/guide notes declare no
language, so the core rejects them as `unsupported_language` (17 strict-run failures). fastText LID is excluded
(CC-BY-NC-4.0, see data/model-manifest.json).

## Decision

Use **franc 6.2.0** (MIT, pure JS, ~290 KB with its trigram data, no model file, no network), restricted to
`swh/eng/deu/fra`, with three refusal rules. Reference: [langid/detect_language.mjs](langid/detect_language.mjs).

| Rule | Value | Why |
|---|---|---|
| Fewer than 4 words | `unsure` (reason `too_short`) | every franc error on in-scope text was a 1-3 word message ("How much?" -> de, "Tolle Tour!" -> fr) |
| Top score below 0.5 | `unsure` (`low_confidence`) | |
| Top minus second score below 0.2 | `unsure` (`low_confidence`) | separates close calls (e.g. Kikuyu, 0.194) |

`unsure` must map to the core's existing fail-safe: `unsupported_language` -> ask a person. It is never a guess.

## Numbers (80 synthetic texts: 74 in sw/en/de/fr, 6 out of scope)

| Strategy | Wrong (of 74) | Answered | Out of scope -> unsure | Size | License |
|---|---|---|---|---|---|
| **franc + rules above (recommended)** | **0** | **68%** (50/74) | 4/6 | ~290 KB | MIT |
| franc, score/margin rules only | 2 | 80% | 4/6 | ~290 KB | MIT |
| franc, always answer | 8 | 100% | 1/6 | ~290 KB | MIT |
| eld/small, score >= 0.5, margin >= 0.1 | 1 | 66% | 5/6 | ~1.6 MB | Apache-2.0 |
| tinyld, score >= 0.5, margin >= 0.1 | 1 | 49% | 6/6 | ~12 MB | MIT |
| franc and eld must agree | 0 | 46% | 6/6 | ~1.9 MB | MIT + Apache-2.0 |

By length, recommended rule: 9+ words 26/29 answered, 4-8 words 24/30 answered, 1-3 words 0/15 answered (by design),
0 wrong in every bucket. Speed: ~0.03-0.06 ms per text on desktop, negligible on a phone.

## Known gaps

- **Code-switching** ("Thanks Mama Noor, kahawa ilikuwa poa sana!") is labeled `sw`, not `unsure`. Acceptable
  for feedback (Noor reads Swahili); for choosing a *reply* language to a tourist it is not, so a reply flow
  should confirm the language or reply in the language of the platform/thread.
- **Kikuyu** came out `unsure` only by a hair (margin 0.194 vs 0.2). Kikuyu text with fewer diacritics may be
  labeled `sw`. Kikuyu is out of scope for the first release; treat any Kikuyu source as ask-a-person by hand.
- **Short messages are never auto-labeled** (32% of the in-scope set is `unsure`, mostly short SMS). Platform
  metadata (GetYourGuide/Airbnb language fields, phone country code as a hint only) should fill the language
  before this detector is called.
- Synthetic, non-native Swahili and one Kikuyu line, all UNREVIEWED; n=80. Re-run on Nat's held-out set and on
  real messages before trusting the coverage number.

## For Domain (port)

`langid/test-vectors.json` lists all 80 texts with the reference output `{lang, score, margin, reason}` from
franc 6.2.0. A TS port inside packages/core (or Mobile's import layer) must reproduce every `expected.lang` and
`reason`. franc is ESM-only; it runs in React Native/Hermes without native modules.
