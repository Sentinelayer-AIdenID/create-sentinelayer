/**
 * ENGRAM §EW02 — Graph contract (R02): assertions, entities, links, and
 * provenance classification.
 *
 * Every assertion in the ENGRAM graph carries an explicit provenance class:
 *   observed     — direct measurement or event capture (e.g. session event)
 *   authoritative— signed/verified by a trust anchor (e.g. AIdenID receipt)
 *   derived      — computed from other assertions (e.g. recall ranking, summary)
 *   unknown      — provenance cannot be determined; treated as non-authoritative
 *
 * This contract is the gate every graph consumer validates against before
 * executing on the graph. A graph containing plausible but fabricated fields
 * is not safe to execute (ticket 73ead329).
 */

import { z } from "zod";

/**
 * Provenance classification (R09 truth). Must be one of exactly four values.
 */
export const PROVENANCE_CLASSES = Object.freeze([
  "observed",
  "authoritative",
  "derived",
  "unknown",
]);

/** Schema validity level for an assertion. */
export const SCHEMA_VALIDITY = Object.freeze([
  "valid",
  "invalid",
  "unvalidated",
]);

/** Model confidence: probability-like range with explicit "unavailable" sentinel. */
export const MODEL_CONFIDENCE = Object.freeze([
  "high",
  "medium",
  "low",
  "unavailable",
]);

export const provenanceClassSchema = z.enum(["observed", "authoritative", "derived", "unknown"]);
export const schemaValiditySchema = z.enum(["valid", "invalid", "unvalidated"]);
export const modelConfidenceSchema = z.enum(["high", "medium", "low", "unavailable"]);

/**
 * An entity node in the ENGRAM graph.
 */
export const entitySchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  label: z.string().optional(),
  attributes: z.record(z.unknown()).optional(),
  tenantScope: z.string().optional(),
});

/**
 * A link between two graph entities.
 */
export const linkSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  predicate: z.string().min(1),
  provenance: provenanceClassSchema,
  confidence: modelConfidenceSchema.optional(),
  evidenceAddress: z.string().optional(),
});

/**
 * Freshness marker (R09 truth). Every assertion that can go stale must carry
 * an asOf watermark. Absence means "unknown freshness" — disclosed, never implied.
 */
export const freshnessSchema = z.object({
  asOf: z.string().datetime().optional(),
  staleAfterMs: z.number().int().positive().optional(),
  isStale: z.boolean().optional(),
  coverageRatio: z.number().min(0).max(1).optional(),
});

/**
 * An assertion in the ENGRAM graph.
 *
 * Every assertion must be classifiable as observed/authoritative/derived/unknown,
 * must declare its schema validity, and must carry freshness markers when
 * applicable.
 */
export const assertionSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.unknown(),
  provenance: provenanceClassSchema,
  schemaValidity: schemaValiditySchema,
  modelConfidence: modelConfidenceSchema.optional(),
  freshness: freshnessSchema.optional(),
  evidenceAddress: z.string().optional(),
  tenantScope: z.string().optional(),
  sourceVersion: z.string().optional(),
});

/**
 * A versioned ENGRAM graph.
 *
 * Every graph version carries its own schema version, a set of entities,
 * links, and assertions, plus coverage and freshness metadata.
 */
export const graphSchema = z.object({
  version: z.string().min(1),
  entities: z.array(entitySchema).optional(),
  links: z.array(linkSchema).optional(),
  assertions: z.array(assertionSchema),
  coverage: z.object({
    totalAssertions: z.number().int().nonnegative(),
    byProvenance: z.record(z.string(), z.number().int().nonnegative()).optional(),
    bySchemaValidity: z.record(z.string(), z.number().int().nonnegative()).optional(),
  }).optional(),
  freshness: freshnessSchema.optional(),
  generatedAt: z.string().datetime(),
});

/**
 * Classify an assertion's provenance from its context.
 * @param {object} assertion
 * @param {object} [ctx] — { isVerified, hasReceipt, derivedFrom }
 * @returns {string} one of PROVENANCE_CLASSES
 */
export function classifyProvenance(assertion, ctx = {}) {
  if (!assertion || !assertion.id) return "unknown";
  if (ctx.derivedFrom && Array.isArray(ctx.derivedFrom) && ctx.derivedFrom.length > 0) return "derived";
  if (ctx.isVerified === true || ctx.hasReceipt === true) return "authoritative";
  if (ctx.observedAt && typeof ctx.observedAt === "string") return "observed";
  return "unknown";
}

/**
 * Validate that a graph has no fabricated fields: every assertion must have
 * a recognized provenance class, and every monetary-like field within
 * assertions must pass the money contract (not a binary float).
 *
 * @param {object} graph — a graphSchema-shaped object
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateGraphIntegrity(graph) {
  const errors = [];
  if (!graph || typeof graph !== "object") {
    return { valid: false, errors: ["graph must be an object"] };
  }
  if (!graph.version || typeof graph.version !== "string") {
    errors.push("graph.version is required and must be a string");
  }
  const assertions = Array.isArray(graph.assertions) ? graph.assertions : [];
  if (assertions.length === 0) {
    errors.push("graph.assertions must be a non-empty array");
  }
  for (let i = 0; i < assertions.length; i++) {
    const a = assertions[i];
    if (!a || typeof a !== "object") {
      errors.push(`assertion[${i}] must be an object`);
      continue;
    }
    if (!PROVENANCE_CLASSES.includes(a.provenance)) {
      errors.push(`assertion[${i}].provenance "${a.provenance}" is not a recognized class`);
    }
    if (!SCHEMA_VALIDITY.includes(a.schemaValidity)) {
      errors.push(`assertion[${i}].schemaValidity "${a.schemaValidity}" is not recognized`);
    }
    // Reject binary floats anywhere in the object sub-tree
    _rejectFloats(a.object, `assertion[${i}].object`, errors);
  }
  return { valid: errors.length === 0, errors };
}

const MAX_FLOAT_CHECK_DEPTH = 100;

function _rejectFloats(value, path, errors, depth = 0) {
  if (depth > MAX_FLOAT_CHECK_DEPTH) {
    errors.push(`${path}: exceeded max depth ${MAX_FLOAT_CHECK_DEPTH}; possible circular or deeply nested structure`);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      errors.push(`${path}: non-finite number not allowed`);
    } else if (!Number.isInteger(value)) {
      errors.push(`${path}: binary float ${value} not allowed; use integer minor units or decimal string`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      _rejectFloats(value[i], `${path}[${i}]`, errors, depth + 1);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      _rejectFloats(value[key], `${path}.${key}`, errors, depth + 1);
    }
  }
}
