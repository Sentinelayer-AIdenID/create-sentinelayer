import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { entitySchema, graphSchema, linkSchema, validateGraphIntegrity } from "../src/engram/contracts/graph.js";
import { sourceSnapshotSchema, VALID_SOURCE_SNAPSHOT } from "../src/engram/contracts/source-snapshot.js";
import { capabilityEntrySchema, negotiateCapability } from "../src/engram/contracts/capability.js";

const at = "2026-10-23T12:00:00Z";
const source = { sourceId: "catalog", version: "1.0.0", capturedAt: at, tenantScope: "tenant/acme" };
const quantity = { kind: "quantity", value: 19.99, unit: "count" };
const price = { amount: "19.99", amountUnit: "major_decimal", currency: "USD", exponent: 2 };
const entity = (attributes, overrides = {}) => ({
  id: "product-1", type: "product", tenantScope: "tenant/acme",
  sourceId: source.sourceId, sourceVersion: source.version, capturedAt: at,
  provenance: "observed", attributes, ...overrides,
});
const assertion = (predicate, object, overrides = {}) => ({
  id: "fact-1", subject: "product-1", predicate, object,
  provenance: "observed", schemaValidity: "valid", source, ...overrides,
});
const graph = (overrides = {}) => ({
  version: "1.0.0", generatedAt: at, assertions: [], ...overrides,
});

test("merchant metadata strings and booleans do not become money by compound name", () => {
  const ordinary = {
    costCenter: "CC-12", priceTier: "gold", feeSchedule: "monthly",
    refundPolicy: "30 days", budgetOwner: "alice", paymentTerms: "net 30",
    balanceSheetUrl: "https://x", taxExempt: true,
  };
  for (const [name, value] of Object.entries(ordinary)) {
    assert.equal(validateGraphIntegrity(graph({ entities: [entity({ [name]: value })] })).valid,
      true, `entity ${name} is descriptive metadata`);
    assert.equal(validateGraphIntegrity(graph({ assertions: [assertion(name, value)] })).valid,
      true, `assertion ${name} is descriptive metadata`);
  }
  for (const name of ["price", "PRICE", "prices"]) {
    assert.equal(validateGraphIntegrity(graph({ assertions: [assertion(name, "19.99")] })).valid,
      false, `single-token monetary predicate ${name} remains strict`);
  }
});

test("plural monetary names cannot launder a count quantity", () => {
  for (const name of ["prices", "fees", "totals", "amounts", "costs", "taxes", "refunds", "lineItemPrices"]) {
    assert.equal(validateGraphIntegrity(graph({ entities: [entity({ [name]: [quantity] })] })).valid,
      false, `entity ${name}`);
    assert.equal(validateGraphIntegrity(graph({ assertions: [assertion(name, quantity)] })).valid,
      false, `assertion ${name}`);
  }
  for (const name of ["prices", "lineItemPrices"]) {
    assert.equal(validateGraphIntegrity(graph({ entities: [entity({ [name]: [price] })] })).valid,
      true, `canonical money list remains usable under ${name}`);
    assert.equal(validateGraphIntegrity(graph({ assertions: [assertion(name, [price])] })).valid,
      true, `canonical money assertion list remains usable under ${name}`);
  }
  for (const name of ["totalCounts", "itemCounts"]) {
    assert.equal(validateGraphIntegrity(graph({ assertions: [assertion(name, quantity)] })).valid,
      true, `${name} is a nonmonetary measure`);
  }
  for (const name of ["totalDollars", "priceRate", "amountUsd", "grandTotal"]) {
    assert.equal(validateGraphIntegrity(graph({ assertions: [assertion(name, quantity)] })).valid,
      false, `${name} is monetary even with a count unit`);
  }
});

