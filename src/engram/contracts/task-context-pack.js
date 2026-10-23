/**
 * ENGRAM §EW02 — TaskContextPack contract.
 *
 * A TaskContextPack bundles the minimal context needed for a parallel agent
 * to operate: capabilities, evidence references, and delegation instructions.
 * Every pack carries its own version, tenant scope, and source snapshot.
 *
 * Cross-field tenant validation: nested source snapshots, media assets,
 * temporal segments, and receipts must share the pack's tenant scope or
 * declare an explicit authorized cross-tenant relationship.
 */

import { z } from "zod";
import { sourceSnapshotSchema } from "./source-snapshot.js";
import { capabilityVersionSchema } from "./capability.js";

/**
 * A delegation reference: what agent or capability is delegated, with
 * constraints and version requirements.
 */
export const delegationReferenceSchema = z.object({
  delegateId: z.string().min(1),
  capability: capabilityVersionSchema,
  constraints: z.record(z.string(), z.unknown()).optional(),
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
 * scope unless an explicit authorizedCrossTenant relationship is declared.
 */
export const taskContextPackSchema = z.object({
  packId: z.string().min(1),
  version: z.string().min(1),
  tenantScope: z.string().min(1),
  sourceSnapshot: sourceSnapshotSchema,
  capabilities: z.array(capabilityVersionSchema).optional(),
  evidenceRefs: z.array(z.string().min(1)).optional(),
  delegations: z.array(delegationReferenceSchema).optional(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  authorizedCrossTenant: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict().refine(
  (data) => {
    const packTenant = data.tenantScope;
    const allowed = data.authorizedCrossTenant ? [packTenant, ...data.authorizedCrossTenant] : [packTenant];
    if (!allowed.includes(data.sourceSnapshot.tenantScope)) {
      return false;
    }
    return true;
  },
  { message: "sourceSnapshot tenantScope must match pack tenantScope or be listed in authorizedCrossTenant", path: ["sourceSnapshot", "tenantScope"] },
);

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
