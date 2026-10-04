/**
 * Swahili (and digit) parsing done by code, never by the model: amounts,
 * clock times, yes/no. Ported in reduced form from the Python reference
 * sauti/lang/swahili.py (W1). Prices and hours in the farm sheet come from
 * Noor's own words through these functions; a review or a model never sets one.
 */

const UNITS: Record<string, number> = { moja: 1, mbili: 2, tatu: 3, nne: 4, tano: 5, sita: 6, saba: 7, nane: 8, tisa: 9 };
const PEOPLE_UNITS: Record<string, number> = { mmoja: 1, wawili: 2, watatu: 3, wanne: 4, watano: 5, wanane: 8 };
const TENS: Record<string, number> = { kumi: 10, ishirini: 20, thelathini: 30, arobaini: 40, hamsini: 50, sitini: 60, sabini: 70, themanini: 80, tisini: 90 };
const MULTIPLIERS: Record<string, number> = { mia: 100, elfu: 1000, laki: 100_000, milioni: 1_000_000 };
const SMALL: Record<string, number> = { ...UNITS, ...PEOPLE_UNITS, ...TENS };

export function tokens(text: string): string[] {
  let t = text.toLowerCase();
  t = t.replace(/(?<=\d)[,.](?=\d{3}(?!\d))/g, ""); // 2,000 or 2.000 -> 2000
  t = t.replace(/\b(\d{1,2})\.(\d{2})\b/g, "$1:$2"); // 8.30 -> 8:30
  return t.match(/\d{1,2}:\d{2}|\d+|[\p{L}']+/gu) ?? [];
}

function isNumberToken(tok: string): boolean {
  return /^\d+$/.test(tok) || tok in SMALL || tok in MULTIPLIERS;
}

function value(tok: string): number {
  return /^\d+$/.test(tok) ? Number(tok) : SMALL[tok]!;
}

/**
 * Parse one run of number tokens, 'na' connectors included. Same rules as the
 * Python reference `_parse_run`: "mia" takes a single digit after it (mia tano =
 * 500, mia alone = 100, "mia moja na hamsini" = 150); the count of a larger
 * multiplier stops at the next multiplier (elfu mbili mia tano = 2500) except a
 * smaller one in first position (elfu mia moja = 100 000), and stops at 'na'
 * (elfu moja na moja = 1001) except inside a tens-and-units count (elfu kumi na
 * tano = 15 000). Hub finding 2026-10-04: the previous port read "mia moja na
 * hamsini" as 5100.
 */
function parseRun(toks: string[]): number {
  let total = 0;
  let i = 0;
  while (i < toks.length) {
    const tok = toks[i]!;
    if (tok === "na") {
      i++;
    } else if (tok === "mia") {
      const nxt = i + 1 < toks.length ? toks[i + 1]! : null;
      if (nxt !== null && (nxt in UNITS || (/^\d+$/.test(nxt) && Number(nxt) >= 1 && Number(nxt) <= 9))) {
        total += 100 * value(nxt);
        i += 2;
      } else {
        total += 100;
        i++;
      }
    } else if (tok in MULTIPLIERS) {
      let j = i + 1;
      if (j < toks.length && toks[j]! in MULTIPLIERS && MULTIPLIERS[toks[j]!]! < MULTIPLIERS[tok]!) j++;
      while (j < toks.length && !(toks[j]! in MULTIPLIERS)) {
        if (toks[j] === "na" && !(toks[j - 1]! in TENS && j + 1 < toks.length && (toks[j + 1]! in UNITS || toks[j + 1]! in PEOPLE_UNITS))) break;
        j++;
      }
      const count = j > i + 1 ? parseRun(toks.slice(i + 1, j)) : 1;
      total += MULTIPLIERS[tok]! * count;
      i = j;
    } else {
      total += value(tok);
      i++;
    }
  }
  return total;
}

/**
 * Every number said in the text, in order. "shilingi elfu mbili kwa mtu mmoja"
 * -> [2000, 1]. A bare digit right after another number starts a new number
 * ("BEI 2000 500" -> [2000, 500], never 2500). Clock hours ("saa tatu") and
 * HH:MM tokens are skipped; see findTimes for those.
 */
export function findNumbers(text: string): number[] {
  const toks = tokens(text).filter((t) => !/^\d{1,2}:\d{2}$/.test(t));
  const runs: string[][] = [];
  let current: string[] = [];
  let afterSaa = false;
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!;
    if (isNumberToken(tok)) {
      if (current.length > 0 && /^\d+$/.test(tok) && !(current[current.length - 1]! in MULTIPLIERS)) {
        if (!afterSaa) runs.push(current);
        current = [];
        afterSaa = false;
      }
      if (current.length === 0 && i > 0 && toks[i - 1] === "saa") afterSaa = true;
      current.push(tok);
    } else if (tok === "na" && current.length > 0 && i + 1 < toks.length && isNumberToken(toks[i + 1]!)) {
      current.push(tok);
    } else {
      if (current.length > 0 && !afterSaa) runs.push(current);
      current = [];
      afterSaa = false;
    }
  }
  if (current.length > 0 && !afterSaa) runs.push(current);
  return runs.map(parseRun);
}

/** The largest number said: the price in "elfu mbili kwa mtu mmoja". Null when none. */
export function parseAmount(text: string): number | null {
  const nums = findNumbers(text).filter((n) => n > 0);
  return nums.length ? Math.max(...nums) : null;
}

export interface ClockTime {
  hour: number;
  minute: number;
}

const PERIODS = new Set(["alfajiri", "asubuhi", "mchana", "jioni", "usiku"]);

function swahiliTo24h(hourSw: number, period: string | null): number {
  let h = (hourSw + 6) % 12; // saa moja = 7 o'clock
  if (period === "mchana" || period === "jioni" || period === "usiku") {
    if (h < 12) h += 12;
  } else if (period === null && h < 6) {
    h += 12; // "saa tisa" with no period: a daytime tour, 15:00 not 03:00
  }
  return h;
}

/** Clock times in order of mention: "kuanzia saa tatu asubuhi mpaka saa tisa na nusu mchana" -> 09:00, 15:30. Also 9:00, 14.30. */
export function findTimes(text: string): ClockTime[] {
  const toks = tokens(text);
  const out: ClockTime[] = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!;
    const western = /^(\d{1,2}):(\d{2})$/.exec(tok);
    if (western) {
      const h = Number(western[1]);
      const m = Number(western[2]);
      if (h <= 23 && m <= 59) out.push({ hour: h, minute: m });
      continue;
    }
    if (tok !== "saa") continue;
    // small number after "saa": "tatu", "kumi na mbili", "9"
    let j = i + 1;
    let n = 0;
    let got = false;
    while (j < toks.length) {
      const t = toks[j]!;
      if (/^\d+$/.test(t)) {
        n += Number(t);
        got = true;
        j++;
      } else if (t in SMALL && !(t in PEOPLE_UNITS)) {
        n += SMALL[t]!;
        got = true;
        j++;
      } else if (t === "na" && j + 1 < toks.length && (toks[j + 1]! in UNITS || toks[j + 1]! in TENS) && !got) {
        j++;
      } else break;
    }
    if (!got || n < 1 || n > 12) continue;
    let minute = 0;
    let hourSw = n;
    if (toks[j] === "na" && toks[j + 1] === "nusu") {
      minute = 30;
      j += 2;
    } else if (toks[j] === "na" && toks[j + 1] === "robo") {
      minute = 15;
      j += 2;
    } else if (toks[j] === "kasorobo") {
      minute = 45;
      hourSw = n - 1 === 0 ? 12 : n - 1;
      j += 1;
    } else if (toks[j] === "na" && toks[j + 1] === "dakika") {
      const mm = toks[j + 2] ? parseRun([toks[j + 2]!]) : 0;
      if (mm > 0 && mm < 60) {
        minute = mm;
        j += 3;
      }
    }
    const period = toks[j] && PERIODS.has(toks[j]!) ? toks[j]! : null;
    out.push({ hour: swahiliTo24h(hourSw, period), minute });
  }
  return out;
}

