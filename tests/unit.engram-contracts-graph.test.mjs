import "./setup-env.mjs";
// unit.engram-contracts-graph.test.mjs — EW02 graph contract tests (R02, R09).
// Updated for luna-judge findings F2, F3, F4, F6.

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

// --- Basic enums ---

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

// --- Assertion (F2: source required, F3: strict) ---

test("assertionSchema: validates a complete assertion with required source", () => {
  const result = assertionSchema.safeParse({
    id: "a1",
    subject: "session:s1",
    predicate: "contains",
    object: { text: "hello" },
    provenance: "observed",
    schemaValidity: "valid",
    modelConfidence: "high",
    freshness: { asOf: "2026-10-23T00:00:00Z" },
    evidenceRef: {
      address: "engram://s1/obs/1",
      verifiedAt: "2026-10-23T00:00:00Z",
      verifier: "aidenid-01",
    },
    source: {
      sourceId: "src-001",
      version: "1.2.0",
      capturedAt: "2026-10-23T00:00:00Z",
      tenantScope: "tenant/acme",
    },
  });
  assert.equal(result.success, true);
});

test("assertionSchema: REFUSES missing source (required per F2)", () => {
  const result = assertionSchema.safeParse({
    id: "a1",
    subject: "x",
    predicate: "y",
    object: "z",
    provenance: "observed",
    schemaValidity: "valid",
  });
  assert.equal(result.success, false);
});

test("assertionSchema: REFUSES extra unknown field (strict per F3)", () => {
  const result = assertionSchema.safeParse({
    id: "a1",
    subject: "x",
    predicate: "y",
    object: "z",
    provenance: "observed",
    schemaValidity: "valid",
    source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
    fabricatedField: "should be rejected",
  });
  assert.equal(result.success, false);
});

test("assertionSchema: REFUSES assertion with fabricated provenance", () => {
  const result = assertionSchema.safeParse({
    id: "a1",
    subject: "x",
    predicate: "y",
    object: "z",
    provenance: "fake_class",
    schemaValidity: "valid",
    source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
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
    source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
  });
  assert.equal(result.success, false);
});

// --- Entity (F2: tenantScope required) ---

test("entitySchema: validates entity with required tenantScope", () => {
  assert.equal(entitySchema.safeParse({
    id: "session:s1", type: "session", tenantScope: "tenant/acme",
  }).success, true);
});

test("entitySchema: REFUSES entity without tenantScope", () => {
  assert.equal(entitySchema.safeParse({
    id: "session:s1", type: "session",
  }).success, false);
});

// --- Link (F3: strict) ---

test("linkSchema: validates a graph link with provenance", () => {
  assert.equal(linkSchema.safeParse({
    source: "n1", target: "n2", predicate: "child_of", provenance: "observed",
  }).success, true);
});

test("linkSchema: REFUSES link with fabricated provenance", () => {
  assert.equal(linkSchema.safeParse({
    source: "n1", target: "n2", predicate: "child_of", provenance: "imaginary",
  }).success, false);
});

test("linkSchema: REFUSES extra unknown field (strict)", () => {
  assert.equal(linkSchema.safeParse({
    source: "n1", target: "n2", predicate: "child_of", provenance: "observed", extra: true,
  }).success, false);
});

