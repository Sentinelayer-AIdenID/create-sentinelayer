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
 *
 * All schemas are strict: extra fields are rejected (luna-judge P2 finding).
 * Negotiation validates inputs on every path and returns validated results.
 */

import { z } from "zod";

/**
 * A capability version identifier.
 * Format: <name>@<semver> (e.g. "engram-graph@1.0.0")
 */
const CAPABILITY_NAME_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const CAPABILITY_VERSION_RE = /^([a-z][a-z0-9_-]{0,47})@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

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
}).strict();

/**
 * A source descriptor: identifies where an assertion or capability originated.
 */
export const sourceDescriptorSchema = z.object({
  sourceId: z.string().min(1),
  sourceType: z.enum(["adapter", "ingest", "derived", "external", "manual"]),
  version: capabilityVersionSchema,
  tenantScope: z.string().min(1),
  endpoint: z.string().url().optional(),
}).strict();

/**
 * Valid capability status values for server entries.
 */
const CAPABILITY_STATUS = z.enum(["supported", "deprecated", "experimental", "unknown", "unsupported", "stale"]);

/**
 * A single capability entry: what a source can do, at what version.
 */
export const capabilityEntrySchema = z.object({
  capability: z.string().regex(CAPABILITY_NAME_RE),
  version: capabilityVersionSchema,
  source: sourceDescriptorSchema,
  status: CAPABILITY_STATUS,
  evidenceAddress: z.string().optional(),
  deprecatesAt: z.string().datetime().optional(),
  migratesTo: capabilityVersionSchema.optional(),
}).strict().superRefine((entry, ctx) => {
  for (const field of ["version", "migratesTo"]) {
    if (entry[field] && !versionNameMatches(entry.capability, entry[field])) {
      ctx.addIssue({ code: "custom", path: [field], message: `${field} name must match capability` });
    }
  }
});

/**
 * Protocol capability negotiation result.
 */
export const negotiationResultSchema = z.object({
  capability: z.string().regex(CAPABILITY_NAME_RE),
  clientVersion: capabilityVersionSchema,
  serverVersion: capabilityVersionSchema.optional(),
  negotiatedVersion: capabilityVersionSchema.optional(),
  tenantScope: z.string().min(1).optional(),
  result: z.enum(["matched", "upgraded", "downgraded", "incompatible", "unknown"]),
  reason: z.string().optional(),
  evidenceAddress: z.string().optional(),
}).strict().superRefine((result, ctx) => {
  for (const field of ["clientVersion", "serverVersion", "negotiatedVersion"]) {
    if (result[field] && !versionNameMatches(result.capability, result[field])) {
      ctx.addIssue({ code: "custom", path: [field], message: `${field} name must match capability` });
    }
  }
  const usable = ["matched", "upgraded", "downgraded"].includes(result.result);
  if (usable) {
    if (!result.tenantScope) {
      ctx.addIssue({ code: "custom", path: ["tenantScope"], message: "usable negotiation requires requesting tenant scope" });
    }
    if (!result.serverVersion || !result.negotiatedVersion || result.negotiatedVersion !== result.serverVersion) {
      ctx.addIssue({ code: "custom", path: ["negotiatedVersion"], message: "usable negotiation must identify the server version" });
    }
    if (result.serverVersion) {
      const client = parseCapVersion(result.clientVersion);
      const server = parseCapVersion(result.serverVersion);
      if (client && server) {
        if (client[1] !== server[1]) {
          ctx.addIssue({ code: "custom", path: ["result"], message: "usable negotiation requires a matching major version" });
        }
        const order = server[2] === client[2]
          ? (server[3] > client[3] ? 1 : server[3] < client[3] ? -1 : 0)
          : (server[2] > client[2] ? 1 : -1);
        if ((result.result === "matched" && order !== 0) ||
            (result.result === "upgraded" && order <= 0) ||
            (result.result === "downgraded" && order >= 0)) {
          ctx.addIssue({ code: "custom", path: ["result"], message: "negotiation result must match version order" });
        }
      }
    }
  } else if (result.negotiatedVersion) {
    ctx.addIssue({ code: "custom", path: ["negotiatedVersion"], message: "unusable negotiation cannot grant a version" });
  }
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
}).strict().refine(
  (page) => !page.hasMore || !!page.nextCursor,
  { message: "hasMore requires nextCursor", path: ["nextCursor"] },
);

/**
 * Migration policy: declares compatibility between capability versions.
 */
