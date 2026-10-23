import "./setup-env.mjs";
// unit.engram-contracts-evidence.test.mjs — EW02 evidence contract tests (R09, step-12).

import test from "node:test";
import assert from "node:assert/strict";

import {
  evidenceAddressSchema,
  evidenceRecordSchema,
  evidencePageSchema,
  evidenceMigrationPolicySchema,
  evidenceFreshnessSchema,
  EvidenceError,
  evidenceNotFound,
  evidenceStale,
  evidenceUnsupportedScheme,
  validateNotScreenshotInferred,
} from "../src/engram/contracts/evidence.js";

test("evidenceAddressSchema: validates complete address", () => {
  assert.equal(evidenceAddressSchema.safeParse({
    scheme: "engram",
    locator: "session:s1/obs/1",
    contentHash: "abc123",
    capturedAt: "2026-10-23T00:00:00Z",
    sourceVersion: "enrich-v2@1.0.0",
    tenantScope: "tenant:acme",
    reachable: true,
    verifiedBy: "trusted-verifier",
  }).success, true);
});

test("evidenceAddressSchema: REFUSES missing scheme or locator", () => {
  assert.equal(evidenceAddressSchema.safeParse({ locator: "x" }).success, false);
  assert.equal(evidenceAddressSchema.safeParse({ scheme: "file" }).success, false);
});

test("evidenceRecordSchema: validates full evidence record", () => {
  assert.equal(evidenceRecordSchema.safeParse({
    address: { scheme: "file", locator: "/data/ev.json", sourceVersion: "v1", tenantScope: "tenant/acme", verifiedBy: "trusted-verifier" },
    payload: { key: "value" },
    schemaVersion: "1.0.0",
    collectedAt: "2026-10-23T00:00:00Z",
    modelConfidence: "high",
    independentlyVerified: true,
  }).success, true);
});

test("evidencePageSchema: validates paginated list", () => {
  const page = {
    items: [{
      address: { scheme: "file", locator: "/data/ev.json", sourceVersion: "v1", tenantScope: "tenant/acme", verifiedBy: "trusted-verifier" },
      payload: {},
      schemaVersion: "1.0.0",
      collectedAt: "2026-10-23T00:00:00Z",
    }],
    cursor: "page1",
    nextCursor: "page2",
    hasMore: true,
    total: 50,
  };
  assert.equal(evidencePageSchema.safeParse(page).success, true);
});

test("evidenceFreshnessSchema: validates freshness with coverage", () => {
  assert.equal(evidenceFreshnessSchema.safeParse({
    asOf: "2026-10-23T00:00:00Z",
    coverage: { totalAssertions: 100, evidenced: 85, ratio: 0.85 },
    staleAfterMs: 3600000,
    isStale: false,
  }).success, true);
});

test("validateNotScreenshotInferred: REJECTS screenshot scheme", () => {
  const result = validateNotScreenshotInferred({ scheme: "screenshot", locator: "img.png" });
  assert.equal(result.valid, false);
  assert.ok(/screenshot/.test(result.error));
});

test("validateNotScreenshotInferred: REJECTS image scheme", () => {
  const result = validateNotScreenshotInferred({ scheme: "image", locator: "img.png" });
  assert.equal(result.valid, false);
  assert.ok(/screenshot/.test(result.error));
});

test("validateNotScreenshotInferred: REJECTS address without sourceVersion or contentHash", () => {
  const result = validateNotScreenshotInferred({ scheme: "http", locator: "https://example.com/data" });
  assert.equal(result.valid, false);
  assert.ok(/sourceVersion/.test(result.error));
});

test("validateNotScreenshotInferred: ACCEPTS address with sourceVersion", () => {
  const result = validateNotScreenshotInferred({
    scheme: "http",
    locator: "https://example.com/data",
    sourceVersion: "enrich-v2@1.0.0",
    tenantScope: "tenant/acme",
    verifiedBy: "trusted-verifier",
  }, { verifySource: (address) => address.locator === "https://example.com/data" });
  assert.equal(result.valid, true);
});

test("validateNotScreenshotInferred: ACCEPTS address with contentHash", () => {
  const result = validateNotScreenshotInferred({
    scheme: "file",
    locator: "/data/ev.json",
    contentHash: "abc123",
    tenantScope: "tenant/acme",
    verifiedBy: "trusted-verifier",
  }, { verifySource: (address) => address.locator === "/data/ev.json" });
  assert.equal(result.valid, true);
});

test("EvidenceError: typed errors with codes", () => {
  const err = evidenceNotFound("engram://s1/obs/99");
  assert.ok(err instanceof EvidenceError);
  assert.equal(err.code, "evidence_not_found");
  assert.equal(err.address, "engram://s1/obs/99");

  const err2 = evidenceStale("engram://s1/obs/1", "2026-01-01");
  assert.equal(err2.code, "evidence_stale");

  const err3 = evidenceUnsupportedScheme("ftp");
  assert.equal(err3.code, "unsupported_evidence_scheme");
});

