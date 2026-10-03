#!/usr/bin/env node
// Adapter: runs Claude Domain's packages/core on one eval/w3 fixture (W3 steps 2-3).
//
//   python eval/w3/run_fixtures.py run --impl node contrib/nat/adapters/domain-core-w3.mjs <packages/core/dist>
//
// Translation only, no rule of its own. Reads {"fixture_id", "input"} on stdin, calls
// summarizeThemesReport and validateEvidenceItem (core API at claude-domain 885c0b4),
// prints the outcome (eval/w3/README.md). Whatever the core has no API for is declared
// in `not_implemented`, so it is reported as not covered, never as a pass.

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The fixtures' catalogue (eval/w3/README.md, PROPOSED) and supported languages, passed as core options.
const THEMES = ["coffee", "farm_walk", "food", "host", "directions", "price", "timing", "booking", "language",
  "facilities", "buy_coffee"];
const LANGUAGES = ["en", "sw", "de", "fr"];

const coreDist = process.argv[2];
if (!coreDist) {
  console.error("usage: domain-core-w3.mjs <path to packages/core/dist>");
  process.exit(2);
}
const core = await import(pathToFileURL(resolve(coreDist, "index.js")).href);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const options = { allowedThemes: new Set(THEMES), supportedLanguages: new Set(LANGUAGES) };

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { input } = JSON.parse(Buffer.concat(chunks).toString("utf8"));

// A source is identified by the platform's own id, so a re-synced review is the same source.
// Its language is only what the source declared: the core receives no detection from here.
const sourceIdOf = (m) => `${m.source}:${m.external_id}`;
const sources = new Map();
const messageIdOf = new Map(); // source_id -> first fixture message id with it
for (const m of input.messages) {
  const id = sourceIdOf(m);
  if (sources.has(id)) continue;
  const source = { source_id: id, text: m.text, content_hash: core.sourceTextHash(m.text, sha256) };
  if (m.lang) source.language = m.lang;
  sources.set(id, source);
  messageIdOf.set(id, m.id);
}
const messages = new Map(input.messages.map((m) => [m.id, m]));
const toMessageIds = (sourceIds) => [...new Set(sourceIds.map((id) => messageIdOf.get(id) ?? id))];

const labels = input.model_output.status === "ok" ? input.model_output.labels : [];
const tagged = labels.map((label) => {
  const m = messages.get(label.message_id);
  const sourceId = m ? sourceIdOf(m) : `missing:${label.message_id}`;
  const evidence = {
    source_id: sourceId,
    content_hash: m ? sources.get(sourceId).content_hash : "0".repeat(64),
    span: { start: label.start, end: label.end },
    quote: label.quote,
  };
  return { label, item: { theme: label.theme, sentiment: label.sentiment, evidence } };
});

const report = core.summarizeThemesReport(tagged.map((t) => t.item), sources, sha256, options);
const tagReason = new Map(report.rejected_tags.map((r) => [r.item, r.reason]));

const accepted = [];
const rejected = [];
const valid = [];
for (const t of tagged) {
  const reason = tagReason.get(t.item)
    ?? (({ ok, reason: r }) => (ok ? null : r))(core.validateEvidenceItem(t.item.evidence, sources, sha256, options));
  if (reason) {
    rejected.push({ message_id: t.label.message_id, theme: t.label.theme, reason });
  } else {
    accepted.push({ message_id: t.label.message_id, theme: t.label.theme });
    valid.push(t);
  }
}

const STATUS = {
  insufficient: "not_enough_feedback",
  neutral_mentions: "not_enough_feedback", // mentions with no opinion: nothing to conclude
  conflicting: "contradictory",
  supported: "enough_evidence",
  supported_with_dissent: "enough_evidence",
};
const counts = {};
const findings = [];
for (const s of report.themes) {
  if (s.comment_count === 0) continue; // every citation for this theme was rejected
  counts[s.theme] = {
    unique_messages: s.comment_count,
    positive: s.positive_sources,
    negative: s.negative_sources,
    neutral: s.neutral_sources,
  };
  const finding = { theme: s.theme, status: STATUS[s.verdict] ?? `unmapped:${s.verdict}` };
  if (finding.status === "enough_evidence") {
    const folded = new Set(s.cross_posted);
    finding.sentiment = s.direction;
    finding.evidence_message_ids = toMessageIds(valid
      .filter((t) => t.item.theme === s.theme && t.item.sentiment === s.direction && !folded.has(t.item.evidence.source_id))
      .map((t) => t.item.evidence.source_id));
  }
  findings.push(finding);
}

// The core says what each question is about (themes or source ids); name the fixture messages concerned.
const polarIdsOf = (theme) => valid
  .filter((t) => t.item.theme === theme && (t.item.sentiment === "positive" || t.item.sentiment === "negative"))
  .map((t) => t.item.evidence.source_id);
const askAPerson = report.ask_a_person.map((a) => ({
  reason: a.reason,
  message_ids: a.reason === "contradictory_reviews" ? toMessageIds(a.about.flatMap(polarIdsOf))
    : a.reason === "structured_output_failure" ? [...new Set(report.rejected_tags.map((r) => tagged.find((t) => t.item === r.item).label.message_id))]
      : toMessageIds(a.about),
}));

process.stdout.write(JSON.stringify({
  not_implemented: ["ingest", "cards", "decisions"],
  accepted_labels: accepted,
  rejected_labels: rejected,
  counts,
  findings,
  ask_a_person: askAPerson,
  // summarizeThemesReport and validateEvidenceItem are pure: they cannot write a fact, an approval or an outbox row.
  side_effects: { facts_changed: false, approvals_created: 0, outbox_entries: 0 },
}));
