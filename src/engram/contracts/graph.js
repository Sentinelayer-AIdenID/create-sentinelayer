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
 *
 * All schemas are strict: unknown/unsupported fields produce validation errors
 * rather than being silently dropped (luna-judge finding F3).
 */

import { z } from "zod";
import { moneySchema } from "./money.js";
import { GRAPH_SCHEMA_VERSION } from "./versions.js";

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
 * An evidence reference: ties an assertion to a verifiable evidence record.
 * Required for authoritative classification (luna-judge finding F2).
 */
export const evidenceRefSchema = z.object({
  address: z.string().min(1),
  verifiedAt: z.string().datetime(),
  verifier: z.string().min(1),
}).strict();

/**
 * An entity node in the ENGRAM graph.
 *
 * Entities carrying factual content (label, attributes) require sourceVersion
 * and capturedAt to establish provenance. Source-less facts are fabricable.
 */
export const entitySchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  label: z.string().optional(),
  attributes: z.record(z.string(), z.json()).optional(),
  tenantScope: z.string().min(1),
  sourceId: z.string().min(1),
  sourceVersion: z.string().min(1),
  capturedAt: z.string().datetime().optional(),
}).strict().refine(
  (data) => {
    const hasFacts = !!(data.label || (data.attributes && Object.keys(data.attributes).length > 0));
    if (hasFacts && !data.capturedAt) {
      return false;
    }
    return true;
  },
  { message: "entity with factual content (label or attributes) requires capturedAt", path: ["capturedAt"] },
);

/**
 * A link between two graph entities.
 *
 * Links with non-unknown provenance require tenantScope and capturedAt.
 * Authoritative links require an evidenceAddress.
 */
export const linkSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  predicate: z.string().min(1),
  provenance: provenanceClassSchema,
  confidence: modelConfidenceSchema.optional(),
  evidenceAddress: z.string().min(1).optional(),
  tenantScope: z.string().min(1),
  capturedAt: z.string().datetime().optional(),
}).strict().refine(
  (data) => {
    if (data.provenance === "authoritative" && !data.evidenceAddress) {
      return false;
    }
    if (data.provenance !== "unknown" && !data.capturedAt) {
      return false;
    }
    return true;
  },
  { message: "all links require tenantScope; non-unknown provenance links require capturedAt; authoritative links require evidenceAddress", path: ["capturedAt"] },
);

/**
 * Freshness marker (R09 truth). Every assertion that can go stale must carry
 * an asOf watermark. Absence means "unknown freshness" — disclosed, never implied.
 */
export const freshnessSchema = z.object({
  asOf: z.string().datetime().optional(),
  staleAfterMs: z.number().int().positive().optional(),
  isStale: z.boolean().optional(),
  coverageRatio: z.number().min(0).max(1).optional(),
}).strict();

/**
 * A versioned source descriptor. Every assertion must carry a source version
 * and tenant scope (luna-judge finding F2).
 */
export const sourceDescriptorSchema = z.object({
  sourceId: z.string().min(1),
  version: z.string().min(1),
  capturedAt: z.string().datetime(),
  tenantScope: z.string().min(1),
}).strict();

/**
 * An assertion in the ENGRAM graph.
 *
 * Every assertion must be classifiable as observed/authoritative/derived/unknown,
 * must declare its schema validity, and must carry freshness markers when
 * applicable. Tenant scope and source version are required (F2).
 * Authoritative assertions MUST carry an evidenceRef (luna-judge P1 finding).
 */
export const assertionSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.json(),
  provenance: provenanceClassSchema,
  schemaValidity: schemaValiditySchema,
  modelConfidence: modelConfidenceSchema.optional(),
  freshness: freshnessSchema.optional(),
  evidenceRef: evidenceRefSchema.optional(),
  source: sourceDescriptorSchema,
}).strict().refine(
  (data) => {
    if (data.provenance === "authoritative" && !data.evidenceRef) {
      return false;
    }
    return true;
  },
  { message: "authoritative provenance requires an evidenceRef with a verified address", path: ["evidenceRef"] },
);

/**
 * A versioned ENGRAM graph.
 *
 * Every graph version carries its own schema version, a set of entities,
 * links, and assertions, plus coverage and freshness metadata.
 */
