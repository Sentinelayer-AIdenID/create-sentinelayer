/**
 * ENGRAM §EW02 — MediaAsset contract.
 *
 * A MediaAsset represents any media resource referenced by the ENGRAM graph:
 * images, audio, video, documents, or other binary/textual assets. Every
 * asset must declare its address scheme, content hash for integrity, and
 * a source snapshot reference.
 */

import { z } from "zod";
import { sourceSnapshotSchema } from "./source-snapshot.js";

export const MEDIA_ASSET_TYPES = Object.freeze([
  "image",
  "audio",
  "video",
  "document",
  "text",
  "binary",
  "other",
]);

export const mediaAssetTypeSchema = z.enum([
  "image",
  "audio",
  "video",
  "document",
  "text",
  "binary",
  "other",
]);

/**
 * A media asset in the ENGRAM graph.
 *
 * Every asset carries a content hash for integrity verification and a
 * source snapshot for provenance. Assets without a source snapshot cannot
 * be treated as authoritative evidence.
 */
export const mediaAssetSchema = z.object({
  assetId: z.string().min(1),
  type: mediaAssetTypeSchema,
  uri: z.string().min(1),
  contentHash: z.string().min(1),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().positive().optional(),
  sourceSnapshot: sourceSnapshotSchema,
  metadata: z.record(z.string(), z.json()).optional(),
  tenantScope: z.string().min(1),
}).strict().refine(
  (data) => {
    // Tenant scope must be consistent: top-level tenantScope must match
    // the sourceSnapshot's tenantScope, or an explicit authorization boundary
    // must be declared. Without authorization, cross-tenant is refused.
    if (data.tenantScope !== data.sourceSnapshot.tenantScope) {
      return false;
    }
    return true;
  },
  {
    message: "tenantScope must match sourceSnapshot.tenantScope; cross-tenant requires explicit authorization",
    path: ["tenantScope"],
  },
);

/**
 * Valid fixture: a complete, valid media asset.
 */
export const VALID_MEDIA_ASSET = Object.freeze({
  assetId: "ma-img-001",
  type: "image",
  uri: "https://evidence.example.com/assets/img-001.png",
  contentHash: "sha256:def789abc123",
  mimeType: "image/png",
  sizeBytes: 102400,
  sourceSnapshot: {
    sourceId: "src-session-abc123",
    sourceType: "session",
    version: "1.2.0",
    capturedAt: "2026-10-23T12:00:00Z",
    tenantScope: "tenant/acme",
  },
  tenantScope: "tenant/acme",
});
