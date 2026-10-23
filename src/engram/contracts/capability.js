/**
 * ENGRAM §EW02 — Capability contract (R04 skills, R14 parallelism).
 *
 * Source/capability versions and tenant scope are required — no inferred
 * backend endpoints from screenshots (ticket 73ead329 mandatory constraints).
 *
 * This module codifies:
 *   - Capability versioning: every source and capability declares its version
 *   - Tenant scoping: every graph consumer operates within a tenant
 *   - Protocol capability negotiation: what two parties agree they can do
 *   - Unknown/unsupported/stale errors: typed, with evidence addresses
 *   - Pagination: cursor-based pagination for evidence lists
 *   - Migration policy: version compatibility declarations
 */

import { z } from "zod";

/**
 * A capability version identifier.
 * Format: <name>@<semver> (e.g. "engram-graph@1.0.0")
 */
const CAPABILITY_VERSION_RE = /^[a-z][a-z0-9_-]{0,47}@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export const capabilityVersionSchema = z.string().regex(
  CAPABILITY_VERSION_RE,
  { message: "capability version must match <name>@<semver>" },
);

/**
 * A tenant scope: the namespace boundary for all capability operations.
 */
export const tenantScopeSchema = z.object({
  tenantId: z.string().min(1).max(128),
  namespace: z.string().min(1).max(256).optional(),
  environment: z.enum(["production", "staging", "development", "sandbox"]).optional(),
});

/**
 * A source descriptor: identifies where an assertion or capability originated.
 */
export const sourceDescriptorSchema = z.object({
  sourceId: z.string().min(1),
  sourceType: z.enum(["adapter", "ingest", "derived", "external", "manual"]),
  version: capabilityVersionSchema,
  tenantScope: tenantScopeSchema.optional(),
  endpoint: z.string().url().optional(),
});

/**
 * A single capability entry: what a source can do, at what version.
 */
export const capabilityEntrySchema = z.object({
  capability: z.string().min(1),
  version: capabilityVersionSchema,
  source: sourceDescriptorSchema,
  status: z.enum(["supported", "deprecated", "experimental", "unknown", "unsupported", "stale"]),
  evidenceAddress: z.string().optional(),
  deprecatesAt: z.string().datetime().optional(),
  migratesTo: capabilityVersionSchema.optional(),
});

/**
 * Protocol capability negotiation result.
 */
export const negotiationResultSchema = z.object({
  capability: z.string().min(1),
  clientVersion: capabilityVersionSchema,
  serverVersion: capabilityVersionSchema.optional(),
  negotiatedVersion: capabilityVersionSchema.optional(),
  result: z.enum(["matched", "upgraded", "downgraded", "incompatible", "unknown"]),
  reason: z.string().optional(),
  evidenceAddress: z.string().optional(),
});

/**
 * Pagination cursor for evidence lists.
 */
export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  nextCursor: z.string().optional(),
  hasMore: z.boolean().optional(),
  total: z.number().int().nonnegative().optional(),
});

/**
 * Migration policy: declares compatibility between capability versions.
 */
export const migrationPolicySchema = z.object({
  capability: z.string().min(1),
  fromVersion: capabilityVersionSchema,
  toVersion: capabilityVersionSchema,
  compatibility: z.enum(["compatible", "breaking", "additive"]),
  migrationNotes: z.string().optional(),
  createdAt: z.string().datetime(),
});

/**
 * Error types for capability operations.
 */
export class CapabilityError extends Error {
  constructor(message, code, evidence) {
    super(message);
    this.name = "CapabilityError";
    this.code = code;
    this.evidence = evidence || null;
  }
}

export function unknownCapability(capability, evidence) {
  return new CapabilityError(
    `capability "${capability}" is unknown or not registered`,
    "unknown_capability",
    evidence,
  );
}

export function unsupportedCapability(capability, version, reason, evidence) {
  return new CapabilityError(
    `capability "${capability}@${version}" is unsupported: ${reason || "no reason given"}`,
    "unsupported_capability",
    evidence,
  );
}

export function staleCapability(capability, version, asOf, evidence) {
  return new CapabilityError(
    `capability "${capability}@${version}" is stale (asOf ${asOf}); refresh required`,
    "stale_capability",
    evidence,
  );
}

/**
 * Negotiate a protocol capability between client and server.
 *
 * @param {object} params
 * @param {string} params.capability
 * @param {string} params.clientVersion
 * @param {Array<{capability: string, version: string, status: string}>} params.serverCapabilities
 * @returns {object} negotiationResultSchema-shaped result
 */
export function negotiateCapability({ capability, clientVersion, serverCapabilities = [] } = {}) {
  if (!capability || !clientVersion) {
    return {
      capability: capability || "unknown",
      clientVersion: clientVersion || "0.0.0",
      serverVersion: undefined,
      negotiatedVersion: undefined,
      result: "incompatible",
      reason: "capability and clientVersion are required",
    };
  }

  const serverCap = serverCapabilities.find((c) => c.capability === capability);

  if (!serverCap) {
    return {
      capability,
      clientVersion,
      serverVersion: undefined,
      negotiatedVersion: undefined,
      result: "unknown",
      reason: `capability "${capability}" is not registered on the server`,
    };
  }

  if (serverCap.status === "unsupported") {
    return {
      capability,
      clientVersion,
      serverVersion: serverCap.version,
      negotiatedVersion: undefined,
      result: "incompatible",
      reason: `capability "${capability}" is explicitly unsupported`,
    };
  }

  if (serverCap.status === "stale") {
    return {
      capability,
      clientVersion,
      serverVersion: serverCap.version,
      negotiatedVersion: serverCap.version,
      result: "downgraded",
      reason: `capability "${capability}" is stale; server offers ${serverCap.version}`,
    };
  }

  // Simple semver match for now: major must match, minor/patch server >= client
  const clientParts = clientVersion.split("@")[1]?.split(".").map(Number) || [];
  const serverParts = serverCap.version.split("@")[1]?.split(".").map(Number) || [];

  if (clientParts[0] !== serverParts[0]) {
    return {
      capability,
      clientVersion,
      serverVersion: serverCap.version,
      negotiatedVersion: undefined,
      result: "incompatible",
      reason: `major version mismatch: client ${clientParts[0]}, server ${serverParts[0]}`,
    };
  }

  if (
    serverParts[1] > clientParts[1] ||
    (serverParts[1] === clientParts[1] && serverParts[2] >= clientParts[2])
  ) {
    return {
      capability,
      clientVersion,
      serverVersion: serverCap.version,
      negotiatedVersion: serverCap.version,
      result: clientVersion === serverCap.version ? "matched" : "upgraded",
    };
  }

  return {
    capability,
    clientVersion,
    serverVersion: serverCap.version,
    negotiatedVersion: serverCap.version,
    result: "downgraded",
    reason: `server version ${serverCap.version} is behind client ${clientVersion}`,
  };
}
