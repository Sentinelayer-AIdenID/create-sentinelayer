import "./setup-env.mjs";
// unit.engram-contracts-new.test.mjs — EW02: new contract schemas (luna-judge finding F1).

import test from "node:test";
import assert from "node:assert/strict";
import {
  sourceSnapshotSchema,
  VALID_SOURCE_SNAPSHOT,
  MINIMAL_SOURCE_SNAPSHOT,
  mediaAssetSchema,
  VALID_MEDIA_ASSET,
  MEDIA_ASSET_TYPES,
  mediaAssetTypeSchema,
  temporalSegmentSchema,
  VALID_TEMPORAL_SEGMENT,
  TEMPORAL_SEGMENT_KINDS,
  temporalSegmentKindSchema,
  delegationReferenceSchema,
  taskContextPackSchema,
  VALID_TASK_CONTEXT_PACK,
  actionReceiptSchema,
  VALID_ACTION_RECEIPT,
  ACTION_RECEIPT_STATUSES,
  actionReceiptStatusSchema,
  CONTRACT_VERSIONS,
  GRAPH_SCHEMA_VERSION,
  EVIDENCE_SCHEMA_VERSION,
  COMPAT_FIXTURES,
  graphSchema,
} from "../src/engram/contracts/index.js";

// --- SourceSnapshot ---

test("sourceSnapshotSchema: accepts valid complete snapshot", () => {
  const r = sourceSnapshotSchema.safeParse(VALID_SOURCE_SNAPSHOT);
  assert.equal(r.success, true);
});

test("sourceSnapshotSchema: accepts minimal snapshot", () => {
  const r = sourceSnapshotSchema.safeParse(MINIMAL_SOURCE_SNAPSHOT);
  assert.equal(r.success, true);
});

test("sourceSnapshotSchema: REFUSES missing tenantScope", () => {
  const { tenantScope, ...rest } = VALID_SOURCE_SNAPSHOT;
  const r = sourceSnapshotSchema.safeParse(rest);
  assert.equal(r.success, false);
});

test("sourceSnapshotSchema: REFUSES missing version", () => {
  const { version, ...rest } = VALID_SOURCE_SNAPSHOT;
  const r = sourceSnapshotSchema.safeParse(rest);
  assert.equal(r.success, false);
});

test("sourceSnapshotSchema: REFUSES extra unknown field (strict)", () => {
  const r = sourceSnapshotSchema.safeParse({ ...VALID_SOURCE_SNAPSHOT, fabricated: true });
  assert.equal(r.success, false);
});

// --- MediaAsset ---

test("mediaAssetSchema: accepts valid asset", () => {
  const r = mediaAssetSchema.safeParse(VALID_MEDIA_ASSET);
  assert.equal(r.success, true);
});

test("mediaAssetSchema: REFUSES missing contentHash", () => {
  const { contentHash, ...rest } = VALID_MEDIA_ASSET;
  const r = mediaAssetSchema.safeParse(rest);
  assert.equal(r.success, false);
});

test("mediaAssetSchema: REFUSES missing sourceSnapshot", () => {
  const { sourceSnapshot, ...rest } = VALID_MEDIA_ASSET;
  const r = mediaAssetSchema.safeParse(rest);
  assert.equal(r.success, false);
});

// --- TemporalSegment ---

test("temporalSegmentSchema: accepts valid segment", () => {
  const r = temporalSegmentSchema.safeParse(VALID_TEMPORAL_SEGMENT);
  assert.equal(r.success, true);
});

test("temporalSegmentSchema: REFUSES endTime before startTime", () => {
  const r = temporalSegmentSchema.safeParse({
    ...VALID_TEMPORAL_SEGMENT,
    startTime: "2026-10-23T12:30:00Z",
    endTime: "2026-10-23T12:00:00Z",
  });
  assert.equal(r.success, false, "must reject endTime before startTime");
  const messages = r.error.issues.map((i) => i.message);
  assert.ok(
    messages.some((m) => /endTime.*after.*startTime/i.test(m)),
    "must report endTime ordering violation"
  );
});

// --- DelegationReference ---

test("delegationReferenceSchema: accepts valid delegation", () => {
  const r = delegationReferenceSchema.safeParse({
    delegateId: "agent-ew03-001",
    capability: "evidence-fetch@1.0.0",
  });
  assert.equal(r.success, true);
});

test("delegationReferenceSchema: REFUSES missing delegateId", () => {
  const r = delegationReferenceSchema.safeParse({
    capability: "evidence-fetch@1.0.0",
  });
  assert.equal(r.success, false);
});

// --- TaskContextPack ---

test("taskContextPackSchema: accepts valid pack", () => {
  const r = taskContextPackSchema.safeParse(VALID_TASK_CONTEXT_PACK);
  assert.equal(r.success, true);
});

test("taskContextPackSchema: REFUSES missing version", () => {
  const { version, ...rest } = VALID_TASK_CONTEXT_PACK;
  const r = taskContextPackSchema.safeParse(rest);
  assert.equal(r.success, false);
});

test("taskContextPackSchema: REFUSES extra unknown field (strict)", () => {
  const r = taskContextPackSchema.safeParse({ ...VALID_TASK_CONTEXT_PACK, injected: "bad" });
  assert.equal(r.success, false);
});

