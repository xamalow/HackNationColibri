// `npm run demo:check` inside the test suite, so CI catches a demo regression: the two-phone demo server driven
// through its HTTP API, every hub workflow asserted (scripts/demo_check.mjs), plus Nat's two independent suites.
import { test } from "node:test";
import assert from "node:assert/strict";
import { missingPrerequisites, runDemoCheck, WORKFLOWS } from "../scripts/demo_check.mjs";

test("demo:check prerequisites are installed (core build, langid deps)", () => {
  assert.deepEqual(missingPrerequisites(), []);
});

test("demo:check: every hub workflow passes through the demo page's API", async (t) => {
  const lines = [];
  const { results, failed } = await runDemoCheck({ nat: true, out: (l) => lines.push(l) });
  assert.equal(results.length, WORKFLOWS.length + 3, "8 workflows + the page check + Nat's 2 suites");
  for (const r of results) {
    await t.test(`${r.id}: ${r.name}`, () => assert.ok(r.ok, r.error));
  }
  assert.equal(failed, 0, lines.join("\n"));
});
