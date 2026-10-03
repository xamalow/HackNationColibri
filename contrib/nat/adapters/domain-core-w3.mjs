#!/usr/bin/env node
// Adapter: runs Claude Domain's packages/core on one eval/w3 fixture (W3 steps 2-3).
//
//   python eval/w3/run_fixtures.py run --impl node contrib/nat/adapters/domain-core-w3.mjs <packages/core/dist>
//
// Translation only, no rule of its own. Reads {"fixture_id", "input"} on stdin, calls
// validateEvidenceItem and summarizeThemes, prints the outcome (eval/w3/README.md).
// Whatever the core has no API for is declared in `not_implemented`, so it is
// reported as not covered, never as a pass.

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const coreDist = process.argv[2];
if (!coreDist) {
  console.error("usage: domain-core-w3.mjs <path to packages/core/dist>");
  process.exit(2);
}
const core = await import(pathToFileURL(resolve(coreDist, "index.js")).href);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { input } = JSON.parse(Buffer.concat(chunks).toString("utf8"));

// A source is identified by the platform's own id, so a re-synced review is the same source.
const sourceIdOf = (m) => `${m.source}:${m.external_id}`;
const sources = new Map();
const messageIdOf = new Map(); // source_id -> first fixture message id with it
for (const m of input.messages) {
  const id = sourceIdOf(m);
  if (sources.has(id)) continue;
  sources.set(id, { source_id: id, text: m.text, content_hash: core.sourceTextHash(m.text, sha256) });
  messageIdOf.set(id, m.id);
}
const messages = new Map(input.messages.map((m) => [m.id, m]));

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

const accepted = [];
const rejected = [];
const valid = [];
for (const t of tagged) {
  const verdict = core.validateEvidenceItem(t.item.evidence, sources, sha256);
  if (verdict.ok) {
    accepted.push({ message_id: t.label.message_id, theme: t.label.theme });
    valid.push(t);
  } else {
    rejected.push({ message_id: t.label.message_id, theme: t.label.theme, reason: verdict.reason });
  }
}

const idsFor = (theme, sentiment) => [
  ...new Set(valid.filter((t) => t.item.theme === theme && t.item.sentiment === sentiment)
    .map((t) => messageIdOf.get(t.item.evidence.source_id))),
];

const STATUS = {
  insufficient: "not_enough_feedback",
  conflicting: "contradictory",
  supported: "enough_evidence",
  supported_with_dissent: "enough_evidence",
};
const counts = {};
const findings = [];
const askAPerson = [];
for (const s of core.summarizeThemes(tagged.map((t) => t.item), sources, sha256)) {
  if (s.comment_count === 0) continue; // every citation for this theme was rejected
  counts[s.theme] = {
    unique_messages: s.comment_count,
    positive: s.positive_sources,
    negative: s.negative_sources,
    neutral: s.neutral_sources,
  };
  const finding = { theme: s.theme, status: STATUS[s.verdict] ?? `unmapped:${s.verdict}` };
  if (finding.status === "enough_evidence") {
    // The core states no direction; the side with more comments is the one the card would present.
    const side = s.positive_sources > s.negative_sources ? "positive"
      : s.negative_sources > s.positive_sources ? "negative" : null;
    finding.sentiment = side;
    finding.evidence_message_ids = side ? idsFor(s.theme, side) : [];
  }
  findings.push(finding);
  if (s.verdict === "conflicting") {
    askAPerson.push({
      reason: "contradictory_reviews",
      message_ids: [...idsFor(s.theme, "positive"), ...idsFor(s.theme, "negative")],
    });
  }
}

process.stdout.write(JSON.stringify({
  not_implemented: ["ingest", "cards", "decisions"],
  accepted_labels: accepted,
  rejected_labels: rejected,
  counts,
  findings,
  ask_a_person: askAPerson,
  // validateEvidenceItem and summarizeThemes are pure: they cannot write a fact, an approval or an outbox row.
  side_effects: { facts_changed: false, approvals_created: 0, outbox_entries: 0 },
}));
