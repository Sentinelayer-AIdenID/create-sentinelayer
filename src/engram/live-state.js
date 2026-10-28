/**
 * ENGRAM §EW14 — Live-state hydration: freshness classes, source versioning,
 * revalidation gates, TOCTOU guards, and commerce context.
 *
 * ## Freshness Data Classes
 *
 * Every fact in the ENGRAM graph carries an explicit freshness class:
 *   static           — immutable facts (e.g. a SHA hash, a contract version)
 *   stale_readable   — cacheable with a known staleness deadline; reads are
 *                      marked with an asOf timestamp, never claimed fresh
 *   live_required    — MUST be fetched from the authoritative source at
 *                      action time; cached values are insufficient
 *   private_session  — scoped to a caller session; never shared or cached
 *
 * ## Source Versioning
 *
 * Source adapters carry ETags, content versions, and staleness deadlines.
 * Every fetch records the version it observed. A mismatch at action time
 * triggers re-fetch, never silent substitution.
 *
 * ## TOCTOU Guard
 *
 * Cached graph facts cannot authorize a transaction. Before any
 * authorization-significant action, the caller must revalidate against the
 * live source. The revalidation gate (`mustRevalidate`) enforces this:
 * a graph-level read returns facts with an explicit staleness marker;
 * an authorization path requires a fresh source fetch.
 *
 * ## Source Outage
 *
 * When a source is unavailable, dependent actions are disabled or escalated.
 * No invented substitute facts. The `SourceStatus` enumeration tracks
 * available/degraded/unavailable, and `disabledByOutage` checks whether a
 * requested action is blocked.
 *
 * ## Commerce Context
 *
 * Currency, market, variant, customer eligibility, and quantity are part of
 * the relevant commerce context — never one global price. Every
 * commerce-sensitive operation carries a `CommerceContext` bundle.
 */
import { moneySchema } from "./contracts/money.js";
import { EW05_PREDICATES } from "./compile-graph.js";


// ---------------------------------------------------------------------------
// Freshness data classes
// ---------------------------------------------------------------------------

/**
 * Exactly four freshness classes. Every graph fact must be classifiable into
 * one of these, and the class determines what a consumer may do with it.
 */
export const FRESHNESS_CLASSES = Object.freeze([
  "static",
  "stale_readable",
  "live_required",
  "private_session",
]);

const FRESHNESS_CLASS_SET = new Set(FRESHNESS_CLASSES);

/**
 * Classification rules (deterministic, not inferred):
 *
 *   static           immutable-by-nature facts: contract versions, content
 *                    hashes, schema identifiers, cryptographic fingerprints.
 *                    These may be cached indefinitely.
 *
 *   stale_readable   facts that can be read from cache with a known asOf
 *                    timestamp and a staleness deadline, but must disclose
 *                    their age to the consumer. Examples: indexed prices,
 *                    inventory snapshots, policy documents.
 *
 *   live_required    facts that MUST be fetched from the authoritative source
 *                    at action time. Cached values are informative only and
 *                    cannot authorize. Examples: current inventory count at
 *                    checkout, payment authorization, delivery estimate for
 *                    a specific cart.
 *
 *   private_session  facts scoped to the caller's session: authentication
 *                    tokens, session-scoped preferences, transient state.
 *                    Never cached or shared across sessions.
 *
 * @param {{kind: string, sourceKind?: string, isAuth?: boolean, isSessionScoped?: boolean}} params
 * @returns {string} one of FRESHNESS_CLASSES
 */
export function classifyFreshness({ kind, sourceKind, isAuth, isSessionScoped } = {}) {
  if (isSessionScoped) return "private_session";
  if (isAuth) return "live_required";
  if (kind === "hash" || kind === "version" || kind === "schema" || kind === "fingerprint") return "static";
  if (sourceKind === "live" || sourceKind === "realtime") return "live_required";
  return "stale_readable";
}

/**
 * Validate that a freshness class string is one of the four canonical values.
 */
export function isValidFreshnessClass(value) {
  return FRESHNESS_CLASS_SET.has(value);
}

// ---------------------------------------------------------------------------
// Freshness marker
// ---------------------------------------------------------------------------

/**
 * A FreshnessMarker records what is known about a fact's age.
 *
 * Rules:
 *   - `asOf` is mandatory when `freshnessClass` is `stale_readable` or `live_required`.
 *   - Never claim `staleAfterMs = 0` or `isStale = false` on a stale_readable fact
 *     without a live revalidation.
 *   - `sourceVersion` records the ETag or content version observed at fetch time.
 *   - `sourceStatus` records whether the source was available at fetch time.
 *
 * @typedef {{asOf: string, freshnessClass: string, staleAfterMs?: number,
 *            sourceVersion?: string, sourceStatus?: string,
 *            isStale?: boolean, revalidatedAt?: string}} FreshnessMarker
 */

/**
 * Create a freshness marker with mandatory timestamp and disclosure.
 *
 * @param {{freshnessClass: string, asOf?: string, staleAfterMs?: number,
 *          sourceVersion?: string, sourceStatus?: string,
 *          isStale?: boolean, revalidatedAt?: string}} params
 * @returns {FreshnessMarker}
 */
