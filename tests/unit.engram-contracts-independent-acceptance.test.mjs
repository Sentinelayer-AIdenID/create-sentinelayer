import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  moneySchema, migrateLegacyMoney, toMinorUnits, taskContextPackSchema, VALID_TASK_CONTEXT_PACK,
  capabilityEntrySchema, negotiateCapability, evidenceRecordSchema,
  evidencePageSchema, graphSchema, quantitySchema, validateGraphIntegrity,
} from "../src/engram/contracts/index.js";

test("money requires an explicit amount unit and refuses mismatched representations", () => {
  const minor = { amount: 1999, amountUnit: "minor_units", currency: "USD", exponent: 2 };
  const major = { amount: "19.99", amountUnit: "major_decimal", currency: "USD", exponent: 2 };
  assert.equal(moneySchema.safeParse(minor).success, true);
  assert.equal(moneySchema.safeParse(major).success, true);
  assert.equal(toMinorUnits(minor), 1999);
  assert.equal(toMinorUnits(major), 1999);
  for (const candidate of [
    { amount: 1999, currency: "USD", exponent: 2 },
    { amount: "19.99", currency: "USD", exponent: 2 },
    { ...minor, amountUnit: "major_decimal" },
    { ...major, amountUnit: "minor_units" },
  ]) {
    assert.equal(moneySchema.safeParse(candidate).success, false);
    assert.equal(toMinorUnits(candidate), null);
  }
});

test("legacy money migration requires an explicit source unit convention", () => {
  const legacy = { amount: 1999, currency: "USD", exponent: 2 };
  assert.equal(migrateLegacyMoney(legacy), null);
  assert.equal(migrateLegacyMoney(legacy, "major_decimal"), null);
  assert.deepEqual(migrateLegacyMoney(legacy, "minor_units"), {
    ...legacy, amountUnit: "minor_units",
  });
});

test("task pack uses the pinned contract version and possible source/expiry instants", () => {
  assert.equal(taskContextPackSchema.safeParse(VALID_TASK_CONTEXT_PACK).success, true);
  for (const candidate of [
    { ...VALID_TASK_CONTEXT_PACK, version: "bogus" },
    { ...VALID_TASK_CONTEXT_PACK, version: "0.9.0" },
    { ...VALID_TASK_CONTEXT_PACK, expiresAt: "2026-10-23T11:59:59Z" },
    { ...VALID_TASK_CONTEXT_PACK, sourceSnapshot: {
      ...VALID_TASK_CONTEXT_PACK.sourceSnapshot, capturedAt: "2026-10-24T12:00:00Z",
    } },
  ]) {
    assert.equal(taskContextPackSchema.safeParse(candidate).success, false);
  }
});

test("task pack cannot delegate a capability it did not declare", () => {
  const delegated = { delegateId: "agent/other", capability: "admin-write@1.0.0" };
  assert.equal(taskContextPackSchema.safeParse({
    ...VALID_TASK_CONTEXT_PACK, delegations: [delegated],
  }).success, false);
  assert.equal(taskContextPackSchema.safeParse({
    ...VALID_TASK_CONTEXT_PACK, capabilities: undefined, delegations: [delegated],
  }).success, false);
  assert.equal(taskContextPackSchema.safeParse({
    ...VALID_TASK_CONTEXT_PACK,
    capabilities: ["admin-write@1.0.0"], delegations: [delegated],
  }).success, true);
});

const serverEntry = {
  capability: "graph-read", version: "graph-read@1.0.0", status: "supported",
  source: { sourceId: "adapter-a", sourceType: "adapter", version: "adapter-a@1.0.0", tenantScope: "tenant/acme" },
};
const request = { capability: "graph-read", clientVersion: "graph-read@1.0.0", tenantScope: "tenant/acme" };

test("capability negotiation refuses conflicting records independent of list order", () => {
  assert.equal(capabilityEntrySchema.safeParse(serverEntry).success, true);
  const stale = { ...serverEntry, status: "stale" };
  for (const entries of [[serverEntry, stale], [stale, serverEntry]]) {
    const result = negotiateCapability({ ...request, serverCapabilities: entries });
    assert.equal(result.result, "incompatible");
    assert.equal(result.negotiatedVersion, undefined);
  }
});

test("evidence record and page reject impossible time and mixed-tenant records", () => {
  const address = {
    scheme: "receipt", locator: "r1", sourceVersion: "1.0.0",
    verifiedBy: "trusted-verifier", tenantScope: "tenant/acme",
    capturedAt: "2026-10-23T12:00:00Z",
  };
  const record = {
    address, payload: "payload", schemaVersion: "1.0.0",
    collectedAt: "2026-10-23T12:01:00Z", expiresAt: "2026-10-23T12:02:00Z",
  };
  assert.equal(evidenceRecordSchema.safeParse(record).success, true);
  assert.equal(evidenceRecordSchema.safeParse({ ...record, expiresAt: "2026-10-23T11:59:00Z" }).success, false);
  assert.equal(evidenceRecordSchema.safeParse({ ...record,
    address: { ...address, capturedAt: "2026-10-23T12:02:00Z" },
  }).success, false);
  assert.equal(evidencePageSchema.safeParse({
    items: [record, { ...record, address: { ...address, tenantScope: "tenant/beta" } }],
    hasMore: false,
  }).success, false);
});

test("graph generation cannot predate a fact capture or its freshness watermark", () => {
  const graph = {
    version: "1.0.0", generatedAt: "2026-10-23T12:00:00Z",
    entities: [{ id: "e1", type: "product", tenantScope: "tenant/acme", sourceId: "catalog", sourceVersion: "1.0.0" }],
    assertions: [{
      id: "a1", subject: "e1", predicate: "description", object: "sample",
      provenance: "observed", schemaValidity: "valid",
      source: { sourceId: "catalog", version: "1.0.0", capturedAt: "2026-10-23T12:00:00Z", tenantScope: "tenant/acme" },
    }],
  };
  assert.equal(graphSchema.safeParse(graph).success, true);
  assert.equal(graphSchema.safeParse({ ...graph, assertions: [{
    ...graph.assertions[0], source: { ...graph.assertions[0].source, capturedAt: "2026-10-23T12:00:01Z" },
  }] }).success, false);
  assert.equal(graphSchema.safeParse({ ...graph, freshness: { asOf: "2026-10-23T12:00:01Z" } }).success, false);
});

test("a typed quantity cannot disguise a monetary fact with a currency unit", () => {
  const currencyQuantity = { kind: "quantity", value: 19.99, unit: "usd" };
  assert.equal(quantitySchema.safeParse(currencyQuantity).success, false);
  const graph = {
    version: "1.0.0", generatedAt: "2026-10-23T12:00:00Z",
    assertions: [{
      id: "total-1", subject: "order-1", predicate: "grandTotal",
      object: currencyQuantity, provenance: "observed", schemaValidity: "valid",
      source: { sourceId: "order-api", version: "1.0.0", capturedAt: "2026-10-23T12:00:00Z", tenantScope: "tenant/acme" },
    }],
  };
  assert.equal(validateGraphIntegrity(graph).valid, false);
});
