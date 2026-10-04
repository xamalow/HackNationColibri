// node --test contrib/max/baseline/test_make_baseline.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const run = (...a) => execFileSync(process.execPath, ["contrib/max/baseline/make_baseline.mjs", ...a], { cwd: ROOT, encoding: "utf8" });
const md = () => readFileSync(`${ROOT}docs/evidence/BASELINE.md`, "utf8");
const json = (rel) => JSON.parse(readFileSync(`${ROOT}${rel}`, "utf8"));
const section = (title) => md().split("\n## ").find((s) => s.startsWith(title)) ?? "";

test("docs/evidence/BASELINE.md is generated from the result files and up to date", () => {
  assert.match(run("--check"), /up to date/);
});

test("every held-out row equals baseline-heldout.json, in the page's order", () => {
  const h = json("contrib/nat/results/baseline-heldout.json").conditions;
  const order = ["manual_nat", "app_tagger_core", "template_baseline", "qwen3_0.6b"].filter((k) => h[k]);
  const rows = section("Held-out set").split("\n").filter((l) => /\| \*\*\d+\/\d+\*\* \|/.test(l));
  assert.equal(rows.length, order.length);
  rows.forEach((line, i) => {
    const s = h[order[i]].summary;
    assert.ok(line.includes(`| **${s.correct}/${s.gold_findings}** | ${s.UNSUPPORTED_findings} | ${s.missed} |`), `${order[i]}: ${line}`);
  });
});

test("the app row is the app's finding path, not a model, and the page never calls Gemma the app path", () => {
  const page = md();
  assert.match(section("Held-out set"), /\| \*\*Sauti app\*\*: deterministic tagger \+ core rules, no model \|/);
  assert.doesNotMatch(page, /APP PATH: Gemma|not run yet/);
  assert.match(page, /Gemma 4 only translates/);
});

test("every demo row's app and template cells come from baseline-demo.json", () => {
  const d = json("contrib/nat/results/baseline-demo.json");
  const demo = section("The demo reviews");
  for (const r of d.rows) {
    const line = demo.split("\n").find((l) => l.startsWith(`| ${r.theme} |`));
    assert.ok(line, r.theme);
    if (r.template_baseline) assert.ok(line.includes(r.template_baseline.shows), line);
    const a = r.app_tagger_core;
    if (a && ["supported", "supported_with_dissent"].includes(a.verdict)) assert.ok(line.includes(`**${a.direction}**, ${a.comments} comments`), line);
  }
});
