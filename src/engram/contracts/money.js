/**
 * ENGRAM §EW02 — Money contract: integer minor units + currency + exponent,
 * or validated decimal strings. Never binary floats.
 *
 * Design constraint (ticket 73ead329): money is integer minor units plus
 * currency and correct exponent, or validated decimal strings; never binary
 * floats for totals. This module is the single codified source of truth for
 * every path that stores, reads, or validates monetary values in ENGRAM.
 */

import { z } from "zod";

/**
 * ISO 4217 currency codes (subset validated at runtime).
 */
const CURRENCY_RE = /^[A-Z]{3}$/;
const CURRENCY_MINOR_UNITS = new Map([
  ["USD", 2], ["EUR", 2], ["GBP", 2], ["JPY", 0], ["KRW", 0],
  ["CNY", 2], ["INR", 2], ["CAD", 2], ["AUD", 2], ["CHF", 2],
  ["BRL", 2], ["MXN", 2], ["SEK", 2], ["NOK", 2], ["DKK", 2],
  ["PLN", 2], ["RUB", 2], ["TRY", 2], ["ZAR", 2], ["NGN", 2],
  ["BHD", 3], ["KWD", 3], ["OMR", 3], ["JOD", 3], ["TND", 3],
  ["CLF", 4], ["UYW", 4],
]);

/**
 * Reject binary floating-point in monetary positions.
 * NaN, Infinity, -Infinity, non-integer, and unsafe integers are all refused.
 */
function rejectFloat(value, ctx) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "monetary value must be finite; got non-finite number" });
      return z.NEVER;
    }
    if (!Number.isInteger(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "monetary value must be an integer (minor units); binary floats are not allowed for totals" });
      return z.NEVER;
    }
    if (!Number.isSafeInteger(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "monetary value exceeds safe integer range; use decimal string instead" });
      return z.NEVER;
    }
    return value;
  }
  return value;
}

/** Validated decimal string: no scientific notation. */
const DECIMAL_STRING_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** Minor-units integer: safe, finite. */
export const minorUnitsSchema = z.number().int().finite().refine(
  (v) => v >= -9007199254740991,
  { message: "minor units outside safe representable range" },
);

/** Decimal string that parses cleanly and never encodes scientific notation. */
export const decimalStringSchema = z.string().regex(
  DECIMAL_STRING_RE,
  { message: "money decimal string must match /^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$/; no scientific notation" },
);

/**
 * The single canonical money schema.
 *
 * A well-formed monetary value in ENGRAM is exactly one of:
 *   { amount: <integer minor units>, currency: "USD", exponent: 2 }
 *   { amount: "-?[0-9]+(\\.[0-9]+)?", currency: "USD", exponent: 2 }
 *
 * Binary floats (1.99), NaN, Infinity, and unsafe integers are REFUSED.
 */
export const moneySchema = z.object({
  amount: z.union([
    z.number().superRefine(rejectFloat),
    decimalStringSchema,
  ]),
  currency: z.string().regex(CURRENCY_RE, { message: "currency must be a 3-letter ISO 4217 code" }),
  exponent: z.number().int().min(0).max(6).optional(),
}).refine(
  (data) => {
    const known = CURRENCY_MINOR_UNITS.get(data.currency);
    if (data.exponent != null && known != null && data.exponent !== known) {
      return false;
    }
    return true;
  },
  { message: "exponent must match the currency's standard minor units when both are known", path: ["exponent"] },
).refine(
  (data) => {
    if (typeof data.amount === "string" && data.exponent != null) {
      const dot = data.amount.indexOf(".");
      if (dot >= 0) {
        const fracLen = data.amount.length - dot - 1;
        if (fracLen > data.exponent) return false;
      }
    }
    return true;
  },
  { message: "decimal string fractional digits must not exceed the currency exponent", path: ["amount"] },
);

/**
 * Normalize a money value to its canonical minor-units integer representation.
 * @param {object} money — a moneySchema-validated object
 * @returns {number|null}
 */
export function toMinorUnits(money) {
  const exponent = money.exponent ?? CURRENCY_MINOR_UNITS.get(money.currency) ?? 2;
  if (typeof money.amount === "number") return money.amount;
  const parsed = Number.parseFloat(money.amount);
  if (!Number.isFinite(parsed)) return null;
  const scaled = Math.round(parsed * 10 ** exponent);
  return Number.isSafeInteger(scaled) ? scaled : null;
}

/**
 * Format minor units back to a decimal string.
 * @param {number} minorUnits
 * @param {number} exponent
 * @returns {string}
 */
export function formatFromMinorUnits(minorUnits, exponent = 2) {
  if (exponent === 0) return String(minorUnits);
  const divisor = 10 ** exponent;
  const sign = minorUnits < 0 ? "-" : "";
  const abs = Math.abs(minorUnits);
  const whole = Math.floor(abs / divisor);
  const frac = String(abs % divisor).padStart(exponent, "0");
  return `${sign}${whole}.${frac}`;
}

/** Known minor-unit exponent for a currency code (null if unknown). */
export function currencyExponent(currency) {
  return CURRENCY_MINOR_UNITS.get(currency) ?? null;
}
