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
 * graphSchema checks serializable shape and deterministic graph consistency.
 * validateGraphIntegrity additionally requires an out-of-band verifier before
 * accepting any authoritative provenance. Neither check grants permission to
 * execute an action (ticket 73ead329).
 *
 * All schemas are strict: unknown/unsupported fields produce validation errors
 * rather than being silently dropped (luna-judge finding F3).
 */

import { z } from "zod";
import { moneySchema, currencyExponent } from "./money.js";
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
 * Links with non-unknown provenance require a versioned data source and time.
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
  sourceId: z.string().min(1).optional(),
  sourceVersion: z.string().min(1).optional(),
  capturedAt: z.string().datetime().optional(),
}).strict().superRefine((link, ctx) => {
  if (link.provenance !== "unknown") {
    for (const field of ["sourceId", "sourceVersion", "capturedAt"]) {
      if (!link[field]) {
        ctx.addIssue({ code: "custom", path: [field], message: `non-unknown link requires ${field}` });
      }
    }
  }
  if (link.provenance === "authoritative" && !link.evidenceAddress) {
    ctx.addIssue({ code: "custom", path: ["evidenceAddress"], message: "authoritative link requires evidenceAddress" });
  }
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
    byProvenance: z.partialRecord(provenanceClassSchema, z.number().int().nonnegative()).optional(),
    bySchemaValidity: z.partialRecord(schemaValiditySchema, z.number().int().nonnegative()).optional(),
  }).strict().optional(),
  freshness: freshnessSchema.optional(),
  generatedAt: z.string().datetime(),
}).strict().superRefine((data, ctx) => {
  const generatedAtMs = Date.parse(data.generatedAt);
  const capturedByGeneration = (timestamp, path) => {
    if (timestamp && Date.parse(timestamp) > generatedAtMs) {
      ctx.addIssue({ code: "custom", path, message: "fact time cannot be after graph generatedAt" });
    }
  };
  capturedByGeneration(data.freshness?.asOf, ["freshness", "asOf"]);
  (data.entities ?? []).forEach((entity, i) => capturedByGeneration(entity.capturedAt, ["entities", i, "capturedAt"]));
  data.assertions.forEach((assertion, i) => {
    capturedByGeneration(assertion.source.capturedAt, ["assertions", i, "source", "capturedAt"]);
    capturedByGeneration(assertion.evidenceRef?.verifiedAt, ["assertions", i, "evidenceRef", "verifiedAt"]);
    capturedByGeneration(assertion.freshness?.asOf, ["assertions", i, "freshness", "asOf"]);
  });
  (data.links ?? []).forEach((link, i) => capturedByGeneration(link.capturedAt, ["links", i, "capturedAt"]));

  const nodeScopes = new Map();
  for (const [kind, nodes] of [["entities", data.entities ?? []], ["assertions", data.assertions]]) {
    nodes.forEach((node, i) => {
      if (nodeScopes.has(node.id)) {
        ctx.addIssue({ code: "custom", path: [kind, i, "id"], message: `duplicate graph id ${node.id}` });
      } else {
        nodeScopes.set(node.id, kind === "entities" ? node.tenantScope : node.source.tenantScope);
      }
    });
  }
  if (new Set(nodeScopes.values()).size > 1) {
    ctx.addIssue({ code: "custom", path: ["assertions"], message: "graph facts must share one tenant scope" });
  }
  (data.links ?? []).forEach((link, i) => {
    for (const endpoint of ["source", "target"]) {
      if (!nodeScopes.has(link[endpoint])) {
        ctx.addIssue({ code: "custom", path: ["links", i, endpoint], message: `dangling link ${endpoint}` });
      } else if (nodeScopes.get(link[endpoint]) !== link.tenantScope) {
        ctx.addIssue({ code: "custom", path: ["links", i, "tenantScope"], message: "link tenant scope must match both endpoints" });
      }
    }
  });
  if (!data.coverage) return;
  if (data.coverage.totalAssertions !== data.assertions.length) {
    ctx.addIssue({ code: "custom", path: ["coverage", "totalAssertions"], message: "coverage totalAssertions must match assertions" });
  }
  for (const [field, key] of [["byProvenance", "provenance"], ["bySchemaValidity", "schemaValidity"]]) {
    const claimed = data.coverage[field];
    if (!claimed) continue;
    for (const className of field === "byProvenance" ? PROVENANCE_CLASSES : SCHEMA_VALIDITY) {
      const actual = data.assertions.filter((item) => item[key] === className).length;
      if ((claimed[className] ?? 0) !== actual) {
        ctx.addIssue({ code: "custom", path: ["coverage", field, className], message: `${className} count must match assertions` });
      }
    }
  }
});

/**
 * Classify an assertion's provenance from its context.
 *
 * Only returns "authoritative" when a caller-supplied trusted verifier checks
 * the fact and reference. Serializable isVerified/verifiedBy fields are claims.
 *
 * @param {object} assertion
 * @param {object} [ctx] — { evidenceRef, derivedFrom, observedAt }
 * @param {{verifyEvidence?: (fact: object, reference: object) => boolean}} options
 * @returns {string} one of PROVENANCE_CLASSES
 */
