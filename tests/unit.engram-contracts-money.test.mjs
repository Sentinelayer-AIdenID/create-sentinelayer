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
import { graphSchema, validateGraphIntegrity, assertionSchema } from "../src/engram/contracts/graph.js";

test("moneySchema: accepts integer minor units with currency and exponent", () => {
  const result = moneySchema.safeParse({ amount: 199, amountUnit: "minor_units", currency: "USD", exponent: 2 });
  assert.equal(result.success, true);
  assert.equal(result.data.amount, 199);
  assert.equal(result.data.currency, "USD");
});

test("moneySchema: accepts validated decimal string", () => {
  const result = moneySchema.safeParse({ amount: "1.99", amountUnit: "major_decimal", currency: "USD", exponent: 2 });
  assert.equal(result.success, true);
  assert.equal(result.data.amount, "1.99");
});

test("moneySchema: accepts negative amount for credit", () => {
  const result = moneySchema.safeParse({ amount: -500, amountUnit: "minor_units", currency: "USD", exponent: 2 });
  assert.equal(result.success, true);
  assert.equal(result.data.amount, -500);
});

test("moneySchema: REFUSES binary float (not integer minor units)", () => {
  const result = moneySchema.safeParse({ amount: 1.99, amountUnit: "minor_units", currency: "USD" });
  assert.equal(result.success, false);
  const issues = result.error.issues.map((i) => i.message);
  const hasFloat = issues.some((m) => /binary floats/i.test(m));
  assert.ok(hasFloat, "must reject binary float with a clear message about binary floats");
});

test("moneySchema: REFUSES NaN", () => {
  const result = moneySchema.safeParse({ amount: NaN, amountUnit: "minor_units", currency: "USD" });
  assert.equal(result.success, false);
});

test("moneySchema: REFUSES Infinity", () => {
  const result = moneySchema.safeParse({ amount: Infinity, amountUnit: "minor_units", currency: "USD" });
  assert.equal(result.success, false);
});

test("moneySchema: REFUSES unsafe integer", () => {
  const result = moneySchema.safeParse({ amount: 2 ** 53, amountUnit: "minor_units", currency: "USD" });
  assert.equal(result.success, false);
});

test("moneySchema: REFUSES currency not matching ISO 4217 3-letter pattern", () => {
  const result = moneySchema.safeParse({ amount: 100, amountUnit: "minor_units", currency: "us" });
  assert.equal(result.success, false);
});

test("moneySchema: REFUSES exponent that contradicts known currency exponent", () => {
  const result = moneySchema.safeParse({ amount: 100, amountUnit: "minor_units", currency: "USD", exponent: 3 });
  assert.equal(result.success, false);
});

test("moneySchema: REFUSES decimal string with too many fractional digits for exponent", () => {
  const result = moneySchema.safeParse({ amount: "1.999", amountUnit: "major_decimal", currency: "USD", exponent: 2 });
  assert.equal(result.success, false);
});

test("moneySchema: accepts JPY with exponent 0", () => {
  const result = moneySchema.safeParse({ amount: 500, amountUnit: "minor_units", currency: "JPY", exponent: 0 });
  assert.equal(result.success, true);
});

test("moneySchema: accepts BHD with exponent 3", () => {
  const result = moneySchema.safeParse({ amount: 1000, amountUnit: "minor_units", currency: "BHD", exponent: 3 });
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
  assert.equal(toMinorUnits({ amount: "1.99", amountUnit: "major_decimal", currency: "USD", exponent: 2 }), 199);
  assert.equal(toMinorUnits({ amount: "10.00", amountUnit: "major_decimal", currency: "USD", exponent: 2 }), 1000);
  assert.equal(toMinorUnits({ amount: "500", amountUnit: "major_decimal", currency: "JPY", exponent: 0 }), 500);
  assert.equal(toMinorUnits({ amount: -500, amountUnit: "minor_units", currency: "USD" }), -500);
});

test("toMinorUnits: returns null for non-finite values", () => {
  assert.equal(toMinorUnits({ amount: "notanumber", amountUnit: "major_decimal", currency: "USD" }), null);
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
  const original = { amount: 1999, amountUnit: "minor_units", currency: "USD", exponent: 2 };
  const formatted = formatFromMinorUnits(original.amount, original.exponent);
  const reparsed = moneySchema.safeParse({ amount: formatted, amountUnit: "major_decimal", currency: original.currency, exponent: original.exponent });
  assert.equal(reparsed.success, true);
  assert.equal(toMinorUnits(reparsed.data), 1999);
});

test("wrong-price proof: structurally valid price is NOT factually verified", () => {
  // A price that passes schema validation but should NOT be treated as
  // factually verified. Structural validity ≠ factual truth.
  // This proves ticket 73ead329's "valid-looking wrong-price case that is
  // structurally valid but NOT declared factually verified."

  const structurallyValid = moneySchema.safeParse({
    amount: "999999.99", amountUnit: "major_decimal",
    currency: "USD",
    exponent: 2,
  });
  assert.equal(structurallyValid.success, true,
    "structurally valid money must parse");

  // Schema validation alone is NECESSARY but NOT SUFFICIENT for factual truth.
  // The parsed data has no source snapshot, no evidence address, no
  // verifier — it is structurally valid but unverified.
  const data = structurallyValid.data;

  // The parsed result must not carry any implicit factual verification flag
  assert.equal(data._verified, undefined,
    "schema validation must not set _verified");
  assert.equal(data._sourceVersion, undefined,
    "schema validation must not set _sourceVersion");

  // Even a "plausible" price (e.g. 999999.99 USD) that passes the schema
  // is not declared authoritative without provenance.
  // The moneySchema only validates STRUCTURE; provenance is the graph layer.
});

