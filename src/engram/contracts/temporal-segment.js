/**
 * ENGRAM §EW02 — TemporalSegment contract.
 *
 * A TemporalSegment anchors a set of assertions to a specific time window.
 * It is used for freshness tracking, replay, and time-bounded evidence
 * retrieval. Every temporal segment must declare its boundaries and a
 * source snapshot.
 */

import { z } from "zod";
import { sourceSnapshotSchema } from "./source-snapshot.js";

export const TEMPORAL_SEGMENT_KINDS = Object.freeze([
  "session",
  "observation_window",
  "ingest_batch",
  "replay_range",
]);

export const temporalSegmentKindSchema = z.enum([
  "session",
  "observation_window",
  "ingest_batch",
  "replay_range",
]);

/**
 * A time-bounded segment of the ENGRAM graph.
 */
export const temporalSegmentSchema = z.object({
  segmentId: z.string().min(1),
  kind: temporalSegmentKindSchema,
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  sourceSnapshot: sourceSnapshotSchema,
  assertionCount: z.number().int().nonnegative().optional(),
  coverageRatio: z.number().min(0).max(1).optional(),
  tenantScope: z.string().min(1),
}).strict();

/**
 * Valid fixture: a complete, valid temporal segment.
 */
export const VALID_TEMPORAL_SEGMENT = Object.freeze({
  segmentId: "ts-session-20261023-001",
  kind: "session",
  startTime: "2026-10-23T12:00:00Z",
  endTime: "2026-10-23T12:30:00Z",
  sourceSnapshot: {
    sourceId: "src-session-abc123",
    sourceType: "session",
    version: "1.2.0",
    capturedAt: "2026-10-23T12:00:00Z",
    tenantScope: "tenant/acme",
  },
  assertionCount: 150,
  tenantScope: "tenant/acme",
});