export function createFreshnessMarker({
  freshnessClass,
  asOf,
  staleAfterMs,
  sourceVersion,
  sourceStatus,
  isStale,
  revalidatedAt,
} = {}) {
  if (!isValidFreshnessClass(freshnessClass)) {
    throw new FreshnessClassError(
      `invalid freshness class "${freshnessClass}"; must be one of ${FRESHNESS_CLASSES.join(", ")}`,
    );
  }

  const now = asOf || new Date().toISOString();

  // live_required and stale_readable MUST carry an asOf timestamp
  if ((freshnessClass === "live_required" || freshnessClass === "stale_readable") && !asOf) {
    throw new FreshnessClassError(
      `freshness class "${freshnessClass}" requires an explicit asOf timestamp`,
    );
  }

  // Never claim zero staleness on stale_readable without revalidation
  if (freshnessClass === "stale_readable" && staleAfterMs !== undefined && staleAfterMs <= 0) {
    throw new FreshnessClassError(
      "stale_readable facts cannot claim zero or negative staleness",
    );
  }

  if (sourceStatus !== undefined && !SOURCE_STATUS_SET.has(sourceStatus)) {
    throw new FreshnessClassError(
      `sourceStatus must be one of ${SOURCE_STATUSES.join(", ")}; got "${sourceStatus}"`,
    );
  }

  const marker = {
    asOf: now,
    freshnessClass,
  };

  if (staleAfterMs !== undefined) marker.staleAfterMs = staleAfterMs;
  if (sourceVersion !== undefined) marker.sourceVersion = sourceVersion;
  if (sourceStatus !== undefined) marker.sourceStatus = sourceStatus;
  if (isStale !== undefined) marker.isStale = isStale;
  if (revalidatedAt !== undefined) marker.revalidatedAt = revalidatedAt;

  return Object.freeze(marker);
}

/**
 * Determine whether a freshness marker is currently stale.
 * Returns undefined when staleness cannot be determined (never lie).
 */
export function isFreshnessStale(marker, now = new Date()) {
  if (!marker || marker.freshnessClass === "static") return false;
  if (marker.freshnessClass === "live_required" && !marker.revalidatedAt) return true;
  if (marker.isStale === true) return true;
  if (marker.staleAfterMs !== undefined && marker.asOf) {
    const age = now.getTime() - new Date(marker.asOf).getTime();
    if (age > marker.staleAfterMs) return true;
  }
  return undefined; // cannot determine — disclose, don't invent
}

// ---------------------------------------------------------------------------
// Source versioning (ETags, content versions)
// ---------------------------------------------------------------------------

/**
 * A source version descriptor captured at fetch time.
 *
 * @typedef {{sourceId: string, version: string, etag?: string,
 *            fetchedAt: string, tenantScope: string,
 *            sourceStatus: string}} SourceVersion
 */

export const SOURCE_STATUSES = Object.freeze([
  "available",
  "degraded",
  "unavailable",
]);

const SOURCE_STATUS_SET = new Set(SOURCE_STATUSES);

/**
 * Create a source version record from a fetch result.
 */
export function createSourceVersion({
  sourceId,
  version,
  etag,
  fetchedAt,
  tenantScope,
  sourceStatus,
} = {}) {
  if (!sourceId || typeof sourceId !== "string" || sourceId.length === 0) {
    throw new SourceVersionError("sourceId is required and must be non-empty");
  }
  if (!version || typeof version !== "string" || version.length === 0) {
    throw new SourceVersionError("version is required and must be non-empty");
  }
  if (!fetchedAt) {
    throw new SourceVersionError("fetchedAt is required");
  }
  if (!SOURCE_STATUS_SET.has(sourceStatus)) {
    throw new SourceVersionError(
      `sourceStatus must be one of ${SOURCE_STATUSES.join(", ")}; got "${sourceStatus}"`,
    );
  }

  const record = {
    sourceId,
    version,
    fetchedAt: typeof fetchedAt === "string" ? fetchedAt : fetchedAt.toISOString(),
    tenantScope: tenantScope || "default",
    sourceStatus,
  };

  if (etag !== undefined) record.etag = etag;

  return Object.freeze(record);
}

// ---------------------------------------------------------------------------
// Authoritative priority resolution
// ---------------------------------------------------------------------------

/**
 * Resolve which of two source versions is more authoritative.
 *
 * Priority (highest to lowest):
 *   1. available > degraded > unavailable
 *   2. fresher fetchedAt
 *   3. higher version (string comparison)
 *
 * Returns the more authoritative version, or null if neither is usable.
 */
export function resolveAuthoritativeSource(a, b) {
  if (!a || !b) return a || b || null;

  const authorityRank = { available: 3, degraded: 2, unavailable: 1 };
  const rankA = authorityRank[a.sourceStatus] || 0;
  const rankB = authorityRank[b.sourceStatus] || 0;

  if (rankA !== rankB) return rankA > rankB ? a : b;

  const timeA = new Date(a.fetchedAt).getTime();
  const timeB = new Date(b.fetchedAt).getTime();
  if (timeA !== timeB) return timeA > timeB ? a : b;

  return a.version > b.version ? a : b;
}

// ---------------------------------------------------------------------------
// Revalidation gate (TOCTOU guard)
// ---------------------------------------------------------------------------

/**
 * Determine whether a freshness marker requires revalidation before the
 * fact it describes can authorize an action.
 *
 * Rules:
 *   - live_required ALWAYS requires revalidation (cached is never enough)
 *   - stale_readable requires revalidation when isStale or past deadline
 *   - unavailable source → revalidation is impossible → escalate
 *   - static never requires revalidation
 *
 * @returns {{mustRevalidate: boolean, reason?: string, escalate?: boolean}}
 */
