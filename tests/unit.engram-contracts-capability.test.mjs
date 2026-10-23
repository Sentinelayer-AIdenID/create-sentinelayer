import "./setup-env.mjs";
// unit.engram-contracts-capability.test.mjs — EW02 capability contract tests (R04, R14, step-11).

import test from "node:test";
import assert from "node:assert/strict";

import {
  capabilityVersionSchema,
  tenantScopeSchema,
  sourceDescriptorSchema,
  capabilityEntrySchema,
  negotiationResultSchema,
  paginationSchema,
  migrationPolicySchema,
  CapabilityError,
  unknownCapability,
  unsupportedCapability,
  staleCapability,
  negotiateCapability,
} from "../src/engram/contracts/capability.js";

test("capabilityVersionSchema: accepts valid name@semver", () => {
  assert.equal(capabilityVersionSchema.safeParse("engram-graph@1.0.0").success, true);
  assert.equal(capabilityVersionSchema.safeParse("evidence-store@0.1.5").success, true);
  assert.equal(capabilityVersionSchema.safeParse("recall-engine@2.0.1").success, true);
});

test("capabilityVersionSchema: REFUSES malformed versions", () => {
  assert.equal(capabilityVersionSchema.safeParse("graph@1.0").success, false); // missing patch
  assert.equal(capabilityVersionSchema.safeParse("graph@v1.0.0").success, false); // v prefix
  assert.equal(capabilityVersionSchema.safeParse("1.0.0").success, false); // no name
  assert.equal(capabilityVersionSchema.safeParse("").success, false);
});

test("tenantScopeSchema: validates required fields", () => {
  assert.equal(tenantScopeSchema.safeParse({ tenantId: "acme" }).success, true);
  assert.equal(tenantScopeSchema.safeParse({ tenantId: "acme", namespace: "ns:notes", environment: "sandbox" }).success, true);
});

test("tenantScopeSchema: REFUSES missing tenantId", () => {
  assert.equal(tenantScopeSchema.safeParse({}).success, false);
});

test("sourceDescriptorSchema: requires sourceId, sourceType, version, tenantScope", () => {
  assert.equal(sourceDescriptorSchema.safeParse({
    sourceId: "session-adapter",
    sourceType: "adapter",
    version: "enrich-v2@1.0.0",
    tenantScope: "tenant/acme",
  }).success, true);
});

test("sourceDescriptorSchema: REFUSES without version", () => {
  assert.equal(sourceDescriptorSchema.safeParse({
    sourceId: "s1",
    sourceType: "adapter",
  }).success, false);
});

test("sourceDescriptorSchema: REFUSES invalid sourceType", () => {
  assert.equal(sourceDescriptorSchema.safeParse({
    sourceId: "s1",
    sourceType: "fabricated",
    version: "enrich-v2@1.0.0",
  }).success, false);
});

test("capabilityEntrySchema: validates full entry", () => {
  assert.equal(capabilityEntrySchema.safeParse({
    capability: "engram-graph",
    version: "engram-graph@1.0.0",
    source: { sourceId: "s1", sourceType: "adapter", version: "enrich-v2@1.0.0", tenantScope: "tenant/acme" },
    status: "supported",
  }).success, true);
});

test("capabilityEntrySchema: REFUSES unsupported status", () => {
  // "unsupported" IS a valid status enum
  assert.equal(capabilityEntrySchema.safeParse({
    capability: "x",
    version: "x@1.0.0",
    source: { sourceId: "s1", sourceType: "adapter", version: "enrich-v2@1.0.0", tenantScope: "tenant/acme" },
    status: "unsupported",
  }).success, true);
});

test("negotiateCapability: matched when versions identical", () => {
  const result = negotiateCapability({
    capability: "engram-graph",
    clientVersion: "engram-graph@1.0.0",
    serverCapabilities: [{ capability: "engram-graph", version: "engram-graph@1.0.0", status: "supported" }],
  });
  assert.equal(result.result, "matched");
  assert.equal(result.negotiatedVersion, "engram-graph@1.0.0");
});

test("negotiateCapability: upgraded when server is ahead on minor", () => {
  const result = negotiateCapability({
    capability: "engram-graph",
    clientVersion: "engram-graph@1.0.0",
    serverCapabilities: [{ capability: "engram-graph", version: "engram-graph@1.1.0", status: "supported" }],
  });
  assert.equal(result.result, "upgraded");
});

test("negotiateCapability: downgraded when server is behind on minor", () => {
  const result = negotiateCapability({
    capability: "engram-graph",
    clientVersion: "engram-graph@1.2.0",
    serverCapabilities: [{ capability: "engram-graph", version: "engram-graph@1.0.0", status: "supported" }],
  });
  assert.equal(result.result, "downgraded");
});

test("negotiateCapability: incompatible when major version differs", () => {
  const result = negotiateCapability({
    capability: "engram-graph",
    clientVersion: "engram-graph@2.0.0",
    serverCapabilities: [{ capability: "engram-graph", version: "engram-graph@1.0.0", status: "supported" }],
  });
  assert.equal(result.result, "incompatible");
});

test("negotiateCapability: unknown when capability not registered", () => {
  const result = negotiateCapability({
    capability: "unknown-cap",
    clientVersion: "unknown-cap@1.0.0",
    serverCapabilities: [{ capability: "engram-graph", version: "engram-graph@1.0.0", status: "supported" }],
  });
  assert.equal(result.result, "unknown");
});

test("negotiateCapability: incompatible when capability is unsupported", () => {
  const result = negotiateCapability({
    capability: "old-cap",
    clientVersion: "old-cap@1.0.0",
    serverCapabilities: [{ capability: "old-cap", version: "old-cap@1.0.0", status: "unsupported" }],
  });
  assert.equal(result.result, "incompatible");
});

test("negotiateCapability: incompatible when capability is stale", () => {
  const result = negotiateCapability({
    capability: "stale-cap",
    clientVersion: "stale-cap@2.0.0",
    serverCapabilities: [{ capability: "stale-cap", version: "stale-cap@1.0.0", status: "stale" }],
  });
  assert.equal(result.result, "incompatible");
});

test("CapabilityError: typed errors with codes", () => {
  const err = unknownCapability("no-such", { loc: "test" });
  assert.ok(err instanceof CapabilityError);
  assert.equal(err.code, "unknown_capability");
  assert.equal(err.evidence.loc, "test");

  const err2 = unsupportedCapability("c", "1.0.0", "deprecated", null);
  assert.equal(err2.code, "unsupported_capability");

  const err3 = staleCapability("c", "1.0.0", "2026-01-01", null);
  assert.equal(err3.code, "stale_capability");
});

test("paginationSchema: validates cursor-based pagination", () => {
  assert.equal(paginationSchema.safeParse({ cursor: "abc", limit: 50 }).success, true);
  assert.equal(paginationSchema.safeParse({ nextCursor: "def", hasMore: true, total: 100 }).success, true);
});

test("migrationPolicySchema: validates compatibility declaration", () => {
  assert.equal(migrationPolicySchema.safeParse({
    capability: "engram-graph",
    fromVersion: "engram-graph@1.0.0",
    toVersion: "engram-graph@2.0.0",
    compatibility: "breaking",
    createdAt: "2026-10-23T00:00:00Z",
  }).success, true);
});

test("migrationPolicySchema: REFUSES invalid compatibility", () => {
  assert.equal(migrationPolicySchema.safeParse({
    capability: "x",
    fromVersion: "x@1.0.0",
    toVersion: "x@2.0.0",
    compatibility: "hopeful",
    createdAt: "2026-10-23T00:00:00Z",
  }).success, false);
});
