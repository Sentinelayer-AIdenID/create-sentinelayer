import "./setup-env.mjs";
// unit.engram-contracts-warden-fixes.test.mjs — Failing tests for all 12
// warden HOLD findings on PR #862. Each test must FAIL before the fix and
// PASS after. These are isolated contract counterexamples.

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyProvenance,
  validateGraphIntegrity,
  entitySchema,
  linkSchema,
  graphSchema,
} from "../src/engram/contracts/graph.js";

import {
  negotiateCapability,
  negotiationResultSchema,
  capabilityEntrySchema,
} from "../src/engram/contracts/capability.js";

import {
  mediaAssetSchema,
  VALID_MEDIA_ASSET,
  actionReceiptSchema,
  VALID_ACTION_RECEIPT,
} from "../src/engram/contracts/index.js";

// =========================================================================
// Finding 1: classifyProvenance — empty-string evidenceRef bypass
// =========================================================================

test("WARDEN-F1: classifyProvenance REJECTS empty-string evidenceRef as authoritative", () => {
  // The current code checks truthiness of evidenceRef fields, but empty
  // strings are truthy in those checks. They must be rejected.
  const result = classifyProvenance(
    { id: "x" },
    {
      isVerified: true,
      evidenceRef: { address: "", verifier: "", verifiedAt: "" },
    },
  );
  assert.notEqual(result, "authoritative",
    "empty-string evidenceRef must NOT classify as authoritative");
  assert.equal(result, "unknown",
    "empty-string evidenceRef must classify as unknown");
});

test("WARDEN-F1b: classifyProvenance REJECTS whitespace-only evidenceRef", () => {
  const result = classifyProvenance(
    { id: "x" },
    {
      isVerified: true,
      evidenceRef: { address: "   ", verifier: "  ", verifiedAt: "  " },
    },
  );
  assert.notEqual(result, "authoritative",
    "whitespace-only evidenceRef must NOT classify as authoritative");
});

// =========================================================================
// Finding 2: Money field name regex gaps — subtotal, total_amount, amount
// =========================================================================

