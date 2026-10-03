// Calibrate the language detector on FLORES-200 *dev* (CC-BY-SA 4.0). Never devtest: Nat's private
// held-out set (eval/langid) is drawn from devtest, so dev keeps the two disjoint.
//
//   node contrib/max/langid/calibrate_flores_dev.mjs <path to flores200_dataset/dev> [maxLines]
//
// For each language: share labeled sw/en/de/fr (target) or refused ("und"), on full sentences and on their
// first 5 words. For non-target languages any sw/en/de/fr label is a critical error. Data is not committed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectLanguage } from "./detect_language.mjs";

const [dir, maxArg] = process.argv.slice(2);
if (!dir) {
  console.error("usage: calibrate_flores_dev.mjs <flores200_dataset/dev> [maxLines]");
  process.exit(2);
}
const MAX = Number(maxArg ?? 997);
const TARGET = { swh_Latn: "sw", eng_Latn: "en", deu_Latn: "de", fra_Latn: "fr" };
const NON_TARGET = ["kam_Latn", "kik_Latn", "luo_Latn", "som_Latn", "lug_Latn", "kin_Latn", "run_Latn", "nya_Latn"];

function run(code, cut) {
  const lines = readFileSync(join(dir, `${code}.dev`), "utf8").split("\n").filter(Boolean).slice(0, MAX);
  const counts = {};
  for (const line of lines) {
    const text = cut ? line.split(/\s+/).slice(0, 5).join(" ") : line;
    const { lang } = detectLanguage(text);
    counts[lang] = (counts[lang] ?? 0) + 1;
  }
  return { n: lines.length, counts };
}

const report = { source: "FLORES-200 dev (CC-BY-SA 4.0)", lines_per_language: MAX, target: {}, non_target: {} };
for (const [code, lang] of Object.entries(TARGET)) {
  for (const cut of [false, true]) {
    const { n, counts } = run(code, cut);
    report.target[`${code}${cut ? "/5w" : ""}`] = {
      correct: +((counts[lang] ?? 0) / n).toFixed(3), refused: +((counts.und ?? 0) / n).toFixed(3),
      wrong: +((n - (counts[lang] ?? 0) - (counts.und ?? 0)) / n).toFixed(3),
    };
  }
}
for (const code of NON_TARGET) {
  for (const cut of [false, true]) {
    const { n, counts } = run(code, cut);
    const critical = ["sw", "en", "de", "fr"].reduce((s, l) => s + (counts[l] ?? 0), 0);
    report.non_target[`${code}${cut ? "/5w" : ""}`] = {
      critical: +(critical / n).toFixed(3),
      labeled_as: Object.fromEntries(["sw", "en", "de", "fr"].filter((l) => counts[l]).map((l) => [l, counts[l]])),
    };
  }
}
console.log(JSON.stringify(report, null, 1));