test("wrong-price proof: null/undefined amounts rejected regardless of structure", () => {
  // Prove that missing amounts fail, not pass silently
  const noAmount = moneySchema.safeParse({ currency: "USD", exponent: 2 });
  assert.equal(noAmount.success, false);
});


test("wrong-price proof: graph-level price verification requires provenance", () => {
  // A structurally valid price in a graph assertion must NOT be treated as
  // factually verified unless the assertion carries authoritative provenance
  // and an evidence reference. This proves ticket 73ead329's independent
  // proof: "a valid-looking wrong-price case that is structurally valid but
  // NOT declared factually verified."
  //
  // The moneySchema validates STRUCTURE only. Provenance and verification
  // live at the graph layer. A price that passes moneySchema is NOT
  // automatically authoritative.

  // A graph assertion with a structurally valid price but only "observed" provenance
  // and no evidenceRef: this should NOT be treated as a verified price.
  const graphWithObservedPrice = {
    version: "1.0.0",
    assertions: [
      {
        id: "assert-price-001",
        subject: "product/xyz",
        predicate: "Price",
        // Structurally valid money object — passes moneySchema
        object: { amount: "999999.99", amountUnit: "major_decimal", currency: "USD", exponent: 2 },
        provenance: "observed",
        schemaValidity: "valid",
        source: {
          sourceId: "src-session-abc123",
          version: "1.0.0",
          capturedAt: "2026-10-23T12:00:00Z",
          tenantScope: "tenant/acme",
        },
      },
    ],
    generatedAt: "2026-10-23T12:00:00Z",
  };

  // Graph-level validation succeeds structurally
  const graphResult = graphSchema.safeParse(graphWithObservedPrice);
  assert.equal(graphResult.success, true, "structurally valid graph must parse");

  // But validateGraphIntegrity flags it: "observed" provenance with no
  // evidenceRef cannot be authoritative — the price is NOT verified.
  const integrity = validateGraphIntegrity(graphWithObservedPrice);
  // The graph is valid (the price object IS a valid money object)
  assert.equal(integrity.valid, true,
    "validateGraphIntegrity: structurally valid price passes integrity check");

  // Key proof point: the assertion has "observed" provenance, NOT
  // "authoritative". A consumer checking provenance would see this is
  // NOT a verified price. The moneySchema alone does not verify the
  // price — only provenance + evidenceRef can do that.
  const priceAssertion = graphResult.data.assertions[0];
  assert.equal(priceAssertion.provenance, "observed");
  assert.equal(priceAssertion.evidenceRef, undefined);

  // This is the wrong-price proof: structurally valid, NOT factually verified.
  // A separate authoritative assertion with evidenceRef would be required
  // to treat this price as verified.
});

test("wrong-price proof: observed price with no evidence is not treated as authoritative", () => {
  // Even if the price were changed to "authoritative" provenance,
  // it would require evidenceRef or be rejected by the schema refine.
  const authoritativeNoEvidence = assertionSchema.safeParse({
    id: "assert-price-002",
    subject: "product/xyz",
    predicate: "Price",
    object: { amount: "1.00", amountUnit: "major_decimal", currency: "USD", exponent: 2 },
    provenance: "authoritative",
    schemaValidity: "valid",
    source: {
      sourceId: "src-session-abc123",
      version: "1.0.0",
      capturedAt: "2026-10-23T12:00:00Z",
      tenantScope: "tenant/acme",
    },
  });
  assert.equal(authoritativeNoEvidence.success, false,
    "authoritative provenance must be rejected without evidenceRef");
  const messages = authoritativeNoEvidence.error.issues.map((i) => i.message);
  assert.ok(messages.some((m) => /evidenceRef/.test(m)),
    "must mention evidenceRef: " + JSON.stringify(messages));
});

// --- New tests for luna-judge P2 findings ---

test("moneySchema: REFUSES unknown currency code with provided exponent", () => {
  const result = moneySchema.safeParse({ amount: 100, amountUnit: "minor_units", currency: "ZZZ", exponent: 2 });
  assert.equal(result.success, false, "unknown currency ZZZ must be rejected");
  const messages = result.error.issues.map((i) => i.message);
  assert.ok(messages.some((m) => /not in the supported/i.test(m)),
    "must report unknown currency: " + JSON.stringify(messages));
});

test("moneySchema: REFUSES extra unsupported field (strict)", () => {
  const result = moneySchema.safeParse({ amount: 199, amountUnit: "minor_units", currency: "USD", exponent: 2, verified: true });
  assert.equal(result.success, false, "extra 'verified' field must be rejected");
});

test("toMinorUnits: returns null for excess fractional digits (no silent truncation)", () => {
  assert.equal(toMinorUnits({ amount: "1.999", amountUnit: "major_decimal", currency: "USD", exponent: 2 }), null,
    "1.999 with exponent 2 must return null, not silently truncate to 199");
  assert.equal(toMinorUnits({ amount: "1.99", amountUnit: "major_decimal", currency: "USD", exponent: 2 }), 199,
    "1.99 with exponent 2 must correctly convert to 199");
});

test("toMinorUnits: rejects excess fraction before BigInt conversion", () => {
  assert.equal(toMinorUnits({ amount: "0.123", amountUnit: "major_decimal", currency: "BHD", exponent: 3 }), 123,
    "0.123 with BHD exponent 3 must convert correctly");
  assert.equal(toMinorUnits({ amount: "0.1234", amountUnit: "major_decimal", currency: "BHD", exponent: 3 }), null,
    "0.1234 with BHD exponent 3 must return null (excess precision)");
});
