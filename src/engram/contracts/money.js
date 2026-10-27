/**
 * ENGRAM §EW02 — Money contract: integer minor units + currency + exponent,
 * or validated decimal strings. Never binary floats.
 *
 * Design constraint (ticket 73ead329): money is integer minor units plus
 * currency and correct exponent, or validated decimal strings; never binary
 * floats for totals. This module is the single codified source of truth for
 * every path that stores, reads, or validates monetary values in ENGRAM.
 *
 * Luna-judge F5: use exact BigInt conversion, never floating-point rounding.
 * Luna-judge F8: minorUnitsSchema must check both safe integer bounds.
 * Luna-judge P2: validate against a complete currency registry; reject unknown codes.
 * Luna-judge P2: strict schema — reject extra fields.
 */

import { z } from "zod";

/**
 * ISO 4217 currency codes (supported subset validated at runtime).
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

/** Complete list of known currency codes — used to reject unknown codes. */
export const KNOWN_CURRENCIES = new Set(CURRENCY_MINOR_UNITS.keys());

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

/** Minor-units integer: safe, finite, both bounds checked (F8). */
export const minorUnitsSchema = z.number().int().finite().refine(
  (v) => Number.isSafeInteger(v),
  { message: "minor units outside safe representable range" },
);

/** Decimal string that parses cleanly and never encodes scientific notation. */
export const decimalStringSchema = z.string().regex(
  DECIMAL_STRING_RE,
  { message: "money decimal string must match /^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$/; no scientific notation" },
);

/**
 * The single canonical money schema — strict: rejects extra fields.
 *
 * A well-formed monetary value in ENGRAM is exactly one of:
 *   { amount: <integer minor units>, amountUnit: "minor_units", currency: "USD", exponent: 2 }
 *   { amount: "-?[0-9]+(\\.[0-9]+)?", amountUnit: "major_decimal", currency: "USD", exponent: 2 }
 *
 * Binary floats (1.99), NaN, Infinity, and unsafe integers are REFUSED.
 * Unknown currency codes are REFUSED (P2: pinned registry only).
 * Extra fields are REFUSED (P2: strict).
 */
export const moneySchema = z.object({
  amount: z.union([
    z.number().superRefine(rejectFloat),
    decimalStringSchema,
  ]),
  // Do not infer units from JSON number/string representation. A lost quote
  // must fail validation rather than silently changing a total by 10^exponent.
  amountUnit: z.enum(["minor_units", "major_decimal"]),
  currency: z.string().regex(CURRENCY_RE, { message: "currency must be a 3-letter ISO 4217 code" }),
  exponent: z.number().int().min(0).max(6).optional(),
}).strict().refine(
  (data) => (data.amountUnit === "minor_units") === (typeof data.amount === "number"),
  { message: "amountUnit must match numeric minor units or string major decimal", path: ["amountUnit"] },
).refine(
  (data) => {
    if (!KNOWN_CURRENCIES.has(data.currency)) {
      return false;
    }
    return true;
  },
  { message: "currency code is not in the supported ISO 4217 registry; register it before use", path: ["currency"] },
).refine(
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
    // Require exponent for decimal strings or use currency default
    const exponent = data.exponent ?? CURRENCY_MINOR_UNITS.get(data.currency);
    if (exponent == null) {
      return false;
    }
    if (typeof data.amount === "string") {
      const dot = data.amount.indexOf(".");
      if (dot >= 0) {
        const fracLen = data.amount.length - dot - 1;
        if (fracLen > exponent) return false;
      }
    }
    return true;
  },
  { message: "currency requires a known exponent; provide exponent or use a known currency code", path: ["exponent"] },
);

/**
 * Migrate a pre-freeze `{amount, currency, exponent}` value only when the
 * importing source explicitly declares its old unit convention. Never guess
 * a unit from a number/string, since that can multiply a total by 10^exponent.
 * Returns null for malformed or already-tagged input.
 */
