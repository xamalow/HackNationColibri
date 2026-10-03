#!/usr/bin/env node
// Score a language detector on the private held-out set, printing aggregates only (never the texts).
//
//   node eval/langid/score_detector.mjs <detector module exporting detectLanguage(text) -> {lang}> [heldout.jsonl]
//
// A label outside an item's `acceptable` list is WRONG. Any label that is not sw/en/de/fr is an
// abstention ("ask a person"). On non-target languages (Kikuyu, Kamba, Luo) any sw/en/de/fr label is
// a critical error: the text would be read and counted as a language it is not.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TARGETS = new Set(["sw", "en", "de", "fr"]);
const [detectorPath, heldoutArg] = process.argv.slice(2);
if (!detectorPath) {
  console.error("usage: score_detector.mjs <detector module> [heldout.jsonl]");
  process.exit(2);
}
const heldout = heldoutArg ?? resolve(dirname(fileURLToPath(import.meta.url)), "heldout", "langid_heldout.jsonl");
const { detectLanguage } = await import(pathToFileURL(resolve(detectorPath)).href);
const items = readFileSync(heldout, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const byCategory = {};
const wrongIds = [];
for (const item of items) {
  const out = detectLanguage(item.text);
  const label = TARGETS.has(out?.lang) ? out.lang : "unsure";
  const c = (byCategory[item.category] ??= { n: 0, correct: 0, abstained: 0, wrong: 0 });
  c.n += 1;
  if (!item.acceptable.includes(label)) {
    c.wrong += 1;
    wrongIds.push({ id: item.id, gold: item.gold_lang, got: label });
  } else if (label === "unsure" && !item.acceptable.every((a) => a === "unsure")) {
    c.abstained += 1;
  } else {
    c.correct += 1;
  }
}
const critical = wrongIds.filter((w) => w.id.startsWith("LID-") && ["ki", "kam", "luo"].includes(w.gold)).length;
process.stdout.write(JSON.stringify({ items: items.length, critical_non_target_errors: critical, by_category: byCategory, wrong: wrongIds }, null, 2) + "\n");
