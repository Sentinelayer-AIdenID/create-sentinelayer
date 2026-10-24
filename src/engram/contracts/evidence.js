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
 *
 * Luna-judge P2: evidencePageSchema requires nextCursor when hasMore is true.
 */

import { z } from "zod";
import { EVIDENCE_SCHEMA_VERSION } from "./versions.js";

/**
 * Supported evidence locator schemes. "screenshot" and
 * "image" are explicitly banned (ticket 73ead329: no inferred backend
 * endpoints from screenshots).
 */
const TRUSTED_SCHEMES = Object.freeze(["file", "http", "https", "engram", "receipt", "inline"]);

/**
 * An evidence address: a stable reference to where an assertion's proof lives.
 * Must NOT be inferred from screenshots (ticket 73ead329 constraint).
 *
 * These fields record a provenance claim. Parsing them does not authenticate
 * the claimed verifier; consumers must check it against a trusted source.
 */
export const evidenceAddressSchema = z.object({
  /** Protocol/scheme: must be an allowed locator scheme */
  scheme: z.enum(["file", "http", "https", "engram", "receipt", "inline"]),
  /** Locator within that scheme */
  locator: z.string().min(1),
  /** Content hash at the time of reference (for integrity) */
  contentHash: z.string().min(1).optional(),
  /** When this evidence was captured */
  capturedAt: z.string().datetime().optional(),
  /** Source version that produced this evidence */
  sourceVersion: z.string().min(1).optional(),
  /** Tenant scope of the evidence */
  tenantScope: z.string().min(1),
  /** Whether the evidence is still reachable */
  reachable: z.boolean().optional(),
  /** Verifier identity — who attested this address was not screenshot-inferred */
  verifiedBy: z.string().min(1).optional(),
}).strict().refine(
  (addr) => {
    // At least one of sourceVersion or contentHash must be present to
    // guard against screenshot-inferred evidence.
    if (!addr.sourceVersion && !addr.contentHash) return false;
    // Require a verifier identity as metadata, but do not treat this string as
    // proof of independent verification.
    if (!addr.verifiedBy) return false;
    return true;
  },
  {
    message: "evidence address must claim sourceVersion or contentHash and verifiedBy; a trusted source must verify the claim",
    path: ["verifiedBy"],
  },
);

/**
 * An evidence record: the address plus the actual evidence payload.
 */
export const evidenceRecordSchema = z.object({
  address: evidenceAddressSchema,
  /** The raw evidence payload (type depends on scheme) */
  payload: z.json(),
  /** Schema version of the evidence format */
  schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
  /** When the evidence was collected */
  collectedAt: z.string().datetime(),
  /** When the evidence expires (if applicable) */
  expiresAt: z.string().datetime().optional(),
  /** Model confidence in the evidence interpretation */
  modelConfidence: z.enum(["high", "medium", "low", "unavailable"]).optional(),
  /** Whether the evidence has been independently verified */
  independentlyVerified: z.boolean().optional(),
  /** Verifier identity — who attested this evidence is not screenshot-inferred */
  verifiedBy: z.string().min(1).optional(),
}).strict().superRefine((record, ctx) => {
  if (record.address.capturedAt && Date.parse(record.address.capturedAt) > Date.parse(record.collectedAt)) {
    ctx.addIssue({ code: "custom", message: "address capturedAt cannot be after collectedAt", path: ["address", "capturedAt"] });
  }
  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.parse(record.collectedAt)) {
    ctx.addIssue({ code: "custom", message: "expiresAt must be after collectedAt", path: ["expiresAt"] });
  }
});

/**
 * Paginated evidence list.
 *
 * When hasMore is true, nextCursor is required so clients can retrieve the
 * next page (luna-judge P2 finding).
 */
export const evidencePageSchema = z.object({
  items: z.array(evidenceRecordSchema),
  cursor: z.string().optional(),
  nextCursor: z.string().optional(),
  hasMore: z.boolean(),
  total: z.number().int().nonnegative().optional(),
}).strict().superRefine((data, ctx) => {
  if (data.hasMore && !data.nextCursor) {
    ctx.addIssue({ code: "custom", message: "hasMore requires nextCursor for pagination", path: ["nextCursor"] });
  }
  const scopes = new Set(data.items.map((record) => record.address.tenantScope));
  if (scopes.size > 1) {
    ctx.addIssue({ code: "custom", message: "evidence page cannot mix tenant scopes", path: ["items"] });
  }
  if (data.total != null && data.total < data.items.length) {
    ctx.addIssue({ code: "custom", message: "total cannot be smaller than items count", path: ["total"] });
  }
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
}).strict();

/**
 * Freshness declaration for an evidence set.
 */
export const evidenceFreshnessSchema = z.object({
  asOf: z.string().datetime(),
  coverage: z.object({
    totalAssertions: z.number().int().nonnegative(),
    evidenced: z.number().int().nonnegative(),
    ratio: z.number().min(0).max(1),
  }).strict().superRefine((coverage, ctx) => {
    if (coverage.evidenced > coverage.totalAssertions) {
      ctx.addIssue({ code: "custom", path: ["evidenced"], message: "evidenced cannot exceed totalAssertions" });
    }
    const expected = coverage.totalAssertions === 0 ? 0 : coverage.evidenced / coverage.totalAssertions;
    if (Math.abs(coverage.ratio - expected) > 1e-9) {
      ctx.addIssue({ code: "custom", path: ["ratio"], message: "ratio must match evidenced / totalAssertions" });
    }
  }),
  staleAfterMs: z.number().int().positive().optional(),
  isStale: z.boolean().optional(),
}).strict();

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
 * Validate the address shape and ask a trusted, out-of-band source verifier
 * whether it was actually derived from the stated source. Caller-supplied
 * sourceVersion, hash, and verifiedBy strings cannot prove this by themselves.
 *
 * @param {object} address — evidenceAddressSchema-shaped
 * @param {{verifySource?: (address: object) => boolean}} options
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateNotScreenshotInferred(address, { verifySource } = {}) {
  if (!address || typeof address !== "object") {
    return { valid: false, error: "evidence address is required" };
  }
  if (address.scheme === "screenshot" || address.scheme === "image") {
    return {
      valid: false,
      error: `evidence scheme "${address.scheme}" is screenshot-inferred; backend endpoints must not be inferred from screenshots (ticket 73ead329)`,
    };
  }
  if (address.scheme && !TRUSTED_SCHEMES.includes(address.scheme)) {
    return {
      valid: false,
      error: `evidence scheme "${address.scheme}" is not a trusted scheme; must be one of: ${TRUSTED_SCHEMES.join(", ")}`,
    };
  }
  if (!address.sourceVersion && !address.contentHash) {
    return {
      valid: false,
      error: "evidence address lacks both sourceVersion and contentHash; cannot verify it was not screenshot-inferred",
    };
  }
  if (!address.verifiedBy) {
    return {
      valid: false,
      error: "evidence address lacks verifiedBy metadata; trusted source verification is also required",
    };
  }
  if (!evidenceAddressSchema.safeParse(address).success) {
    return { valid: false, error: "evidence address does not match the required source and tenant shape" };
  }
  if (typeof verifySource !== "function") {
    return { valid: false, error: "trusted source verification is required; verifiedBy is only a claim" };
  }
  try {
    if (verifySource(address) !== true) {
      return { valid: false, error: "trusted source did not verify this evidence address" };
    }
  } catch {
    return { valid: false, error: "trusted source verification failed" };
  }
  return { valid: true };
}