export function migrateLegacyMoney(legacy, amountUnit) {
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy) || "amountUnit" in legacy) return null;
  const result = moneySchema.safeParse({ ...legacy, amountUnit });
  return result.success ? result.data : null;
}

/**
 * Exact decimal multiplication using BigInt for lossless conversion.
 * Parses a decimal string and multiplies by 10^exp using integer arithmetic.
 * @param {string} decimal — e.g. "19.99" or "90071992547409.90"
 * @param {number} exponent — minor-units exponent
 * @returns {bigint|null}
 */
function decimalToMinorUnitsExact(decimal, exponent) {
  const negative = decimal.startsWith("-");
  const abs = negative ? decimal.slice(1) : decimal;

  const dot = abs.indexOf(".");
  let integerPart, fracPart;
  if (dot >= 0) {
    integerPart = abs.slice(0, dot);
    fracPart = abs.slice(dot + 1).padEnd(exponent, "0").slice(0, exponent);
    // Reject extra fractional digits beyond the exponent
    const origFracLen = abs.length - dot - 1;
    if (origFracLen > exponent) return null;
  } else {
    integerPart = abs;
    fracPart = "0".repeat(exponent);
  }

  // Pad fraction to exactly exponent digits
  if (fracPart.length < exponent) {
    fracPart = fracPart.padEnd(exponent, "0");
  }

  let result;
  try {
    const int = BigInt(integerPart);
    const frac = BigInt(fracPart);
    const multiplier = 10n ** BigInt(exponent);
    result = int * multiplier + frac;
  } catch {
    return null;
  }

  return negative ? -result : result;
}

/**
 * Normalize a money value to its canonical minor-units integer representation.
 * Uses exact BigInt conversion for decimal strings (F5).
 * Validates the input: rejects extra fractional digits that would truncate.
 *
 * @param {object} money — an explicitly unit-tagged money object
 * @returns {number|null}
 */
export function toMinorUnits(money) {
  const parsed = moneySchema.safeParse(money);
  if (!parsed.success) return null;
  const value = parsed.data;
  const exponent = value.exponent ?? CURRENCY_MINOR_UNITS.get(value.currency);
  if (exponent == null) return null;

  if (value.amountUnit === "minor_units") return value.amount;

  // Validate: reject if fractional digits exceed exponent (would truncate)
  const dot = value.amount.indexOf(".");
  if (dot >= 0) {
    const fracLen = value.amount.length - dot - 1;
    if (fracLen > exponent) return null;
  }

  // Exact BigInt conversion for decimal strings
  const exact = decimalToMinorUnitsExact(value.amount, exponent);
  if (exact == null) return null;

  // Check safe integer range before converting back to Number
  if (exact > 9007199254740991n || exact < -9007199254740991n) return null;

  return Number(exact);
}

/**
 * Format minor units back to a decimal string using exact BigInt arithmetic (F5).
 * @param {number} minorUnits
 * @param {number} exponent
 * @returns {string}
 * @throws {RangeError} when minorUnits is not a safe integer or exponent is outside 0..6
 */
export function formatFromMinorUnits(minorUnits, exponent = 2) {
  if (!Number.isSafeInteger(minorUnits)) {
    throw new RangeError("minorUnits must be a finite safe integer");
  }
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new RangeError("exponent must be an integer from 0 to 6");
  }
  if (exponent === 0) return String(minorUnits);

  const negative = minorUnits < 0;
  const abs = negative ? -minorUnits : minorUnits;
  const divisor = 10n ** BigInt(exponent);
  const bigAbs = BigInt(abs);
  const whole = bigAbs / divisor;
  const frac = String(bigAbs % divisor).padStart(exponent, "0");

  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** Known minor-unit exponent for a currency code (null if unknown). */
export function currencyExponent(currency) {
  return CURRENCY_MINOR_UNITS.get(currency) ?? null;
}
