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
// Live-source adapter interface (contract only — adapter is injected)
// ---------------------------------------------------------------------------

/**
 * A live-source adapter MUST fulfil this interface. No concrete implementation
 * is provided here; callers inject an adapter per authoritative source.
 *
 *   fetchLive(commerceContext, fieldNames) → Promise<Map<string, any>>
 *
 *   - commerceContext: a CommerceContext (created by createCommerceContext)
 *   - fieldNames: string[] of field names to fetch (e.g. ["price", "inventory"])
 *   - Returns: Map keyed by field name → live value
 *     Fields that are unknown or unavailable are simply absent from the Map.
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
// hydrate — read graph through graph-store, overlay live values
// ---------------------------------------------------------------------------

/**
 * Hydrate the caller's view of the published graph.
 *
 * Reads the graph through graph-store and resolves every entity whose
 * freshness class is `live_required` against the live-source adapter.
 * The returned graph has live values merged into the entity attributes;
 * cached values are preserved for `static` and `stale_readable` entities.
 *
 * Returns:
 *   { graph, version, publishedAt, hydratedAt, liveFields: string[],
 *     sourceStatus: "available"|"degraded"|"unavailable" }
 *
 * When the adapter is absent or the graph has no entities, returns the
 * raw graph with an empty liveFields set.
 */
export async function hydrate(caller, namespace, graphStore, liveSourceAdapter, commerceContext) {
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
  const entities = graph.entities ?? [];
  const assertions = graph.assertions ?? [];

  if (entities.length === 0 || !liveSourceAdapter) {
    const status = liveSourceAdapter ? liveSourceAdapter.sourceStatus() : "unavailable";
    return {
      graph,
      version,
      publishedAt,
      hydratedAt: new Date().toISOString(),
      liveFields: [],
      sourceStatus: status,
    };
  }

  // Collect field names that are live_required from entity attributes
  const liveFieldNames = new Set();

  for (const entity of entities) {
    if (!entity.attributes) continue;
    for (const [key] of Object.entries(entity.attributes)) {
      if (isVolatileField(key)) {
        liveFieldNames.add(key);
      }
    }
  }

  // Also collect volatile predicates from assertions
  for (const a of assertions) {
    if (isVolatileField(a.predicate)) {
      liveFieldNames.add(a.predicate);
    }
  }

  let liveValues = new Map();
  let sourceStatus = liveSourceAdapter.sourceStatus();

  if (liveFieldNames.size > 0 && sourceStatus !== "unavailable") {
    try {
      liveValues = await liveSourceAdapter.fetchLive(
        commerceContext ?? {},
        [...liveFieldNames],
      );
    } catch {
      // Transport failure → treat as unavailable for this hydration
      sourceStatus = "unavailable";
    }
  }

  // Build hydrated graph: merge live values into entity attributes
  const hydratedEntities = entities.map((entity) => {
    if (!entity.attributes) return entity;
    const attrs = { ...entity.attributes };
    let changed = false;
    for (const key of liveFieldNames) {
      if (liveValues.has(key)) {
        attrs[key] = liveValues.get(key);
        changed = true;
      }
    }
    if (!changed) return entity;
    return { ...entity, attributes: attrs };
  });

  const hydratedGraph = {
    ...graph,
    entities: hydratedEntities,
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
 * Reads the current graph via graph-store, extracts every live_required
 * field, fetches current values from the adapter, and compares them
 * against the cached graph values. If any live field has changed,
 * the action MUST be re-attempted with the new values.
 *
 * Returns:
 *   { ok: boolean, mustRetry: boolean, changedFields: Map<string, {cached, live}>,
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
  const assertions = graph.assertions ?? [];

  // Collect live_required fields
  const liveFieldNames = new Set();
  for (const entity of entities) {
    if (!entity.attributes) continue;
    for (const [key] of Object.entries(entity.attributes)) {
      if (isVolatileField(key)) {
        liveFieldNames.add(key);
      }
    }
  }
  for (const a of assertions) {
    if (isVolatileField(a.predicate)) {
      liveFieldNames.add(a.predicate);
    }
  }

  if (liveFieldNames.size === 0) {
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

  // Fetch live values
  let liveValues;
  try {
    liveValues = await liveSourceAdapter.fetchLive(
      commerceContext ?? {},
      [...liveFieldNames],
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

  // Compare cached vs live
  const changedFields = new Map();
  for (const entity of entities) {
    if (!entity.attributes) continue;
    for (const key of liveFieldNames) {
      if (liveValues.has(key)) {
        const liveVal = liveValues.get(key);
        const cachedVal = entity.attributes[key];
        // Deep-strict comparison for objects, shallow for primitives
        const changed = typeof liveVal === "object" && liveVal !== null
          ? JSON.stringify(liveVal) !== JSON.stringify(cachedVal)
          : liveVal !== cachedVal;
        if (changed) {
          changedFields.set(key, { cached: cachedVal, live: liveVal });
        }
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
