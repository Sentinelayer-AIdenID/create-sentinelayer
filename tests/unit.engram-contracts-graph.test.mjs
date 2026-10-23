import "./setup-env.mjs";
// unit.engram-contracts-graph.test.mjs — EW02 graph contract tests (R02, R09).

import test from "node:test";
import assert from "node:assert/strict";

import {
  PROVENANCE_CLASSES,
  SCHEMA_VALIDITY,
  MODEL_CONFIDENCE,
  provenanceClassSchema,
  schemaValiditySchema,
  modelConfidenceSchema,
  entitySchema,
  linkSchema,
  freshnessSchema,
  assertionSchema,
  graphSchema,
  classifyProvenance,
  validateGraphIntegrity,
} from "../src/engram/contracts/graph.js";

test("PROVENANCE_CLASSES are exactly four frozen values", () => {
  assert.deepEqual(PROVENANCE_CLASSES, ["observed", "authoritative", "derived", "unknown"]);
  assert.throws(() => { PROVENANCE_CLASSES.push("fake"); }, TypeError);
});

test("provenanceClassSchema: accepts all four classes", () => {
  for (const c of PROVENANCE_CLASSES) {
    assert.equal(provenanceClassSchema.safeParse(c).success, true, `${c} must be accepted`);
  }
});

test("provenanceClassSchema: REFUSES fabricated value", () => {
  assert.equal(provenanceClassSchema.safeParse("fabricated").success, false);
  assert.equal(provenanceClassSchema.safeParse("").success, false);
});

test("schemaValiditySchema: accepts valid/invalid/unvalidated", () => {
  for (const s of SCHEMA_VALIDITY) {
    assert.equal(schemaValiditySchema.safeParse(s).success, true);
  }
});

test("modelConfidenceSchema: accepts high/medium/low/unavailable", () => {
  for (const m of MODEL_CONFIDENCE) {
    assert.equal(modelConfidenceSchema.safeParse(m).success, true);
  }
});

test("assertionSchema: validates a complete assertion with all classification fields", () => {
  const result = assertionSchema.safeParse({
    id: "a1",
    subject: "session:s1",
    predicate: "contains",
    object: { text: "hello" },
    provenance: "observed",
    schemaValidity: "valid",
    modelConfidence: "high",
    freshness: { asOf: "2026-10-23T00:00:00Z" },
    evidenceAddress: "engram://s1/obs/1",
    tenantScope: "tenant:acme",
    sourceVersion: "enrich-v2@1.0.0",
  });
  assert.equal(result.success, true);
});

test("assertionSchema: REFUSES assertion with fabricated provenance", () => {
  const result = assertionSchema.safeParse({
    id: "a1",
    subject: "x",
    predicate: "y",
    object: "z",
    provenance: "fake_class",
    schemaValidity: "valid",
  });
  assert.equal(result.success, false);
});

test("assertionSchema: REFUSES assertion with no provenance", () => {
  const result = assertionSchema.safeParse({
    id: "a1",
    subject: "x",
    predicate: "y",
    object: "z",
    schemaValidity: "valid",
  });
  assert.equal(result.success, false);
});

