// Reference for Domain (packages/core owns the product version): language of a source that
// declares none. Pure JS, MIT dependency (franc 6.2.0), no model file, no network.
//
//   detectLanguage("Habari, bei ni ngapi kwa watu wawili?")  -> { lang: "sw", ..., reason: "ok" }
//   detectLanguage("How much?")                               -> { lang: "und", ..., reason: "too_short" }
//   detectLanguage("Kahua ni kega muno")                      -> { lang: "und", ..., reason: "kikuyu_marker" }
//
// "und" (ISO 639 "undetermined") means: do not guess -> unsupported_language -> ask a person.
// Every rule below can only turn an answer into "und", never create one (fail closed).
// Measured in contrib/max/langid-decision.md (DESKTOP; FLORES-200 dev for thresholds, synthetic data for vectors).

import { francAll } from "franc";
import { SWAHILI_COMMON } from "./swahili_common_words.js";

export const SUPPORTED = Object.freeze({ swh: "sw", eng: "en", deu: "de", fra: "fr" });
export const RULE = Object.freeze({
  minWords: 4, // r0: 2-3 word texts tested and NOT safe (German "Tolle Tour!" -> fr)
  minScore: 0.5,
  minMargin: 0.2, // top supported language vs the next supported one
  maxSwahiliGap: 0.2, // r1 (Nat F2): unrestricted top score minus Swahili's score
  // r2 (Nat L1: Kamba read as Swahili), thresholds chosen on FLORES-200 dev, never devtest:
  minSwahiliVocabulary: 0.25, // share of words in swahili_common_words.mjs
  minNeighborMargin: 0.05, // Swahili score minus the best Bantu/Cushitic neighbour franc knows
  maxGlobalGap: 0.2, // en/de/fr: unrestricted top score minus the chosen language's score
});
// Neighbours franc can score. Kamba, Kikuyu and Luo are not in franc's data: the vocabulary rule covers them.
const NEIGHBORS = ["nya", "kin", "run", "lug", "som", "sna", "zul", "xho", "bem", "toi", "yao"];

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

  const all = Object.fromEntries(francAll(clean, { minLength: 1 }));
  const top = Math.max(...Object.values(all));
  if (best === "swh") {
    // Other Bantu languages also score high on the Swahili trigram profile.
    if (top - (all.swh ?? 0) > RULE.maxSwahiliGap) return und("bantu_ambiguous", score, margin);
    const neighbor = Math.max(0, ...NEIGHBORS.map((l) => all[l] ?? 0));
    if ((all.swh ?? 0) - neighbor < RULE.minNeighborMargin) return und("bantu_neighbor", score, margin);
    const vocab = tokens.filter((t) => SWAHILI_COMMON.has(t)).length / Math.max(1, tokens.length);
    if (vocab < RULE.minSwahiliVocabulary) return und("swahili_vocabulary_low", score, margin);
  } else if (top - (all[best] ?? 0) > RULE.maxGlobalGap) {
    return und("low_confidence_global", score, margin);
  }
  return { lang: SUPPORTED[best], score: round(score), margin: round(margin), reason: "ok" };
}

// Refusals that are positive evidence of another language (as opposed to "not enough text to tell").
// Only kikuyu_marker is positive evidence of another language; the other refusals mean "not sure it is this one".
const OTHER_LANGUAGE = new Set(["kikuyu_marker"]);

/**
 * HO-012 (Nat R4): a source DECLARES a language (platform field, sender). Check it instead of trusting it.
 *   agree      -> the detector found the same language
 *   disagree   -> the detector found another supported language, or evidence of an unsupported one -> ask a person
 *   unverified -> too short or too unclear to check; the caller decides whether that declaration source is trusted
 */
export function checkDeclared(text, declared) {
  const detected = detectLanguage(text);
  if (detected.lang === declared) return { verdict: "agree", detected };
  if (detected.lang !== "und" || OTHER_LANGUAGE.has(detected.reason)) return { verdict: "disagree", detected };
  return { verdict: "unverified", detected };
}
