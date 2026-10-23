/**
 * ENGRAM §EW02 — ActionReceipt contract.
 *
 * An ActionReceipt is a verifiable record of an action taken by an agent or
 * system. It carries a content hash, timestamp, verifier identity, and a
 * source snapshot. Receipts without these fields cannot be used to establish
 * authoritative provenance.
 *
 * Note: The contentHash and verifier fields provide integrity and attestation;
 * full cryptographic verification (signatures, signed payloads) is deferred to
 * a future contract version. Do not treat these receipts as cryptographically
 * authoritative without verifying signatures at the application layer.
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
  contentHash: z.string().regex(
    /^[a-z0-9]+:[a-zA-Z0-9+/=-]+$/,
    { message: "contentHash must be scheme:encoded format (e.g. sha256:<hex>)" },
  ),
  sourceSnapshot: sourceSnapshotSchema,
  tenantScope: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

/**
 * Valid fixture: a complete, valid action receipt.
 */
export const VALID_ACTION_RECEIPT = Object.freeze({
  receiptId: "rec-exec-abc123",
  action: "graph.validate",
  status: "executed",
  performedAt: "2026-10-23T12:00:01Z",
  verifier: "aidenid-verifier-01",
  contentHash: "sha256:YWJjMTIzZGVmNDU2Cg==",
  sourceSnapshot: {
    sourceId: "src-session-abc123",
    sourceType: "session",
    version: "1.2.0",
    capturedAt: "2026-10-23T12:00:00Z",
    tenantScope: "tenant/acme",
  },
  tenantScope: "tenant/acme",
});
