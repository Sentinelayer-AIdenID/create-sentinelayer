import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  capabilityEntrySchema, migrationPolicySchema, negotiationResultSchema,
  negotiateCapability, paginationSchema, linkSchema, actionReceiptSchema,
  evidenceFreshnessSchema, VALID_ACTION_RECEIPT,
} from "../src/engram/contracts/index.js";

const tenantScope = "tenant/acme";
const entry = {
  capability: "graph-read", version: "graph-read@1.0.0", status: "supported",
  source: { sourceId: "adapter-acme", sourceType: "adapter",
    version: "adapter-acme@1.0.0", tenantScope },
};

test("capability entries and migration policies bind every version to the named capability", () => {
  assert.equal(capabilityEntrySchema.safeParse(entry).success, true);
  assert.equal(capabilityEntrySchema.safeParse({ ...entry, version: "other@1.0.0" }).success, false);
  assert.equal(capabilityEntrySchema.safeParse({ ...entry, migratesTo: "other@2.0.0" }).success, false);
  const policy = { capability: "graph-read", fromVersion: "graph-read@1.0.0",
    toVersion: "graph-read@1.1.0", compatibility: "additive", createdAt: "2026-10-23T00:00:00Z" };
  assert.equal(migrationPolicySchema.safeParse(policy).success, true);
  assert.equal(migrationPolicySchema.safeParse({ ...policy, fromVersion: "other@1.0.0" }).success, false);
  assert.equal(migrationPolicySchema.safeParse({ ...policy, toVersion: "other@1.1.0" }).success, false);
});

test("negotiation never grants another tenant's or an unscoped capability", () => {
  const request = { capability: "graph-read", clientVersion: "graph-read@1.0.0" };
  const unscoped = negotiateCapability({ ...request, serverCapabilities: [entry] });
  assert.equal(unscoped.result, "incompatible");
  assert.equal(negotiationResultSchema.safeParse(unscoped).success, true);
  const foreign = negotiateCapability({ ...request, tenantScope: "tenant/beta", serverCapabilities: [entry] });
  assert.equal(foreign.result, "unknown");
  assert.equal(foreign.negotiatedVersion, undefined);
  const matched = negotiateCapability({ ...request, tenantScope, serverCapabilities: [null, entry] });
  assert.equal(matched.result, "matched");
  assert.equal(matched.tenantScope, tenantScope);
  assert.equal(negotiationResultSchema.safeParse(matched).success, true);
});

test("malformed negotiation inputs return schema-valid failures, never an accidental match", () => {
  for (const request of [
    { capability: 7, clientVersion: "graph-read@1.0.0" },
    { capability: "graph-read", clientVersion: "graph-read@01.0.0" },
    { capability: "graph-read", clientVersion: "graph-read@1.0.0", serverCapabilities: [null] },
    { capability: "graph-read", clientVersion: "graph-read@1.0.0", serverCapabilities: {} },
  ]) {
    const result = negotiateCapability({ tenantScope, ...request });
    assert.equal(negotiationResultSchema.safeParse(result).success, true);
    assert.ok(["unknown", "incompatible"].includes(result.result));
  }
});

test("negotiation results and pagination cannot claim an unusable continuation or version", () => {
  const matched = { capability: "graph-read", clientVersion: "graph-read@1.0.0",
    serverVersion: "graph-read@1.0.0", tenantScope, result: "matched" };
  assert.equal(negotiationResultSchema.safeParse(matched).success, false);
  assert.equal(negotiationResultSchema.safeParse({ ...matched, negotiatedVersion: "graph-read@1.0.0" }).success, true);
  assert.equal(negotiationResultSchema.safeParse({ ...matched, negotiatedVersion: "graph-read@1.0.0", result: "incompatible" }).success, false);
  assert.equal(negotiationResultSchema.safeParse({ ...matched, negotiatedVersion: "graph-read@1.0.0", result: "upgraded" }).success, false);
  assert.equal(paginationSchema.safeParse({ hasMore: true }).success, false);
  assert.equal(paginationSchema.safeParse({ hasMore: true, nextCursor: "cursor-2" }).success, true);
});

test("factual links identify their source, receipts carry full digests, and evidence counts agree", () => {
  const link = { source: "e1", target: "e2", predicate: "related", provenance: "observed",
    tenantScope, capturedAt: "2026-10-23T00:00:00Z" };
  assert.equal(linkSchema.safeParse(link).success, false);
  assert.equal(linkSchema.safeParse({ ...link, sourceId: "catalog", sourceVersion: "1.0.0" }).success, true);
  assert.equal(actionReceiptSchema.safeParse({ ...VALID_ACTION_RECEIPT, contentHash: "sha256:abcdefgh" }).success, false);
  assert.equal(actionReceiptSchema.safeParse(VALID_ACTION_RECEIPT).success, true);
  const freshness = { asOf: "2026-10-23T00:00:00Z",
    coverage: { totalAssertions: 2, evidenced: 1, ratio: 0.5 } };
  assert.equal(evidenceFreshnessSchema.safeParse(freshness).success, true);
  assert.equal(evidenceFreshnessSchema.safeParse({ ...freshness, coverage: { totalAssertions: 1, evidenced: 2, ratio: 1 } }).success, false);
  assert.equal(evidenceFreshnessSchema.safeParse({ ...freshness, coverage: { totalAssertions: 2, evidenced: 1, ratio: 0 } }).success, false);
  assert.equal(evidenceFreshnessSchema.safeParse({ ...freshness, coverage: { totalAssertions: 0, evidenced: 0, ratio: 0 } }).success, true);
});
