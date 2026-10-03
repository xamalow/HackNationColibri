// Reference for Domain (packages/core owns the product version): language of a source that
// declares none. Pure JS, MIT dependency (franc 6.2.0), no model file, no network.
//
//   detectLanguage("Habari, bei ni ngapi kwa watu wawili?")  -> { lang: "sw", score: 1, margin: 0.58, reason: "ok" }
//   detectLanguage("How much?")                               -> { lang: "unsure", ..., reason: "too_short" }
//
// "unsure" means: do not guess, treat the source as unsupported_language -> ask a person.
// Rule measured in contrib/max/langid-decision.md (DESKTOP): 0 wrong on 74 in-scope texts, 68% answered.

import { francAll } from "franc";

export const SUPPORTED = Object.freeze({ swh: "sw", eng: "en", deu: "de", fra: "fr" });
export const RULE = Object.freeze({ minWords: 4, minScore: 0.5, minMargin: 0.2 });

export function detectLanguage(text) {
  const clean = String(text ?? "").normalize("NFC").trim();
  const words = clean ? clean.split(/\s+/).length : 0;
  if (words < RULE.minWords) return { lang: "unsure", score: 0, margin: 0, reason: "too_short" };
  const ranked = francAll(clean, { only: Object.keys(SUPPORTED), minLength: 1 }).filter(([l]) => l in SUPPORTED);
  if (ranked.length === 0) return { lang: "unsure", score: 0, margin: 0, reason: "no_candidate" };
  const [best, score] = ranked[0];
  const margin = score - (ranked[1]?.[1] ?? 0);
  const round = (x) => Math.round(x * 1000) / 1000;
  if (score < RULE.minScore || margin < RULE.minMargin) {
    return { lang: "unsure", score: round(score), margin: round(margin), reason: "low_confidence" };
  }
  return { lang: SUPPORTED[best], score: round(score), margin: round(margin), reason: "ok" };
}
