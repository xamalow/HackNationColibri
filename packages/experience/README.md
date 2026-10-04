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
| `scripts/check.mjs` | Consistency gate, no dependencies |
| `audio/pending_clips.json` | Clips the hub's alert calls need that are not rendered yet (`PENDING_RENDER`); never counted as available, see below |
| `scripts/pending_clips.py` | Reads the pending clips and moves a `RECORDED` render into the manifest; unit-tested |

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
- a Swahili string claims a review that the sheet does not record with a reviewer id and date.

## Rules Mobile must keep

1. Business and transport states are two lines. Approved is never shown as sent; sent is never shown as delivered.
2. Approve exists only on `proposed`. The approval call carries the digest of exactly what was rendered; there is no second state machine in UI code.
3. The pending marker survives restart (read from the encrypted store on launch).
4. `simulated` channel ⇒ the SIMULATED banner on the card and in the preview.
5. Unreviewed Swahili ⇒ the "not yet checked by a Swahili speaker" tag under the body.

## Updating copy

Edit `copy/source.json`, then regenerate `en.json`, `sw.json` and the review sheet (the generator lives in the commit that introduced them). Never set a Swahili `review_status` by hand: the check only accepts it when the sheet has a signed `APPROVED` row.

## Pending clips (alert calls, not rendered yet)

The hub's owner-alert calls (`apps/hub/src/notify.mjs`, `NEEDED_CLIPS` / `MISSING_CLIPS`) speak 28 clips that have
no audio yet: `alert.*` (urgent, overbooked, visitor_message, voicemail, missed_call, see_sms), `platform.*` (gyg,
airbnb, booking, phone, sms), the people/count words (`word.tarehe`, `mtu`, `watu`, `nafasi`, `mmoja`, `wawili`,
`watatu`, `wanne`, `watano`, `wanane`) and the seven weekdays (`word.jumatatu` ... `word.jumapili`). They live in
`audio/pending_clips.json` with the hub's proposed text, `status: PENDING_RENDER`, `review_status: UNREVIEWED`,
`needs_native_review: true`, and no `file` / `wav_sha256` (nothing is faked).

- **Why not in `manifest.json` yet:** `apps/hub` (`notify.MANIFEST_KEYS`) and `apps/hub-voice` (`ClipLibrary`) count
  every key in the manifest groups `copy_clips` / `word_clips` / `alert_clips` / `clips` as available. A key listed
  there without audio would make the hub list a call the worker cannot play. Pending keys are in neither, so the hub
  keeps them in `MISSING_CLIPS` (call held, SMS sent) and the worker refuses them as `unknown_clip`.
- **Word clips** say the word after `word.` (lowercase, the manifest's word-clip rule, `text_sha256` of that word);
  `display_text` keeps the hub's capitalised weekday. `word.na` and `word.mia` are not here: they are already in the
  manifest, and the decision to drop their audio (`audio: false` in `audio/tts_overrides.json`, PR #29) stands.
- **Rendering:** the generator (`scripts/generate_audio.py`, PR #29, not on main yet) renders these when it iterates
  `pending_clips.jobs(...)` after the manifest clips and calls `pending_clips.promote(...)` per rendered entry (hook
  in the docstring of `scripts/pending_clips.py`). Until that hook is in the generator, a run does not touch them.
- **After a render** (`pending_clips.promote`): a `RECORDED` clip moves into `manifest.alert_clips` (keeping its
  `text`, the re-render source) or `manifest.word_clips`, with `file: audio/sw/<key>.wav` and its measurements; only
  then do the hub and the worker see it. A `SUSPECT` render stays pending (with `suspect_file` for a listener) and is
  retried on the next run.
- `check.mjs` fails if a pending key is also in the manifest, has a file or audio hash, digits, a text/hash mismatch,
  a word clip that does not say its key, or a review claim; and if an `alert_clips` entry is not `RECORDED` with its
  file.

```bash
python -m pytest -q packages/experience/scripts/test_pending_clips.py
```
