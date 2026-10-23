import "./setup-env.mjs";
// unit.engram-contracts-money.test.mjs — EW02 money contract tests (steps 9, 10).

import test from "node:test";
import assert from "node:assert/strict";

import {
  moneySchema,
  minorUnitsSchema,
  decimalStringSchema,
  toMinorUnits,
  formatFromMinorUnits,
  currencyExponent,
} from "../src/engram/contracts/money.js";

test("moneySchema: accepts integer minor units with currency and exponent", () => {
  const result = moneySchema.safeParse({ amount: 199, currency: "USD", exponent: 2 });
  assert.equal(result.success, true);
  assert.equal(result.data.amount, 199);
  assert.equal(result.data.currency, "USD");
});

test("moneySchema: accepts validated decimal string", () => {
  const result = moneySchema.safeParse({ amount: "1.99", currency: "USD", exponent: 2 });
  assert.equal(result.success, true);
  assert.equal(result.data.amount, "1.99");
});

test("moneySchema: accepts negative amount for credit", () => {
  const result = moneySchema.safeParse({ amount: -500, currency: "USD", exponent: 2 });
  assert.equal(result.success, true);
  assert.equal(result.data.amount, -500);
});

test("moneySchema: REFUSES binary float (not integer minor units)", () => {
  const result = moneySchema.safeParse({ amount: 1.99, currency: "USD" });
  assert.equal(result.success, false);
  const issues = result.error.issues.map((i) => i.message);
  const hasFloat = issues.some((m) => /binary floats/i.test(m));
  assert.ok(hasFloat, "must reject binary float with a clear message about binary floats");
});

test("moneySchema: REFUSES NaN", () => {
  const result = moneySchema.safeParse({ amount: NaN, currency: "USD" });
  assert.equal(result.success, false);
});

test("moneySchema: REFUSES Infinity", () => {
  const result = moneySchema.safeParse({ amount: Infinity, currency: "USD" });
  assert.equal(result.success, false);
});

test("moneySchema: REFUSES unsafe integer", () => {
  const result = moneySchema.safeParse({ amount: 2 ** 53, currency: "USD" });
  assert.equal(result.success, false);
});

test("moneySchema: REFUSES currency not matching ISO 4217 3-letter pattern", () => {
  const result = moneySchema.safeParse({ amount: 100, currency: "us" });
  assert.equal(result.success, false);
});

test("moneySchema: REFUSES exponent that contradicts known currency exponent", () => {
  const result = moneySchema.safeParse({ amount: 100, currency: "USD", exponent: 3 });
  assert.equal(result.success, false);
});

test("moneySchema: REFUSES decimal string with too many fractional digits for exponent", () => {
  const result = moneySchema.safeParse({ amount: "1.999", currency: "USD", exponent: 2 });
  assert.equal(result.success, false);
});

test("moneySchema: accepts JPY with exponent 0", () => {
  const result = moneySchema.safeParse({ amount: 500, currency: "JPY", exponent: 0 });
  assert.equal(result.success, true);
});

test("moneySchema: accepts BHD with exponent 3", () => {
  const result = moneySchema.safeParse({ amount: 1000, currency: "BHD", exponent: 3 });
  assert.equal(result.success, true);
});

test("decimalStringSchema: accepts valid decimal strings", () => {
  assert.equal(decimalStringSchema.safeParse("0").success, true);
  assert.equal(decimalStringSchema.safeParse("1.99").success, true);
  assert.equal(decimalStringSchema.safeParse("100").success, true);
  assert.equal(decimalStringSchema.safeParse("-50.25").success, true);
});

test("decimalStringSchema: REFUSES scientific notation", () => {
  assert.equal(decimalStringSchema.safeParse("1e5").success, false);
  assert.equal(decimalStringSchema.safeParse("1.5e10").success, false);
});

test("decimalStringSchema: REFUSES leading zeros on non-zero integer", () => {
  assert.equal(decimalStringSchema.safeParse("01").success, false);
});

test("toMinorUnits: converts decimal string to integer minor units", () => {
  assert.equal(toMinorUnits({ amount: "1.99", currency: "USD", exponent: 2 }), 199);
  assert.equal(toMinorUnits({ amount: "10.00", currency: "USD", exponent: 2 }), 1000);
  assert.equal(toMinorUnits({ amount: "500", currency: "JPY", exponent: 0 }), 500);
  assert.equal(toMinorUnits({ amount: -500, currency: "USD" }), -500);
});

test("toMinorUnits: returns null for non-finite values", () => {
  assert.equal(toMinorUnits({ amount: "notanumber", currency: "USD" }), null);
});

test("formatFromMinorUnits: formats minor units to decimal string", () => {
  assert.equal(formatFromMinorUnits(199, 2), "1.99");
  assert.equal(formatFromMinorUnits(1000, 2), "10.00");
  assert.equal(formatFromMinorUnits(-500, 2), "-5.00");
  assert.equal(formatFromMinorUnits(500, 0), "500");
  assert.equal(formatFromMinorUnits(1000, 3), "1.000");
});

test("currencyExponent: returns known exponent for ISO codes", () => {
  assert.equal(currencyExponent("USD"), 2);
  assert.equal(currencyExponent("JPY"), 0);
  assert.equal(currencyExponent("BHD"), 3);
  assert.equal(currencyExponent("CLF"), 4);
  assert.equal(currencyExponent("XXX"), null);
});

test("moneySchema round-trip: integer minor units -> format -> parse -> same integer", () => {
  const original = { amount: 1999, currency: "USD", exponent: 2 };
  const formatted = formatFromMinorUnits(original.amount, original.exponent);
  const reparsed = moneySchema.safeParse({ amount: formatted, currency: original.currency, exponent: original.exponent });
  assert.equal(reparsed.success, true);
  assert.equal(toMinorUnits(reparsed.data), 1999);
});
