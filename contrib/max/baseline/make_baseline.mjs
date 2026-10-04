// Generates docs/evidence/BASELINE.md from Nat's result files (contrib/nat/results/*.json). No number is typed by
// hand: every cell comes from a result file, and every table names its source file. Rerun after each new result:
//   node contrib/max/baseline/make_baseline.mjs            (writes docs/evidence/BASELINE.md)
//   node contrib/max/baseline/make_baseline.mjs --check    (exit 1 if the committed file is stale)
// Held-out texts and per-batch held-out details stay private: only the aggregates Nat published are shown.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RESULTS = "contrib/nat/results";
const OUT = "docs/evidence/BASELINE.md";
const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const has = (rel) => existsSync(join(ROOT, rel));

/**
 * The conditions, in the order the video shows them. `pick` returns { dev, heldout } blocks in Nat's schema:
 * { summary: { gold_findings, correct, UNSUPPORTED_findings, missed, evidence_precision, contradictions_recognized },
 *   per_batch?: { A: { gold_findings, correct, unsupported, missed }, ... } }.
 */
function conditions() {
  const out = [];
  const manual = `${RESULTS}/feedback-manual-nat-heldout.json`;
  if (has(manual)) {
    out.push({ name: "Manual reading (Nat, blind)", heldout: { summary: read(manual).summary, src: manual } });
  }
  const kw = `${RESULTS}/feedback-keyword-3d4e405-4a39a1b.json`;
  if (has(kw)) {
    const runs = read(kw).runs;
    const block = (key) => (runs[key] ? { summary: runs[key].findings, per_batch: runs[key].per_batch, src: kw } : null);
    out.push({
      name: "Keyword baseline (deterministic tagger, language detected)",
      dev: block("dev (tagger detects language)"), heldout: block("heldout (tagger detects language)"),
    });
  }
  // Model conditions: every feedback-model-<name>-<dev|heldout>-lang.json (language given, the app's setting).
  const files = readdirSync(join(ROOT, RESULTS)).filter((f) => /^feedback-model-.+-(dev|heldout)-lang\.json$/.test(f));
  const byModel = new Map();
  for (const f of files) {
    const [, model, corpus] = /^feedback-model-(.+)-(dev|heldout)-lang\.json$/.exec(f);
    const j = read(`${RESULTS}/${f}`);
    const entry = byModel.get(model) ?? { name: `Local model: ${model} (language given)` };
    entry[corpus] = { summary: j.summary, per_batch: j.per_batch, src: `${RESULTS}/${f}` };
    byModel.set(model, entry);
  }
  for (const [model, entry] of [...byModel].sort(([a], [b]) => (a.includes("gemma") ? -1 : b.includes("gemma") ? 1 : a.localeCompare(b)))) {
    out.push({ ...entry, app: /gemma/i.test(model) });
  }
  if (![...byModel.keys()].some((m) => /gemma/i.test(m))) {
    out.push({ name: "APP PATH: Gemma 4 (E2B phone default / E4B hub PC)", app: true, missing: true });
  }
  return out;
}

const cell = (s, k) => (s?.[k] === null || s?.[k] === undefined ? "-" : String(s[k]));
const frac = (s) => (s ? `${s.correct}/${s.gold_findings}` : "not run yet");

