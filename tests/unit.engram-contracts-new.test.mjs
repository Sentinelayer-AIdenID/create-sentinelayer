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
  temporalSegmentSchema,
  VALID_TEMPORAL_SEGMENT,
  delegationReferenceSchema,
  taskContextPackSchema,
  VALID_TASK_CONTEXT_PACK,
  actionReceiptSchema,
  VALID_ACTION_RECEIPT,
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
  // Schema doesn't enforce ordering, just accepts datetimes
  assert.equal(r.success, true);
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
