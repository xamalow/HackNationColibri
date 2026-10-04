// Fixed replies to a tourist (SMS / voice agent), in en / de / fr / sw. Ported in style from
// sauti/workflows/templates.py (branch w2-answer-tourist).
//
// REVIEW STATUS: UNREVIEWED (de, fr, sw drafted by a non-native author).
//
// Rules this module keeps:
// - Every value in a reply comes from a structured field computed by code (ISO date, integer party size, integer
//   KES total, HH:MM clock time, weekday keys). Each is validated here; an invalid value throws, nothing is guessed.
// - Tourist-provided text NEVER enters a reply. The only free text that can appear is Noor's own suggestion in the
//   "relay" reply (quoted, labelled as hers, sanitised and capped), and, only when the caller injects a translator,
//   its machine translation, labelled "machine translation, may contain errors".
// - An unsupported or undetermined language falls back to English (the caller flags it).
import { sanitizeSuggestion } from "./commands.mjs";
import { parseIsoDate } from "./notify.mjs";

export const REPLY_LANGS = Object.freeze(["en", "de", "fr", "sw"]);
export const replyLang = (lang) => (REPLY_LANGS.includes(lang) ? lang : "en");

const MONTHS = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  de: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
  fr: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
  sw: ["Januari", "Februari", "Machi", "Aprili", "Mei", "Juni", "Julai", "Agosti", "Septemba", "Oktoba", "Novemba", "Desemba"],
};
// getUTCDay order (Sunday first).
const DAYS = {
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  de: ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"],
  fr: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
  sw: ["Jumapili", "Jumatatu", "Jumanne", "Jumatano", "Alhamisi", "Ijumaa", "Jumamosi"],
};
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEK_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** "2026-10-17" -> "Saturday 17 October 2026" / "Samstag, 17. Oktober 2026" / "samedi 17 octobre 2026" / "Jumamosi, tarehe 17 Oktoba 2026". */
export function fmtDate(iso, lang) {
  const p = parseIsoDate(iso);
  if (!p) throw new Error("invalid date");
  const l = replyLang(lang);
  const day = DAYS[l][p.weekday];
  const month = MONTHS[l][p.m - 1];
  if (l === "de") return `${day}, ${p.d}. ${month} ${p.y}`;
  if (l === "sw") return `${day}, tarehe ${p.d} ${month} ${p.y}`;
  return `${day} ${p.d} ${month} ${p.y}`;
}

/** ["mon","sat","tue"] -> "Monday, Tuesday and Saturday" (unknown keys throw). */
export function fmtDays(days, lang) {
  const l = replyLang(lang);
  const keys = [...new Set(days)].sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b));
  const names = keys.map((k) => {
    const i = DAY_KEYS.indexOf(k);
    if (i < 0) throw new Error("invalid weekday");
    return DAYS[l][i];
  });
  if (!names.length) throw new Error("no days");
  const and = { en: " and ", de: " und ", fr: " et ", sw: " na " }[l];
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")}${and}${names[names.length - 1]}`;
}

function int(n, min, max) {
  if (!Number.isInteger(n) || n < min || n > max) throw new Error("invalid number");
  return n;
}
function clock(t) {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(t ?? ""));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error("invalid time");
  return `${m[1]}:${m[2]}`;
}
const kes = (n) => String(int(n, 0, 100_000_000));

function people(n, lang) {
  const k = int(n, 1, 1000);
  return {
    en: k === 1 ? "1 person" : `${k} people`,
    de: k === 1 ? "1 Person" : `${k} Personen`,
    fr: k === 1 ? "1 personne" : `${k} personnes`,
    sw: k === 1 ? "mtu 1" : `watu ${k}`,
  }[replyLang(lang)];
}