// --- Graph (F3: strict, F4: schema-driven) ---

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
        source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
      },
      {
        id: "a2",
        subject: "session:s1",
        predicate: "summary",
        object: "session summary text",
        provenance: "derived",
        schemaValidity: "valid",
        modelConfidence: "medium",
        source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
      },
    ],
    entities: [
      { id: "session:s1", type: "session", tenantScope: "tenant/acme" },
    ],
    links: [
      { source: "a1", target: "a2", predicate: "supports", provenance: "derived" },
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

test("graphSchema: REFUSES unsupported version string (F10: pinned)", () => {
  const result = graphSchema.safeParse({
    version: "banana",
    assertions: [{
      id: "a1", subject: "x", predicate: "y", object: "z",
      provenance: "observed", schemaValidity: "valid",
      source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
    }],
    generatedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(result.success, false);
});

test("graphSchema: REFUSES extra unknown field (strict)", () => {
  const result = graphSchema.safeParse({
    version: "1.0.0",
    assertions: [{
      id: "a1", subject: "x", predicate: "y", object: "z",
      provenance: "observed", schemaValidity: "valid",
      source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
    }],
    generatedAt: "2026-10-23T00:00:00Z",
    injectedField: "bad",
  });
  assert.equal(result.success, false);
});

// --- classifyProvenance (F2: authoritative requires evidenceRef) ---

test("classifyProvenance: derived when derivedFrom has entries", () => {
  assert.equal(classifyProvenance({ id: "a1" }, { derivedFrom: ["a0"] }), "derived");
});

test("classifyProvenance: authoritative requires isVerified AND evidenceRef (F2)", () => {
  // Bare isVerified without evidenceRef is NOT authoritative
  assert.equal(classifyProvenance({ id: "a1" }, { isVerified: true }), "unknown");
  // Bare hasReceipt is NOT authoritative
  assert.equal(classifyProvenance({ id: "a1" }, { hasReceipt: true }), "unknown");
  // isVerified + evidenceRef IS authoritative
  assert.equal(classifyProvenance({ id: "a1" }, {
    isVerified: true,
    evidenceRef: { address: "engram://rec/1", verifier: "aidenid-01" },
  }), "authoritative");
  // isVerified + incomplete evidenceRef is NOT authoritative
  assert.equal(classifyProvenance({ id: "a1" }, {
    isVerified: true,
    evidenceRef: { address: "engram://rec/1" },
  }), "unknown");
});

test("classifyProvenance: observed when observedAt is a string", () => {
  assert.equal(classifyProvenance({ id: "a1" }, { observedAt: "2026-10-23T00:00:00Z" }), "observed");
  // Non-string observedAt must NOT classify as observed
  assert.equal(classifyProvenance({ id: "a1" }, { observedAt: 123456 }), "unknown");
  assert.equal(classifyProvenance({ id: "a1" }, { observedAt: true }), "unknown");
  assert.equal(classifyProvenance({ id: "a1" }, { observedAt: null }), "unknown");
});

test("classifyProvenance: unknown when nothing is known", () => {
  assert.equal(classifyProvenance({ id: "a1" }, {}), "unknown");
  assert.equal(classifyProvenance(null), "unknown");
});

// --- validateGraphIntegrity (F4: schema-driven, F6: typed money fields) ---

test("validateGraphIntegrity: valid graph passes (F4: full schema validation)", () => {
  const { valid, errors } = validateGraphIntegrity({
    version: "1.0.0",
    assertions: [{
      id: "a1",
      subject: "x",
      predicate: "y",
      object: { value: 100 },
      provenance: "observed",
      schemaValidity: "valid",
      source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
    }],
    generatedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("validateGraphIntegrity: rejects graph with fabricated provenance (F4: schema-driven)", () => {
  const { valid, errors } = validateGraphIntegrity({
    version: "1.0.0",
    assertions: [{
      id: "a1",
      subject: "x",
      predicate: "y",
      object: "z",
      provenance: "invented",
      schemaValidity: "valid",
      source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
    }],
    generatedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /provenance/i.test(e) || /schema/i.test(e)));
});

test("validateGraphIntegrity: rejects money float in assertion field (F6: typed money check)", () => {
  const { valid, errors } = validateGraphIntegrity({
    version: "1.0.0",
    assertions: [{
      id: "a1",
      subject: "x",
      predicate: "cost",
      object: { Amount: { amount: 1.99, currency: "USD" } },
      provenance: "observed",
      schemaValidity: "valid",
      source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
    }],
    generatedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /money/i.test(e) && /Amount/i.test(e)),
    "must reject money float in Amount field: " + JSON.stringify(errors));
});

test("validateGraphIntegrity: accepts non-monetary float like ratio (F6: not too broad)", () => {
  const { valid, errors } = validateGraphIntegrity({
    version: "1.0.0",
    assertions: [{
      id: "a1",
      subject: "x",
      predicate: "temperature",
      object: { ratio: 0.85, degrees: 36.6 },
      provenance: "observed",
      schemaValidity: "valid",
      source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
    }],
    generatedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(valid, true, "non-monetary floats like ratios should be accepted: " + JSON.stringify(errors));
});

test("validateGraphIntegrity: catches money float in entity.attributes.Price (F6: full graph scan)", () => {
  const { valid, errors } = validateGraphIntegrity({
    version: "1.0.0",
    assertions: [{
      id: "a1",
      subject: "x",
      predicate: "y",
      object: "z",
      provenance: "observed",
      schemaValidity: "valid",
      source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
    }],
    entities: [{
      id: "e1",
      type: "product",
      tenantScope: "tenant/acme",
      attributes: { Price: { amount: 1.99, currency: "USD" } },
    }],
    generatedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(valid, false, "must catch money float in entity attributes");
  assert.ok(errors.some((e) => /money/i.test(e) && /Price/i.test(e)),
    "must report money field in entity: " + JSON.stringify(errors));
});

test("freshnessSchema: validates complete freshness marker", () => {
  assert.equal(freshnessSchema.safeParse({
    asOf: "2026-10-23T00:00:00Z", staleAfterMs: 3600000, isStale: false, coverageRatio: 0.95,
  }).success, true);
});

test("freshnessSchema: REFUSES extra field (strict)", () => {
  assert.equal(freshnessSchema.safeParse({
    asOf: "2026-10-23T00:00:00Z", extraField: true,
  }).success, false);
});