test("evidenceMigrationPolicySchema: validates migration policy", () => {
  assert.equal(evidenceMigrationPolicySchema.safeParse({
    fromSchemaVersion: "1.0.0",
    toSchemaVersion: "2.0.0",
    compatibility: "breaking",
    createdAt: "2026-10-23T00:00:00Z",
    appliesToSchemes: ["file", "engram"],
  }).success, true);
});

test("evidenceRecordSchema: REFUSES record without schemaVersion", () => {
  const result = evidenceRecordSchema.safeParse({
    address: { scheme: "file", locator: "/data/ev.json", sourceVersion: "v1", tenantScope: "tenant/acme", verifiedBy: "trusted-verifier" },
    payload: {},
    collectedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(result.success, false);
});

test("evidenceRecordSchema: REFUSES undefined payload (z.json() rejects undefined)", () => {
  const result = evidenceRecordSchema.safeParse({
    address: { scheme: "file", locator: "/data/ev.json", sourceVersion: "v1", tenantScope: "tenant/acme", verifiedBy: "trusted-verifier" },
    payload: undefined,
    schemaVersion: "1.0.0",
    collectedAt: "2026-10-23T00:00:00Z",
  });
  assert.equal(result.success, false);
});

// --- New tests for luna-judge P2 findings ---

test("evidencePageSchema: REFUSES hasMore=true without nextCursor", () => {
  const r = evidencePageSchema.safeParse({ items: [], hasMore: true, total: 0 });
  assert.equal(r.success, false, "hasMore without nextCursor must be rejected");
  const messages = r.error.issues.map((i) => i.message);
  assert.ok(messages.some((m) => /hasMore.*requires.*nextCursor/i.test(m) || /nextCursor/i.test(m)),
    "must report missing nextCursor: " + JSON.stringify(messages));
});

test("evidencePageSchema: ACCEPTS hasMore=true with nextCursor", () => {
  const r = evidencePageSchema.safeParse({ items: [], hasMore: true, nextCursor: "page2", total: 100 });
  assert.equal(r.success, true, "hasMore with nextCursor must be accepted");
});

test("evidenceAddressSchema: REFUSES sourceVersion without verifiedBy", () => {
  const r = evidenceAddressSchema.safeParse({
    scheme: "https",
    locator: "api.example.com/v1/data",
    sourceVersion: "engram-evidence@1.0.0",
    tenantScope: "tenant/acme",
  });
  assert.equal(r.success, false,
    "sourceVersion without verifiedBy must be rejected (self-attested hash is not proof)");
  const messages = r.error.issues.map((i) => i.message);
  assert.ok(messages.some((m) => /verifiedBy/i.test(m)),
    "must report missing verifiedBy: " + JSON.stringify(messages));
});

test("evidenceAddressSchema: REFUSES contentHash without verifiedBy", () => {
  const r = evidenceAddressSchema.safeParse({
    scheme: "https",
    locator: "api.example.com/v1/data",
    contentHash: "sha256:abc123",
    tenantScope: "tenant/acme",
  });
  assert.equal(r.success, false,
    "contentHash without verifiedBy must be rejected (self-supplied hash is not proof)");
});

test("evidenceAddressSchema: ACCEPTS sourceVersion with verifiedBy", () => {
  const r = evidenceAddressSchema.safeParse({
    scheme: "https",
    locator: "api.example.com/v1/data",
    sourceVersion: "engram-evidence@1.0.0",
    tenantScope: "tenant/acme",
    verifiedBy: "trusted-verifier-001",
  });
  assert.equal(r.success, true,
    "sourceVersion with verifiedBy must be accepted: " + JSON.stringify(r.error?.issues));
});

test("validateNotScreenshotInferred: REFUSES address without verifiedBy", () => {
  const r = validateNotScreenshotInferred({
    scheme: "https",
    locator: "api.example.com/v1/data",
    sourceVersion: "engram-evidence@1.0.0",
    tenantScope: "tenant/acme",
  });
  assert.equal(r.valid, false,
    "address without verifiedBy must be rejected by validateNotScreenshotInferred");
  assert.ok(/verifiedBy/.test(r.error),
    "must report missing verifiedBy: " + JSON.stringify(r.error));
});

test("validateNotScreenshotInferred: ACCEPTS address after trusted source verification", () => {
  const r = validateNotScreenshotInferred({
    scheme: "https",
    locator: "api.example.com/v1/data",
    sourceVersion: "engram-evidence@1.0.0",
    tenantScope: "tenant/acme",
    verifiedBy: "trusted-verifier-001",
  }, { verifySource: (address) => address.sourceVersion === "engram-evidence@1.0.0" });
  assert.equal(r.valid, true,
    "address with verifiedBy must be accepted: " + r.error);
});