function heldoutTable(conds) {
  const rows = conds.map((c) => {
    const s = c.heldout?.summary;
    if (!s) return `| ${c.name}${c.app ? " **(app)**" : ""} | not run yet | | | | |`;
    return `| ${c.name}${c.app ? " **(app)**" : ""} | **${frac(s)}** | ${cell(s, "UNSUPPORTED_findings")} | ${cell(s, "missed")} | ${cell(s, "contradictions_recognized")} | [${c.heldout.src.split("/").pop()}](../../${c.heldout.src}) |`;
  });
  return [
    "| Condition | Findings correct | Stated without support | Missed | Contradiction recognized | Source |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function devTable(conds) {
  const withDev = conds.filter((c) => c.dev?.per_batch);
  if (!withDev.length) return "_No per-finding dev results yet._";
  const batches = Object.keys(withDev[0].dev.per_batch).sort();
  const lines = [
    `| Batch | Reference finding | ${withDev.map((c) => c.name + (c.app ? " (app)" : "")).join(" | ")} |`,
    `|---|---|${withDev.map(() => "---").join("|")}|`,
  ];
  for (const b of batches) {
    const gold = withDev[0].dev.per_batch[b].gold_findings;
    for (const g of gold) {
      const marks = withDev.map((c) => {
        const pb = c.dev.per_batch[b];
        return pb?.correct?.includes(g) ? "found" : pb?.missed?.includes(g) ? "missed" : "-";
      });
      lines.push(`| ${b} | ${g.replace(":", " · ")} | ${marks.join(" | ")} |`);
    }
    const extra = withDev.map((c) => (c.dev.per_batch[b]?.unsupported ?? []).join(", ") || "none");
    lines.push(`| ${b} | _stated without support_ | ${extra.join(" | ")} |`);
  }
  lines.push("", `Totals (dev): ${withDev.map((c) => `${c.name}: ${frac(c.dev.summary)}, ${cell(c.dev.summary, "UNSUPPORTED_findings")} unsupported`).join("; ")}.`);
  lines.push(`Sources: ${[...new Set(withDev.map((c) => c.dev.src))].map((s) => `[${s.split("/").pop()}](../../${s})`).join(", ")}.`);
  return lines.join("\n");
}

function render() {
  const conds = conditions();
  const appMissing = conds.some((c) => c.app && c.missing);
  return `# Baseline comparison: does the AI path beat reading the messages?

_Generated by \`node contrib/max/baseline/make_baseline.mjs\` from Nat's result files in \`${RESULTS}/\`. Do not edit by hand: every number below comes from a result file named in its row. Nat owns the numbers; labels are DRAFT/UNREVIEWED where his reports say so._

The judged workflow (W3): saved visitor feedback → evidence-backed findings → Swahili decision card → Noor approves one exact follow-up. A **finding** is a theme with at least 3 comments on the same side (code counts unique comments and keeps exact quotes). This page compares, finding by finding, the app's path with a manual reading and with a keyword baseline.

## Held-out set (private texts, aggregates only)

${heldoutTable(conds)}

${appMissing ? "**The app path (Gemma) has not been run on this set yet.** Its row fills in automatically when a `feedback-model-gemma*-heldout-lang.json` result lands in the results folder.\n" : ""}
## Dev set (public, inspectable): finding by finding

${devTable(conds)}

## How to read it

- **Manual reading is the bar.** It finds the reference findings, but it takes Noor's (or a helper's) time and is not repeatable.
- **The keyword baseline never states a point without support** (every quote exact) **but finds almost none of the findings**: a finding needs 3 comments on the same side, and each missed paraphrase or wrong sentiment drops a theme below the threshold. Safe, not useful.
- **The app path must beat the keyword baseline without adding unsupported findings.** That is the claim this page will show once the Gemma row is filled; until then we do not claim it.

## Caveats (stated, not hidden)

- Only 6 reference findings per set; small synthetic corpus (\`eval/feedback\`).
- The manual reader (Nat) also designed the task; his held-out labels were reviewed after his blind reading.
- Swahili texts are UNREVIEWED by a native speaker.
- See [contrib/nat/submission-evidence.md](../../contrib/nat/submission-evidence.md) for every other claim and its status.
`;
}

const text = render();
if (process.argv.includes("--check")) {
  const cur = has(OUT) ? readFileSync(join(ROOT, OUT), "utf8") : "";
  if (cur !== text) { console.error(`${OUT} is stale: rerun node contrib/max/baseline/make_baseline.mjs`); process.exit(1); }
  console.log(`${OUT} is up to date`);
} else {
  mkdirSync(dirname(join(ROOT, OUT)), { recursive: true });
  writeFileSync(join(ROOT, OUT), text);
  console.log(`wrote ${OUT}`);
}
