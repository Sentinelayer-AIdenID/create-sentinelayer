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

  const statusRank = { available: 3, degraded: 2, unavailable: 1 };
  const rankA = statusRank[a.sourceStatus] || 0;
  const rankB = statusRank[b.sourceStatus] || 0;

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

/**
 * Check whether a source outage disables a dependent action.
 *
 * When a source is unavailable, dependent actions are disabled.
 * Degraded sources allow actions but with reduced confidence.
 * No invented substitute facts.
 */
export function disabledByOutage(sourceVersions, actionDependencies) {
  if (!actionDependencies || actionDependencies.length === 0) return { disabled: false };

  const sources = new Map();
  for (const sv of sourceVersions || []) {
    if (sv && sv.sourceId) sources.set(sv.sourceId, sv);
  }

  for (const dep of actionDependencies) {
    const sv = sources.get(dep);
    if (!sv) {
      return { disabled: true, reason: `source "${dep}" has no recorded version — cannot verify availability` };
    }
    if (sv.sourceStatus === "unavailable") {
      return { disabled: true, reason: `source "${dep}" is unavailable` };
    }
    if (sv.sourceStatus === "degraded") {
      return { disabled: false, degraded: true, reason: `source "${dep}" is degraded — proceed with caution` };
    }
  }

  return { disabled: false };
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
// Offsets helper — walk schema.org-style offers for volatile fields
// ---------------------------------------------------------------------------

/**
 * Walk an entity's offers (object, array of variants, or AggregateOffer)
 * and collect volatile field values keyed by field name.
 *
 * Schema.org Products carry price and availability inside `offers`, not at the
 * top level. This helper extracts them so they can be treated as volatile.
 *
 * Returns: Map<fieldName, value> — only fields that were found in the offers.
 */
function collectOfferVolatiles(entity) {
  const result = new Map();
  const offers = entity?.attributes?.offers ?? entity?.offers;
  if (!offers) return result;

  // Single offer object
  if (!Array.isArray(offers) && typeof offers === "object" && offers !== null) {
    if (offers.price !== undefined) result.set("offers.price", offers.price);
    if (offers.availability !== undefined) result.set("offers.availability", offers.availability);
    if (offers.inventory !== undefined) result.set("offers.inventory", offers.inventory);
    // AggregateOffer fields
    if (offers.lowPrice !== undefined) result.set("offers.lowPrice", offers.lowPrice);
    if (offers.highPrice !== undefined) result.set("offers.highPrice", offers.highPrice);
    if (offers.priceSpecification?.price !== undefined) result.set("offers.priceSpecification.price", offers.priceSpecification.price);
    return result;
  }

  // Array of offers (variants)
  if (Array.isArray(offers)) {
    for (let i = 0; i < offers.length; i++) {
      const offer = offers[i];
      if (offer && typeof offer === "object") {
        if (offer.price !== undefined) result.set(`offers[${i}].price`, offer.price);
        if (offer.availability !== undefined) result.set(`offers[${i}].availability`, offer.availability);
        if (offer.inventory !== undefined) result.set(`offers[${i}].inventory`, offer.inventory);
      }
    }
    return result;
  }

  return result;
}

/**
 * Check whether an entity has any volatile field (top-level or in offers).
 * Returns: Set<fieldName> of volatile field names present on this entity.
 */
function volatileFieldsForEntity(entity) {
  const names = new Set();
  if (!entity) return names;

  // Top-level attributes
  if (entity.attributes) {
    for (const [key] of Object.entries(entity.attributes)) {
      if (isVolatileField(key)) names.add(key);
    }
  }

  // Offers (schema.org pattern)
  const offerVolatiles = collectOfferVolatiles(entity);
  for (const key of offerVolatiles.keys()) {
    names.add(key);
  }

  return names;
}


// ---------------------------------------------------------------------------
// Path helpers for nested attribute writes
// ---------------------------------------------------------------------------

/**
 * Parse a field path like "offers.price", "offers[0].price",
 * "offers.lowPrice", "offers.priceSpecification.price" into segments.
 *
 * Returns: string[] of property keys / array indices
 *   "offers.price"    -> ["offers", "price"]
 *   "offers[0].price" -> ["offers", "0", "price"]
 *   "price"           -> ["price"]
 */
function parseFieldPath(path) {
  if (!path.includes(".") && !path.includes("[")) return [path];
  const segments = [];
  let i = 0;
  while (i < path.length) {
    let j = i;
    while (j < path.length && path[j] !== "." && path[j] !== "[") j++;
    const prop = path.slice(i, j);
    if (prop) segments.push(prop);
    if (j >= path.length) break;
    if (path[j] === ".") {
      i = j + 1;
    } else if (path[j] === "[") {
      const close = path.indexOf("]", j);
      if (close === -1) { i = path.length; break; }
      segments.push(path.slice(j + 1, close));
      i = close + 1;
      if (i < path.length && path[i] === ".") i++;
    }
  }
  return segments;
}

/**
 * Set a value at a dotted / bracketed path in an object tree.
 * Creates intermediate objects/arrays as needed.
 * Returns a new tree; the original is not mutated.
 */
function setAtPath(obj, path, value) {
  const segments = parseFieldPath(path);
  if (segments.length === 0) return obj;
  return _setAtPath(obj, segments, value);
}

function _setAtPath(obj, segments, value) {
  if (segments.length === 0) return value;
  const [head, ...rest] = segments;
  const isArrayIndex = /^\d+$/.test(head);
  const existing = obj?.[head];
  const child = _setAtPath(
    existing !== null && typeof existing === "object" ? existing : (isArrayIndex ? [] : {}),
    rest,
    value,
  );
  if (Array.isArray(obj)) {
    const copy = [...obj];
    copy[Number(head)] = child;
    return copy;
  }
  const copy = { ...obj };
  copy[head] = child;
  return copy;
}

/**
 * Delete the value at a dotted path from an object tree.
 * Returns a new tree; the original is not mutated.
 */
function deleteAtPath(obj, path) {
  const segments = parseFieldPath(path);
  if (segments.length === 0) return obj;
  return _deleteAtPath(obj, segments);
}

function _deleteAtPath(obj, segments) {
  if (segments.length === 0) return obj;
  const [head, ...rest] = segments;
  if (!(head in (obj ?? {}))) return obj;
  if (rest.length === 0) {
    if (Array.isArray(obj)) {
      const copy = [...obj];
      copy.splice(Number(head), 1);
      return copy;
    }
    const copy = { ...obj };
    delete copy[head];
    return copy;
  }
  const nested = obj[head];
  if (nested === null || typeof nested !== "object") return obj;
  const updated = _deleteAtPath(nested, rest);
  if (Array.isArray(obj)) {
    const copy = [...obj];
    copy[Number(head)] = updated;
    return copy;
  }
  return { ...obj, [head]: updated };
}

/**
 * Clear all volatile field values from an entity's attributes and offers.
 * Returns a new entity object; the original is not mutated.
 */
function clearVolatileFields(entity) {
  if (!entity) return entity;
  const result = { ...entity };

  // Clear top-level volatile attributes
  if (result.attributes) {
    const attrs = { ...result.attributes };
    let cleared = false;
    for (const key of Object.keys(attrs)) {
      if (isVolatileField(key)) {
        delete attrs[key];
        cleared = true;
      }
    }
    result.attributes = cleared ? attrs : result.attributes;
  }

  // Clear offers volatiles
  const offers = result.attributes?.offers ?? result.offers;
  if (offers) {
    if (!Array.isArray(offers) && typeof offers === "object") {
      const cleaned = { ...offers };
      delete cleaned.price;
      delete cleaned.availability;
      delete cleaned.inventory;
      delete cleaned.lowPrice;
      delete cleaned.highPrice;
      if (cleaned.priceSpecification && typeof cleaned.priceSpecification === "object") {
        const ps = { ...cleaned.priceSpecification };
        delete ps.price;
        cleaned.priceSpecification = ps;
      }
      if (result.attributes) {
        result.attributes = { ...result.attributes, offers: cleaned };
      } else {
        result.offers = cleaned;
      }
    } else if (Array.isArray(offers)) {
      const cleaned = offers.map((o) => {
        if (!o || typeof o !== "object") return o;
        const c = { ...o };
        delete c.price;
        delete c.availability;
        delete c.inventory;
        delete c.lowPrice;
        delete c.highPrice;
        return c;
      });
      if (result.attributes) {
        result.attributes = { ...result.attributes, offers: cleaned };
      } else {
        result.offers = cleaned;
      }
    }
  }

  return result;
}

/**
 * Merge live values (per-entity Map<entityId, Map<field, value>>) into
 * entity attributes. When source is unavailable, volatile fields are cleared.
 *
 * Returns: hydrated entities array and the set of live field names used.
 */
function mergeLiveValues(entities, liveValues, sourceStatus) {
  const liveFieldNames = new Set();
  const hydratedEntities = entities.map((entity) => {
    if (!entity) return entity;
    const perEntity = liveValues.get(entity.id);
    const entityVolatiles = volatileFieldsForEntity(entity);

    // On outage: clear volatile fields, never serve cached values
    if (sourceStatus === "unavailable") {
      for (const fn of entityVolatiles) liveFieldNames.add(fn);
      return clearVolatileFields(entity);
    }

    // Merge per-entity live values
    if (!perEntity || perEntity.size === 0) {
      // No live values for this entity — still track its volatile field names
      for (const fn of entityVolatiles) liveFieldNames.add(fn);
      return entity;
    }

    let attrs = entity.attributes ? { ...entity.attributes } : {};
    let changed = false;

    for (const [path, value] of perEntity) {
      liveFieldNames.add(path);
      const segments = parseFieldPath(path);

      if (segments.length === 1) {
        // Top-level attribute: write directly
        attrs[path] = value;
        changed = true;
      } else {
        // Nested path (e.g. "offers.price", "offers[0].price", "offers.lowPrice")
        // Only write through attrs, never add a new top-level key
        const root = segments[0];
        const existing = attrs[root];
        if (existing !== null && typeof existing === "object") {
          const restPath = segments.slice(1).reduce((acc, seg, idx) => {
            if (/^\d+$/.test(seg)) return acc + `[${seg}]`;
            return acc + (idx === 0 ? seg : `.${seg}`);
          }, "");
          attrs[root] = setAtPath(existing, restPath, value);
          changed = true;
        }
      }
    }

    // Also merge simple offer-level fields into attrs.offers for backward compat
    // when offers is a single object (not array). This is now handled by the
    // path-based writes above (offers.price writes to attrs.offers.price).
    // Keep this for fields the adapter returns without "offers." prefix.
    if (attrs.offers && !Array.isArray(attrs.offers) && typeof attrs.offers === "object") {
      for (const [path, value] of perEntity) {
        const segments = parseFieldPath(path);
        if (segments.length === 1) {
          // Top-level field that might belong in offers
          if (path === "price" || path === "availability" || path === "inventory") {
            // Only if offers has this field (it was there before hydration)
            if (path in attrs.offers) {
              attrs.offers = { ...attrs.offers, [path]: value };
              changed = true;
            }
          }
        }
      }
    }

    if (!changed) return entity;
    return { ...entity, attributes: attrs };
  });

  return { hydratedEntities, liveFieldNames };
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
 * When the source is unavailable, volatile fields are CLEARED from entities
 * (never served from cache). The caller sees sourceStatus="unavailable".
 *
 * Optional `entityIds` and `fieldNames` filter the returned graph to only
 * the requested entities and fields.
 *
 * Returns:
 *   { graph, version, publishedAt, hydratedAt, liveFields: string[],
 *     sourceStatus: "available"|"degraded"|"unavailable" }
 *
 * When the adapter is absent or the graph has no entities, returns the
 * raw graph with an empty liveFields set.
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
  let entities = graph.entities ?? [];
  const assertions = graph.assertions ?? [];

  // Filter to requested entities
  if (entityIds && entityIds.length > 0) {
    const idSet = new Set(entityIds);
    entities = entities.filter((e) => idSet.has(e.id));
  }

  if (entities.length === 0 || !liveSourceAdapter) {
    const status = liveSourceAdapter ? liveSourceAdapter.sourceStatus() : "unavailable";
    // If source is unavailable and we have entities, clear volatiles
    const clearedEntities = status === "unavailable"
      ? entities.map((e) => clearVolatileFields(e))
      : entities;
    return {
      graph: { ...graph, entities: clearedEntities },
      version,
      publishedAt,
      hydratedAt: new Date().toISOString(),
      liveFields: [],
      sourceStatus: status,
    };
  }

  // Collect all entity ids and their volatile field names
  const ids = entities.map((e) => e.id).filter(Boolean);
  const allLiveFieldNames = new Set();
  for (const entity of entities) {
    for (const fn of volatileFieldsForEntity(entity)) {
      allLiveFieldNames.add(fn);
    }
  }

  // Also collect volatile predicates from assertions
  for (const a of assertions) {
    if (isVolatileField(a.predicate)) {
      allLiveFieldNames.add(a.predicate);
    }
  }

  let liveValues = new Map();
  let sourceStatus = liveSourceAdapter.sourceStatus();

  if (allLiveFieldNames.size > 0 && ids.length > 0 && sourceStatus !== "unavailable") {
    try {
      liveValues = await liveSourceAdapter.fetchLive(
        commerceContext ?? {},
        ids,
        [...allLiveFieldNames],
      );
    } catch {
      // Transport failure → treat as unavailable for this hydration
      sourceStatus = "unavailable";
    }
  }

  // Merge per-entity live values (or clear volatiles on outage)
  const { hydratedEntities, liveFieldNames } = mergeLiveValues(entities, liveValues, sourceStatus);

  // Filter to requested fields
  let finalEntities = hydratedEntities;
  if (fieldNames && fieldNames.length > 0) {
    const fieldSet = new Set(fieldNames);
    finalEntities = hydratedEntities.map((entity) => {
      if (!entity.attributes) return entity;
      const filtered = {};
      for (const [k, v] of Object.entries(entity.attributes)) {
        if (fieldSet.has(k)) filtered[k] = v;
      }
      return { ...entity, attributes: filtered };
    });
  }

  const hydratedGraph = {
    ...graph,
    entities: finalEntities,
  };

  return {
    graph: hydratedGraph,
    version,
    publishedAt,
    hydratedAt: new Date().toISOString(),
    liveFields: [...liveFieldNames],
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
 * the action MUST be re-attempted with the new values.
 *
 * Returns:
 *   { ok: boolean, mustRetry: boolean, changedFields: Map<string, {callerVersion, live}>,
 *     sourceStatus: string, revalidatedAt: string }
 *
 * When ok=false the action is blocked (source unavailable, no graph, etc.).
 * When mustRetry=true the action must be re-attempted with the live values.
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

  // Read current graph
  const result = await graphStore.readCurrentGraph(caller, namespace);

  if (!result || result.graph === null) {
    return {
      ok: false,
      mustRetry: false,
      reason: result?.reason ?? "no graph published",
      revalidatedAt,
    };
  }

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

  if (allLiveFieldNames.size === 0) {
    return { ok: true, mustRetry: false, changedFields: new Map(), revalidatedAt };
  }

  // Check source outage
  const sourceStatus = liveSourceAdapter.sourceStatus();
  if (sourceStatus === "unavailable") {
    return {
      ok: false,
      mustRetry: false,
      reason: "live source unavailable — cannot revalidate",
      sourceStatus,
      revalidatedAt,
    };
  }

  // Check action dependencies against source versions
  if (actionDependencies && actionDependencies.length > 0) {
    const outageCheck = disabledByOutage(
      actionDependencies.map((dep) => createSourceVersion({ sourceId: dep, sourceStatus })),
      actionDependencies,
    );
    if (outageCheck.disabled) {
      return {
        ok: false,
        mustRetry: false,
        reason: outageCheck.reason,
        sourceStatus,
        revalidatedAt,
      };
    }
  }

  // Fetch live values per entity
  let liveValues;
  try {
    liveValues = await liveSourceAdapter.fetchLive(
      commerceContext ?? {},
      ids,
      [...allLiveFieldNames],
    );
  } catch {
    return {
      ok: false,
      mustRetry: false,
      reason: "live source fetch failed — cannot revalidate",
      sourceStatus: "unavailable",
      revalidatedAt,
    };
  }

  // Compare expectedVersions against live values (TOCTOU guard)
  const changedFields = new Map();
  const ev = expectedVersions ?? new Map();

  for (const entity of entities) {
    if (!entity || !entity.id) continue;
    const perEntityLive = liveValues.get(entity.id);
    const perEntityExpected = ev.get(entity.id);

    if (!perEntityLive) continue;

    for (const [field, liveVal] of perEntityLive) {
      const expectedVersion = perEntityExpected?.get(field);
      if (expectedVersion !== undefined) {
        // Compare against caller's expected version
        const liveVersion = typeof liveVal === "object" && liveVal !== null
          ? JSON.stringify(liveVal)
          : String(liveVal);
        const expectedStr = typeof expectedVersion === "object" && expectedVersion !== null
          ? JSON.stringify(expectedVersion)
          : String(expectedVersion);

        if (liveVersion !== expectedStr) {
          changedFields.set(`${entity.id}:${field}`, {
            callerVersion: expectedVersion,
            live: liveVal,
          });
        }
      } else {
        // No expected version provided for this field — report as changed (pessimistic)
        changedFields.set(`${entity.id}:${field}`, {
          callerVersion: undefined,
          live: liveVal,
        });
      }
    }
  }

  return {
    ok: true,
    mustRetry: changedFields.size > 0,
    changedFields,
    sourceStatus,
    revalidatedAt,
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
 * These correspond to the volatile commerce fields from the ticket:
 * price, availability, inventory, delivery estimate.
 *
 * Note: schema.org Products typically carry price and availability inside
 * `offers` (an object, array of variants, or AggregateOffer). The hydrate and
 * revalidateForAction functions walk offers to detect these fields.
 */
export const VOLATILE_FIELD_NAMES = Object.freeze([
  "price",
  "availability",
  "inventory",
  "delivery_estimate",
  "deliveryEstimate",
]);

const VOLATILE_FIELD_SET = new Set(VOLATILE_FIELD_NAMES);

/**
 * Check whether a field name is volatile (must be fetched live).
 */
export function isVolatileField(fieldName) {
  return VOLATILE_FIELD_SET.has(fieldName);
}
