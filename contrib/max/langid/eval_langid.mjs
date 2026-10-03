// Max lane: which MIT/Apache language detector can run in the TS core on the phone,
// for sources with no declared language (tourist SMS, direct reviews, Noor/guide notes)?
//
//   cd contrib/max/langid && npm ci && node eval_langid.mjs
//
// Every detector is restricted to the 4 supported languages (sw, en, de, fr). A text is
// "accepted" only when the top score clears the detector's threshold AND beats the runner-up
// by a margin; otherwise the answer is "unsure -> ask a person". Gold "mixed", "ki" and
// "other" items are correct only when the detector says unsure.
// Results are DESKTOP (Node on a laptop), not phone measurements.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { francAll } from "franc";
import { eld } from "eld/small"; // static database, smallest phone-friendly size
import { detectAll as tinyAll } from "tinyld";
import { detectLanguage } from "./detect_language.mjs";

const SUPPORTED = ["sw", "en", "de", "fr"];
const ISO3 = { sw: "swh", en: "eng", de: "deu", fr: "fra" };
const FROM3 = Object.fromEntries(Object.entries(ISO3).map(([k, v]) => [v, k]));

const items = readFileSync(new URL("./langid_eval.jsonl", import.meta.url), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Each detector returns [[lang, score], ...] over SUPPORTED, best first, scores in [0, 1].
const detectors = {
  franc: (t) => francAll(t, { only: Object.values(ISO3), minLength: 1 })
    .map(([l, s]) => [FROM3[l], s]).filter(([l]) => l),
  eld: (() => {
    eld.setLanguageSubset(SUPPORTED);
    return (t) => {
      const r = eld.detect(t);
      const scores = r.getScores ? r.getScores() : {};
      return Object.entries(scores).filter(([l]) => SUPPORTED.includes(l)).sort((a, b) => b[1] - a[1]);
    };
  })(),
  tinyld: (t) => tinyAll(t, { only: SUPPORTED }).map(({ lang, accuracy }) => [lang, accuracy]),
};

function decide(ranked, minScore, minMargin) {
  if (!ranked.length) return "unsure";
  const [[lang, top], second] = [ranked[0], ranked[1] ?? [null, 0]];
  return top >= minScore && top - second[1] >= minMargin ? lang : "unsure";
}

function lengthBucket(text) {
  const words = text.trim().split(/\s+/).length;
  return words <= 3 ? "1-3 words" : words <= 8 ? "4-8 words" : "9+ words";
}

// Composite strategies (the recommendation candidates), built from the single detectors.
const words = (t) => t.trim().split(/\s+/).length;
detectors["franc+min4words"] = (t) => (words(t) < 4 ? [] : detectors.franc(t));
detectors["franc&eld_agree"] = (t) => {
  const a = decide(detectors.franc(t), 0.5, 0.2), b = decide(detectors.eld(t), 0.5, 0.1);
  return a !== "unsure" && a === b ? [[a, 1]] : [];
};

// The recommended reference (r1): all rules inside detect_language.mjs; "und" counts as unsure.
detectors["reference_r1"] = (t) => { const r = detectLanguage(t); return r.lang === "und" ? [] : [[r.lang, 1]]; };

const THRESHOLDS = [
  // [minScore, minMargin]: "none" = always answer, others trade coverage for safety
  [0, 0], [0.5, 0.1], [0.5, 0.2], [0.7, 0.2], [0.7, 0.3],
];

const report = { label: "DESKTOP (Node " + process.version + "), not a phone measurement",
  date_utc: new Date().toISOString(), items: items.length, detectors: {} };

for (const [name, detect] of Object.entries(detectors)) {
  const raw = [];
  const t0 = performance.now();
  for (const it of items) raw.push({ it, ranked: detect(it.text) });
  const msPerText = (performance.now() - t0) / items.length;
  const byThreshold = {};
  for (const [minScore, minMargin] of THRESHOLDS) {
    let inScope = 0, correct = 0, wrong = 0, abstained = 0, outScope = 0, outScopeSafe = 0;
    const buckets = {};
    const errors = [];
    for (const { it, ranked } of raw) {
      const got = decide(ranked, minScore, minMargin);
      if (SUPPORTED.includes(it.lang)) {
        inScope++;
        const b = (buckets[lengthBucket(it.text)] ??= { n: 0, correct: 0, wrong: 0, unsure: 0 });
        b.n++;
        if (got === it.lang) { correct++; b.correct++; }
        else if (got === "unsure") { abstained++; b.unsure++; }
        else { wrong++; b.wrong++; errors.push(`${it.id}: gold ${it.lang} got ${got}`); }
      } else {
        outScope++;
        if (got === "unsure") outScopeSafe++;
        else errors.push(`${it.id}: gold ${it.lang} got ${got} (should be unsure)`);
      }
    }
    byThreshold[`score>=${minScore},margin>=${minMargin}`] = {
      in_scope: inScope, correct, wrong, unsure: abstained,
      accuracy_when_answering: +(correct / Math.max(1, correct + wrong)).toFixed(3),
      coverage: +((correct + wrong) / inScope).toFixed(3),
      out_of_scope_marked_unsure: `${outScopeSafe}/${outScope}`,
      by_length: buckets, errors,
    };
  }
  report.detectors[name] = { ms_per_text: +msPerText.toFixed(3), by_threshold: byThreshold };
}

const pkg = JSON.parse(readFileSync(new URL("./package-lock.json", import.meta.url), "utf8"));
report.versions = Object.fromEntries(["franc", "eld", "tinyld"].map((n) => [n, pkg.packages[`node_modules/${n}`]?.version]));
mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
const out = new URL(`../results/langid-desktop-${report.date_utc.slice(0, 16).replace(/[-:]/g, "")}Z.json`, import.meta.url);
writeFileSync(out, JSON.stringify(report, null, 2));
for (const [name, d] of Object.entries(report.detectors)) {
  console.log(`\n== ${name} (${d.ms_per_text} ms/text)`);
  for (const [k, v] of Object.entries(d.by_threshold)) {
    console.log(`  ${k.padEnd(24)} acc=${v.accuracy_when_answering} coverage=${v.coverage} wrong=${v.wrong} unsure=${v.unsure} out-of-scope-safe=${v.out_of_scope_marked_unsure}`);
  }
}
console.log(`\nwrote ${out.pathname}`);
