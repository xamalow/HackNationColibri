// Writes test-vectors.json: every eval text with the reference decision, so a TS port of
// detect_language.mjs can be checked byte for byte (same franc version, same rule).
import { readFileSync, writeFileSync } from "node:fs";
import { detectLanguage, RULE } from "./detect_language.mjs";

const items = readFileSync(new URL("./langid_eval.jsonl", import.meta.url), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const vectors = items.map(({ id, lang, text }) => ({ id, gold: lang, text, expected: detectLanguage(text) }));
const inScope = vectors.filter((v) => ["sw", "en", "de", "fr"].includes(v.gold));
const summary = {
  wrong: inScope.filter((v) => v.expected.lang !== "unsure" && v.expected.lang !== v.gold).map((v) => v.id),
  answered: inScope.filter((v) => v.expected.lang !== "unsure").length,
  in_scope: inScope.length,
};
writeFileSync(new URL("./test-vectors.json", import.meta.url), JSON.stringify({
  synthetic: true, generator: "contrib/max/langid/make_test_vectors.mjs", franc: "6.2.0", rule: RULE, summary, vectors,
}, null, 2) + "\n");
console.log(summary);
