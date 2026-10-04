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