export function mustRevalidate(marker, now = new Date()) {
  if (!marker) {
    return { mustRevalidate: true, reason: "no freshness marker — cannot authorize without provenance" };
  }

  // Fail-safe: unknown freshness class must revalidate
  if (!isValidFreshnessClass(marker.freshnessClass)) {
    return { mustRevalidate: true, reason: `unknown freshness class "${marker.freshnessClass}" — refusing to authorize` };
  }

  if (marker.freshnessClass === "static") {
    return { mustRevalidate: false };
  }

  if (marker.freshnessClass === "live_required") {
    return { mustRevalidate: true, reason: "live_required facts must be fetched at action time" };
  }

  if (marker.freshnessClass === "private_session") {
    return { mustRevalidate: false }; // session-scoped; already bound to caller
  }

  // stale_readable
  if (marker.isStale === true) {
    return { mustRevalidate: true, reason: "fact is marked stale" };
  }

  if (marker.staleAfterMs !== undefined && marker.asOf) {
    const age = now.getTime() - new Date(marker.asOf).getTime();
    if (age > marker.staleAfterMs) {
      return { mustRevalidate: true, reason: `staleness deadline exceeded (age ${age}ms > ${marker.staleAfterMs}ms)` };
    }
  }

  // Degraded source: allow but disclose reduced confidence
  if (marker.sourceStatus === "degraded") {
    return {
      mustRevalidate: false,
      degraded: true,
      reason: "source is degraded — proceed with reduced confidence",
    };
  }

  // Source outage: cannot revalidate → escalate
  if (marker.sourceStatus === "unavailable") {
    return {
      mustRevalidate: true,
      reason: "source is unavailable — cannot revalidate; escalate to operator",
      escalate: true,
    };
  }

  // No staleness signal → must disclose but not block
  return { mustRevalidate: false };
}

// ---------------------------------------------------------------------------
// Source outage handling
// ---------------------------------------------------------------------------

/** How bad a source status is; a status outside SOURCE_STATUSES is the worst. */
const SOURCE_STATUS_RANK = new Map([["available", 0], ["degraded", 1], ["unavailable", 2]]);
const statusRank = (status) => SOURCE_STATUS_RANK.get(status) ?? 3;

/**
 * Check whether a source outage disables a dependent action.
 *
 * When a source is unavailable, dependent actions are disabled.
 * Degraded sources allow actions but with reduced confidence.
 * No invented substitute facts.
 *
 * Every dependency is checked before a degraded one is reported, so one
 * unavailable source disables the action wherever it sits in the list. A
 * status outside SOURCE_STATUSES cannot be verified and disables it too.
 * When several records name one source, the worst status counts (unknown,
 * then unavailable, then degraded, then available), so the result never
 * depends on their order.
 */
export function disabledByOutage(sourceVersions, actionDependencies) {
  if (!actionDependencies || actionDependencies.length === 0) return { disabled: false };

  const sources = new Map();
  for (const sv of sourceVersions || []) {
    if (!sv || !sv.sourceId) continue;
    const recorded = sources.get(sv.sourceId);
    if (!recorded || statusRank(sv.sourceStatus) > statusRank(recorded.sourceStatus)) {
      sources.set(sv.sourceId, sv);
    }
  }

  let degraded = null;
  for (const dep of actionDependencies) {
    const sv = sources.get(dep);
    if (!sv) {
      return { disabled: true, reason: `source "${dep}" has no recorded version — cannot verify availability` };
    }
    if (sv.sourceStatus === "unavailable") {
      return { disabled: true, reason: `source "${dep}" is unavailable` };
    }
    if (sv.sourceStatus === "degraded") {
      degraded ??= { disabled: false, degraded: true, reason: `source "${dep}" is degraded — proceed with caution` };
    } else if (sv.sourceStatus !== "available") {
      return {
        disabled: true,
        reason: `source "${dep}" has unknown status "${sv.sourceStatus}" — cannot verify availability`,
      };
    }
  }

  return degraded ?? { disabled: false };
}

// ---------------------------------------------------------------------------
// Commerce context (currency / market / variant / customer eligibility / quantity)
// ---------------------------------------------------------------------------

/**
 * A CommerceContext bundles the commerce-relevant dimensions for a single
 * operation. Every operation that touches price, inventory, or eligibility
 * carries its own context — none of these fields is global.
 *
 * Rules:
 *   - No fields are global — every commerce operation carries its own bundle.
 *   - An absent field means "not applicable to this operation" or "not
 *     provided"; it is never silently defaulted to a global value.
 */