/** Opening hours as the first two times said, end after start. */
export function parseHours(text: string): { start: ClockTime; end: ClockTime } | null {
  const times = findTimes(text);
  if (times.length < 2) return null;
  const [a, b] = [times[0]!, times[1]!];
  if (b.hour * 60 + b.minute <= a.hour * 60 + a.minute) return null;
  return { start: a, end: b };
}

export function timeToString(t: ClockTime): string {
  return `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}:00`;
}

const YES = new Set(["ndiyo", "ndio", "sawa", "sawasawa", "naam", "kweli", "yes", "yeah", "ok", "okay"]);
const NO = new Set(["hapana", "la", "siyo", "sio", "si", "no", "badilisha", "kosa"]);
const REPEAT = new Set(["rudia", "tena", "sijasikia", "sikusikia", "sijaelewa", "nini", "repeat"]);
/** Keypad fallback, also accepted spoken: 1 yes, 2 no, 3 repeat. Only as the whole answer. */
const KEYPAD: Record<string, "yes" | "no" | "repeat"> = { "1": "yes", moja: "yes", "2": "no", mbili: "no", "3": "repeat", tatu: "repeat" };

/** "yes", "no", "repeat" or null when unclear. Unclear is never a yes. A "no" anywhere wins over a "yes". */
export function parseConfirmation(text: string): "yes" | "no" | "repeat" | null {
  const toks = tokens(text);
  if (toks.length === 0) return null;
  if (toks.length === 1 && toks[0]! in KEYPAD) return KEYPAD[toks[0]!]!;
  const words = new Set(toks);
  for (const w of words) if (REPEAT.has(w)) return "repeat";
  for (const w of words) if (NO.has(w)) return "no";
  for (const w of words) if (YES.has(w)) return "yes";
  return null;
}