test("graphSchema: validates a complete versioned graph", () => {
  const result = graphSchema.safeParse({
    version: "1.0.0",
    assertions: [
      {
        id: "a1",
        subject: "session:s1",
        predicate: "contains",
        object: { text: "hello" },
        provenance: "observed",
        schemaValidity: "valid",
        modelConfidence: "high",
      },
      {
        id: "a2",
        subject: "session:s1",
        predicate: "summary",
        object: "session summary text",
        provenance: "derived",
        schemaValidity: "valid",
        modelConfidence: "medium",
      },
    ],
    entities: [
      { id: "session:s1", type: "session" },
    ],
    links: [
      {
        source: "a1",
        target: "a2",
        predicate: "supports",
        provenance: "derived",
      },
    ],
    coverage: {
      totalAssertions: 2,
      byProvenance: { observed: 1, derived: 1 },
      bySchemaValidity: { valid: 2 },
    },
    freshness: { asOf: "2026-10-23T00:00:00Z", coverageRatio: 1.0 },
    generatedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(result.success, true);
});

test("graphSchema: REFUSES graph without version", () => {
  const result = graphSchema.safeParse({
    assertions: [],
    generatedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(result.success, false);
});

test("graphSchema: REFUSES assertion with fabricated provenance inside graph", () => {
  const result = graphSchema.safeParse({
    version: "1.0.0",
    assertions: [{
      id: "a1",
      subject: "x",
      predicate: "y",
      object: "z",
      provenance: "made_up",
      schemaValidity: "valid",
    }],
    generatedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(result.success, false);
});

test("classifyProvenance: derived when derivedFrom has entries", () => {
  assert.equal(classifyProvenance({ id: "a1" }, { derivedFrom: ["a0"] }), "derived");
});

test("classifyProvenance: authoritative when verified with receipt", () => {
  assert.equal(classifyProvenance({ id: "a1" }, { isVerified: true }), "authoritative");
  assert.equal(classifyProvenance({ id: "a1" }, { hasReceipt: true }), "authoritative");
});

test("classifyProvenance: observed when observedAt is present", () => {
  assert.equal(classifyProvenance({ id: "a1" }, { observedAt: "2026-10-23T00:00:00Z" }), "observed");
});

test("classifyProvenance: unknown when nothing is known", () => {
  assert.equal(classifyProvenance({ id: "a1" }, {}), "unknown");
  assert.equal(classifyProvenance(null), "unknown");
});

test("validateGraphIntegrity: rejects binary floats in assertion objects", () => {
  const { valid, errors } = validateGraphIntegrity({
    version: "1.0.0",
    assertions: [{
      id: "a1",
      subject: "x",
      predicate: "cost",
      object: { total: 1.99 },
      provenance: "observed",
      schemaValidity: "valid",
    }],
  });
  assert.equal(valid, false);
  const hasFloat = errors.some((e) => /binary float/i.test(e));
  assert.ok(hasFloat, "must reject binary float in assertion object: " + JSON.stringify(errors));
});

test("validateGraphIntegrity: rejects fabricated provenance", () => {
  const { valid, errors } = validateGraphIntegrity({
    version: "1.0.0",
    assertions: [{
      id: "a1",
      subject: "x",
      predicate: "y",
      object: "z",
      provenance: "invented",
      schemaValidity: "valid",
    }],
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /provenance/i.test(e)));
});

test("validateGraphIntegrity: valid graph passes", () => {
  const { valid, errors } = validateGraphIntegrity({
    version: "1.0.0",
    assertions: [{
      id: "a1",
      subject: "x",
      predicate: "y",
      object: { value: 100 },
      provenance: "observed",
      schemaValidity: "valid",
    }],
  });
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("validateGraphIntegrity: rejects non-finite numbers in nested objects", () => {
  const { valid, errors } = validateGraphIntegrity({
    version: "1.0.0",
    assertions: [{
      id: "a1",
      subject: "x",
      predicate: "y",
      object: { nested: { value: NaN } },
      provenance: "observed",
      schemaValidity: "valid",
    }],
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /non-finite/i.test(e)));
});

test("freshnessSchema: validates complete freshness marker", () => {
  assert.equal(freshnessSchema.safeParse({ asOf: "2026-10-23T00:00:00Z", staleAfterMs: 3600000, isStale: false, coverageRatio: 0.95 }).success, true);
});

test("linkSchema: validates a graph link with provenance", () => {
  assert.equal(linkSchema.safeParse({ source: "n1", target: "n2", predicate: "child_of", provenance: "observed" }).success, true);
});

test("linkSchema: REFUSES link with fabricated provenance", () => {
  assert.equal(linkSchema.safeParse({ source: "n1", target: "n2", predicate: "child_of", provenance: "imaginary" }).success, false);
});