export function createCommerceContext({
  currency,
  market,
  variant,
  customerEligibility,
  quantity,
  priceContext,
} = {}) {
  const ctx = {};

  if (currency !== undefined) {
    if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
      throw new CommerceContextError(`invalid currency code "${currency}"`);
    }
    ctx.currency = currency;
  }

  if (market !== undefined) {
    if (typeof market !== "string" || market.length === 0) {
      throw new CommerceContextError("market must be a non-empty string");
    }
    ctx.market = market;
  }

  if (variant !== undefined) {
    if (typeof variant !== "string" || variant.length === 0) {
      throw new CommerceContextError("variant must be a non-empty string");
    }
    ctx.variant = variant;
  }

  if (customerEligibility !== undefined) {
    if (typeof customerEligibility !== "string") {
      throw new CommerceContextError("customerEligibility must be a string");
    }
    ctx.customerEligibility = customerEligibility;
  }

  if (quantity !== undefined) {
    if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 0) {
      throw new CommerceContextError("quantity must be a non-negative safe integer");
    }
    ctx.quantity = quantity;
  }

  if (priceContext !== undefined) {
    if (typeof priceContext !== "object" || priceContext === null) {
      throw new CommerceContextError("priceContext must be an object");
    }
    ctx.priceContext = priceContext;
  }

  return Object.freeze(ctx);
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class FreshnessClassError extends Error {
  constructor(message) {
    super(message);
    this.name = "FreshnessClassError";
  }
}

export class SourceVersionError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceVersionError";
  }
}

export class RevalidationRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "RevalidationRequiredError";
  }
}

export class SourceOutageError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceOutageError";
  }
}

export class CommerceContextError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommerceContextError";
  }
}

// ---------------------------------------------------------------------------
// Live-source adapter interface (contract only — adapter is injected)
// ---------------------------------------------------------------------------

/**
 * A live-source adapter MUST fulfil this interface. No concrete implementation
 * is provided here; callers inject an adapter per authoritative source.
 *
 *   fetchLive(commerceContext, entityIds, fieldNames) → Promise<Map<string, Map<string, any>>>
 *
 *   - commerceContext: a CommerceContext (created by createCommerceContext)
 *   - entityIds: string[] of entity identifiers (e.g. ["product:1", "product:2"])
 *   - fieldNames: string[] of field names to fetch (e.g. ["price", "inventory"])
 *   - Returns: Map keyed by entityId → Map keyed by field name → live value
 *     Entities or fields that are unknown or unavailable are simply absent from the Maps.
 *
 *   sourceId: string — identifies the live source (e.g. "catalog:us-east-1")
 *
 *   sourceStatus(): "available" | "degraded" | "unavailable"
 *
 * Adapters may throw on transport failure; callers MUST handle that.
 */

/**
 * Validate that an object satisfies the minimal live-source adapter shape.
 * Returns an array of missing/invalid members (empty = valid).
 */
export function validateAdapterShape(adapter) {
  const issues = [];
  if (!adapter || typeof adapter !== "object") {
    return ["adapter must be an object"];
  }
  if (typeof adapter.fetchLive !== "function") {
    issues.push("adapter.fetchLive must be a function");
  }
  if (typeof adapter.sourceId !== "string" || adapter.sourceId.length === 0) {
    issues.push("adapter.sourceId must be a non-empty string");
  }
  if (typeof adapter.sourceStatus !== "function") {
    issues.push("adapter.sourceStatus must be a function");
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Volatile values: one rule for what hydrate fetches, merges and clears
// ---------------------------------------------------------------------------

/**
 * Check whether a value is a canonical money object per moneySchema.
 */
function isMoneyValue(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  // moneySchema requires amountUnit: an object without it is not parsed, which
  // keeps the walk over a large graph cheap.
  if (!("amountUnit" in value)) return false;
  return moneySchema.safeParse(value).success;
}

/** True for a list that holds a money value, directly or in nested lists. */
function holdsMoneyInList(value) {
  return Array.isArray(value) && value.some((item) => isMoneyValue(item) || holdsMoneyInList(item));
}

/**
 * True when a value found under `key` is one volatile node: the key names a
 * volatile field (isVolatileField), the value is canonical money
 * (moneySchema), or the value is a list holding money. Such a list is one
 * node, fetched, merged and cleared whole: clearing its money items one by one
 * would shift the items after them, and a live value written by path would
 * land at another item's index.
 */
function isVolatileNode(key, value) {
  return isVolatileField(key) || isMoneyValue(value) || holdsMoneyInList(value);
}

/** Returned by a mapVolatileNodes callback to drop the node it was given. */
const OMIT = Symbol("omit");

/**
 * Rebuild a JSON value with every volatile node replaced by
 * replace(path, node); a node replaced by OMIT is dropped from its object.
 *
 * The rule (isVolatileNode) holds at ANY depth, so it covers a price inside
 * offers or a variant offer, a priceSpecification on an offer or on the
 * product itself, an AggregateOffer's lowPrice and highPrice, the prices of a
 * top-level Offer, AggregateOffer or UnitPriceSpecification entity, and the
 * per-source copies the compiler keeps when two pages describe one product.
 * The root (path null) is never a volatile node itself. A volatile node is
 * handed over whole and not walked into, so no volatile path is a prefix of
 * another.
 *
 * Paths are the keys adapters use for live values: "price", "offers.price",
 * "offers[0].priceSpecification.price". Below the root, a list item is never
 * a volatile node (a list holding money is one node), so lists keep their
 * length and every item its index.
 */
function mapVolatileNodes(value, path, key, replace) {
  if (path !== null && isVolatileNode(key, value)) return replace(path, value);
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      const next = mapVolatileNodes(item, `${path ?? ""}[${i}]`, undefined, replace);
      return next === OMIT ? null : next; // only an item of a root list can be dropped
    });
  }
  if (value !== null && typeof value === "object") {
    const fields = [];
    for (const [childKey, child] of Object.entries(value)) {
      const childPath = path === null ? childKey : `${path}.${childKey}`;
      const next = mapVolatileNodes(child, childPath, childKey, replace);
      if (next !== OMIT) fields.push([childKey, next]);
    }
    return Object.fromEntries(fields);
  }
  return value;
}

