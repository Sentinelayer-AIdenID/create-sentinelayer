/**
 * ENGRAM §EW02 — Versioned contracts barrel.
 *
 * This is the single validated contract set for all parallel agents (ticket
 * 73ead329). It freezes the graph, capability, evidence, and money contracts
 * so every consumer validates against the same schemas.
 *
 * Module name: agent-web-contracts (per ticket proposal).
 * Actual location: src/engram/contracts/ (within the detachable ENGRAM tree).
 */

// Money contract (§ step-9, step-10)
export {
  moneySchema,
  minorUnitsSchema,
  decimalStringSchema,
  toMinorUnits,
  formatFromMinorUnits,
  currencyExponent,
} from "./money.js";

// Graph contract (R02 graph, R09 truth)
export {
  PROVENANCE_CLASSES,
  SCHEMA_VALIDITY,
  MODEL_CONFIDENCE,
  provenanceClassSchema,
  schemaValiditySchema,
  modelConfidenceSchema,
  entitySchema,
  linkSchema,
  freshnessSchema,
  assertionSchema,
  graphSchema,
  classifyProvenance,
  validateGraphIntegrity,
} from "./graph.js";

// Capability contract (R04 skills, R14 parallelism)
export {
  capabilityVersionSchema,
  tenantScopeSchema,
  sourceDescriptorSchema,
  capabilityEntrySchema,
  negotiationResultSchema,
  paginationSchema,
  migrationPolicySchema,
  CapabilityError,
  unknownCapability,
  unsupportedCapability,
  staleCapability,
  negotiateCapability,
} from "./capability.js";

// Evidence contract (R09 truth)
export {
  evidenceAddressSchema,
  evidenceRecordSchema,
  evidencePageSchema,
  evidenceMigrationPolicySchema,
  evidenceFreshnessSchema,
  EvidenceError,
  evidenceNotFound,
  evidenceStale,
  evidenceUnsupportedScheme,
  validateNotScreenshotInferred,
} from "./evidence.js";