const T = {
  ack: {
    en: (f) => `Thank you! We received your request for ${f.party} on ${f.date}. Noor will confirm soon by SMS.`,
    de: (f) => `Vielen Dank! Wir haben Ihre Anfrage für ${f.party} am ${f.date} erhalten. Noor bestätigt bald per SMS.`,
    fr: (f) => `Merci ! Nous avons bien reçu votre demande pour ${f.party} le ${f.date}. Noor confirmera bientôt par SMS.`,
    sw: (f) => `Asante! Tumepokea ombi lako la ${f.party} ${f.date}. Noor atathibitisha hivi karibuni kwa SMS.`,
  },
  confirmed: {
    en: (f) => `Confirmed! Noor welcomes ${f.party} on ${f.date}. The tour starts at ${f.start}. Total price: ${f.total} KES.`,
    de: (f) => `Bestätigt! Noor empfängt ${f.party} am ${f.date}. Die Tour beginnt um ${f.start} Uhr. Gesamtpreis: ${f.total} KES.`,
    fr: (f) => `Confirmé ! Noor accueille ${f.party} le ${f.date}. La visite commence à ${f.start}. Prix total : ${f.total} KES.`,
    sw: (f) => `Imethibitishwa! Noor atakaribisha ${f.party} ${f.date}. Ziara inaanza saa ${f.start}. Bei jumla: KES ${f.total}.`,
  },
  declined: {
    en: (f) => `Sorry, Noor cannot welcome you on ${f.date}. Would another day suit you? Just send us the date.`,
    de: (f) => `Leider kann Noor Sie am ${f.date} nicht empfangen. Passt Ihnen ein anderer Tag? Senden Sie uns einfach das Datum.`,
    fr: (f) => `Désolés, Noor ne peut pas vous accueillir le ${f.date}. Un autre jour vous conviendrait-il ? Envoyez-nous simplement la date.`,
    sw: (f) => `Samahani, Noor hawezi kukukaribisha ${f.date}. Siku nyingine itakufaa? Tutumie tarehe tu.`,
  },
  relay: {
    en: (f) => `Noor replied (in Swahili): «${f.owner_text}»`,
    de: (f) => `Noor hat geantwortet (auf Swahili): «${f.owner_text}»`,
    fr: (f) => `Noor a répondu (en swahili) : «${f.owner_text}»`,
    sw: (f) => `Noor amejibu: «${f.owner_text}»`,
  },
  relay_translation: {
    en: (f) => `Machine translation, may contain errors: «${f.translation}»`,
    de: (f) => `Maschinelle Übersetzung, kann Fehler enthalten: «${f.translation}»`,
    fr: (f) => `Traduction automatique, peut contenir des erreurs : «${f.translation}»`,
    sw: (f) => `Tafsiri ya mashine, inaweza kuwa na makosa: «${f.translation}»`,
  },
  relay_pending: {
    en: (f) => `Your request for ${f.date} is still open: Noor will confirm or decline it.`,
    de: (f) => `Ihre Anfrage für den ${f.date} ist noch offen: Noor wird sie bestätigen oder absagen.`,
    fr: (f) => `Votre demande pour le ${f.date} reste ouverte : Noor la confirmera ou la refusera.`,
    sw: (f) => `Ombi lako la ${f.date} bado liko wazi: Noor atalithibitisha au kulikataa.`,
  },
  ask_details: {
    en: () => "Thank you, we would be happy to welcome you! Please tell us the date (for example 12 October) and the number of people.",
    de: () => "Vielen Dank, wir freuen uns auf Sie! Bitte nennen Sie uns das Datum (zum Beispiel 12. Oktober) und die Personenzahl.",
    fr: () => "Merci, nous serions ravis de vous accueillir ! Indiquez-nous la date (par exemple 12 octobre) et le nombre de personnes.",
    sw: () => "Asante, tutafurahi kukukaribisha! Tafadhali tuambie tarehe (kwa mfano 12 Oktoba) na idadi ya watu.",
  },
  ask_date: {
    en: (f) => `Thank you! Which date would you like to visit${f.party ? ` for ${f.party}` : ""}? (for example 12 October)`,
    de: (f) => `Vielen Dank! An welchem Datum möchten Sie kommen${f.party ? ` (${f.party})` : ""}? (zum Beispiel 12. Oktober)`,
    fr: (f) => `Merci ! Quelle date souhaitez-vous${f.party ? ` pour ${f.party}` : ""} ? (par exemple 12 octobre)`,
    sw: (f) => `Asante! Mngependa kuja tarehe gani${f.party ? ` (${f.party})` : ""}? (kwa mfano 12 Oktoba)`,
  },
  ask_party: {
    en: (f) => `Thank you! Please tell us the number of people for ${f.date}.`,
    de: (f) => `Vielen Dank! Mit wie vielen Personen kommen Sie am ${f.date}?`,
    fr: (f) => `Merci ! Combien de personnes serez-vous le ${f.date} ?`,
    sw: (f) => `Asante! Mtakuwa watu wangapi ${f.date}?`,
  },
  holding: {
    en: () => "Thank you for your message! Noor will answer you soon.",
    de: () => "Vielen Dank für Ihre Nachricht! Noor antwortet Ihnen bald.",
    fr: () => "Merci pour votre message ! Noor vous répondra bientôt.",
    sw: () => "Asante kwa ujumbe wako! Noor atakujibu hivi karibuni.",
  },
  // unavailable(reason)
  closed_day: {
    en: (f) => `Sorry, there is no tour on ${f.date}. We run tours on ${f.days}.`,
    de: (f) => `Leider gibt es am ${f.date} keine Tour. Touren finden ${f.days} statt.`,
    fr: (f) => `Désolés, il n'y a pas de visite le ${f.date}. Les visites ont lieu le ${f.days}.`,
    sw: (f) => `Samahani, hakuna ziara ${f.date}. Ziara ni siku za ${f.days}.`,
  },
  day_closed: {
    en: (f) => `Sorry, there is no tour on ${f.date}. Would another day suit you?`,
    de: (f) => `Leider gibt es am ${f.date} keine Tour. Passt Ihnen ein anderer Tag?`,
    fr: (f) => `Désolés, il n'y a pas de visite le ${f.date}. Un autre jour vous conviendrait-il ?`,
    sw: (f) => `Samahani, hakuna ziara ${f.date}. Siku nyingine itakufaa?`,
  },
  full: {
    en: (f) => (f.left ? `Sorry, on ${f.date} we only have room for ${f.left}, not enough for your group.` : `Sorry, we are fully booked on ${f.date}.`) + " Would another day suit you?",
    de: (f) => (f.left ? `Leider haben wir am ${f.date} nur noch Platz für ${f.left}, zu wenig für Ihre Gruppe.` : `Leider sind wir am ${f.date} ausgebucht.`) + " Passt Ihnen ein anderer Tag?",
    fr: (f) => (f.left ? `Désolés, le ${f.date} il ne reste de la place que pour ${f.left}, pas assez pour votre groupe.` : `Désolés, nous sommes complets le ${f.date}.`) + " Un autre jour vous conviendrait-il ?",
    sw: (f) => (f.left ? `Samahani, ${f.date} imebaki nafasi ya ${f.left} tu, haitoshi kwa kundi lenu.` : `Samahani, ${f.date} hakuna nafasi.`) + " Siku nyingine itakufaa?",
  },
  hours: {
    en: (f) => `Sorry, our tour on ${f.date} runs from ${f.start} to ${f.end} only. Would that time suit you?`,
    de: (f) => `Leider findet unsere Tour am ${f.date} nur von ${f.start} bis ${f.end} Uhr statt. Passt Ihnen diese Zeit?`,
    fr: (f) => `Désolés, la visite du ${f.date} a lieu de ${f.start} à ${f.end} uniquement. Cet horaire vous conviendrait-il ?`,
    sw: (f) => `Samahani, ziara ya ${f.date} ni kuanzia saa ${f.start} hadi ${f.end} tu. Muda huo utakufaa?`,
  },
  too_late: {
    en: (f) => `Sorry, the tour on ${f.date} has already started. Would another day suit you?`,
    de: (f) => `Leider hat die Tour am ${f.date} schon begonnen. Passt Ihnen ein anderer Tag?`,
    fr: (f) => `Désolés, la visite du ${f.date} a déjà commencé. Un autre jour vous conviendrait-il ?`,
    sw: (f) => `Samahani, ziara ya ${f.date} imeshaanza. Siku nyingine itakufaa?`,
  },
};

