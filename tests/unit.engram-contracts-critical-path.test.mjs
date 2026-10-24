import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyProvenance,
  graphSchema,
  validateGraphIntegrity,
} from "../src/engram/contracts/graph.js";
import {
  taskContextPackSchema,
  VALID_TASK_CONTEXT_PACK,
  temporalSegmentSchema,
  VALID_TEMPORAL_SEGMENT,
  validateNotScreenshotInferred,
} from "../src/engram/contracts/index.js";

const source = {
  sourceId: "source-1", version: "1.0.0",
  capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme",
};
const assertion = (overrides = {}) => ({
  id: "a1", subject: "e1", predicate: "description", object: "sample",
  provenance: "observed", schemaValidity: "valid", source, ...overrides,
});
const entity = (overrides = {}) => ({
  id: "e1", type: "item", tenantScope: "tenant/acme",
  sourceId: "source-1", sourceVersion: "1.0.0", ...overrides,
});
const graph = (overrides = {}) => ({
  version: "1.0.0", entities: [entity()], assertions: [assertion()],
  generatedAt: "2026-10-23T00:00:00Z", ...overrides,
});
const forgedReference = {
  address: "receipt:self-written", verifier: "self",
  verifiedAt: "2026-10-23T00:00:00Z",
};

test("caller flags and a forged reference cannot classify a claim as authoritative", () => {
  assert.equal(classifyProvenance({ id: "a1" }, {
    isVerified: true, evidenceRef: forgedReference,
  }), "unknown");
});

test("self-reported verifier names do not prove evidence source provenance", () => {
  const address = {
    scheme: "file", locator: "/tmp/candidate", sourceVersion: "v1",
    tenantScope: "tenant/acme", verifiedBy: "self",
  };
  assert.equal(validateNotScreenshotInferred(address).valid, false);
  assert.equal(validateNotScreenshotInferred(address, {
    verifySource: (candidate) => candidate === address,
  }).valid, true);
});

test("only an out-of-band verifier can promote a bound assertion", () => {
  const claim = assertion({ provenance: "authoritative", evidenceRef: forgedReference });
  const input = graph({ assertions: [claim] });
  assert.equal(validateGraphIntegrity(input).valid, false);
  assert.equal(validateGraphIntegrity(input, {
    verifyEvidence: (fact, reference) => fact.id === "a1" &&
      reference.address === "receipt:self-written" && fact.object === "sample",
  }).valid, true);
});

test("an authoritative link also needs an out-of-band verifier", () => {
  const link = {
    source: "e1", target: "a1", predicate: "supports",
    provenance: "authoritative", tenantScope: "tenant/acme",
    capturedAt: "2026-10-23T00:00:00Z", evidenceAddress: "receipt:self-written",
  };
  assert.equal(validateGraphIntegrity(graph({ links: [link] })).valid, false);
});

test("coverage rejects invented classes and counts that contradict assertions", () => {
  assert.equal(graphSchema.safeParse(graph({
    coverage: { totalAssertions: 1, byProvenance: { fabricated: 999 } },
  })).success, false);
  assert.equal(graphSchema.safeParse(graph({
    coverage: { totalAssertions: 1, byProvenance: { authoritative: 1 } },
  })).success, false);
  assert.equal(graphSchema.safeParse(graph({
    coverage: { totalAssertions: 1, bySchemaValidity: { invalid: 1 } },
  })).success, false);
});

test("graph rejects duplicate identifiers and dangling links", () => {
  assert.equal(graphSchema.safeParse(graph({ assertions: [assertion(), assertion()] })).success, false);
  assert.equal(graphSchema.safeParse(graph({ links: [{
    source: "e1", target: "missing", predicate: "supports", provenance: "unknown",
    tenantScope: "tenant/acme",
  }] })).success, false);
});

test("graph rejects facts and links crossing tenant scopes", () => {
  assert.equal(graphSchema.safeParse(graph({ assertions: [assertion({
    source: { ...source, tenantScope: "tenant/beta" },
  })] })).success, false);
  assert.equal(graphSchema.safeParse(graph({ links: [{
    source: "e1", target: "a1", predicate: "supports", provenance: "unknown",
    tenantScope: "tenant/beta",
  }] })).success, false);
});

test("unknown money names cannot carry ambiguous bare numeric facts", () => {
  const totals = graph({ entities: [entity({
    capturedAt: "2026-10-23T00:00:00Z",
    attributes: { grandTotal: 1.99, purchase_total: 1.99 },
  })] });
  assert.equal(validateGraphIntegrity(totals).valid, false);
  assert.equal(validateGraphIntegrity(graph({ assertions: [assertion({
    predicate: "grandTotal", object: 1.99,
  })] })).valid, false);
});

test("canonical money and explicitly typed non-money quantities pass", () => {
  const input = graph({ assertions: [
    assertion({ id: "a1", predicate: "grandTotal", object: {
      amount: "1.99", amountUnit: "major_decimal", currency: "USD", exponent: 2,
    } }),
    assertion({ id: "a2", predicate: "temperature", object: {
      kind: "quantity", value: 36.6, unit: "celsius",
    } }),
  ] });
  assert.equal(validateGraphIntegrity(input).valid, true);
});

test("a pack cannot grant itself cross-tenant source access", () => {
  assert.equal(taskContextPackSchema.safeParse({
    ...VALID_TASK_CONTEXT_PACK,
    sourceSnapshot: { ...VALID_TASK_CONTEXT_PACK.sourceSnapshot, tenantScope: "tenant/beta" },
    authorizedCrossTenant: ["tenant/beta"],
  }).success, false);
});

test("a temporal segment cannot relabel another tenant's source", () => {
  assert.equal(temporalSegmentSchema.safeParse({
    ...VALID_TEMPORAL_SEGMENT,
    tenantScope: "tenant/beta",
  }).success, false);
});
