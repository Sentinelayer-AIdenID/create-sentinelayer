/**
 * ENGRAM §EW02 — SourceSnapshot contract.
 *
 * A SourceSnapshot captures the provenance of every fact: what source produced
 * it, at what version, when, and under which tenant scope. No assertion is
 * authoritative without a reachable, versioned source snapshot.
 */

import { z } from "zod";

/**
 * A point-in-time snapshot of a data source.
 *
 * Every fact in the ENGRAM graph MUST be traceable to a source snapshot that
 * declares its version, capture time, and tenant scope. Absence of any of
 * these fields means the fact cannot be classified as authoritative.
 */
export const sourceSnapshotSchema = z.object({
  sourceId: z.string().min(1),
  sourceType: z.enum([
    "session",
    "api",
    "ingest",
    "manual",
    "derived",
    "import",
  ]),
  version: z.string().min(1),
  capturedAt: z.string().datetime(),
  tenantScope: z.string().min(1),
  contentHash: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.json()).optional(),
}).strict();

/**
 * Valid fixture: a complete, valid source snapshot.
 */
export const VALID_SOURCE_SNAPSHOT = Object.freeze({
  sourceId: "src-session-abc123",
  sourceType: "session",
  version: "1.2.0",
  capturedAt: "2026-10-23T12:00:00Z",
  tenantScope: "tenant/acme",
  contentHash: "sha256:abc123def456",
});

/**
 * A minimal but valid source snapshot (no optional fields).
 */
export const MINIMAL_SOURCE_SNAPSHOT = Object.freeze({
  sourceId: "src-min-001",
  sourceType: "manual",
  version: "0.1.0",
  capturedAt: "2026-10-23T00:00:00Z",
  tenantScope: "tenant/default",
});
