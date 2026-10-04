# Translation decision r0: how Noor reads everything tourists write (Max lane)

Goal (Max): Noor gets **all** the information tourists send (bookings and schedules, questions, feedback,
recommendations) in Swahili, offline, MIT/Apache only, on the iPhone. Status: **MEASURED on DESKTOP**,
2026-10-04, FLORES-200 dev (formal text, not reviews), `results/translation-*.json`.

## Plan (after asking the room; claude-warden's answer folded in)

| Layer | What Noor sees | How | Risk control |
|---|---|---|---|
| **A. Structured facts** (backbone) | Date, party size, price asked, booking state, question type, theme counts with exact quotes, in Swahili | Code: deterministic parsers (`sauti/lang/extract.py` on the W2 branch), fixed Swahili templates, the tagger (#19) | No model output; numbers come from the original |
| **B. Full free-text translation** (gated) | The whole message in Swahili, labeled *"Tafsiri ya mashine, inaweza kuwa na makosa"* (machine translation, may contain errors), next to the original | **Opus-MT** (Helsinki-NLP, Apache-2.0): en->sw direct, de/fr->en->sw pivot | Number guard (below); never used for counts, cards or actions |
| **C. Replies to tourists** | Noor approves; the text goes out in the tourist's language | Fixed templates per language (W2), no sw->de/fr translation | No outbound MT at all |
| **D. Fallback** | The original plus "muulize mwongozo" (ask the guide) | When B is blocked or the language is `und` | A person reads it |

## Measurements (100 sentences per direction, CPU, 4 threads)

| Translator | en->sw chrF | de->sw | fr->sw | Speed per sentence | Size | License |
|---|---|---|---|---|---|---|
| Qwen3 0.6B (prompted, on device already) | 15.7 | 14.4 | 16.2 | ~2.5 s | 640 MB | Apache-2.0 |
| **Opus-MT, CTranslate2 int8** | **63.2** | **57.5** (pivot) | **56.4** (pivot) | 0.16-0.48 s | ~370 MB for 3 models | Apache-2.0 |

chrF is the standard character-overlap score for translation (0-100). A usable Swahili system is roughly 50+;
Qwen3 0.6B is not usable (it also invented numbers in 9/150 outputs). The Qwen3 1.7B and MADLAD-400 runs are
requested from teammates; MADLAD-400 3B is ~11.7 GB fp32, likely too large for the phone.

**Number guard** (`translation_eval.py::number_guard`): a translation is shown only if it states exactly the
source's numbers (thousands separators normalised). Raw Opus-MT changed or invented a number in 4-6% of sentences
("1,200" -> "1", "35" -> "3525"; Swahili clock time 08:46 -> "saa 2:46" is correct but also blocked).
With the guard: **0 translations shown with a wrong number**; 10-15 of 100 FLORES sentences (news, number-heavy)
fall back to layer D.

## On tourist-style text (31 synthetic reviews and messages, `results/translation-samples-opus-mt.jsonl`)

29 shown, 2 blocked by the number guard (one was a hallucinated German booking request). Most outputs read
correctly to a non-native eye, but there are **meaning errors the guard cannot see**:

- **Systematic: "booking / reservation" -> *kitabu* (a book).** "our booking request" became "our request to
  write a book". This is why layer A must show booking intent, date and party size from code, *above* the
  translation, so Noor never relies on the translation for them.
- "we almost cancelled" -> "we almost got lost"; "leider" (unfortunately) -> "I feared"; "samedi 10 octobre"
  lost the month; a two-sentence review lost its second sentence.

So the label *machine translation, may contain errors* and the original side by side are required, not optional.
All 31 outputs are in `language-review.csv` (UNREVIEWED) for a native reviewer.

## For Mobile and Platform (iPhone runtime)

CTranslate2 has no iOS/React Native binding. Path: **ONNX Runtime React Native** (`onnxruntime-react-native`,
MIT). ONNX exports exist for de->en and fr->en (Xenova/opus-mt-de-en, Xenova/opus-mt-fr-en, int8 ~174-190 MB
decoder each); **en->sw has no public ONNX export**, so Platform exports it once from Helsinki-NLP/opus-mt-en-sw
(Apache-2.0) with a recorded commit and hash. The CTranslate2 int8 files used for these measurements are
third-party conversions (hashes in data/model-manifest.json); the en->sw tokenizer files match Helsinki-NLP's.

## Gaps

- FLORES is formal news text; reviews are shorter and informal. Re-measure on Nat's held-out reviews.
- The de/fr pivot through English drops details (one German test lost "badly signposted").
- Swahili output not reviewed by a native speaker.
- Phone speed/memory unmeasured (Mobile).