export const migrationPolicySchema = z.object({
  capability: z.string().regex(CAPABILITY_NAME_RE),
  fromVersion: capabilityVersionSchema,
  toVersion: capabilityVersionSchema,
  compatibility: z.enum(["compatible", "breaking", "additive"]),
  migrationNotes: z.string().optional(),
  createdAt: z.string().datetime(),
}).strict().superRefine((policy, ctx) => {
  for (const field of ["fromVersion", "toVersion"]) {
    if (!versionNameMatches(policy.capability, policy[field])) {
      ctx.addIssue({ code: "custom", path: [field], message: `${field} name must match capability` });
    }
  }
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
 * Parse a semver tuple from a capability version string.
 * @param {string} capVersion — e.g. "engram-graph@1.2.3"
 * @returns {[string, bigint, bigint, bigint]|null} — [name, major, minor, patch]
 */
function parseCapVersion(capVersion) {
  const match = typeof capVersion === "string" && CAPABILITY_VERSION_RE.exec(capVersion);
  if (!match) return null;
  return [match[1], BigInt(match[2]), BigInt(match[3]), BigInt(match[4])];
}

/**
 * Validate that a server entry's version name binds to the stated capability.
 */
function versionNameMatches(capabilityName, versionString) {
  const parts = parseCapVersion(versionString);
  if (!parts) return false;
  return parts[0] === capabilityName;
}

/**
 * Negotiate a protocol capability between client and server.
 *
 * F7/F8 fixes:
 * - Stale capabilities return "incompatible" with NO negotiatedVersion
 * - Unknown capabilities return "unknown" immediately, no version comparison
 * - Validates server entries and binds version names to the capability
 * - Misspelled statuses are rejected (invalid status → incompatible)
 * - Every path returns a negotiationResultSchema-valid result or a typed error
 *
 * @param {object} params
 * @param {string} params.capability
 * @param {string} params.clientVersion
 * @param {string} params.tenantScope — requesting tenant; caller must authenticate it
 * @param {Array<{capability: string, version: string, status: string}>} params.serverCapabilities
 * @returns {object} negotiationResultSchema-shaped result
 */
export function negotiateCapability({ capability, clientVersion, tenantScope, serverCapabilities = [] } = {}) {
  // All failure paths retain a schema-valid result; malformed caller values
  // cannot leak into the output or grant a usable negotiated version.
  const safeCapability = typeof capability === "string" && CAPABILITY_NAME_RE.test(capability)
    ? capability : "unknown-cap";
  const clientParts = parseCapVersion(clientVersion);
  const safeClientVersion = clientParts?.[0] === safeCapability
    ? clientVersion : `${safeCapability}@0.0.0`;
  const requestedTenant = typeof tenantScope === "string" && tenantScope.length > 0
    ? tenantScope : undefined;
  const makeResult = (overrides) => negotiationResultSchema.parse({
    capability: safeCapability,
    clientVersion: safeClientVersion,
    ...(requestedTenant ? { tenantScope: requestedTenant } : {}),
    result: "incompatible",
    ...overrides,
  });

  if (safeCapability !== capability) {
    return makeResult({ reason: "capability is required and must be a valid name" });
  }
  if (!clientParts) {
    return makeResult({ reason: "clientVersion is not a valid capability version" });
  }
  if (clientParts[0] !== capability) {
    return makeResult({
      reason: `clientVersion name "${clientParts[0]}" does not match capability "${capability}"`,
    });
  }
  if (!requestedTenant) {
    return makeResult({ reason: "requesting tenantScope is required for capability negotiation" });
  }
  if (!Array.isArray(serverCapabilities)) {
    return makeResult({ result: "unknown", reason: "serverCapabilities must be an array" });
  }

  const serverCap = serverCapabilities.find((entry) =>
    entry && typeof entry === "object" && entry.capability === capability &&
    entry.source?.tenantScope === requestedTenant);

  if (!serverCap) {
    return makeResult({ result: "unknown", reason: `capability "${capability}" is not registered for this tenant` });
  }

  // Validate the server entry against the full capabilityEntrySchema.
  // This ensures source, tenantScope, and all required fields are present
  // before negotiating. An entry missing source/tenant is not a valid capability.
  const entryResult = capabilityEntrySchema.safeParse(serverCap);
  if (!entryResult.success) {
    return makeResult({
      result: "unknown",
      reason: `capability "${capability}" server entry is invalid: ${entryResult.error.issues.map((i) => i.message).join("; ")}`,
    });
  }

  const status = entryResult.data.status;

  // stale → incompatible, no negotiated version
  if (status === "stale") {
    return makeResult({
      serverVersion: serverCap.version,
      result: "incompatible",
      reason: `capability "${capability}" is stale; cannot negotiate a usable version`,
    });
  }

  // unknown → unknown immediately, no version comparison
  if (status === "unknown") {
    return makeResult({
      serverVersion: serverCap.version,
      result: "unknown",
      reason: `capability "${capability}" status is unknown; cannot determine compatibility`,
    });
  }

  if (status === "unsupported") {
    return makeResult({
      serverVersion: serverCap.version,
      reason: `capability "${capability}" is explicitly unsupported`,
    });
  }

  // Version comparison for supported/deprecated/experimental
  const serverParts = parseCapVersion(serverCap.version);
  if (!serverParts) {
    return makeResult({
      serverVersion: serverCap.version,
      reason: "cannot parse server version numbers",
    });
  }

  if (clientParts[1] !== serverParts[1]) {
    return makeResult({
      serverVersion: serverCap.version,
      result: "incompatible",
      reason: `major version mismatch: client ${clientParts[1]}, server ${serverParts[1]}`,
    });
  }

  if (
    serverParts[2] > clientParts[2] ||
    (serverParts[2] === clientParts[2] && serverParts[3] >= clientParts[3])
  ) {
    const rawResult = {
      capability,
      clientVersion,
      serverVersion: serverCap.version,
      negotiatedVersion: serverCap.version,
      tenantScope: requestedTenant,
      result: clientVersion === serverCap.version ? "matched" : "upgraded",
    };
    const parsed = negotiationResultSchema.safeParse(rawResult);
    if (!parsed.success) {
      return makeResult({
        serverVersion: serverCap.version,
        reason: `output validation failed: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      });
    }
    return parsed.data;
  }

  const rawResult = {
    capability,
    clientVersion,
    serverVersion: serverCap.version,
    negotiatedVersion: serverCap.version,
    tenantScope: requestedTenant,
    result: "downgraded",
    reason: `server version ${serverCap.version} is behind client ${clientVersion}`,
  };
  const parsed = negotiationResultSchema.safeParse(rawResult);
  if (!parsed.success) {
    return makeResult({
      serverVersion: serverCap.version,
      reason: `output validation failed: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    });
  }
  return parsed.data;
}