test("factual entity fields declare provenance; authority requires trusted evidence binding", () => {
  const wrong = { amount: "999.99", amountUnit: "major_decimal", currency: "USD", exponent: 2 };
  const withoutClass = entity({ Price: wrong }, { provenance: undefined });
  assert.equal(entitySchema.safeParse(withoutClass).success, false);
  assert.equal(validateGraphIntegrity(graph({ entities: [withoutClass] })).valid, false);

  const observed = entity({ Price: wrong });
  assert.equal(validateGraphIntegrity(graph({ entities: [observed] })).valid,
    true, "structural validity of an observed price does not claim factual authority");
  const unknown = entity({ Price: wrong }, { provenance: "unknown" });
  assert.equal(validateGraphIntegrity(graph({ entities: [unknown] })).valid, true);

  const evidenceRef = { address: "receipt:catalog-price", verifier: "trusted-catalog", verifiedAt: at };
  const authority = entity({ Price: wrong }, { provenance: "authoritative", evidenceRef });
  assert.equal(graphSchema.safeParse(graph({ entities: [authority] })).success, true);
  assert.equal(validateGraphIntegrity(graph({ entities: [authority] })).valid, false);
  const verifyEvidence = (fact, reference) =>
    reference.address === evidenceRef.address &&
    fact.sourceId === source.sourceId &&
    fact.sourceVersion === source.version &&
    JSON.stringify(fact.attributes?.Price) === JSON.stringify(price);
  assert.equal(validateGraphIntegrity(graph({ entities: [authority] }), { verifyEvidence }).valid,
    false, "wrong price cannot claim authority through metadata");
  assert.equal(validateGraphIntegrity(graph({
    entities: [entity({ Price: price }, { provenance: "authoritative", evidenceRef })],
  }), { verifyEvidence }).valid, true, "trusted verifier checks the exact entity payload");
  assert.equal(entitySchema.safeParse(entity({ Price: price }, {
    provenance: "authoritative", evidenceRef: undefined,
  })).success, false);
  assert.equal(entitySchema.safeParse(entity({ Price: price }, {
    provenance: "authoritative", evidenceRef: { ...evidenceRef, address: " " },
  })).success, false, "an empty-looking reference cannot structurally attest authority");
  assert.equal(entitySchema.safeParse(entity(undefined, { label: "Product", provenance: undefined })).success,
    false, "labels are factual content too");
});

test("isStale requires graph and assertion watermark plus TTL", () => {
  for (const freshness of [
    { isStale: false }, { asOf: at, isStale: false },
    { staleAfterMs: 1000, isStale: false },
  ]) {
    assert.equal(graphSchema.safeParse(graph({ freshness })).success, false,
      `graph freshness ${JSON.stringify(freshness)}`);
    assert.equal(graphSchema.safeParse(graph({
      assertions: [assertion("status", "open", { freshness })],
    })).success, false, `assertion freshness ${JSON.stringify(freshness)}`);
  }
  const grounded = { asOf: at, staleAfterMs: 1000, isStale: false };
  assert.equal(graphSchema.safeParse(graph({ freshness: grounded })).success, true);
  assert.equal(graphSchema.safeParse(graph({
    assertions: [assertion("status", "open", { freshness: grounded })],
  })).success, true);
});

test("source and capability identities reject blank and padded values", () => {
  for (const field of ["sourceId", "version", "tenantScope"]) {
    for (const value of [" ", "  ", " valid "]) {
      assert.equal(sourceSnapshotSchema.safeParse({ ...VALID_SOURCE_SNAPSHOT, [field]: value }).success,
        false, `snapshot ${field}=${JSON.stringify(value)}`);
    }
  }
  const entry = {
    capability: "graph-read", version: "graph-read@1.0.0", status: "supported",
    source: {
      sourceId: "adapter", sourceType: "adapter", version: "adapter@1.0.0",
      tenantScope: "tenant/acme",
    },
  };
  for (const field of ["sourceId", "tenantScope"]) {
    assert.equal(capabilityEntrySchema.safeParse({
      ...entry, source: { ...entry.source, [field]: " " },
    }).success, false, `capability source ${field}`);
  }
  const result = negotiateCapability({
    capability: "graph-read", clientVersion: "graph-read@1.0.0",
    tenantScope: " ", serverCapabilities: [
      { ...entry, source: { ...entry.source, tenantScope: " " } },
    ],
  });
  assert.notEqual(result.result, "matched");
  assert.equal(result.negotiatedVersion, undefined);
  assert.equal(sourceSnapshotSchema.safeParse(VALID_SOURCE_SNAPSHOT).success, true);
});

