#!/usr/bin/env node
// Baseline comparison (Nat lane): the app's finding path vs a keyword template, per batch of feedback.
//
//   node contrib/nat/baseline/run_conditions.mjs <repo root> <messages.jsonl> <out dir>
//
// <messages.jsonl>: one {id, batch, text, lang?} per line (eval/feedback corpora, or the app's demo CSV converted
// by build_baseline.py). Writes <out>/app_tagger_core.json and <out>/template_baseline.json in the findings
// format eval/feedback/score_conditions.py reads, plus <out>/themes.json (per batch, per theme, what each
// condition would show).
//
// app_tagger_core = exactly apps/mobile/src/domain/w3.ts runW3: core ingestMessages -> Max's tagger
//   (contrib/max/tagger, the file the app vendors) -> core analyzeFeedback with the supported languages. A finding is
//   a theme the core states: verdict supported / supported_with_dissent, direction positive / negative.
// template_baseline = the SAME tagger labels with none of the core's rules (pre-registered in the room, #47814):
//   every label counts (duplicates and cross-posts too), no minimum, no quote check; every theme with >= 1 mention
//   gets "N mentions of THEME, mostly SENTIMENT" (majority, ties = mixed). Only positive / negative lines are
//   directional claims and are scored as findings; neutral / mixed lines are listed, not scored.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [root, messagesPath, outDir] = process.argv.slice(2);
if (!root || !messagesPath || !outDir) {
  console.error("usage: run_conditions.mjs <repo root> <messages.jsonl> <out dir>");
  process.exit(2);
}
const load = (p) => import(pathToFileURL(resolve(root, p)).href);
const core = await load("packages/core/dist/index.js");
const { tagFeedback } = await load("contrib/max/tagger/tag_feedback.mjs");

const SUPPORTED = new Set(["sw", "en", "de", "fr"]); // as in w3.ts
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const RECEIVED_AT = "2026-10-04T08:00:00Z";

const messages = readFileSync(messagesPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const batches = new Map();
for (const m of messages) {
  if (!batches.has(m.batch)) batches.set(m.batch, []);
  batches.get(m.batch).push(m);
}

const app = { condition: "app_tagger_core", batches: {} };
const template = { condition: "template_baseline", batches: {} };
const themes = {};

for (const [batch, items] of batches) {
  // ---- the app's path (runW3)
  const incoming = items.map((m) => ({
    id: m.id, source: "direct_review", external_id: m.id, received_at: RECEIVED_AT, text: m.text,
    ...(SUPPORTED.has(m.lang) ? { lang: m.lang } : {}),
  }));
  const ingested = core.ingestMessages(incoming, sha256);
  const tagged = tagFeedback([...ingested.sources.values()].map((s) => ({ id: s.source_id, text: s.text, lang: s.language })));
  const analysis = core.analyzeFeedback(tagged, ingested.sources, sha256, { supportedLanguages: SUPPORTED });
  const stated = analysis.themes.filter((t) => ["supported", "supported_with_dissent"].includes(t.verdict) && ["positive", "negative"].includes(t.direction));
  app.batches[batch] = { findings: stated.map((t) => ({ theme: t.theme, direction: t.direction, evidence_ids: t.supporting_source_ids })) };

  // ---- the template: same tagger, labels counted with no rules
  const raw = tagFeedback(items.map((m) => ({ id: m.id, text: m.text, ...(SUPPORTED.has(m.lang) ? { lang: m.lang } : {}) })));
  const per = new Map();
  for (const lb of raw.labels ?? []) {
    if (!per.has(lb.theme)) per.set(lb.theme, { mentions: 0, positive: 0, negative: 0, neutral: 0, ids: [] });
    const e = per.get(lb.theme);
    e.mentions += 1;
    e[lb.sentiment] = (e[lb.sentiment] ?? 0) + 1;
    e.ids.push(lb.message_id);
  }
  const lines = [];
  for (const [theme, e] of per) {
    const counts = [["positive", e.positive], ["negative", e.negative], ["neutral", e.neutral]].sort((a, b) => b[1] - a[1]);
    const majority = counts[0][1] === counts[1][1] ? "mixed" : counts[0][0];
    lines.push({ theme, mentions: e.mentions, majority, ids: e.ids, text: `${e.mentions} mention${e.mentions === 1 ? "" : "s"} of ${theme}, mostly ${majority}` });
  }
  template.batches[batch] = {
    findings: lines.filter((l) => l.majority === "positive" || l.majority === "negative").map((l) => ({ theme: l.theme, direction: l.majority, evidence_ids: l.ids })),
    lines: lines.map((l) => l.text),
  };

  // ---- what each condition shows, per theme (for the slide)
  themes[batch] = {
    app: analysis.themes.map((t) => ({
      theme: t.theme, verdict: t.verdict, direction: t.direction, note: t.note, comment_count: t.comment_count,
      supporting_ids: t.supporting_source_ids, dissenting_ids: t.dissenting_source_ids,
      quotes: (t.evidence ?? []).map((ev) => ({ id: ev.source_id ?? ev.message_id, quote: ev.quote })),
    })),
    app_ask_a_person: analysis.ask_a_person.map((a) => ({ reason: a.reason, about: a.about })),
    template: lines,
  };
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "app_tagger_core.json"), JSON.stringify(app, null, 2) + "\n");
writeFileSync(join(outDir, "template_baseline.json"), JSON.stringify(template, null, 2) + "\n");
writeFileSync(join(outDir, "themes.json"), JSON.stringify(themes, null, 2) + "\n");
console.log(`batches ${batches.size}, messages ${messages.length} -> ${outDir}`);
