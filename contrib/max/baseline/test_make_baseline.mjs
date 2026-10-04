// node --test contrib/max/baseline/test_make_baseline.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const run = (...a) => execFileSync(process.execPath, ["contrib/max/baseline/make_baseline.mjs", ...a], { cwd: ROOT, encoding: "utf8" });

test("docs/evidence/BASELINE.md is generated from the result files and up to date", () => {
  assert.match(run("--check"), /up to date/);
});

test("every held-out number on the page equals the result file it cites", () => {
  const md = readFileSync(`${ROOT}docs/evidence/BASELINE.md`, "utf8");
  for (const line of md.split("\n").filter((l) => /\| \*\*\d+\/\d+\*\* \|/.test(l))) {
    const src = /\]\(\.\.\/\.\.\/(contrib\/nat\/results\/[^)]+)\)/.exec(line)[1];
    const j = JSON.parse(readFileSync(`${ROOT}${src}`, "utf8"));
    const s = j.summary ?? Object.entries(j.runs).find(([k]) => k.startsWith("heldout (tagger detects"))[1].findings;
    assert.ok(line.includes(`**${s.correct}/${s.gold_findings}**`), line);
  }
});
