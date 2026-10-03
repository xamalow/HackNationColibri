// Writes test-vectors.json: tagger output for every message of Nat's public W3 dev fixtures and this lane's
// dev set, so a TS port inside packages/core can be checked label for label.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tagFeedback } from "./tag_feedback.mjs";

const root = new URL("../../../", import.meta.url);
const msgs = [];
for (const f of readdirSync(new URL("eval/w3/fixtures/dev/", root)).sort()) {
  const fx = JSON.parse(readFileSync(new URL(`eval/w3/fixtures/dev/${f}`, root), "utf8"));
  for (const m of fx.input.messages) msgs.push({ id: `${fx.fixture_id}/${m.id}`, text: m.text, lang: fx.gold.lang[m.id] });
}
for (const l of readFileSync(new URL("../devset/feedback_dev.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean)) {
  const it = JSON.parse(l);
  msgs.push({ id: it.id, text: it.text, lang: it.lang });
}
const out = tagFeedback(msgs);
writeFileSync(new URL("./test-vectors.json", import.meta.url), JSON.stringify({ synthetic: true, generator: "contrib/max/tagger/make_test_vectors.mjs", inputs: msgs, expected: out }, null, 2) + "\n");
console.log({ messages: msgs.length, labels: out.labels.length, untagged: out.untagged.length });