test("WARDEN-F2: validateGraphIntegrity REJECTS subtotal:1.99 (float) in entity attributes", () => {
  const { valid, errors } = validateGraphIntegrity({
    version: "1.0.0",
    assertions: [{
      id: "a1", subject: "x", predicate: "y", object: "z",
      provenance: "observed", schemaValidity: "valid",
      source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
    }],
    entities: [{
      id: "e1", type: "product", tenantScope: "tenant/acme",
      sourceVersion: "1.0.0", capturedAt: "2026-10-23T00:00:00Z",
      attributes: { subtotal: 1.99 },
    }],
    generatedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(valid, false,
    "subtotal:1.99 (binary float) must be rejected: " + JSON.stringify(errors));
});

test("WARDEN-F2b: validateGraphIntegrity REJECTS total_amount:1.99 (float) in entity attributes", () => {
  const { valid, errors } = validateGraphIntegrity({
    version: "1.0.0",
    assertions: [{
      id: "a1", subject: "x", predicate: "y", object: "z",
      provenance: "observed", schemaValidity: "valid",
      source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
    }],
    entities: [{
      id: "e1", type: "product", tenantScope: "tenant/acme",
      sourceVersion: "1.0.0", capturedAt: "2026-10-23T00:00:00Z",
      attributes: { total_amount: 1.99 },
    }],
    generatedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(valid, false,
    "total_amount:1.99 (binary float) must be rejected: " + JSON.stringify(errors));
});

test("WARDEN-F2c: validateGraphIntegrity REJECTS amount:1.99 (float) in entity attributes", () => {
  const { valid, errors } = validateGraphIntegrity({
    version: "1.0.0",
    assertions: [{
      id: "a1", subject: "x", predicate: "y", object: "z",
      provenance: "observed", schemaValidity: "valid",
      source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
    }],
    entities: [{
      id: "e1", type: "product", tenantScope: "tenant/acme",
      sourceVersion: "1.0.0", capturedAt: "2026-10-23T00:00:00Z",
      attributes: { amount: 1.99 },
    }],
    generatedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(valid, false,
    "amount:1.99 (binary float) must be rejected: " + JSON.stringify(errors));
});

test("WARDEN-F2d: validateGraphIntegrity ACCEPTS non-monetary numeric fields like ratio/temperature", () => {
  // Non-monetary numeric fields should NOT be rejected just because they are numbers
  const { valid, errors } = validateGraphIntegrity({
    version: "1.0.0",
    assertions: [{
      id: "a1", subject: "x", predicate: "y", object: "z",
      provenance: "observed", schemaValidity: "valid",
      source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
    }],
    entities: [{
      id: "e1", type: "product", tenantScope: "tenant/acme",
      sourceVersion: "1.0.0", capturedAt: "2026-10-23T00:00:00Z",
      sourceId: "src-001", attributes: { ratio: 0.5, temperature: 98.6, count: 42 },
    }],
    generatedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(valid, true,
    "non-monetary numeric fields must be accepted: " + JSON.stringify(errors));
});

// =========================================================================
// Finding 3: MediaAsset/ActionReceipt cross-tenant inconsistency
// =========================================================================

test("WARDEN-F3: mediaAssetSchema REJECTS top-level tenant mismatch with sourceSnapshot", () => {
  const asset = { ...VALID_MEDIA_ASSET, tenantScope: "tenant/other" };
  // sourceSnapshot.tenantScope is "tenant/acme"
  const r = mediaAssetSchema.safeParse(asset);
  assert.equal(r.success, false,
    "tenantScope mismatch between top-level and sourceSnapshot must be rejected");
});

test("WARDEN-F3b: actionReceiptSchema REJECTS top-level tenant mismatch with sourceSnapshot", () => {
  const receipt = { ...VALID_ACTION_RECEIPT, tenantScope: "tenant/other" };
  // sourceSnapshot.tenantScope is "tenant/acme"
  const r = actionReceiptSchema.safeParse(receipt);
  assert.equal(r.success, false,
    "tenantScope mismatch between top-level and sourceSnapshot must be rejected");
});

// =========================================================================
// Finding 4: Capability negotiation — missing source/tenant + invalid output
// =========================================================================

test("WARDEN-F4: negotiateCapability REJECTS server entry without source/tenantScope", () => {
  // Server entry with only capability, version, and status — no source
  const result = negotiateCapability({
    capability: "engram-graph",
    clientVersion: "engram-graph@1.0.0",
    serverCapabilities: [{
      capability: "engram-graph",
      version: "engram-graph@1.0.0",
      status: "supported",
    }],
  });
  assert.notEqual(result.result, "matched",
    "server capability without source must not negotiate as matched");
  assert.ok(
    result.result === "incompatible" || result.result === "unknown",
    "must return incompatible or unknown, got: " + JSON.stringify(result),
  );
});

test("WARDEN-F4b: negotiateCapability returns schema-valid result on invalid client version", () => {
  const result = negotiateCapability({
    capability: "engram-graph",
    clientVersion: "not-even-a-version",
    serverCapabilities: [{
      capability: "engram-graph",
      version: "engram-graph@1.0.0",
      status: "supported",
    }],
  });
  // The result must validate against negotiationResultSchema
  const parsed = negotiationResultSchema.safeParse(result);
  assert.equal(parsed.success, true,
    "result of negotiateCapability must always validate against negotiationResultSchema: " +
    JSON.stringify(parsed.error?.issues));
});

test("WARDEN-F4c: negotiateCapability requires server entry to validate against capabilityEntrySchema", () => {
  // A server entry that would fail capabilityEntrySchema (missing source)
  // must not silently negotiate. The function should validate the entry first.
  const serverEntry = {
    capability: "engram-graph",
    version: "engram-graph@1.0.0",
    status: "supported",
  };
  // This entry fails capabilityEntrySchema because source is required
  const entryResult = capabilityEntrySchema.safeParse(serverEntry);
  assert.equal(entryResult.success, false,
    "server entry without source must fail capabilityEntrySchema");

  const result = negotiateCapability({
    capability: "engram-graph",
    clientVersion: "engram-graph@1.0.0",
    serverCapabilities: [serverEntry],
  });
  assert.notEqual(result.result, "matched",
    "negotiateCapability must validate server entries against capabilityEntrySchema");
});

// =========================================================================
// Finding 5: Entity without sourceId, unknown link gaps, coverage, sha256:x
// =========================================================================

test("WARDEN-F5a: entitySchema REJECTS factual entity without sourceId", () => {
  // The entity has label, sourceVersion, capturedAt but no sourceId
  // The current entity schema doesn't have a sourceId field — it should
  // require one for fact-bearing entities, or the assertion's source should
  // be the gate.
  const r = entitySchema.safeParse({
    id: "e1", type: "product", tenantScope: "tenant/acme",
    sourceVersion: "1.0.0", capturedAt: "2026-10-23T00:00:00Z",
    label: "A Product",
  });
  // The warden says this is accepted today. An entity with facts must have
  // traceable source. sourceVersion alone without sourceId is insufficient.
  assert.equal(r.success, false,
    "factual entity without sourceId must be rejected");
});

test("WARDEN-F5b: linkSchema REJECTS unknown-provenance link without tenantScope", () => {
  // While unknown provenance is allowed to skip tenant/capturedAt currently,
  // an unknown link without any tenantScope is untraceable and should be rejected
  // at minimum for tenant scoping.
  const r = linkSchema.safeParse({
    source: "n1", target: "n2", predicate: "child_of",
    provenance: "unknown",
  });
  assert.equal(r.success, false,
    "unknown-provenance link without tenantScope must be rejected");
});

test("WARDEN-F5c: validateGraphIntegrity REJECTS coverage.totalAssertions exceeding actual count", () => {
  const graph = {
    version: "1.0.0",
    assertions: [{
      id: "a1", subject: "x", predicate: "y", object: "z",
      provenance: "observed", schemaValidity: "valid",
      source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
    }],
    coverage: { totalAssertions: 999 },
    generatedAt: "2026-10-23T00:00:00Z",
  };
  const { valid, errors } = validateGraphIntegrity(graph);
  assert.equal(valid, false,
    "coverage.totalAssertions=999 with only 1 actual assertion must be rejected: " +
    JSON.stringify(errors));
});

test("WARDEN-F5d: actionReceiptSchema REJECTS single-char contentHash after sha256:", () => {
  const r = actionReceiptSchema.safeParse({
    receiptId: "rec-1",
    action: "test",
    status: "executed",
    performedAt: "2026-10-23T00:00:00Z",
    verifier: "v1",
    contentHash: "sha256:x",
    sourceSnapshot: {
      sourceId: "src-1", sourceType: "session", version: "1.0.0",
      capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme",
    },
    tenantScope: "tenant/acme",
  });
  assert.equal(r.success, false,
    "sha256:x (single-char digest) must be rejected as invalid content hash");
});

test("WARDEN-F5e: actionReceiptSchema ACCEPTS valid sha256 hex digest", () => {
  const r = actionReceiptSchema.safeParse({
    ...VALID_ACTION_RECEIPT,
    contentHash: "sha256:" + "a".repeat(64),
  });
  assert.equal(r.success, true,
    "valid 64-char hex sha256 digest must be accepted: " +
    JSON.stringify(r.error?.issues));
});

// =========================================================================
// Finding: fabricated provenance class on empty graph
// =========================================================================

test("WARDEN-F6: graphSchema REJECTS fabricated provenance class on assertion", () => {
  const r = graphSchema.safeParse({
    version: "1.0.0",
    assertions: [{
      id: "a1", subject: "x", predicate: "y", object: "z",
      provenance: "fabricated_class", schemaValidity: "valid",
      source: { sourceId: "src-001", version: "1.0.0", capturedAt: "2026-10-23T00:00:00Z", tenantScope: "tenant/acme" },
    }],
    generatedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(r.success, false,
    "fabricated provenance class must be rejected by graphSchema");
});
