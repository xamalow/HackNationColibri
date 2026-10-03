// Reference for Domain (packages/core owns the product version): language of a source that
// declares none. Pure JS, MIT dependency (franc 6.2.0), no model file, no network.
//
//   detectLanguage("Habari, bei ni ngapi kwa watu wawili?")  -> { lang: "sw", ..., reason: "ok" }
//   detectLanguage("How much?")                               -> { lang: "und", ..., reason: "too_short" }
//   detectLanguage("Kahua ni kega muno")                      -> { lang: "und", ..., reason: "kikuyu_marker" }
//
// "und" (ISO 639 "undetermined") means: do not guess -> unsupported_language -> ask a person.
// Every rule below can only turn an answer into "und", never create one (fail closed).
// Measured in contrib/max/langid-decision.md (DESKTOP, synthetic data).

import { francAll } from "franc";

export const SUPPORTED = Object.freeze({ swh: "sw", eng: "en", deu: "de", fra: "fr" });
export const RULE = Object.freeze({
  minWords: 4, // r0: 2-3 word texts tested and NOT safe (German "Tolle Tour!" -> fr)
  minScore: 0.5,
  minMargin: 0.2, // top supported language vs the next supported one
  maxSwahiliGap: 0.2, // r1 (Nat F2): unrestricted top score minus Swahili's score
});

// r1 (Nat F2): Kikuyu is not supported and franc restricted to sw/en/de/fr reads it as Swahili.
// Kikuyu spelling uses i and u with tilde, which Swahili never uses; the words below do not exist in
// Swahili. Written by a non-native author, UNREVIEWED: a false hit only costs coverage (fails closed).
const KIKUYU_LETTERS = /[ĩĨũŨ]/u;
const KIKUYU_WORDS = new Set(["muno", "wega", "mwega", "kega", "uria", "ngai", "thengiu", "thengio"]);

const round = (x) => Math.round(x * 1000) / 1000;
const und = (reason, score = 0, margin = 0) => ({ lang: "und", score: round(score), margin: round(margin), reason });

export function detectLanguage(text) {
  const clean = String(text ?? "").normalize("NFC").trim();
  const words = clean ? clean.split(/\s+/) : [];
  if (words.length < RULE.minWords) return und("too_short");

  const tokens = clean.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").match(/\p{L}+/gu) ?? [];
  if (KIKUYU_LETTERS.test(clean) || tokens.some((t) => KIKUYU_WORDS.has(t))) return und("kikuyu_marker");

  const ranked = francAll(clean, { only: Object.keys(SUPPORTED), minLength: 1 }).filter(([l]) => l in SUPPORTED);
  if (ranked.length === 0) return und("no_candidate");
  const [best, score] = ranked[0];
  const margin = score - (ranked[1]?.[1] ?? 0);
  if (score < RULE.minScore || margin < RULE.minMargin) return und("low_confidence", score, margin);

  if (best === "swh") {
    // Other Bantu languages also score high on the Swahili trigram profile: require Swahili to be
    // close to the best score over ALL languages franc knows.
    const all = francAll(clean, { minLength: 1 });
    const swahili = all.find(([l]) => l === "swh")?.[1] ?? 0;
    if (all[0][1] - swahili > RULE.maxSwahiliGap) return und("bantu_ambiguous", score, margin);
  }
  return { lang: SUPPORTED[best], score: round(score), margin: round(margin), reason: "ok" };
}