export const graphSchema = z.object({
  version: z.literal(GRAPH_SCHEMA_VERSION),
  entities: z.array(entitySchema).optional(),
  links: z.array(linkSchema).optional(),
  assertions: z.array(assertionSchema),
  coverage: z.object({
    totalAssertions: z.number().int().nonnegative(),
    byProvenance: z.record(z.string(), z.number().int().nonnegative()).optional(),
    bySchemaValidity: z.record(z.string(), z.number().int().nonnegative()).optional(),
  }).strict().optional(),
  freshness: freshnessSchema.optional(),
  generatedAt: z.string().datetime(),
}).strict();

/**
 * Classify an assertion's provenance from its context.
 *
 * Only returns "authoritative" when BOTH isVerified is true AND a valid
 * evidenceRef with a receipt reference including verifiedAt is present.
 * A bare hasReceipt or isVerified flag is not sufficient (luna-judge finding F2).
 *
 * @param {object} assertion
 * @param {object} [ctx] — { isVerified, evidenceRef, derivedFrom, observedAt }
 * @returns {string} one of PROVENANCE_CLASSES
 */
export function classifyProvenance(assertion, ctx = {}) {
  if (!assertion || !assertion.id) return "unknown";
  if (ctx.derivedFrom && Array.isArray(ctx.derivedFrom) && ctx.derivedFrom.length > 0) return "derived";
  if (
    ctx.isVerified === true &&
    ctx.evidenceRef &&
    typeof ctx.evidenceRef === "object" &&
    typeof ctx.evidenceRef.address === "string" && ctx.evidenceRef.address.trim().length > 0 &&
    typeof ctx.evidenceRef.verifier === "string" && ctx.evidenceRef.verifier.trim().length > 0 &&
    typeof ctx.evidenceRef.verifiedAt === "string" && ctx.evidenceRef.verifiedAt.trim().length > 0
  ) {
    // Validate that verifiedAt is a real ISO datetime, not an arbitrary string.
    // evidenceRefSchema enforces z.string().datetime(); replicate that check here.
    const _isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
    if (_isoRe.test(ctx.evidenceRef.verifiedAt.trim())) {
      return "authoritative";
    }
    return "unknown";
  }
  const _observedAtRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  if (ctx.observedAt && typeof ctx.observedAt === "string" && _observedAtRe.test(ctx.observedAt)) return "observed";
  return "unknown";
}

/**
 * Money field names that must be validated with moneySchema.
 * Covers common monetary field naming patterns.
 */
// Money field name set: covers common monetary field naming patterns.
// Fields whose name exactly matches one of these are expected to carry
// a canonical money object { amount, currency, exponent }, never a bare float.
// Non-monetary numeric fields like ratio, temperature, count are not in this set.
const MONEY_FIELD_NAMES = new Set([
  "amount", "Amount",
  "price", "Price",
  "cost", "Cost",
  "fee", "Fee",
  "total", "Total",
  "balance", "Balance",
  "payment", "Payment",
  "subtotal", "Subtotal",
  "total_amount", "totalAmount", "TotalAmount",
  "unit_price", "unitPrice", "UnitPrice",
  "tax_amount", "taxAmount", "TaxAmount",
  "discount_amount", "discountAmount", "DiscountAmount",
  "shipping_cost", "shippingCost", "ShippingCost",
]);

function isMoneyFieldName(key) {
  return MONEY_FIELD_NAMES.has(key);
}

