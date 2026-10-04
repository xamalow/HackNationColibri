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

/** Parse one run of number tokens: "elfu moja na mia tano" -> 1500, "kumi na tano" -> 15, "2000" -> 2000. */
function parseRun(toks: string[]): number {
  let total = 0;
  let i = 0;
  while (i < toks.length) {
    const tok = toks[i]!;
    if (/^\d+$/.test(tok)) {
      total += Number(tok);
      i++;
      continue;
    }
    if (tok in MULTIPLIERS) {
      // multiplier followed by a small count: "elfu mbili", "elfu kumi na tano"; a bare "mia" is 100
      let count = 0;
      let j = i + 1;
      let sawSmall = false;
      while (j < toks.length) {
        const t = toks[j]!;
        if (t in SMALL) {
          count += SMALL[t]!;
          sawSmall = true;
          j++;
        } else if (t === "na" && j + 1 < toks.length && toks[j + 1]! in SMALL && !(toks[j + 1]! in MULTIPLIERS)) {
          j++;
        } else break;
      }
      total += MULTIPLIERS[tok]! * (sawSmall ? count : 1);
      i = j;
      continue;
    }
    if (tok in SMALL) {
      total += SMALL[tok]!;
      i++;
      continue;
    }
    if (tok === "na") {
      i++;
      continue;
    }
    break;
  }
  return total;
}

/** Every number said in the text, in order. "shilingi elfu mbili kwa mtu mmoja" -> [2000, 1]. */
export function findNumbers(text: string): number[] {
  const toks = tokens(text).filter((t) => !/^\d{1,2}:\d{2}$/.test(t));
  const out: number[] = [];
  let i = 0;
  while (i < toks.length) {
    if (!isNumberToken(toks[i]!)) {
      i++;
      continue;
    }
    let j = i;
    while (j < toks.length && (isNumberToken(toks[j]!) || (toks[j] === "na" && j + 1 < toks.length && isNumberToken(toks[j + 1]!)))) j++;
    const run = toks.slice(i, j);
    if (run.length > 0) out.push(parseRun(run));
    i = j;
  }
  return out;
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
