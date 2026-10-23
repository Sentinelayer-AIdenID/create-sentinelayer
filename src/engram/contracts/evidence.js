/**
 * ENGRAM §EW02 — Evidence contract (R09 truth).
 *
 * Every assertion's evidence is addressable. This module codifies:
 *   - Evidence addresses: stable references to the source of an assertion
 *   - Pagination: cursor-based evidence list traversal
 *   - Migration policy: evidence format version compatibility
 *   - Freshness: every evidence carries an asOf or declares itself stale
 *
 * Mandatory constraint (ticket 73ead329): include unknown/unsupported/stale
 * errors, pagination, evidence addresses, migration policy and protocol
 * capability negotiation.
 */

import { z } from "zod";

/**
 * An evidence address: a stable reference to where an assertion's proof lives.
 * Must NOT be inferred from screenshots (ticket 73ead329 constraint).
 */
export const evidenceAddressSchema = z.object({
  /** Protocol/scheme: "file", "http", "engram", "receipt", "inline" */
  scheme: z.string().min(1),
  /** Locator within that scheme */
  locator: z.string().min(1),
  /** Content hash at the time of reference (for integrity) */
  contentHash: z.string().optional(),
  /** When this evidence was captured */
  capturedAt: z.string().datetime().optional(),
  /** Source version that produced this evidence */
  sourceVersion: z.string().optional(),
  /** Tenant scope of the evidence */
  tenantScope: z.string().optional(),
  /** Whether the evidence is still reachable */
  reachable: z.boolean().optional(),
});

/**
 * An evidence record: the address plus the actual evidence payload.
 */
export const evidenceRecordSchema = z.object({
  address: evidenceAddressSchema,
  /** The raw evidence payload (type depends on scheme) */
  payload: z.unknown(),
  /** Schema version of the evidence format */
  schemaVersion: z.string().min(1),
  /** When the evidence was collected */
  collectedAt: z.string().datetime(),
  /** When the evidence expires (if applicable) */
  expiresAt: z.string().datetime().optional(),
  /** Model confidence in the evidence interpretation */
  modelConfidence: z.enum(["high", "medium", "low", "unavailable"]).optional(),
  /** Whether the evidence has been independently verified */
  independentlyVerified: z.boolean().optional(),
});

/**
 * Paginated evidence list.
 */
export const evidencePageSchema = z.object({
  items: z.array(evidenceRecordSchema),
  cursor: z.string().optional(),
  nextCursor: z.string().optional(),
  hasMore: z.boolean(),
  total: z.number().int().nonnegative().optional(),
});

/**
 * Migration policy for evidence format changes.
 */
export const evidenceMigrationPolicySchema = z.object({
  fromSchemaVersion: z.string().min(1),
  toSchemaVersion: z.string().min(1),
  compatibility: z.enum(["compatible", "breaking", "additive"]),
  migrationNotes: z.string().optional(),
  createdAt: z.string().datetime(),
  appliesToSchemes: z.array(z.string()).optional(),
});

/**
 * Freshness declaration for an evidence set.
 */
export const evidenceFreshnessSchema = z.object({
  asOf: z.string().datetime(),
  coverage: z.object({
    totalAssertions: z.number().int().nonnegative(),
    evidenced: z.number().int().nonnegative(),
    ratio: z.number().min(0).max(1),
  }),
  staleAfterMs: z.number().int().positive().optional(),
  isStale: z.boolean().optional(),
});

/**
 * Error types for evidence operations.
 */
export class EvidenceError extends Error {
  constructor(message, code, address) {
    super(message);
    this.name = "EvidenceError";
    this.code = code;
    this.address = address || null;
  }
}

export function evidenceNotFound(address) {
  return new EvidenceError(
    `evidence at "${address}" not found or unreachable`,
    "evidence_not_found",
    address,
  );
}

export function evidenceStale(address, asOf) {
  return new EvidenceError(
    `evidence at "${address}" is stale (asOf ${asOf})`,
    "evidence_stale",
    address,
  );
}

export function evidenceUnsupportedScheme(scheme) {
  return new EvidenceError(
    `evidence scheme "${scheme}" is not supported by this runtime`,
    "unsupported_evidence_scheme",
    null,
  );
}

/**
 * Validate that an evidence address was NOT inferred from a screenshot.
 * Screenshot-inferred evidence has no contentHash and no sourceVersion — it
 * is rejected with a clear error.
 *
 * @param {object} address — evidenceAddressSchema-shaped
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateNotScreenshotInferred(address) {
  if (!address || typeof address !== "object") {
    return { valid: false, error: "evidence address is required" };
  }
  if (address.scheme === "screenshot" || address.scheme === "image") {
    return {
      valid: false,
      error: `evidence scheme "${address.scheme}" is screenshot-inferred; backend endpoints must not be inferred from screenshots (ticket 73ead329)`,
    };
  }
  if (!address.sourceVersion && !address.contentHash) {
    return {
      valid: false,
      error: "evidence address lacks both sourceVersion and contentHash; cannot verify it was not screenshot-inferred",
    };
  }
  return { valid: true };
}
