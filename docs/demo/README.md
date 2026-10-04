# Sauti Host web demo

`index.html` is a single self-contained page: an iPhone mock-up of the app (palette and tabs from `apps/mobile`) that
runs Sauti's own code in the browser on the app's 10 SYNTHETIC demo reviews.

- **Runs, unchanged:** `packages/core` (compiled), Max's rule tagger and language check (`contrib/max`), and the
  Swahili/English copy (`packages/experience`), bundled with esbuild from main @ `2d510df`. SHA-256 comes from
  @noble/hashes 1.8.0, the same library as the app.
- **What it shows:**
  - findings with exact quotes, counted only from 3+ distinct comments;
  - "not enough feedback" and the refusal of unsupported languages;
  - a Swahili decision card;
  - PIN approval bound to the exact message's digest;
  - an offline queue that survives a reload ("force-close");
  - an approval voided when one word changes.
- **Only in the iPhone app:**
  - Gemma 4 E2B translating reviews into Swahili on the phone;
  - the encrypted SQLCipher store;
  - the real Sauti PIN (the demo PIN is 2580).
  Every reply is SIMULATED: no real person is contacted.
- **Checked:** the page's findings equal Nat's independent oracle on the demo reviews (coffee +8, directions −5,
  host +4; food 2 and booking 1 "not enough feedback"). See `contrib/nat/submission-evidence.md`.

Open it from any static host, for example
`https://rawcdn.githack.com/xamalow/HackNationColibri/<commit>/docs/demo/index.html`.
