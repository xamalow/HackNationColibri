# packages/experience

Owner: Claude Experience (`cosme-claude`, for Cosme). Consumers: Codex Mobile (`apps/mobile`), Carther (demo).
Mobile implements the screens from these files. Experience never edits `apps/mobile`.

| Path | What it is |
|---|---|
| `interaction/states.json` | UI for every contract business and transport state (1:1 with `contracts/states.json`), plus screen states: offline, empty, working, uncertain, not enough feedback, conflicting, missing fact, owner unlock, clock suspect, stale render |
| `interaction/screens.json` | Today / Evidence / Outbox: card sections, action order, focus order, large-font rules, preview fields, approval flow |
| `copy/en.json`, `copy/sw.json` | Copy tokens. All Swahili is `UNREVIEWED` |
| `copy/source.json` | Single source for both locales: English intent + draft Swahili |
| `review/swahili-review-sheet.csv` | Sheet for a native reviewer: correction, fact/negation/date/price checks, reviewer id, date, status |
| `tokens/design.json` | iOS Dynamic Type text styles, spacing in pt, 44 pt targets (Apple HIG), tones (always icon + words, never color alone) |
| `assets/icons/*.svg` | 17 stroke icons, `currentColor`, 24×24 |
| `demo/DEMO_SCRIPT.md` | Video script draft; numbers are sourced facts or `[[MEASURED]]` slots |
| `audio/manifest.json` | One Swahili voice clip per fixed copy key + number/clock word clips; status, seed, CER and generator per clip |
| `audio/tts_overrides.json` | What a clip says when it must differ from the displayed copy (`tts_text`), or `audio: false` to drop it |
| `scripts/generate_audio.py` | Renders the clips with Chatterbox (MIT) on a laptop GPU; `audio_post.py` post-processing + CER, unit-tested |
| `scripts/check.mjs` | Consistency gate, no dependencies |

Target device: **iPhone** (Carter, 2026-10-03). See `screens.json` → `accessibility_ios` for VoiceOver and Dynamic Type; `owner_confirmation` for the Sauti PIN approval (Carter's decision; no Face ID).

## Check

```bash
node packages/experience/scripts/check.mjs
```

It fails if:
- a contract state has no UI mapping, or the UI maps a state the contract does not have;
- a referenced copy key or icon is missing, or an action has no VoiceOver hint;
- the two locales have different keys or placeholders;
- Swahili copy contains digits (the TTS reads letters; code renders numbers as words);
- a Swahili string claims a review that the sheet does not record with a reviewer id and date;
- an audio clip's text hash no longer matches the copy, or a clip's spoken text / `audio: false` disagrees with
  `audio/tts_overrides.json` (or an override has digits or claims a review).

## Rules Mobile must keep

1. Business and transport states are two lines. Approved is never shown as sent; sent is never shown as delivered.
2. Approve exists only on `proposed`. The approval call carries the digest of exactly what was rendered; there is no second state machine in UI code.
3. The pending marker survives restart (read from the encrypted store on launch).
4. `simulated` channel ⇒ the SIMULATED banner on the card and in the preview.
5. Unreviewed Swahili ⇒ the "not yet checked by a Swahili speaker" tag under the body.

## Audio clips (provenance)

Pre-made at build time, never on the device (Carter, 2026-10-03): Chatterbox multilingual (`chatterbox-tts`,
MIT, `ResembleAI/chatterbox`) with `language_id="sw"`, the built-in voice, and the model pinned by downloading
exactly `--revision` (only the five files `from_local` reads, ~3.2 GB instead of 13.9 GB). Each clip records
package version, model revision and files, seed, every candidate tried, the Whisper transcript and CER when
selected by CER, and `review_status: UNREVIEWED` until a native Swahili listener checks it.

```bash
python packages/experience/scripts/generate_audio.py --device cuda --revision <sha>   --seeds 2 --select-cer --whisper-model large-v3 --max-cer 0.35
python -m pytest -q packages/experience/scripts/test_audio_post.py
```

- `--seeds N` renders N candidates per clip (candidate 0 = the seed of earlier single-seed renders). With
  `--select-cer` and `faster_whisper` installed, each is transcribed (Swahili) and the lowest CER wins; otherwise,
  and on ties, an unflagged duration, then the duration closest to the text length. A clip whose best candidate
  still has a duration flag or CER > `--max-cer` is `SUSPECT`, never `RECORDED`.
- Measured by claude-warden (Whisper round trip, 133 clips): one seed ~83 good / 35 mid / 15 bad; best of 2
  seeds 102 / 27 / 4. The duration check only partly agrees with Whisper, which is why CER selection exists.
- **Spoken-text overrides** (`audio/tts_overrides.json`, all `UNREVIEWED`, `needs_native_review`):
  `channel.sms` says "es em es" (the screen still shows "SMS"); `voice.confirm` says "Je, ni sawa?" for the
  displayed "Ni sawa?" (same meaning, question marker added; a native speaker must confirm or delete it).
- **Dropped from audio** (`audio: false`, status `NO_AUDIO`): `word.na` and `word.mia` were bad in both seeds and
  have no safe respelling (no invented words such as "naa"). Code must never play them: any number that needs
  "na" or "mia" is shown as text, and in the call flow sent as SMS text. Fix: a native speaker records both words.
- **Unpinned fetch**: chatterbox's tokenizer downloads `Cangjie5_TC.json` from the repo's `main` branch,
  not pinned to the revision. It is Chinese-only data (Cangjie codes) and is not used for Swahili text.

## Updating copy

Edit `copy/source.json`, then regenerate `en.json`, `sw.json` and the review sheet (the generator lives in the commit that introduced them). Never set a Swahili `review_status` by hand: the check only accepts it when the sheet has a signed `APPROVED` row.
