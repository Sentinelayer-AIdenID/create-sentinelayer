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

test("assertionSchema: REFUSES undefined object (z.json() rejects undefined per F4)", () => {
  const result = assertionSchema.safeParse({
    id: "a1",
    subject: "x",
    predicate: "y",
    object: undefined,
    provenance: "observed",
    schemaValidity: "valid",
    source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
  });
  assert.equal(result.success, false);
});

// --- Entity (F2: tenantScope required) ---

test("entitySchema: validates entity with required tenantScope", () => {
  assert.equal(entitySchema.safeParse({
    id: "session:s1", type: "session", tenantScope: "tenant/acme", sourceId: "src-001", sourceVersion: "1.0.0",
  }).success, true);
});

test("entitySchema: REFUSES entity without tenantScope", () => {
  assert.equal(entitySchema.safeParse({
    id: "session:s1", type: "session", sourceVersion: "1.0.0",
  }).success, false);
});

// --- Link (F3: strict) ---

test("linkSchema: validates a graph link with provenance", () => {
  assert.equal(linkSchema.safeParse({
    source: "n1", target: "n2", predicate: "child_of", provenance: "observed",
    tenantScope: "tenant/acme", sourceId: "src-001", sourceVersion: "1.0.0",
    capturedAt: "2026-10-23T00:00:00Z",
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
      { id: "session:s1", type: "session", tenantScope: "tenant/acme", sourceId: "src-001", sourceVersion: "1.0.0" },
    ],
    links: [
      { source: "a1", target: "a2", predicate: "supports", provenance: "derived",
        tenantScope: "tenant/acme", sourceId: "src-001", sourceVersion: "1.0.0",
        capturedAt: "2026-10-23T00:00:00Z" },
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

test("classifyProvenance: authoritative requires trusted verification of the fact and evidence", () => {
  // Bare isVerified without evidenceRef is NOT authoritative
  assert.equal(classifyProvenance({ id: "a1" }, { isVerified: true }), "unknown");
  // Bare hasReceipt is NOT authoritative
  assert.equal(classifyProvenance({ id: "a1" }, { hasReceipt: true }), "unknown");
  // isVerified + evidenceRef without verifiedAt is NOT authoritative
  assert.equal(classifyProvenance({ id: "a1" }, {
    isVerified: true,
    evidenceRef: { address: "engram://rec/1", verifier: "aidenid-01" },
  }), "unknown");
  // A complete self-reported reference still is not authoritative.
  assert.equal(classifyProvenance({ id: "a1" }, {
    isVerified: true,
    evidenceRef: { address: "engram://rec/1", verifier: "aidenid-01", verifiedAt: "2026-10-23T00:00:00Z" },
  }), "unknown");
  // The caller supplies a trusted verifier outside the serializable payload.
  assert.equal(classifyProvenance({ id: "a1" }, {
    evidenceRef: { address: "engram://rec/1", verifier: "aidenid-01", verifiedAt: "2026-10-23T00:00:00Z" },
  }, { verifyEvidence: (fact, ref) => fact.id === "a1" && ref.address === "engram://rec/1" }), "authoritative");
  // isVerified + incomplete evidenceRef is NOT authoritative
  assert.equal(classifyProvenance({ id: "a1" }, {
    isVerified: true,
    evidenceRef: { address: "engram://rec/1" },
  }), "unknown");
});

test("classifyProvenance: observed when observedAt is a string", () => {
  assert.equal(classifyProvenance({ id: "a1" }, { observedAt: "2026-10-23T00:00:00Z" }), "observed");
  assert.equal(classifyProvenance({ id: "a1" }, { observedAt: "2026-10-23T00:00:00.000Z" }), "observed");
  assert.equal(classifyProvenance({ id: "a1" }, { observedAt: "2026-10-23T00:00:00+05:30" }), "observed");
  // Non-datetime strings must NOT classify as observed
  assert.equal(classifyProvenance({ id: "a1" }, { observedAt: "banana" }), "unknown");
  assert.equal(classifyProvenance({ id: "a1" }, { observedAt: "not-a-date" }), "unknown");
  assert.equal(classifyProvenance({ id: "a1" }, { observedAt: "" }), "unknown");
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
      object: { kind: "quantity", value: 100, unit: "count" },
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
      object: { Amount: { amount: 1.99, amountUnit: "minor_units", currency: "USD" } },
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

test("validateGraphIntegrity: accepts explicitly typed non-monetary floats", () => {
  const { valid, errors } = validateGraphIntegrity({
    version: "1.0.0",
    assertions: [{
      id: "a1",
      subject: "x",
      predicate: "temperature",
      object: {
        ratio: { kind: "quantity", value: 0.85, unit: "ratio" },
        degrees: { kind: "quantity", value: 36.6, unit: "celsius" },
      },
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
      sourceId: "src-1", sourceVersion: "1.0.0",
      capturedAt: "2026-10-23T00:00:00Z",
      provenance: "observed",
      attributes: { Price: { amount: 1.99, amountUnit: "minor_units", currency: "USD" } },
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

// --- New tests for luna-judge P1 findings ---

test("assertionSchema: REFUSES authoritative provenance without evidenceRef", () => {
  const result = assertionSchema.safeParse({
    id: "a1",
    subject: "x",
    predicate: "y",
    object: { val: 1 },
    provenance: "authoritative",
    schemaValidity: "valid",
    source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
  });
  assert.equal(result.success, false, "authoritative without evidenceRef must be rejected");
  const messages = result.error.issues.map((i) => i.message);
  assert.ok(messages.some((m) => /authoritative.*evidenceRef/i.test(m)),
    "must report missing evidenceRef for authoritative: " + JSON.stringify(messages));
});

test("classifyProvenance: REFUSES evidenceRef without verifiedAt", () => {
  assert.equal(classifyProvenance({ id: "a1" }, {
    isVerified: true,
    evidenceRef: { address: "addr", verifier: "v" },
  }), "unknown", "evidenceRef without verifiedAt is NOT authoritative");
});

test("validateGraphIntegrity: REJECTS authoritative assertion without evidenceRef", () => {
  const { valid, errors } = validateGraphIntegrity({
    version: "1.0.0",
    assertions: [{
      id: "a1", subject: "x", predicate: "y", object: { val: 1 },
      provenance: "authoritative", schemaValidity: "valid",
      source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
    }],
    generatedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /authoritative.*evidenceRef/i.test(e)),
    "must report missing evidenceRef in integrity check");
});

test("entitySchema: REFUSES entity with factual label but no capturedAt", () => {
  const result = entitySchema.safeParse({
    id: "e1", type: "product", tenantScope: "tenant/acme",
      sourceId: "src-1", sourceVersion: "1.0.0",
    label: "A Product",
  });
  assert.equal(result.success, false, "factual entity without capturedAt must be rejected");
});

test("entitySchema: ACCEPTS entity with label, sourceVersion and capturedAt", () => {
  const result = entitySchema.safeParse({
    id: "e1", type: "product", tenantScope: "tenant/acme",
      sourceId: "src-1", sourceVersion: "1.0.0", capturedAt: "2026-10-23T00:00:00Z",
    provenance: "observed",
    label: "A Product",
  });
  assert.equal(result.success, true, "factual entity with capturedAt must be accepted");
});

test("linkSchema: REFUSES authoritative link without evidenceAddress", () => {
  const result = linkSchema.safeParse({
    source: "n1", target: "n2", predicate: "child_of",
    provenance: "authoritative",
    tenantScope: "tenant/acme", capturedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(result.success, false, "authoritative link without evidenceAddress must be rejected");
});

test("linkSchema: REFUSES non-unknown provenance link without capturedAt", () => {
  // tenantScope is required for ALL links. Without capturedAt, observed provenance is rejected.
  const result = linkSchema.safeParse({
    source: "n1", target: "n2", predicate: "child_of",
    provenance: "observed",
    tenantScope: "tenant/acme",
  });
  assert.equal(result.success, false, "observed link without capturedAt must be rejected");
});

test("validateGraphIntegrity: REJECTS monetary predicate with non-money object", () => {
  const { valid, errors } = validateGraphIntegrity({
    version: "1.0.0",
    assertions: [{
      id: "a1", subject: "x", predicate: "total", object: 1.99,
      provenance: "observed", schemaValidity: "valid",
      source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
    }],
    generatedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(valid, false, "predicate=total with float object must be rejected");
  assert.ok(errors.some((e) => /monetary predicate/i.test(e)),
    "must report monetary predicate issue: " + JSON.stringify(errors));
});

test("validateGraphIntegrity: ACCEPTS monetary predicate with valid money object", () => {
  const { valid, errors } = validateGraphIntegrity({
    version: "1.0.0",
    assertions: [{
      id: "a1", subject: "x", predicate: "cost", object: { amount: 199, amountUnit: "minor_units", currency: "USD", exponent: 2 },
      provenance: "observed", schemaValidity: "valid",
      source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
    }],
    generatedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(valid, true, "predicate=cost with valid money object must be accepted: " + JSON.stringify(errors));
});

test("validateGraphIntegrity: REJECTS non-object value on money-named field", () => {
  const { valid, errors } = validateGraphIntegrity({
    version: "1.0.0",
    assertions: [{
      id: "a1", subject: "x", predicate: "y", object: "z",
      provenance: "observed", schemaValidity: "valid",
      source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
    }],
    entities: [{
      id: "e1", type: "product", tenantScope: "tenant/acme",
      sourceId: "src-1", sourceVersion: "1.0.0", capturedAt: "2026-10-23T00:00:00Z",
      provenance: "observed",
      attributes: { total: 1.99 },
    }],
    generatedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(valid, false, "attributes.total=1.99 (non-money-object) must be rejected");
  assert.ok(errors.some((e) => /money field must be a canonical/i.test(e)),
    "must report non-canonical money: " + JSON.stringify(errors));
});

test("entitySchema: REFUSES attributes with non-JSON value (z.json() rejects undefined)", () => {
  const result = entitySchema.safeParse({
    id: "e1", type: "Person", tenantScope: "tenant/acme",
      sourceId: "src-1", sourceVersion: "1.0.0", capturedAt: "2026-10-23T00:00:00Z",
    attributes: { value: undefined },
  });
  assert.equal(result.success, false,
    "entity with undefined attribute value must be rejected (z.json() rejects non-JSON)");
});

test("entitySchema: REFUSES attributes with function value (z.json() rejects functions)", () => {
  // z.unknown() would silently drop functions; z.json() must reject them
  const result = entitySchema.safeParse({
    id: "e1", type: "Person", tenantScope: "tenant/acme",
      sourceId: "src-1", sourceVersion: "1.0.0", capturedAt: "2026-10-23T00:00:00Z",
    attributes: { callback: () => {}, value: 123 },
  });
  assert.equal(result.success, false,
    "entity with function attribute must be rejected (z.json() rejects non-JSON)");
});

test("entitySchema: ACCEPTS attributes with valid JSON values", () => {
  const result = entitySchema.safeParse({
    id: "e1", type: "Person", label: "Alice", tenantScope: "tenant/acme",
      sourceId: "src-1", sourceVersion: "1.0.0", capturedAt: "2026-10-23T00:00:00Z",
    provenance: "observed",
    attributes: { age: 30, active: true, tags: ["a", "b"], meta: { key: "val" } },
  });
  assert.equal(result.success, true,
    "entity with valid JSON attributes must be accepted: " + JSON.stringify(result.error?.issues));
});
