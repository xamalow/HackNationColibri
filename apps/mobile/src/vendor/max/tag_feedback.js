// Max lane: deterministic theme tagger, the auditable replacement for model-made labels
// (contrib/max/model-decision.md: Qwen3 0.6B/1.7B must not decide themes on Swahili).
//
//   tagFeedback([{ id, text, lang? }]) -> { status: "ok", labels: [{ message_id, theme, sentiment, quote, start, end }],
//                                           untagged: [{ message_id, reason }] }
//
// Output has exactly the shape Domain's core reads as model output (packages/core/src/tagging.ts):
// offsets are UTF-8 bytes, end exclusive, and every quote is an exact slice of the original text.
// A message in an undetermined or unsupported language gets no label (reason "unsupported_language"),
// so the core asks a person. Lexicons are hand-written, sw lines non-native and UNREVIEWED.

import { detectLanguage } from "./detect_language.js";

export const THEMES = Object.freeze([
  "coffee", "farm_walk", "food", "host", "directions", "price",
  "timing", "booking", "language", "facilities", "buy_coffee",
]);
const SUPPORTED = new Set(["sw", "en", "de", "fr"]);

// Theme cues: accent-free, lowercase stems matched at the start of a word.
const THEME_CUES = {
  coffee: {
    en: ["coffee", "brew", "cup", "espresso", "tasting"], de: ["kaffee", "verkostung"], fr: ["cafe", "degustation"],
    sw: ["kahawa", "chai ya kahawa"],
  },
  farm_walk: {
    en: ["farm walk", "walk", "picking", "cherries", "plantation", "trees", "roasting", "processing", "demo", "harvest"],
    de: ["rundgang", "ernte", "kaffeeernte", "plantage", "rost", "baume"],
    fr: ["visite des", "plantation", "cueillette", "torrefaction", "arbres", "recolte"],
    sw: ["kuchuma", "miti ya kahawa", "kutembea", "kukaanga", "kuvuna"],
  },
  food: {
    en: ["lunch", "meal", "food", "breakfast", "snack", "dinner"], de: ["mittagessen", "essen", "fruhstuck", "mahlzeit"],
    fr: ["repas", "dejeuner", "nourriture", "cuisine"], sw: ["chakula", "mlo", "chamcha", "kifungua kinywa"],
  },
  host: {
    en: ["host", "welcom", "hospitab", "noor was", "mama noor", "family"], de: ["gastgeber", "empfang", "herzlich", "gastfreund"],
    fr: ["accueil", "hote", "hotesse", "chaleureu"], sw: ["karibisha", "mkarimu", "ukarimu", "mwenyeji"],
  },
  directions: {
    en: ["find", "road", "lost", "map", "direction", "sign", "matatu", "way to"],
    de: ["weg", "strasse", "verfahren", "beschild", "karte", "finden", "gefunden"],
    fr: ["trouver", "route", "chemin", "perdu", "itineraire", "panneau"],
    sw: ["njia", "barabara", "potea", "alama", "ramani", "kufika", "maelekezo"],
  },
  price: {
    en: ["price", "expensive", "cheap", "value", "cost", "paid", "worth"], de: ["preis", "teuer", "gunstig", "kosten", "wert"],
    fr: ["prix", "cher", "tarif", "cout", "rapport qualite"], sw: ["bei", "ghali", "rahisi", "gharama", "pesa"],
  },
  timing: {
    en: ["wait", "late", "long", "rushed", "short", "hours", "on time", "delay"],
    de: ["warten", "spat", "lange", "zu kurz", "verspat", "stunde"],
    fr: ["attendre", "attente", "retard", "trop long", "longue", "trop court"],
    sw: ["subiri", "chelewa", "ndefu", "muda", "saa nzima"],
  },
  booking: {
    en: ["book", "reserv", "answer", "repl", "whatsapp", "confirm", "cancel"],
    de: ["buch", "reservier", "antwort", "bestatig", "storn"],
    fr: ["reserv", "repondu", "reponse", "confirm", "annul"], sw: ["kuhifadhi", "nafasi", "jibu"],
  },
  language: {
    en: ["english", "translat", "language", "understand"], de: ["deutsch", "englisch", "ubersetz", "sprache", "verstand"],
    fr: ["francais", "anglais", "tradu", "langue", "comprendre"], sw: ["kiingereza", "lugha", "kutafsiri", "kuelewa"],
  },
  facilities: {
    en: ["toilet", "bathroom", "parking", "shade", "seat", "wifi"], de: ["toilette", "parkplatz", "schatten"],
    fr: ["toilette", "parking", "ombre", "sanitaire"], sw: ["choo", "maegesho", "kivuli", "vyoo"],
  },
  buy_coffee: {
    en: ["buy", "bought", "beans", "bag of", "take home", "shop"], de: ["kaufen", "gekauft", "bohnen", "mitnehmen"],
    fr: ["acheter", "achete", "grains", "emporter", "sachet"], sw: ["kununua", "tulinunua", "mfuko", "punje", "kuuza"],
  },
};