test("graph fact IDs and evidence addresses cannot be blank-looking", () => {
  for (const field of ["subject", "predicate"]) {
    assert.equal(graphSchema.safeParse(graph({
      assertions: [assertion("status", "open", { [field]: " " })],
    })).success, false, field);
  }
  for (const field of ["source", "target", "predicate", "evidenceAddress"]) {
    const candidate = {
      source: "product-1", target: "fact-1", predicate: "supports",
      provenance: "authoritative", tenantScope: "tenant/acme",
      sourceId: "catalog", sourceVersion: "1.0.0", capturedAt: at,
      evidenceAddress: "receipt:catalog-price", [field]: " ",
    };
    assert.equal(linkSchema.safeParse(candidate).success, false, field);
  }
});

test("compound money names reject string-encoded prices in assertions and entities", () => {
  const disguisedPrices = {
    grandTotal: "19.99",
    totalDollars: "$19.99",
    amountUsd: "USD 19.99",
    priceRate: "19.99 USD",
    purchase_total: "19.99",
    lineItemPrices: "19.99",
    grossTotal: "free",
    totalEuro: "unknown",
    pricePerUnit: "TBD",
    basePriceRate: "low",
  };
  for (const [name, value] of Object.entries(disguisedPrices)) {
    assert.equal(validateGraphIntegrity(graph({ assertions: [assertion(name, value)] })).valid,
      false, `assertion ${name} must use canonical money`);
    assert.equal(validateGraphIntegrity(graph({ entities: [entity({ [name]: value })] })).valid,
      false, `entity ${name} must use canonical money`);
  }
  for (const [name, value] of [
    ["grandTotal", "free"], ["totalDollars", "unknown"],
    ["amountUsd", "TBD"], ["priceRate", "low"],
  ]) {
    assert.equal(validateGraphIntegrity(graph({ assertions: [assertion(name, value)] })).valid,
      false, `assertion ${name} is monetary even without digits`);
    assert.equal(validateGraphIntegrity(graph({ entities: [entity({ [name]: value })] })).valid,
      false, `entity ${name} is monetary even without digits`);
  }
});

test("compact monetary aliases and amount-like metadata require canonical money", () => {
  for (const [name, value] of Object.entries({
    grandtotal: "19.99", GRANDTOTAL: "19.99", purchaseprice: "19.99",
    shippingcost: "19.99", orderamount: "19.99", lineitemprices: "19.99",
    totaldollars: "19.99", priceNumber: "19.99", pricenumber: "19.99",
    priceTier: quantity,
  })) {
    assert.equal(validateGraphIntegrity(graph({ assertions: [assertion(name, value)] })).valid,
      false, `assertion ${name} cannot disguise money`);
    assert.equal(validateGraphIntegrity(graph({ entities: [entity({ [name]: value })] })).valid,
      false, `entity ${name} cannot disguise money`);
  }
  for (const [name, value] of Object.entries({
    grandtotal: price, lineitemprices: [price], priceNumber: price,
    orderNumber: "PO-12", priceTier: "gold",
    costCenter: "CC-12", paymentTerms: "net 30", totalcount: quantity,
  })) {
    assert.equal(validateGraphIntegrity(graph({ assertions: [assertion(name, value)] })).valid,
      true, `assertion ${name} remains valid`);
    assert.equal(validateGraphIntegrity(graph({ entities: [entity({ [name]: value })] })).valid,
      true, `entity ${name} remains valid`);
  }
});

