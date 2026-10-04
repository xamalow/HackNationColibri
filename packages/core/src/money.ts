/**
 * Money is an integer in the currency's minor units plus an ISO 4217 code and the
 * currency's exponent. Never assume two decimals: KES and TZS have cents, UGX and
 * RWF have none, KWD has three. An unknown currency is a clarification, not a guess.
 */

export interface Money {
  amount_minor: number;
  currency: string;
  exponent: number;
}

/** ISO 4217 minor-unit exponents for the currencies this product can meet. Extend by code, never by guess. */
export const ISO_4217_EXPONENT: Readonly<Record<string, number>> = {
  KES: 2, TZS: 2, UGX: 0, RWF: 0, BIF: 0, ETB: 2, SOS: 2, SSP: 2, CDF: 2, ZAR: 2, NGN: 2, GHS: 2,
  USD: 2, EUR: 2, GBP: 2, CHF: 2, CAD: 2, AUD: 2, NZD: 2, SEK: 2, NOK: 2, DKK: 2, PLN: 2, CZK: 2, HUF: 2,
  JPY: 0, KRW: 0, VND: 0, CLP: 0, PYG: 0, ISK: 0, XOF: 0, XAF: 0, XPF: 0,
  KWD: 3, BHD: 3, JOD: 3, OMR: 3, TND: 3, IQD: 3, LYD: 3,
  CLF: 4, UYW: 4,
  INR: 2, CNY: 2, AED: 2, SAR: 2, EGP: 2, MAD: 2, BRL: 2, MXN: 2,
};

export type MoneyVerdict =
  | { ok: true; money: Money }
  | { ok: false; reason: "not_an_object" | "amount_not_integer" | "amount_negative" | "amount_too_large" | "currency_malformed" | "currency_unknown" | "exponent_not_integer" | "exponent_mismatch"; detail: string };

export const MAX_AMOUNT_MINOR = 1_000_000_000_000;

export function validateMoney(input: unknown): MoneyVerdict {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, reason: "not_an_object", detail: "money must be an object" };
  }
  const m = input as Record<string, unknown>;
  const keys = Object.keys(m).sort();
  if (keys.join(",") !== "amount_minor,currency,exponent") {
    return { ok: false, reason: "not_an_object", detail: `money has keys ${keys.join(",")}, expected amount_minor,currency,exponent` };
  }
  const amount = m["amount_minor"];
  if (typeof amount !== "number" || !Number.isInteger(amount)) return { ok: false, reason: "amount_not_integer", detail: "amount_minor must be an integer" };
  if (amount < 0) return { ok: false, reason: "amount_negative", detail: "amount_minor must be >= 0" };
  if (amount > MAX_AMOUNT_MINOR) return { ok: false, reason: "amount_too_large", detail: `amount_minor must be <= ${MAX_AMOUNT_MINOR}` };
  const currency = m["currency"];
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return { ok: false, reason: "currency_malformed", detail: "currency must be an ISO 4217 code" };
  const expected = ISO_4217_EXPONENT[currency];
  if (expected === undefined) return { ok: false, reason: "currency_unknown", detail: `currency ${currency} is not in the table: ask a person` };
  const exponent = m["exponent"];
  if (typeof exponent !== "number" || !Number.isInteger(exponent)) return { ok: false, reason: "exponent_not_integer", detail: "exponent must be an integer" };
  if (exponent !== expected) return { ok: false, reason: "exponent_mismatch", detail: `${currency} has exponent ${expected}, got ${exponent}` };
  return { ok: true, money: { amount_minor: amount, currency, exponent } };
}

/** "2000.00" for KES 200000 minor. Display only; never used for arithmetic or hashing. */
export function toMajorString(money: Money): string {
  if (money.exponent === 0) return String(money.amount_minor);
  const s = String(money.amount_minor).padStart(money.exponent + 1, "0");
  return `${s.slice(0, -money.exponent)}.${s.slice(-money.exponent)}`;
}