/** The volatile paths of an entity: the fields hydrate asks its source for. */
function volatileFieldsForEntity(entity) {
  const paths = new Set();
  mapVolatileNodes(entity?.attributes, null, undefined, (path, node) => {
    paths.add(path);
    return node;
  });
  return paths;
}

/** True when a JSON value is, or holds at any depth, a volatile value. */
function holdsVolatileValue(value) {
  let found = isVolatileNode(undefined, value);
  mapVolatileNodes(value, null, undefined, (_path, node) => {
    found = true;
    return node;
  });
  return found;
}

/**
 * An entity with each volatile path holding the value the source returned for
 * that exact path, and every volatile path the source did not return removed.
 * Only the entity's own volatile paths are ever written: an adapter cannot add
 * a field, grow an offers array or overwrite a stable fact. Each path written
 * is added to liveFields.
 */
function overlayLiveValues(entity, live, liveFields) {
  if (!entity?.attributes) return entity;
  // Attributes that are themselves a volatile node (a money value, or a list
  // holding money) have no path to ask the source for, so they are never served.
  if (isVolatileNode(undefined, entity.attributes)) return { ...entity, attributes: {} };
  const attributes = mapVolatileNodes(entity.attributes, null, undefined, (path) => {
    const value = live.get(path);
    if (value === undefined) return OMIT;
    liveFields.add(path);
    return value;
  });
  return { ...entity, attributes };
}

/**
 * Merge live values (per-entity Map<entityId, Map<path, value>>) into entity
 * attributes. Each entity gets the values for its own volatile paths only; a
 * volatile path with no live value is removed, and on an outage every one is.
 *
 * Returns the hydrated entities and liveFields: the paths that hold a live
 * value in them.
 */
function mergeLiveValues(entities, liveValues, sourceStatus) {
  const liveFields = new Set();
  const hydratedEntities = entities.map((entity) => {
    // On outage nothing is live: never serve cached values
    const live = sourceStatus === "unavailable" ? undefined : liveValues.get(entity?.id);
    return overlayLiveValues(entity, live ?? new Map(), liveFields);
  });
  return { hydratedEntities, liveFields };
}

// ---------------------------------------------------------------------------
// Cached volatile values outside entity attributes
// ---------------------------------------------------------------------------

/** The compiler states attribute <field> of an entity as describes_<field>. */
const ATTRIBUTE_PREDICATE_PREFIX = `${EW05_PREDICATES.DESCRIBES}_`;

/**
 * True when an assertion carries a cached volatile value: its object is or
 * holds one, or its predicate names a volatile field, by name
 * (describes_price, describes_availability) or because that field of its
 * subject is volatile (describes_lowPrice where lowPrice is money).
 */
function isVolatileAssertion(assertion, volatileFieldsBySubject) {
  const predicate = typeof assertion?.predicate === "string" ? assertion.predicate : "";
  const field = predicate.startsWith(ATTRIBUTE_PREDICATE_PREFIX)
    ? predicate.slice(ATTRIBUTE_PREDICATE_PREFIX.length)
    : predicate;
  return isVolatileField(field) ||
    volatileFieldsBySubject.get(assertion?.subject)?.has(field) === true ||
    holdsVolatileValue(assertion?.object);
}

/** Coverage counts for the assertions hydrate returns. */
function recountCoverage(coverage, assertions) {
  const countBy = (field) => {
    const counts = {};
    for (const assertion of assertions) {
      const value = assertion?.[field];
      if (value !== undefined) counts[value] = (counts[value] ?? 0) + 1;
    }
    return counts;
  };
  const recounted = { ...coverage, totalAssertions: assertions.length };
  if (coverage.byProvenance) recounted.byProvenance = countBy("provenance");
  if (coverage.bySchemaValidity) recounted.bySchemaValidity = countBy("schemaValidity");
  return recounted;
}

/**
 * The graph hydrate returns: the hydrated entities, and no cached volatile
 * value anywhere else in the published graph.
 *
 * Assertions. The compiler copies each attribute of an entity into a
 * describes_<field> assertion, so a published graph also holds cached prices
 * there (describes_price, describes_lowPrice, ...). Such an assertion is
 * removed, not rewritten with the live value. An assertion states what one
 * snapshot said: source.version and source.capturedAt name that snapshot, and
 * the graph contract rejects a fact captured after graph.generatedAt. A live
 * value written into it would either keep the snapshot's provenance, which is
 * false, or carry its own fetch time, which the contract rejects; and a live
 * value that is not canonical money would fail the contract's check on
 * monetary predicates. The live value is on the entity, at its own path.
 * coverage is recounted, so the graph stays valid under its contract.
 *
 * Links. A link is kept only when both its ends are in the returned graph: a
 * returned entity or a kept assertion. Otherwise a removed assertion, or an
 * entity left out by entityIds, would leave it dangling.
 *
 * Unresolved facts. A rawValue is a value the compiler could not type: a
 * price with no currency, an amount it could not read, or an array recorded
 * whole, which can hold prices under any field name. hydrate cannot tell which
 * raw values are prices and never asks the source for them, so it returns
 * each record without its rawValue; field, path and reason still disclose the
 * gap.
 */