// --- ActionReceipt ---

test("actionReceiptSchema: accepts valid receipt", () => {
  const r = actionReceiptSchema.safeParse(VALID_ACTION_RECEIPT);
  assert.equal(r.success, true);
});

test("actionReceiptSchema: REFUSES missing verifier", () => {
  const { verifier, ...rest } = VALID_ACTION_RECEIPT;
  const r = actionReceiptSchema.safeParse(rest);
  assert.equal(r.success, false);
});

test("actionReceiptSchema: REFUSES missing contentHash", () => {
  const { contentHash, ...rest } = VALID_ACTION_RECEIPT;
  const r = actionReceiptSchema.safeParse(rest);
  assert.equal(r.success, false);
});

test("actionReceiptSchema: REFUSES invalid status", () => {
  const r = actionReceiptSchema.safeParse({ ...VALID_ACTION_RECEIPT, status: "unknown_status" });
  assert.equal(r.success, false);
});

// --- Enum and constant coverage tests ---

test("MEDIA_ASSET_TYPES: is a frozen array with expected values", () => {
  assert.ok(Array.isArray(MEDIA_ASSET_TYPES));
  assert.ok(MEDIA_ASSET_TYPES.includes("image"));
  assert.ok(MEDIA_ASSET_TYPES.includes("audio"));
  assert.ok(MEDIA_ASSET_TYPES.includes("video"));
  assert.ok(MEDIA_ASSET_TYPES.includes("document"));
  assert.ok(Object.isFrozen(MEDIA_ASSET_TYPES));
});

test("mediaAssetTypeSchema: accepts valid types, rejects invalid", () => {
  assert.equal(mediaAssetTypeSchema.safeParse("image").success, true);
  assert.equal(mediaAssetTypeSchema.safeParse("binary").success, true);
  assert.equal(mediaAssetTypeSchema.safeParse("screenshot").success, false);
});

test("TEMPORAL_SEGMENT_KINDS: is a frozen array with expected values", () => {
  assert.ok(Array.isArray(TEMPORAL_SEGMENT_KINDS));
  assert.ok(TEMPORAL_SEGMENT_KINDS.includes("session"));
  assert.ok(TEMPORAL_SEGMENT_KINDS.includes("observation_window"));
  assert.ok(Object.isFrozen(TEMPORAL_SEGMENT_KINDS));
});

test("temporalSegmentKindSchema: accepts valid kinds, rejects invalid", () => {
  assert.equal(temporalSegmentKindSchema.safeParse("session").success, true);
  assert.equal(temporalSegmentKindSchema.safeParse("replay_range").success, true);
  assert.equal(temporalSegmentKindSchema.safeParse("future").success, false);
});

test("ACTION_RECEIPT_STATUSES: is a frozen array with expected values", () => {
  assert.ok(Array.isArray(ACTION_RECEIPT_STATUSES));
  assert.ok(ACTION_RECEIPT_STATUSES.includes("executed"));
  assert.ok(ACTION_RECEIPT_STATUSES.includes("pending"));
  assert.ok(ACTION_RECEIPT_STATUSES.includes("rolled_back"));
  assert.ok(Object.isFrozen(ACTION_RECEIPT_STATUSES));
});

test("actionReceiptStatusSchema: accepts valid statuses, rejects invalid", () => {
  assert.equal(actionReceiptStatusSchema.safeParse("executed").success, true);
  assert.equal(actionReceiptStatusSchema.safeParse("pending").success, true);
  assert.equal(actionReceiptStatusSchema.safeParse("rolled_back").success, true);
  assert.equal(actionReceiptStatusSchema.safeParse("unknown_status").success, false);
});

test("CONTRACT_VERSIONS: all contracts have pinned semver strings", () => {
  assert.equal(typeof CONTRACT_VERSIONS, "object");
  assert.ok(Object.isFrozen(CONTRACT_VERSIONS));
  const semverRe = /^\d+\.\d+\.\d+$/;
  for (const [name, version] of Object.entries(CONTRACT_VERSIONS)) {
    assert.ok(semverRe.test(version), `${name} version "${version}" must be semver`);
  }
});

test("GRAPH_SCHEMA_VERSION: pinned to semver", () => {
  assert.equal(typeof GRAPH_SCHEMA_VERSION, "string");
  assert.ok(/^\d+\.\d+\.\d+$/.test(GRAPH_SCHEMA_VERSION));
});

test("EVIDENCE_SCHEMA_VERSION: pinned to semver", () => {
  assert.equal(typeof EVIDENCE_SCHEMA_VERSION, "string");
  assert.ok(/^\d+\.\d+\.\d+$/.test(EVIDENCE_SCHEMA_VERSION));
});

test("COMPAT_FIXTURES: graphV1 fixture matches GRAPH_SCHEMA_VERSION", () => {
  assert.ok(Object.isFrozen(COMPAT_FIXTURES));
  assert.equal(typeof COMPAT_FIXTURES.graphV1, "object");
  assert.equal(COMPAT_FIXTURES.graphV1.version, GRAPH_SCHEMA_VERSION);
  // The compat fixture must be usable with the current graph schema
  const result = graphSchema.safeParse(COMPAT_FIXTURES.graphV1);
  assert.equal(result.success, true, "compat graphV1 must validate against current graphSchema");
});