/**
 * Validate that all money fields across the graph use the money contract.
 * Walks entities, links, and assertions looking for monetary fields and
 * validates them with moneySchema regardless of value type (luna-judge P1 finding).
 * Does NOT reject non-monetary numbers like ratios or temperatures.
 *
 * Also checks that authoritative assertions have evidenceRef and that
 * fact-bearing entities/links have required provenance fields.
 *
 * @param {object} graph — a graphSchema-shaped object
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateGraphIntegrity(graph) {
  const errors = [];

  // First, validate the full graph against the schema (F4)
  const schemaResult = graphSchema.safeParse(graph);
  if (!schemaResult.success) {
    for (const issue of schemaResult.error.issues) {
      errors.push(`schema: ${issue.path.join(".")}: ${issue.message}`);
    }
    return { valid: false, errors };
  }

  const data = schemaResult.data;

  // Check: coverage.totalAssertions must match actual assertion count
  if (data.coverage && data.coverage.totalAssertions !== data.assertions.length) {
    errors.push(
      `coverage.totalAssertions (${data.coverage.totalAssertions}) does not match actual assertion count (${data.assertions.length})`,
    );
  }

  // Check: authoritative assertions must have evidenceRef
  for (let i = 0; i < data.assertions.length; i++) {
    const a = data.assertions[i];
    if (a.provenance === "authoritative" && !a.evidenceRef) {
      errors.push(`assertions[${i}]: authoritative provenance requires evidenceRef`);
    }
  }

  // Check: fact-bearing entities need sourceVersion and capturedAt
  if (data.entities) {
    for (let i = 0; i < data.entities.length; i++) {
      const e = data.entities[i];
      const hasFacts = !!(e.label || (e.attributes && Object.keys(e.attributes).length > 0));
      if (hasFacts && (!e.sourceVersion || !e.capturedAt)) {
        errors.push(`entities[${i}]: entity with factual content requires sourceVersion and capturedAt`);
      }
    }
  }

  // Check: links need tenantScope (all) and capturedAt (non-unknown)
  if (data.links) {
    for (let i = 0; i < data.links.length; i++) {
      const l = data.links[i];
      if (!l.tenantScope) {
        errors.push(`links[${i}]: all links require tenantScope`);
      }
      if (l.provenance !== "unknown" && !l.capturedAt) {
        errors.push(`links[${i}]: non-unknown provenance link requires capturedAt`);
      }
      if (l.provenance === "authoritative" && !l.evidenceAddress) {
        errors.push(`links[${i}]: authoritative provenance link requires evidenceAddress`);
      }
    }
  }

  // Walk ALL graph elements for money field validation (F6, P1 update: check regardless of value type)
  // skipObjects: set of objects to NOT recurse into (already validated as money objects)
  function walkForMoney(obj, path, skipObjects = new Set()) {
    if (!obj || typeof obj !== "object") return;
    if (skipObjects.has(obj)) return;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        walkForMoney(obj[i], `${path}[${i}]`, skipObjects);
      }
      return;
    }
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      const fullPath = `${path}.${key}`;
      if (isMoneyFieldName(key)) {
        if (typeof val === "object" && val !== null) {
          const moneyResult = moneySchema.safeParse(val);
          if (!moneyResult.success) {
            for (const issue of moneyResult.error.issues) {
              errors.push(`${fullPath}: money field invalid — ${issue.message}`);
            }
          } else {
            // Valid money object — don't recurse into its internals
            // (amount, currency, exponent are structural, not standalone money fields)
            skipObjects.add(val);
          }
        } else {
          errors.push(`${fullPath}: money field must be a canonical money object { amount, currency, exponent }, got ${typeof val}`);
        }
      }
      if (typeof val === "object" && val !== null && !skipObjects.has(val)) {
        walkForMoney(val, fullPath, skipObjects);
      }
    }
  }

  // Check: assertions with monetary predicates must have moneySchema-valid objects
  for (let i = 0; i < data.assertions.length; i++) {
    const a = data.assertions[i];
    if (isMoneyFieldName(a.predicate)) {
      const objResult = moneySchema.safeParse(a.object);
      if (!objResult.success) {
        errors.push(`assertions[${i}].object: assertion with monetary predicate "${a.predicate}" must have a canonical money object, got ${typeof a.object === "object" ? JSON.stringify(a.object) : String(a.object)}`);
      }
    }
  }

  // Walk entities, links, and assertions
  // Collect already-validated money objects (from assertion predicate checks above)
  // so walkForMoney doesn't recurse into their internal keys
  const moneySkip = new Set();
  for (const a of data.assertions) {
    if (isMoneyFieldName(a.predicate) && typeof a.object === "object" && a.object !== null) {
      const r = moneySchema.safeParse(a.object);
      if (r.success) moneySkip.add(a.object);
    }
  }
  if (data.entities) walkForMoney(data.entities, "entities", moneySkip);
  if (data.links) walkForMoney(data.links, "links", moneySkip);
  walkForMoney(data.assertions, "assertions", moneySkip);

  return { valid: errors.length === 0, errors };
}