/** Reasons an unavailable reply can give (from core checkCapacity, the kv closed days, and the clock). */
export const UNAVAILABLE_REASONS = Object.freeze(["closed_day", "day_closed", "full", "hours", "too_late"]);

/**
 * Render one reply.
 * @param {"ack"|"confirmed"|"declined"|"relay"|"ask_details"|"holding"|"unavailable"} key
 * @param {string} lang tourist language; anything but en/de/fr/sw renders English
 * @param {object} [f] structured facts: { date: ISO, party_size: int, total_kes: int, start: "HH:MM", end: "HH:MM",
 *   open_days: ["mon",...], seats_left: int, reason: one of UNAVAILABLE_REASONS, owner_text: Noor's words (relay
 *   only), translation: machine translation of them (relay only, optional) }
 * @returns {string}
 */
export function renderTouristReply(key, lang, f = {}) {
  const l = replyLang(lang);
  switch (key) {
    case "ask_details":
    case "holding":
      return T[key][l]();
    case "ask_date":
      return T.ask_date[l]({ party: Number.isInteger(f.party_size) ? people(f.party_size, l) : null });
    case "ask_party":
      return T.ask_party[l]({ date: fmtDate(f.date, l) });
    case "ack":
      return T.ack[l]({ party: people(f.party_size, l), date: fmtDate(f.date, l) });
    case "confirmed":
      return T.confirmed[l]({ party: people(f.party_size, l), date: fmtDate(f.date, l), start: clock(f.start), total: kes(f.total_kes) });
    case "declined":
      return T.declined[l]({ date: fmtDate(f.date, l) });
    case "relay": {
      const owner = sanitizeSuggestion(f.owner_text);
      if (!owner) throw new Error("empty suggestion");
      const lines = [T.relay[l]({ owner_text: owner })];
      const tr = f.translation == null ? null : sanitizeSuggestion(f.translation, 400);
      if (tr) lines.push(T.relay_translation[l]({ translation: tr }));
      if (f.date) lines.push(T.relay_pending[l]({ date: fmtDate(f.date, l) }));
      return lines.join("\n");
    }
    case "unavailable": {
      const date = fmtDate(f.date, l);
      switch (f.reason) {
        case "closed_day": return T.closed_day[l]({ date, days: fmtDays(f.open_days, l) });
        case "day_closed": return T.day_closed[l]({ date });
        case "full": {
          const left = Number.isInteger(f.seats_left) && f.seats_left > 0 ? people(f.seats_left, l) : null;
          return T.full[l]({ date, left });
        }
        case "hours": return T.hours[l]({ date, start: clock(f.start), end: clock(f.end) });
        case "too_late": return T.too_late[l]({ date });
        default: throw new Error("unknown unavailable reason");
      }
    }
    default:
      throw new Error("unknown reply key");
  }
}