test("ordinary compact words do not inherit monetary suffixes", () => {
  const ordinary = {
    percent: { kind: "quantity", value: 12.5, unit: "percent" },
    recent: "2026-10-23", scent: "citrus", coffee: "arabica",
    syntax: "json", nonprofit: "registered",
  };
  for (const [name, value] of Object.entries(ordinary)) {
    assert.equal(validateGraphIntegrity(graph({ assertions: [assertion(name, value)] })).valid,
      true, `assertion ${name} is not a monetary fact`);
    assert.equal(validateGraphIntegrity(graph({ entities: [entity({ [name]: value })] })).valid,
      true, `entity ${name} is not a monetary fact`);
  }
});

test("even unknown links in a servable graph identify source, version and time", () => {
  const nodes = ["left", "right"].map((id) => ({
    id, type: "item", tenantScope: "tenant/acme",
    sourceId: "catalog", sourceVersion: "1.0.0",
  }));
  const link = {
    source: "left", target: "right", predicate: "related", provenance: "unknown",
    tenantScope: "tenant/acme", sourceId: "catalog",
    sourceVersion: "1.0.0", capturedAt: at,
  };
  assert.equal(validateGraphIntegrity(graph({ entities: nodes, links: [link] })).valid,
    true, "unknown provenance is allowed when the link remains traceable");
  for (const field of ["sourceId", "sourceVersion", "capturedAt"]) {
    const missing = { ...link };
    delete missing[field];
    assert.equal(linkSchema.safeParse(missing).success, false, `${field} is required`);
    assert.equal(validateGraphIntegrity(graph({ entities: nodes, links: [missing] })).valid,
      false, `untraceable ${field} must not be served by a graph`);
  }
});

test("structured merchant metadata remains usable under semantic metadata names", () => {
  const descriptiveFields = {
    refundPolicy: { returnWindow: "30 days" },
    feeSchedule: ["monthly"],
    paymentTerms: { netDays: "30" },
    taxExempt: { eligible: true },
    costCenter: { code: "CC-12" },
    refundWindow: "30 days",
  };
  for (const [name, value] of Object.entries(descriptiveFields)) {
    assert.equal(validateGraphIntegrity(graph({ assertions: [assertion(name, value)] })).valid,
      true, `assertion ${name} is merchant metadata`);
    assert.equal(validateGraphIntegrity(graph({ entities: [entity({ [name]: value })] })).valid,
      true, `entity ${name} is merchant metadata`);
  }
  assert.equal(validateGraphIntegrity(graph({
    entities: [entity({ refundPolicy: { refundAmount: quantity } })],
  })).valid, false, "metadata exemption must still validate nested money facts");
});

test("entity evidence cannot claim verification after graph generation", () => {
  const evidenceRef = {
    address: "receipt:catalog-price", verifier: "trusted-catalog",
    verifiedAt: "2026-10-23T12:00:01Z",
  };
  for (const provenance of ["observed", "authoritative"]) {
    const futureEvidence = graph({ entities: [entity({ Price: price }, { provenance, evidenceRef })] });
    assert.equal(graphSchema.safeParse(futureEvidence).success, false,
      `${provenance} entity evidence cannot postdate graph generation`);
  }
  assert.equal(graphSchema.safeParse(graph({ entities: [entity({ Price: price }, {
    provenance: "authoritative", evidenceRef: { ...evidenceRef, verifiedAt: at },
  })] })).success, true, "evidence at generation time is allowed");
});

test("MSRP aliases require canonical money in assertions and entity attributes", () => {
  for (const name of ["MSRP", "msrp", "Msrp", "productMSRP"]) {
    assert.equal(validateGraphIntegrity(graph({ assertions: [assertion(name, "19.99")] })).valid,
      false, `assertion ${name} cannot encode MSRP as an untyped string`);
    assert.equal(validateGraphIntegrity(graph({ entities: [entity({ [name]: "19.99" })] })).valid,
      false, `entity ${name} cannot encode MSRP as an untyped string`);
    assert.equal(validateGraphIntegrity(graph({ assertions: [assertion(name, price)] })).valid,
      true, `assertion ${name} accepts canonical money`);
    assert.equal(validateGraphIntegrity(graph({ entities: [entity({ [name]: price })] })).valid,
      true, `entity ${name} accepts canonical money`);
  }
});