function withoutCachedVolatiles(graph, entities) {
  const hydrated = { ...graph, entities };

  const volatileFieldsBySubject = new Map();
  for (const entity of graph.entities ?? []) {
    if (entity) volatileFieldsBySubject.set(entity.id, volatileFieldsForEntity(entity));
  }
  const assertions = Array.isArray(graph.assertions) ? graph.assertions : [];
  const kept = assertions.filter((assertion) => !isVolatileAssertion(assertion, volatileFieldsBySubject));
  if (kept.length < assertions.length) {
    hydrated.assertions = kept;
    if (graph.coverage) hydrated.coverage = recountCoverage(graph.coverage, kept);
  }

  if (Array.isArray(graph.links)) {
    const nodes = new Set([...entities, ...kept].map((node) => node?.id));
    hydrated.links = graph.links.filter((link) => nodes.has(link?.source) && nodes.has(link?.target));
  }

  if (Array.isArray(graph.unresolvedFacts)) {
    hydrated.unresolvedFacts = graph.unresolvedFacts.map((fact) => {
      if (!fact || typeof fact !== "object") return fact;
      const { rawValue: _cached, ...record } = fact;
      return record;
    });
  }
  return hydrated;
}

// ---------------------------------------------------------------------------
// Adapter results, checked before they are trusted
// ---------------------------------------------------------------------------

/**
 * A live source's status. A missing adapter, a status check that throws and
 * a status outside SOURCE_STATUSES all read as "unavailable": hydrate and
 * revalidateForAction fail closed rather than trust them.
 */