const POSITIVE = {
  en: ["love", "loved", "great", "best", "wonderful", "delicious", "amazing", "excellent", "fun", "highlight", "beautiful",
       "friendly", "good", "nice", "recommend", "fair", "worth"],
  de: ["toll", "wunderbar", "hervorragend", "lecker", "gut", "schon", "herzlich", "spannend", "empfehl", "fair", "super"],
  fr: ["delicieu", "excellent", "super", "genial", "chaleureu", "magnifique", "passionnant", "bien", "bon", "recommand"],
  sw: ["zuri", "tamu", "poa", "safi", "penda", "furahi", "mkarimu", "bora"], // verb roots: wa-li-penda, tu-li-furahia
};
const NEGATIVE = {
  en: ["hard", "lost", "bad", "cold", "expensive", "rushed", "too long", "late", "wait", "nobody", "no ", "not ", "never",
       "dirty", "small", "wrong", "difficult", "overpriced", "missing", "confusing", "confused", "unclear",
       "hard to follow", "barely", "hardly"],
  de: ["schwer", "schlecht", "kalt", "teuer", "lange", "spat", "warten", "keine", "nicht", "leider", "zu ", "verfahren",
       "kaum", "verwirrend", "unklar"],
  fr: ["difficile", "mauvais", "froid", "cher", "trop", "attendre", "retard", "personne", "pas ", "impossible", "perdu",
       "confus"],
  sw: ["mbaya", "ghali", "baridi", "ndefu", "hakuna", "vigumu", "potea", "subiri", "kidogo", "si ", "^haku", "chafu",
       "kwama", "lalamika", "chelewa", "gumu"], // verb roots: wa-li-potea, tu-li-subiri, li-li-kwama; ma-gumu / ngumu (difficult)
};

const enc = new TextEncoder();
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
const has = (text, stem, lang) => {
  if (stem.endsWith(" ")) return text.includes(stem); // "no ", "pas ": whole word followed by a space
  if (stem.startsWith("^")) stem = stem.slice(1); // "^haku": a prefix, only at the start of a word (not c-haku-la)
  else if (lang === "sw" && stem.length >= 4 && !stem.includes(" ")) return text.includes(stem);
  // Swahili builds words with prefixes (a-li-tu-karibisha, ki-zuri): stems of 4+ letters match inside a word,
  // except entries marked "^" (negation prefixes), which only match at the start of a word.
  const i = text.indexOf(stem);
  return i >= 0 && (i === 0 || !/\p{L}/u.test(text[i - 1]));
};

// Split into clauses on punctuation and contrast words, keeping exact character offsets.
// German "aber" is not a split word: as "but" German grammar puts a comma before it (already a split); without a
// comma it is a particle ("haben wir aber kaum gefunden") and splitting there cut the quote. French "mais" often
// has no comma ("passionnante mais trop longue"), so it stays a split word.
const SPLIT = /[.!?;,]|\s(?:but|lakini|mais|however)\s/giu;
function clauses(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(SPLIT)) {
    out.push([last, m.index]);
    last = m.index + m[0].length;
  }
  out.push([last, text.length]);
  return out
    .map(([a, b]) => {
      const raw = text.slice(a, b);
      const lead = raw.length - raw.trimStart().length;
      return [a + lead, a + lead + raw.trim().length];
    })
    .filter(([a, b]) => b > a);
}

function sentimentOf(clauseNorm, lang) {
  const pos = POSITIVE[lang].some((w) => has(clauseNorm, norm(w), lang));
  const neg = NEGATIVE[lang].some((w) => has(clauseNorm + " ", norm(w), lang));
  if (pos && !neg) return "positive";
  if (neg && !pos) return "negative";
  return "neutral";
}

function byteOffsets(text, start, end) {
  const s = enc.encode(text.slice(0, start)).length;
  return [s, s + enc.encode(text.slice(start, end)).length];
}

export function tagMessage({ id, text, lang }) {
  const source = String(text ?? "");
  const language = SUPPORTED.has(lang) ? lang : detectLanguage(source).lang;
  if (!SUPPORTED.has(language)) return { labels: [], untagged: { message_id: id, reason: "unsupported_language" } };
  const labels = [];
  const seen = new Set();
  for (const [a, b] of clauses(source)) {
    const clauseNorm = norm(source.slice(a, b));
    for (const theme of THEMES) {
      if (seen.has(theme)) continue;
      const cues = THEME_CUES[theme][language];
      if (!cues.some((c) => has(clauseNorm, norm(c), language))) continue;
      // "picking coffee", "buy coffee beans": the coffee word is the object of another theme, not the drink.
      if (theme === "coffee" && ["farm_walk", "buy_coffee"].some((t) => THEME_CUES[t][language].some((c) => has(clauseNorm, norm(c), language)))) continue;
      const [start, end] = byteOffsets(source, a, b);
      labels.push({ message_id: id, theme, sentiment: sentimentOf(clauseNorm, language), quote: source.slice(a, b), start, end });
      seen.add(theme);
    }
  }
  return labels.length ? { labels } : { labels, untagged: { message_id: id, reason: "no_theme_found" } };
}

export function tagFeedback(messages) {
  const labels = [];
  const untagged = [];
  for (const m of messages) {
    const r = tagMessage(m);
    labels.push(...r.labels);
    if (r.untagged) untagged.push(r.untagged);
  }
  return { status: "ok", labels, untagged };
}
