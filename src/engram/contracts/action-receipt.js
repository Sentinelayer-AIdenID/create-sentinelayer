/**
 * ENGRAM §EW02 — ActionReceipt contract.
 *
 * An ActionReceipt is a verifiable record of an action taken by an agent or
 * system. It carries a content hash, timestamp, verifier identity, and a
 * source snapshot. Receipts without these fields cannot be used to establish
 * authoritative provenance.
 *
 * The contentHash and verifier fields are claims until an application checks
 * the digest against the actual action payload and authenticates the verifier.
 */

import { z } from "zod";
import { sourceSnapshotSchema } from "./source-snapshot.js";

export const ACTION_RECEIPT_STATUSES = Object.freeze([
  "executed",
  "failed",
  "pending",
  "rolled_back",
]);

export const actionReceiptStatusSchema = z.enum([
  "executed",
  "failed",
  "pending",
  "rolled_back",
]);

// SHA-256 is 32 bytes: 64 hex characters or canonical padded base64.
// Encoding validation alone does not verify the claimed action payload.
const SHA256_CONTENT_HASH_RE = /^sha256:(?:[0-9a-fA-F]{64}|[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=)$/;

/**
 * A verifiable receipt for an action performed in the system.
 *
 * Every receipt carries a content hash over the action payload, the
 * verifier identity, and a source snapshot. The contentHash format is a
 * scheme-prefixed digest (e.g. "sha256:<hex>") for integrity checking;
 * full signature verification is deferred to a future contract version.
 */
export const actionReceiptSchema = z.object({
  receiptId: z.string().min(1),
  action: z.string().min(1),
  status: actionReceiptStatusSchema,
  performedAt: z.string().datetime(),
  verifier: z.string().min(1),
  contentHash: z.string().regex(SHA256_CONTENT_HASH_RE, {
    message: "contentHash must be a complete sha256 digest in hex or canonical base64",
  }),
  sourceSnapshot: sourceSnapshotSchema,
  tenantScope: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.json()).optional(),
}).strict().refine(
  (data) => {
    // Tenant scope must be consistent with sourceSnapshot.
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
 * Valid fixture: a complete, valid action receipt.
 */
export const VALID_ACTION_RECEIPT = Object.freeze({
  receiptId: "rec-exec-abc123",
  action: "graph.validate",
  status: "executed",
  performedAt: "2026-10-23T12:00:01Z",
  verifier: "aidenid-verifier-01",
  contentHash: "sha256:nji40eArkmG6ZZyc3Od23mge2TYew/f4vFc/wTBwCOE=",
  sourceSnapshot: {
    sourceId: "src-session-abc123",
    sourceType: "session",
    version: "1.2.0",
    capturedAt: "2026-10-23T12:00:00Z",
    tenantScope: "tenant/acme",
  },
  tenantScope: "tenant/acme",
});