function liveSourceStatus(adapter) {
  if (!adapter || typeof adapter.sourceStatus !== "function") return "unavailable";
  try {
    const status = adapter.sourceStatus();
    return SOURCE_STATUS_SET.has(status) ? status : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** True for a Map whose values are all Maps: Map<entityId, Map<path, value>>. */
function isMapOfMaps(value) {
  if (!(value instanceof Map)) return false;
  for (const inner of value.values()) {
    if (!(inner instanceof Map)) return false;
  }
  return true;
}

/** True for a record shaped like createSourceVersion's output. */
function isSourceVersionRecord(record) {
  if (record === null || typeof record !== "object") return false;
  const named = [record.sourceId, record.version, record.fetchedAt];
  return named.every((field) => typeof field === "string" && field.length > 0) &&
    SOURCE_STATUS_SET.has(record.sourceStatus);
}

// ---------------------------------------------------------------------------
// hydrate — read graph through graph-store, overlay live values per entity
// ---------------------------------------------------------------------------

/**
 * Hydrate the caller's view of the published graph.
 *
 * Reads the graph through graph-store and resolves every entity whose
 * freshness class is `live_required` against the live-source adapter.
 * Each entity gets its own live values — never a single shared value.
 *
 * A volatile value (a field named in VOLATILE_FIELD_NAMES in any spelling,
 * canonical money, or a list holding money, at any depth of an entity's
 * attributes) comes only from the live source. A volatile path the source
 * does not return is CLEARED; on an outage, a transport failure, a malformed
 * response or with no adapter every one is (never served from cache), and
 * the caller sees sourceStatus="unavailable". Assertions that carry a
 * volatile value and the raw values of unresolved facts are never returned
 * (see withoutCachedVolatiles).
 *
 * Optional `entityIds` and `fieldNames` (top-level attribute names) filter
 * the returned graph to the requested entities and fields, with or without
 * an adapter; the source is asked only for the volatile paths inside them.
 *
 * Returns:
 *   { graph, version, publishedAt, hydratedAt, liveFields: string[],
 *     sourceStatus: "available"|"degraded"|"unavailable" }
 *
 * liveFields lists the volatile paths that hold a live value in the
 * returned graph, so it is empty whenever nothing came back from the source.
 */
export async function hydrate(
  caller,
  namespace,
  graphStore,
  liveSourceAdapter,
  commerceContext,
  { entityIds, fieldNames } = {},
) {
  // Read the currently published graph
  const result = await graphStore.readCurrentGraph(caller, namespace);

  if (!result || result.graph === null) {
    return {
      graph: null,
      version: result?.version ?? 0,
      reason: result?.reason ?? "no graph published",
      hydratedAt: new Date().toISOString(),
      liveFields: [],
      sourceStatus: "unavailable",
    };
  }

  const { graph, version, publishedAt } = result;

  // The caller's view: the requested entities and top-level fields
  let entities = graph.entities ?? [];
  if (entityIds && entityIds.length > 0) {
    const idSet = new Set(entityIds);
    entities = entities.filter((entity) => idSet.has(entity?.id));
  }
  if (fieldNames && fieldNames.length > 0) {
    const fieldSet = new Set(fieldNames);
    entities = entities.map((entity) => {
      if (!entity?.attributes) return entity;
      // Attributes that are themselves a volatile node are one value, never
      // served: a slice of them (a money object's amount alone) would no
      // longer look volatile.
      if (isVolatileNode(undefined, entity.attributes)) return { ...entity, attributes: {} };
      const attributes = Object.fromEntries(Object.entries(entity.attributes).filter(([key]) => fieldSet.has(key)));
      return { ...entity, attributes };
    });
  }

  // Ask the source for the volatile paths in that view only. Assertions are
  // not hydrated (withoutCachedVolatiles removes the ones that carry a
  // volatile value), so it is asked for entity fields only.
  const ids = entities.map((entity) => entity?.id).filter(Boolean);
  const requested = new Set();
  for (const entity of entities) {
    for (const path of volatileFieldsForEntity(entity)) requested.add(path);
  }

  let sourceStatus = liveSourceStatus(liveSourceAdapter);
  let liveValues = new Map();
  if (sourceStatus !== "unavailable" && requested.size > 0 && ids.length > 0) {
    try {
      const response = await liveSourceAdapter.fetchLive(commerceContext ?? {}, ids, [...requested]);
      // A response outside the adapter contract is a failed fetch
      if (isMapOfMaps(response)) liveValues = response;
      else sourceStatus = "unavailable";
    } catch {
      // Transport failure → treat as unavailable for this hydration
      sourceStatus = "unavailable";
    }
  }

  // Merge per-entity live values (or clear volatiles on outage)
  const { hydratedEntities, liveFields } = mergeLiveValues(entities, liveValues, sourceStatus);

  return {
    graph: withoutCachedVolatiles(graph, hydratedEntities),
    version,
    publishedAt,
    hydratedAt: new Date().toISOString(),
    liveFields: [...liveFields],
    sourceStatus,
  };
}

// ---------------------------------------------------------------------------
// revalidateForAction — TOCTOU re-check before authorisation
// ---------------------------------------------------------------------------

/**
 * Revalidate live_required fields against the live source before an
 * authorization-significant action.
 *
 * Accepts `expectedVersions`: a Map<entityId, Map<fieldName, version>> that
 * records what the caller saw. Compares live values against THESE versions,
 * not against cached graph values. If the caller's version differs from live,
 * the action MUST be re-attempted with the new values. Every expected field
 * must be a volatile field of its entity in the published graph, checked
 * before the source is called: the source is asked for the graph's own
 * volatile fields only, so a caller cannot widen the live query.
 *
 * `actionDependencies` (optional): SourceVersion records (createSourceVersion)
 * for the other sources the action depends on, as the caller last observed
 * them. One that is unavailable blocks the action (disabledByOutage), and so
 * does anything that is not such a record: a non-empty sourceId, version and
 * fetchedAt, and a status in SOURCE_STATUSES. With two records for one
 * source the worse status counts.
 *
 * Reduced confidence: when the live source or a dependency is degraded the
 * action may go ahead, and the result says so with degraded: true and a
 * reason naming each degraded source (sourceStatus alone reports only the
 * live source).
 *
 * Empty or missing expectedVersions: nothing is compared, so the result is
 * ok:true with an empty changedFields, meaning the action relied on no
 * volatile value. The source is still asked, so an outage, a failed fetch or
 * an unavailable dependency still gives ok:false. A caller that showed a
 * volatile value must pass it here.
 *
 * Returns:
 *   { ok: boolean, mustRetry: boolean, changedFields: Map<string, {callerVersion, live}>,
 *     sourceStatus: string, revalidatedAt: string, degraded?: true, reason?: string }
 *
 * When ok=false the action is blocked (no graph, the source unavailable or
 * misbehaving, a missing live value, an unavailable dependency, ...); a
 * missing adapter or a malformed argument or response blocks it too, nothing
 * is thrown. When mustRetry=true the action must be re-attempted with the
 * live values.
 */
export async function revalidateForAction(
  caller,
  namespace,
  graphStore,
  liveSourceAdapter,
  commerceContext,
  actionDependencies,
  expectedVersions,
) {
  const revalidatedAt = new Date().toISOString();
  const blocked = (reason, sourceStatus) => ({
    ok: false,
    mustRetry: false,
    reason,
    ...(sourceStatus ? { sourceStatus } : {}),
    revalidatedAt,
  });

  // Read current graph
  const result = await graphStore.readCurrentGraph(caller, namespace);
  if (!result || result.graph === null) return blocked(result?.reason ?? "no graph published");

  const { graph } = result;
  const entities = graph.entities ?? [];

  // Collect live_required fields per entity (including offers)
  const allLiveFieldNames = new Set();
  const ids = [];
  for (const entity of entities) {
    if (!entity) continue;
    if (entity.id) ids.push(entity.id);
    for (const fn of volatileFieldsForEntity(entity)) {
      allLiveFieldNames.add(fn);
    }
  }

  // Check source outage; a missing or misbehaving adapter is one
  const sourceStatus = liveSourceStatus(liveSourceAdapter);
  if (sourceStatus === "unavailable") return blocked("live source unavailable — cannot revalidate", sourceStatus);

  // Check the other sources the action depends on
  let degradedDependency = null;
  if (actionDependencies !== undefined && actionDependencies !== null) {
    if (!Array.isArray(actionDependencies) || !actionDependencies.every(isSourceVersionRecord)) {
      return blocked("actionDependencies must be SourceVersion records (createSourceVersion)", sourceStatus);
    }
    const outage = disabledByOutage(actionDependencies, actionDependencies.map((record) => record.sourceId));
    if (outage.disabled) return blocked(outage.reason, sourceStatus);
    if (outage.degraded) degradedDependency = outage.reason;
  }

  // Walk expectedVersions before the source is called: an entity no longer in
  // the graph, or a field outside its volatile set, is refused here.
  if (expectedVersions !== undefined && expectedVersions !== null && !isMapOfMaps(expectedVersions)) {
    return blocked("expectedVersions must be a Map<entityId, Map<field, version>>", sourceStatus);
  }
  const ev = expectedVersions ?? new Map();
  const entityMap = new Map(entities.filter((e) => e?.id).map((e) => [e.id, e]));
  for (const [entityId, expectedFields] of ev) {
    if (!entityMap.has(entityId)) return blocked(`entity ${entityId} is no longer in the graph`, sourceStatus);
    const entityVolatiles = volatileFieldsForEntity(entityMap.get(entityId));
    for (const field of expectedFields.keys()) {
      if (!entityVolatiles.has(field)) {
        return blocked(`entity ${entityId}: field ${field} is not a volatile field of this entity`, sourceStatus);
      }
    }
  }

  // Fetch the graph's own volatile fields
  let liveValues;
  try {
    liveValues = await liveSourceAdapter.fetchLive(
      commerceContext ?? {},
      ids,
      [...allLiveFieldNames],
    );
  } catch {
    return blocked("live source fetch failed — cannot revalidate", "unavailable");
  }
  if (!isMapOfMaps(liveValues)) {
    return blocked("live source returned a malformed response — cannot revalidate", "unavailable");
  }

  // Fail closed: every expected field needs a live value
  const changedFields = new Map();
  for (const [entityId, perEntityExpected] of ev) {
    const perEntityLive = liveValues.get(entityId);

    for (const [field, expectedVersion] of perEntityExpected) {
      if (!perEntityLive || perEntityLive.size === 0) {
        return blocked(`entity ${entityId}: no live values returned for expected field ${field}`, sourceStatus);
      }
      if (!perEntityLive.has(field)) {
        return blocked(`entity ${entityId}: expected field ${field} has no live value`, sourceStatus);
      }

      const liveVal = perEntityLive.get(field);

      // Compare against caller's expected version
      const liveVersion = typeof liveVal === "object" && liveVal !== null
        ? JSON.stringify(liveVal)
        : String(liveVal);
      const expectedStr = typeof expectedVersion === "object" && expectedVersion !== null
        ? JSON.stringify(expectedVersion)
        : String(expectedVersion);

      if (liveVersion !== expectedStr) {
        changedFields.set(`${entityId}:${field}`, {
          callerVersion: expectedVersion,
          live: liveVal,
        });
      }
    }
  }

  // Disclose reduced confidence, from the live source and from dependencies
  const degraded = [
    sourceStatus === "degraded" ? "live source is degraded — proceed with reduced confidence" : null,
    degradedDependency,
  ].filter(Boolean);

  return {
    ok: true,
    mustRetry: changedFields.size > 0,
    changedFields,
    sourceStatus,
    revalidatedAt,
    ...(degraded.length > 0 ? { degraded: true, reason: degraded.join("; ") } : {}),
  };
}

// ---------------------------------------------------------------------------
// LiveStateError
// ---------------------------------------------------------------------------

export class LiveStateError extends Error {
  constructor(message) {
    super(message);
    this.name = "LiveStateError";
  }
}

// ---------------------------------------------------------------------------
// Known volatile commerce field names (always live_required)
// ---------------------------------------------------------------------------

/**
 * Field names that are always served from the live source, never from cache.
 * These correspond to the volatile commerce fields from the ticket: price,
 * availability, inventory (schema.org inventoryLevel) and delivery estimate
 * (schema.org deliveryTime on shipping details, deliveryLeadTime on an
 * offer).
 *
 * Note: schema.org Products typically carry price and availability inside
 * `offers` (an object, array of variants, or AggregateOffer), and prices also
 * sit in a priceSpecification or on top-level Offer, AggregateOffer and
 * UnitPriceSpecification entities. hydrate and revalidateForAction therefore
 * treat a field with one of these names, and any canonical money value, as
 * volatile at any depth of an entity's attributes (mapVolatileNodes).
 *
 * A name is volatile wherever it appears, on any entity: a store-wide shipping
 * policy under deliveryTime (an Organization's, say) is cleared like an
 * offer's estimate unless the adapter serves it. Adapters must serve these
 * fields to keep them; limiting the delivery names to offer paths would let a
 * cached estimate through on a top-level Offer entity or under makesOffer.
 */
export const VOLATILE_FIELD_NAMES = Object.freeze([
  "price",
  "availability",
  "inventory",
  "inventoryLevel",
  "delivery_estimate",
  "deliveryEstimate",
  "deliveryTime",
  "deliveryLeadTime",
]);

/**
 * The form a field name is compared in: the local name after any namespace
 * prefix (schema:availability, https://schema.org/availability), lowercased,
 * with every character other than a letter or digit removed. The compiler
 * keeps markup keys as written, so Availability, AVAILABILITY and
 * delivery-estimate name the same fields as availability and
 * deliveryEstimate.
 */
function normalizeFieldName(fieldName) {
  if (typeof fieldName !== "string") return "";
  return fieldName.split(/[:/#]/).pop().toLowerCase().replace(/[^a-z0-9]/g, "");
}

const VOLATILE_FIELD_SET = new Set(VOLATILE_FIELD_NAMES.map(normalizeFieldName));

/**
 * Check whether a field name is volatile (must be fetched live), in any
 * spelling normalizeFieldName folds together.
 */
export function isVolatileField(fieldName) {
  return VOLATILE_FIELD_SET.has(normalizeFieldName(fieldName));
}
