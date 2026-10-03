# W3 evaluation fixtures: feedback → grounded decision

Lane: **Nat, independent evaluation and failure fixtures** (addendum r1.0). Built by muller-claude for Nat.
Scope: W3 steps 1–6 (collect, tag, count, decision card, Noor's choice, farm sheet change → W5). Step 6 was
validated by Nat on 2026-10-03.

These fixtures say what **any** implementation must do, without depending on how it is built. Claude Domain's
core (or any prototype) runs against them through a small adapter. Every rule below is **PROPOSED** until
Domain and Carther agree on it; then the fixture's `expectation_status` becomes `AGREED`.

## Layout

| Path | In git | What |
|---|---|---|
| `fixtures/dev/W3-DEV-*.json` | yes | 37 shared fixtures, built by `build_dev_fixtures.py` |
| `heldout/` | **no** | 13 private fixtures + their builder, git-ignored, kept by Nat |
| `heldout_manifest.json` | yes | SHA-256 of each held-out file, proves they were not edited after results |
| `run_fixtures.py` | yes | `lint` the fixtures, `run` an implementation against them |
| `reference_rules.py` | yes | A second reading of the step 1–3 rules, used only by `lint`. Not product code |
| `fixture_kit.py` | yes | Helpers that place quotes and compute UTF-8 offsets |

## Run

```bash
python eval/w3/build_dev_fixtures.py --check        # JSON matches its builder
python eval/w3/run_fixtures.py lint                 # structure, offsets, manifest, expectations
python eval/w3/run_fixtures.py run --impl oracle    # self-check (steps 1-3 only)
python eval/w3/run_fixtures.py run --set dev --report out.json --impl node packages/core/dist/w3-adapter.js
python -m pytest tests/test_eval_w3.py
```

`--impl` takes the adapter command and its arguments and must come last. `--set heldout` and `--set all` only work
on a machine that has the held-out files.

## Adapter contract

For each fixture, the runner starts the adapter, writes `{"fixture_id": ..., "input": {...}}` to its stdin and reads
one JSON outcome from its stdout (timeout 60 s, exit code 0). The adapter never receives `gold` or `expected`.

**Input** (`input`):

- `messages[]`: `id`, `source`, `external_id`, `received_at` (ISO 8601 UTC), `text`, and optionally `author` and
  `lang`. `lang` is what the source declares, often nothing, and is not proof of the language.
- `model_output`: either `{"status": "ok", "labels": [...]}` or `{"status": "malformed", "raw": "..."}`. This is a
  **simulated** tagger output, adversarial on purpose. Each label has `message_id`, `theme`, `sentiment`, `quote`,
  `start` and `end`. Offsets are **UTF-8 bytes** into the original message text, end exclusive.
- `owner_facts` (optional): the farm sheet.
- `owner_inputs` (optional, steps 4–6), in order:
  - `{"type": "show_cards"}`
  - `{"type": "owner_says", "card_theme", "transcript", "asr_uncertain"?}`
  - `{"type": "new_messages", "messages", "labels"}`
  - step 6: `{"type": "owner_dictates", "card_theme", "transcript"}` (Noor says the new value)
  - step 6: `{"type": "owner_confirms_change", "card_theme", "transcript"}` (her answer to the read-back of that
    exact change)
  - step 6: `{"type": "facts_changed", "owner_facts", "source"}` (the farm sheet changed elsewhere, e.g. W1)
  - step 6: `{"type": "crash_and_restart", "at"}`

**Outcome**: report every key you implement. Only keys present in a fixture's `expected` are compared.

```json
{
  "ingest": {"duplicates": ["m2"], "rejected": [{"message_id": "m1", "reason": "invalid_message"}]},
  "accepted_labels": [{"message_id": "m1", "theme": "directions"}],
  "rejected_labels": [{"message_id": "m9", "theme": "food", "reason": "unknown_source"}],
  "counts": {"directions": {"unique_messages": 3, "positive": 0, "negative": 3, "neutral": 0}},
  "findings": [{"theme": "directions", "status": "enough_evidence", "sentiment": "negative",
                "evidence_message_ids": ["m1", "m2", "m3"]}],
  "ask_a_person": [{"reason": "unsupported_language", "message_ids": ["m4"]}],
  "cards": [{"theme": "directions", "text": "...", "quotes": [{"message_id": "m1", "quote": "...", "start": 0, "end": 10}],
             "choices": ["try", "reject", "ask_someone"], "prospective": true}],
  "decisions": [{"theme": "directions", "choice": "try"}],
  "fact_change_proposals": [{"theme": "price", "field": "price_per_person_kes", "value": 1500}],
  "facts_after": {"price_per_person_kes": 1500, "...": "the full farm sheet after the scenario"},
  "listing_proposals": [{"channel": "google_business", "field": "price_per_person_kes", "published": false}],
  "side_effects": {"facts_changed": false, "approvals_created": 0, "outbox_entries": 0}
}
```

An implementation may list keys it does not do yet in `"not_implemented"`. They are reported as not checked. A
fixture is `PASS` only when everything it expects was checked; otherwise it is `PARTIAL` or `NOT_COVERED`, never a
pass.

Lists are compared as sets. `side_effects.facts_changed` means the W3 flow itself wrote a new farm sheet version; a change
made elsewhere (a `facts_changed` input, e.g. W1) does not count. `facts_after` is the full farm sheet at the end.
Listing drafts are checked as properties: count within bounds, approved field only, one per channel,
`published: false`. `sentiment` and `evidence_message_ids` are compared only for `enough_evidence`.
Cards are checked as properties, because their wording is free:

- Only themes with enough evidence get a card.
- Quotes are the exact bytes at their offsets.
- Cited messages are validated evidence for that theme.
- The choices are exactly try / reject / ask_someone.
- The card is marked prospective.
- Every number in the text, in digits or Swahili words, appears in the owner facts, the theme's counts or the
  quoted messages.

## Rules (PROPOSED)

| Rule | Value | Source |
|---|---|---|
| Sources | direct_review, google_review, getyourguide_review, tourist_message, noor_note, guide_note | CLAUDE.md W3 step 1 |
| Supported languages | en, sw, de, fr; anything else goes to a person | CLAUDE.md §1, §13 |
| Themes | coffee, farm_walk, food, host, directions, price, timing, booking, language, facilities, buy_coffee | proposed |
| Sentiments | positive, negative, neutral | proposed |
| Duplicate import | same `source` + `external_id`: first copy kept, the rest reported in `ingest.duplicates` | packet 04, test 3 |
| Count unit | unique messages, not labels. A cross-post (same author and text, after case and space folding) counts once | packet 04 |
| Finding | ≥ 3 unique messages on one side (positive or negative) | CLAUDE.md W3 fail-safe |
| Contradiction | ≥ 2 positive **and** ≥ 2 negative: status `contradictory`, ask a person | packet 04 |
| Side effects | steps 1–5 never change a fact, create an approval or fill the outbox | CLAUDE.md §3, §6 |
| Choice | only an explicit, confident try / reject / ask_someone on the card currently shown is recorded | packet 05 |
| Step 6 field | directions → `directions_sw`, price → `price_per_person_kes`, timing → `hours`, food → `inclusions_sw`; any other theme has no field and goes to a person | validated by Nat |
| Step 6 value | only from Noor's own dictation, parsed by code; never from a review or the model | CLAUDE.md §3 |
| Step 6 apply | only after her explicit yes to the read-back of that exact change, on the current farm sheet; a fact change in between voids it | CLAUDE.md §7, packet 04 test 1 |
| Step 6 → W5 | an applied change creates listing drafts, at most one per channel, none published; fact and drafts are written together or not at all | CLAUDE.md W5, packet 04 test 2 |

Label rejection reasons, checked in this order. They are Claude Domain's strings, in Domain's order
(`packages/core/src/evidence.ts` @ 885c0b4), except the first and the fourth, which cover layers the core does not
have:

1. `malformed_label`
2. `theme_not_allowed`
3. `sentiment_not_allowed`
4. `duplicate_message`
5. `unknown_source`
6. `unsupported_language`
7. `span_out_of_range`
8. `span_not_on_char_boundary`
9. `quote_mismatch`

`ask_a_person` reasons: `unsupported_language`, `structured_output_failure`, `contradictory_reviews`.
Finding statuses: `enough_evidence`, `not_enough_feedback`, `contradictory`.

## Coverage (dev set)

| W3 step | Fixtures |
|---|---|
| 1 Collect | 001, 003, 004, 011, 013, 014 |
| 2 Tag and validate | 001, 005–011, 013, 024, 025 |
| 3 Count | 001–008, 011–013, 015, 016, 024–028 |
| 4 Decision card | 016 |
| 5 Noor's choice | 017–023 |
| 6 Farm sheet change → W5 | 029–037 |

Domain packet tests:

- **Test 3** (duplicates, nonexistent ID, altered quote): fixtures 003–007, 015, 024 and 025.
- **Test 4** (malicious review instructions): fixtures 013 and 020.
- **Tests 1, 2, 5–8** (approval binding, crash boundary, dates and currency, send_unknown, two devices, clock): not
  part of W3 steps 1–5, so not covered yet.

Several fixtures are built to **bite**. A naive implementation fails them, and `tests/test_eval_w3.py` proves it:

- 003, 004, 005, 006, 011 and 015 catch one that counts labels, trusts every label, or skips dedup and language
  checks.
- 008 catches code-point or UTF-16 offsets instead of UTF-8.
- 026–028 cover weak evidence and a strongly worded single outlier (packet 07).

Results against Domain's core are in [contrib/nat/results.md](../../contrib/nat/results.md).

## Held-out set

The repo is public, so the held-out fixtures never enter git. To use them:

- **Run them** only after an implementation is frozen for evaluation, on Nat's machine, and publish the report.
- **Do not describe** the scenarios in the room before then.
- **Verify** them: `lint` checks every held-out file against `heldout_manifest.json`.
- **Back them up** privately (Nat), because they exist only on this machine.

## Open decisions (Domain + Carther)

1. **Count unit.** The packet says unique messages, so one visitor writing three messages counts 3. The fail-safe
   reading would count people. Which one?
2. **Cross-posts** (004): is same author and same text on two platforms one message?
3. **Notes** dictated by Noor or the guide (005, 006): do they count as feedback items?
4. **Contradiction threshold**: is ≥ 2 on each side right?
5. **Quotes and offsets**: do quotes cite the original message (not a translation), in UTF-8 bytes?
6. **Theme list**: are the 11 themes the contract, or does Domain publish its own?
7. **Choice words**: `jaribu` / `kataa` / `uliza mtu` are unreviewed Swahili. Should "ndiyo" alone (017) be refused?
8. **Stale card** (019): new evidence after a card was shown voids the pending choice. Agreed?

## Limitations

- **Synthetic content.** All content is hand-written by an AI helper, not real reviews, and every fixture is marked
  `synthetic`.
- **Unreviewed languages.** Swahili, German and French are unreviewed (`language_review`). The Kikuyu text is
  approximate and was written without a speaker.
- **Code layer only.** The model outputs are simulated, so these fixtures test what code does with them. Whether a
  quote really **supports** its label (the semantic check the Domain packet asks for) needs a labeled evaluation
  set. That set is not built yet.
- **Same author.** `reference_rules.py` and the expectations were written by the same author. The lint catches slips
  between them, not a shared misunderstanding; Domain disagreeing is the real independent check.
- **Card format.** Steps 4–5 are checked as properties and decisions until Domain publishes the card and approval
  contract.
