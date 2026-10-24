/**
 * ENGRAM §EW02 — TaskContextPack contract.
 *
 * A TaskContextPack bundles the minimal context needed for a parallel agent
 * to operate: capabilities, evidence references, and delegation instructions.
 * Every pack carries its own version, tenant scope, and source snapshot.
 *
 * Cross-field tenant validation: source snapshots must share the pack's
 * tenant scope. A pack cannot grant itself a cross-tenant exception.
 */

import { z } from "zod";
import { sourceSnapshotSchema } from "./source-snapshot.js";
import { capabilityVersionSchema } from "./capability.js";
import { CONTRACT_VERSIONS } from "./versions.js";

/**
 * A delegation reference: what agent or capability is delegated, with
 * constraints and version requirements.
 */
export const delegationReferenceSchema = z.object({
  delegateId: z.string().min(1),
  capability: capabilityVersionSchema,
  constraints: z.record(z.string(), z.json()).optional(),
  minVersion: z.string().optional(),
  maxVersion: z.string().optional(),
}).strict();

/**
 * A task context pack: the minimal validated context for a parallel agent.
 *
 * Packs carry capabilities, evidence references, and delegation instructions
 * so every agent gets a consistent, validated starting context.
 *
 * Tenant scope reconciliation: nested objects must share the pack's tenant
 * scope. Cross-tenant delegation needs a separate, trusted authorization
 * boundary rather than a self-declared field in an incoming pack.
 */
export const taskContextPackSchema = z.object({
  packId: z.string().min(1),
  version: z.literal(CONTRACT_VERSIONS.taskContextPack),
  tenantScope: z.string().min(1),
  sourceSnapshot: sourceSnapshotSchema,
  capabilities: z.array(capabilityVersionSchema).optional(),
  evidenceRefs: z.array(z.string().min(1)).optional(),
  delegations: z.array(delegationReferenceSchema).optional(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.json()).optional(),
}).strict().superRefine((data, ctx) => {
  if (data.sourceSnapshot.tenantScope !== data.tenantScope) {
    ctx.addIssue({ code: "custom", message: "sourceSnapshot tenantScope must match pack tenantScope", path: ["sourceSnapshot", "tenantScope"] });
  }
  if (Date.parse(data.sourceSnapshot.capturedAt) > Date.parse(data.createdAt)) {
    ctx.addIssue({ code: "custom", message: "sourceSnapshot cannot be captured after pack creation", path: ["sourceSnapshot", "capturedAt"] });
  }
  if (data.expiresAt && Date.parse(data.expiresAt) <= Date.parse(data.createdAt)) {
    ctx.addIssue({ code: "custom", message: "expiresAt must be after createdAt", path: ["expiresAt"] });
  }
  const declared = new Set(data.capabilities ?? []);
  for (const [index, delegation] of (data.delegations ?? []).entries()) {
    if (!declared.has(delegation.capability)) {
      ctx.addIssue({ code: "custom", message: "delegation capability must be declared by this pack", path: ["delegations", index, "capability"] });
    }
  }
});

/**
 * Valid fixture: a complete task context pack.
 */
export const VALID_TASK_CONTEXT_PACK = Object.freeze({
  packId: "tcp-ew02-001",
  version: "1.0.0",
  tenantScope: "tenant/acme",
  sourceSnapshot: {
    sourceId: "src-session-abc123",
    sourceType: "session",
    version: "1.2.0",
    capturedAt: "2026-10-23T12:00:00Z",
    tenantScope: "tenant/acme",
  },
  capabilities: ["graph-read@1.0.0"],
  evidenceRefs: ["evi-abc123"],
  createdAt: "2026-10-23T12:00:00Z",
});