export function classifyProvenance(assertion, ctx = {}, { verifyEvidence } = {}) {
  if (!assertion || !assertion.id) return "unknown";
  if (ctx.derivedFrom && Array.isArray(ctx.derivedFrom) && ctx.derivedFrom.length > 0) return "derived";
  // Serializable flags and verifier names are claims. Only a trusted caller's
  // out-of-band verifier can bind this fact to an independently checked record.
  if (typeof verifyEvidence === "function" && evidenceRefSchema.safeParse(ctx.evidenceRef).success) {
    try {
      if (verifyEvidence(assertion, ctx.evidenceRef) === true) return "authoritative";
    } catch { /* unverifiable is not authoritative */ }
  }
  if (z.string().datetime({ offset: true }).safeParse(ctx.observedAt).success && Number.isFinite(Date.parse(ctx.observedAt))) return "observed";
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

// Other predicates may name the same monetary fact in camel/snake case.
// Match the monetary noun at the end so totalCount and totalWeight remain
// ordinary quantities rather than being misclassified as prices.
const MONEY_FIELD_SUFFIXES = new Set([
  "amount", "price", "cost", "fee", "total", "subtotal", "balance",
  "payment", "revenue", "expense", "charge", "refund", "budget", "profit",
]);

// A quantity is explicitly non-monetary. Currency codes and unambiguous
// currency words cannot turn a binary float into a monetary total.
const MONEY_UNIT_WORDS = new Set([
  "money", "currency", "dollar", "dollars", "cent", "cents", "euro",
  "euros", "yen", "yuan", "won", "rupee", "rupees", "peso", "pesos",
  "franc", "francs", "dinar", "dinars", "dirham", "dirhams",
]);

/** Explicit non-money numeric fact. Bare JSON numbers are ambiguous. */
export const quantitySchema = z.object({
  kind: z.literal("quantity"),
  value: z.number().finite(),
  unit: z.string().regex(/^[a-z][a-z0-9/_-]*$/),
}).strict().refine(
  ({ unit }) => unit.split(/[/_-]/).every((token) =>
    currencyExponent(token.toUpperCase()) === null && !MONEY_UNIT_WORDS.has(token)),
  { message: "currency units require a canonical money object", path: ["unit"] },
);

function isMoneyFieldName(key) {
  if (MONEY_FIELD_NAMES.has(key)) return true;
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/);
  return MONEY_FIELD_SUFFIXES.has(words.at(-1));
}

/**
 * Validate that all money fields across the graph use the money contract.
 * Walks open-ended fact payloads, rejecting ambiguous bare numbers and
 * accepting canonical money or explicitly typed non-money quantities.
 * Familiar monetary field names are also checked directly.
 *
 * Also checks that authoritative assertions have evidenceRef and that
 * fact-bearing entities/links have required provenance fields.
 *
 * @param {object} graph — a graphSchema-shaped object
 * @param {{verifyEvidence?: (fact: object, reference: object|string) => boolean}} options
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateGraphIntegrity(graph, { verifyEvidence } = {}) {
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

  // A payload's evidence strings are only a claim; authority requires an
  // independently supplied verifier that checks the fact and reference pair.
  const isVerified = (fact, reference) => {
    if (typeof verifyEvidence !== "function") return false;
    try { return verifyEvidence(fact, reference) === true; } catch { return false; }
  };
  for (let i = 0; i < data.assertions.length; i++) {
    const a = data.assertions[i];
    if (a.provenance === "authoritative" && !isVerified(a, a.evidenceRef)) {
      errors.push(`assertions[${i}]: authoritative provenance requires trusted evidence verification`);
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
      if (l.provenance === "authoritative" && !isVerified(l, l.evidenceAddress)) {
        errors.push(`links[${i}]: authoritative provenance link requires trusted evidence verification`);
      }
    }
  }

  // Fact payloads need explicit numeric types. A finite list of money-like
  // field names cannot catch new names such as grandTotal or purchase_total.
  function validateFactNumbers(obj, path) {
    if (typeof obj === "number") {
      errors.push(`${path}: untyped numeric fact; use canonical money or an explicit quantity`);
      return;
    }
    if (!obj || typeof obj !== "object") return;
    if (moneySchema.safeParse(obj).success) return;
    if (obj.kind === "quantity") {
      if (!quantitySchema.safeParse(obj).success) {
        errors.push(`${path}: invalid explicit quantity`);
      }
      return;
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        validateFactNumbers(obj[i], `${path}[${i}]`);
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
          }
        } else {
          errors.push(`${fullPath}: money field must be a canonical money object { amount, currency, exponent }, got ${typeof val}`);
        }
        continue;
      }
      validateFactNumbers(val, fullPath);
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

  // Only open-ended fact JSON needs this check. Typed graph metadata has its
  // own schemas, and money objects must not be reinterpreted as bare numbers.
  for (let i = 0; i < (data.entities ?? []).length; i++) {
    if (data.entities[i].attributes) validateFactNumbers(data.entities[i].attributes, `entities[${i}].attributes`);
  }
  for (let i = 0; i < data.assertions.length; i++) {
    validateFactNumbers(data.assertions[i].object, `assertions[${i}].object`);
  }

  return { valid: errors.length === 0, errors };
}
