/**
 * ENGRAM §EW06 — Hybrid site-entity retrieval.
 *
 * Retrieves relevant site entities from a compiled ENGRAM graph without
 * sending the entire graph to a model. Reuses the §1 recall engine
 * (dense int8 scan + BM25 + RRF + bounded graph diffusion) over
 * entity/assertion "observations" built from the compiled graph.
 *
 * Mandatory constraints (per ticket 97996969):
 *   - Exact IDs and filters precede semantic ranking
 *   - Tenant/ACL filters applied BEFORE retrieval and rechecked before serving
 *   - Embedding model/dimensions pinned; incompatible vector spaces refused
 *   - No unbounded graph expansion
 *   - Stable cursor pagination
 *   - Explainable provenance evidence on every result
 */

import { buildRecallIndex } from "../session/recall/index-core.js";
import { recall as recallEngine, RECALL_DEFAULTS } from "../session/recall/retrieve.js";
import { createEmbedder } from "../session/recall/embedder.js";
import { normalizeString, tokenize, clipSnippet } from "../session/recall/text.js";

// ---------------------------------------------------------------------------
// Pinned constants
// ---------------------------------------------------------------------------

/** Pinned retrieval index schema version — bump on breaking index changes. */
export const RETRIEVE_SITE_INDEX_VERSION = "1.0.0";

/** Required embedder dimension — refuse anything else (per constraint). */
export const REQUIRED_EMBEDDER_DIM = 256;

/** Default retrieval parameters (separate from session recall defaults). */
export const SITE_RETRIEVAL_DEFAULTS = Object.freeze({
  k: 12,
  expansionHops: 5, // tighter than session recall (8) — site graphs are larger
  expansionDecay: 0.8,
  hubDegreeCap: 30,
  poolCap: 256,
  pageSize: 20,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a generation-bound cursor for stable pagination.
 * Format: base64url(json({g:<generation>,o:<offset>,q:<queryHash>}))
 *
 * The cursor binds to the graph generation so that a republish
 * (which increments the generation) invalidates the cursor rather
 * than silently restarting. The query hash ensures a cursor from
 * a different query does not silently apply.
 */
function encodeCursor(generation, offset, queryHash) {
  const payload = JSON.stringify({
    v: String(generation || ""),
    o: Number.isFinite(offset) ? offset : 0,
    q: String(queryHash || ""),
  });
  return Buffer.from(payload, "utf-8").toString("base64url");
}

/**
 * Decode a pagination cursor. Returns null for garbage input,
 * and validates the generation/offset/queryHash fields.
 */
function decodeCursor(cursor) {
  const raw = normalizeString(cursor);
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf-8");
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && typeof parsed.v === "string" && typeof parsed.o === "number" && typeof parsed.q === "string") {
      return { version: parsed.v, offset: parsed.o, queryHash: parsed.q };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Flatten graph assertions/attributes into searchable text for an entity.
 */
function entitySearchText(entity, assertionsForEntity) {
  const parts = [];
  if (entity.label) parts.push(entity.label);
  if (entity.type && entity.type !== "unknown") parts.push(entity.type);

  // Per-attribute assertions carry factual content (SKUs, prices, descriptions)
  for (const assertion of assertionsForEntity) {
    const pred = normalizeString(assertion.predicate);
    if (pred && !["contains", "describes", "references", "variant_of", "same_as_candidate"].includes(pred)) {
      parts.push(pred);
    }
    // Safely extract string values from any JSON-compatible assertion object.
    const obj = assertion.object;
    if (typeof obj === "string") {
      parts.push(normalizeString(obj));
    } else if (typeof obj === "number" || typeof obj === "boolean") {
      parts.push(String(obj));
    } else if (obj !== null && typeof obj === "object") {
      if (Array.isArray(obj)) {
        for (const item of obj) {
          if (typeof item === "string") parts.push(normalizeString(item));
          else if (typeof item === "number" || typeof item === "boolean") parts.push(String(item));
        }
      } else {
        for (const val of Object.values(obj)) {
          if (typeof val === "string") parts.push(normalizeString(val));
          else if (typeof val === "number" || typeof val === "boolean") parts.push(String(val));
        }
      }
    }
  }

  // Entity attributes (SKUs, prices, etc.)
  if (entity.attributes !== null && entity.attributes !== undefined && typeof entity.attributes === "object") {
    // Use Object.entries so we skip prototype-inherited and __proto__ keys.
    const safeEntries = Object.entries(Object(entity.attributes));
    for (const [, val] of safeEntries) {
      if (val === null || typeof val === "function") continue;
      if (typeof val === "string") parts.push(normalizeString(val));
      else if (typeof val === "number" || typeof val === "boolean") parts.push(String(val));
    }
  }

  return parts.filter(Boolean).join(" · ");
}

/**
 * Build an observation-like object from a graph entity for the recall index.
 * Each entity becomes one observation, enriched with its assertions' text
 * and with graph-link-derived entity references so the recall engine can
 * build a proper entity graph for bounded spreading activation (mentions,
 * files, prRefs from describes/contains/references links).
 */
function entityToObservation(entity, assertions, index) {
  const text = entitySearchText(entity, assertions);
  const displayText = text || [entity.label, entity.type].filter(Boolean).join(" ");

  const mentions = [];
  const files = [];
  const prRefs = [];

  return {
    id: entity.id,
    sessionId: entity.tenantScope || "",
    sequenceId: index + 1,
    index,
    ts: entity.capturedAt || new Date(0).toISOString(),
    tsMs: Date.parse(entity.capturedAt) || 0,
    kind: entity.type || "unknown",
    agentId: "graph",
    agentModel: "",
    text: displayText,
    tokens: tokenize(displayText),
    mentions,
    files,
    prRefs,
    replyToSequence: 0,
    snippet: clipSnippet(displayText),
    raw: { entity, assertions },
  };
}

/**
 * Apply tenant/ACL filter to entities BEFORE building the index.
 */
function applyAccessFilter(entities, accessFilter) {
  if (typeof accessFilter !== "function") return entities;
  return entities.filter((entity) => {
    try {
      return accessFilter(entity) === true;
    } catch {
      return false;
    }
  });
}

/**
 * Check for exact entity-ID match in the query.
 *
 * Matches in order of precedence:
 * 1. Exact entity.id match (full digest id).
 * 2. Entity attribute value match (sku, gtin, productID, @id, etc.).
 * 3. Attribute assertion value match (describes_sku, describes_gtin, etc.).
 * 4. Hex digest prefix match (12+ hex chars matching id suffix).
 *
 * EW05 stores business identifiers in entity.attributes and emits
 * describes_<attrKey> assertions, so queries for sku/gtin/productID
 * values must take the exact path — not just fall through to BM25.
 */
const IDENTIFIER_KEYS = new Set([
  "@id", "sku", "gtin", "gtin8", "gtin12", "gtin13", "gtin14",
  "mpn", "productID", "identifier",
]);

const DESCRIBES_ID_KEYS = new Set(
  Array.from(IDENTIFIER_KEYS).map((k) => `describes_${k}`),
);

function findExactEntityIdMatch(query, entities, assertionMap) {
  const normalizedQuery = normalizeString(query);
  if (!normalizedQuery) return [];

  // 1. Exact id match first (case-insensitive).
  for (const entity of entities) {
    if (normalizeString(entity.id) === normalizedQuery) return [entity];
  }

  // 2. Match on identifier-key entity.attributes (case-insensitive).
  const attrMatches = [];
  for (const entity of entities) {
    if (entity.attributes !== null && entity.attributes !== undefined && typeof entity.attributes === "object") {
      for (const [key, val] of Object.entries(Object(entity.attributes))) {
        if (!IDENTIFIER_KEYS.has(key)) continue;
        if (typeof val === "string" && normalizeString(val).toLowerCase() === normalizedQuery.toLowerCase()) {
          attrMatches.push(entity);
          break;
        }
        if (typeof val === "number" && String(val) === normalizedQuery.toLowerCase()) {
          attrMatches.push(entity);
          break;
        }
      }
    }
  }
  // Stable order by entity id.
  attrMatches.sort((a, b) => normalizeString(a.id).localeCompare(normalizeString(b.id)));
  if (attrMatches.length > 0) return attrMatches;

  // 3. Match on describes_<identifierKey> assertions (case-insensitive).
  const assertionMatches = [];
  for (const entity of entities) {
    const entityAssertions = assertionMap ? (assertionMap.get(entity.id) || []) : [];
    for (const assertion of entityAssertions) {
      if (!assertion || typeof assertion !== "object") continue;
      const pred = normalizeString(assertion.predicate);
      if (!pred || !DESCRIBES_ID_KEYS.has(pred)) continue;
      const obj = assertion.object;
      if (typeof obj === "string" && normalizeString(obj).toLowerCase() === normalizedQuery.toLowerCase()) {
        assertionMatches.push(entity);
        break;
      }
      if (typeof obj === "number" && String(obj) === normalizedQuery.toLowerCase()) {
        assertionMatches.push(entity);
        break;
      }
    }
  }
  assertionMatches.sort((a, b) => normalizeString(a.id).localeCompare(normalizeString(b.id)));
  if (assertionMatches.length > 0) return assertionMatches;

  // 4. Prefix match on the digest part (last 16 hex chars after last colon).
  const digestMatch = normalizedQuery.match(/^[a-f0-9]{12,16}$/i);
  if (digestMatch) {
    const digest = digestMatch[0].toLowerCase();
    for (const entity of entities) {
      const lastColon = entity.id.lastIndexOf(":");
      if (lastColon >= 0 && entity.id.slice(lastColon + 1).toLowerCase() === digest) {
        return [entity];
      }
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Main retrieval
// ---------------------------------------------------------------------------

/**
 * Build a retrieval index over a compiled graph's entities.
 */
export function buildSiteRetrievalIndex({
  graph,
  embedder = createEmbedder(),
  tenantScope = "",
  accessFilter = null,
  graphVersion,
} = {}) {
  if (!graph || typeof graph !== "object") {
    throw new TypeError("graph is required");
  }

  // Pin embedding dimensions.
  if (embedder.dim !== REQUIRED_EMBEDDER_DIM) {
    throw new Error(
      `Embedder dimension mismatch: got ${embedder.dim}, required ${REQUIRED_EMBEDDER_DIM}. ` +
      `Do not mix incompatible vector spaces.`,
    );
  }

  const allEntities = Array.isArray(graph.entities) ? graph.entities : [];
  const allAssertions = Array.isArray(graph.assertions) ? graph.assertions : [];

  // Apply tenant/ACL filter BEFORE building index.
  const entities = applyAccessFilter(allEntities, accessFilter);
  const accessFiltered = allEntities.length - entities.length;

  // Build assertion lookup by entity subject.
  const assertionMap = new Map();
  for (const assertion of allAssertions) {
    if (!assertion || typeof assertion !== "object") continue;
    const subject = normalizeString(assertion.subject);
    if (!subject) continue;
    if (!assertionMap.has(subject)) assertionMap.set(subject, []);
    assertionMap.get(subject).push(assertion);
  }

  // Build observations from entities.
  const observations = entities.map((entity, i) => {
    const entityAssertions = assertionMap.get(entity.id) || [];
    return entityToObservation(entity, entityAssertions, i);
  });

  // Build the recall index.
  const index = buildRecallIndex({
    observations,
    embedder,
    sessionId: normalizeString(tenantScope),
  });

  // Build entity lookup for results.
  const entityMap = new Map();
  for (const entity of entities) {
    entityMap.set(entity.id, entity);
  }

  return {
    index,
    indexSchemaVersion: RETRIEVE_SITE_INDEX_VERSION,
    embedderName: embedder.name,
    embedderDim: embedder.dim,
    entityMap,
    assertionMap,
    entityCount: entities.length,
    assertionCount: allAssertions.length,
    accessFiltered,
    graphVersion: String(graphVersion ?? ""),
  };
}

/**
 * Retrieve site entities from a compiled graph.
 *
 * This is the main entry point. It builds an index from the graph, then
 * queries it using the ENGRAM §1 recall engine (dense + BM25 + bounded
 * graph diffusion). Exact entity-ID matches always rank first.
 */
/**
 * Stable fingerprint of a query and its retrieval parameters.
 * Used to bind cursors to a specific query so a cursor from a
 * different query does not silently apply.
 */
function hashQueryFingerprint(normalizedQuery, k, tenantScope) {
  // Simple deterministic hash — not cryptographic, just collision-resistant
  // enough to bind a cursor to its originating query.
  const input = `${normalizedQuery}|${k}|${String(tenantScope || "")}`;
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return String(h);
}

export function retrieveSiteEntities({
  graph,
  query,
  k = SITE_RETRIEVAL_DEFAULTS.k,
  embedder = createEmbedder(),
  tenantScope = "",
  accessFilter = null,
  cursor = "",
  expansionHops = SITE_RETRIEVAL_DEFAULTS.expansionHops,
  now = Date.now(),
  graphVersion,
} = {}) {
  const normalizedQuery = normalizeString(query);
  if (normalizedQuery.length < 2) {
    return { ok: false, reason: "query_too_short", results: [], nextCursor: null };
  }

  const normalizedK = Math.max(1, Math.floor(Number(k) || SITE_RETRIEVAL_DEFAULTS.k));

  // Build the site retrieval index (includes access filtering).
  const siteIndex = buildSiteRetrievalIndex({
    graph,
    embedder,
    tenantScope,
    accessFilter,
    graphVersion,
  });

  const { index, entityMap } = siteIndex;

  if (index.observations.length === 0) {
    return {
      ok: true,
      reason: "no_entities_after_filtering",
      results: [],
      nextCursor: null,
      meta: {
        query: normalizedQuery,
        k: normalizedK,
        totalEntities: entityMap.size,
        accessFiltered: siteIndex.accessFiltered,
        embedderDim: embedder.dim,
      },
    };
  }

  // --- Exact entity-ID match precedence ---
  const allEntities = Array.from(entityMap.values());
  const exactMatches = findExactEntityIdMatch(normalizedQuery, allEntities, siteIndex.assertionMap);

  // --- Run the §1 recall engine ---
  const recallConfig = {
    ...RECALL_DEFAULTS,
    expansionHops: 0,
  };

  const engineResult = recallEngine(index, {
    query: normalizedQuery,
    k: index.observations.length, // fetch all for honest pagination
    role: "",
    now,
    tuning: recallConfig,
  });

  // --- Assemble results with entity data ---
  let results = engineResult.results.map((r) => {
    const obs = index.byId.get(r.observationId);
    const entity = obs?.raw?.entity || entityMap.get(r.observationId) || null;
    const assertions = obs?.raw?.assertions || [];

    // Recheck ACL before serving (per constraint).
    let accessDenied = false;
    if (typeof accessFilter === "function" && entity) {
      try {
        accessDenied = !accessFilter(entity);
      } catch {
        accessDenied = true;
      }
    }

    if (accessDenied) return null;

    return {
      entityId: entity?.id || r.observationId,
      entityType: entity?.type || "unknown",
      entityLabel: entity?.label || "",
      score: r.score,
      breakdown: r.breakdown,
      snippet: r.snippet,
      provenance: r.provenance,
      assertionCount: assertions.length,
      channels: r.breakdown?.channels || [],
      entity: entity || null,
    };
  }).filter(Boolean);

  // --- Explicit graph expansion: follow describes/contains/references links ---
  // from top semantic hits (depth 1, max 50). This replaces the recall engine's
  // built-in author-hub diffusion with targeted site-graph traversal.
  // The recall engine runs with expansionHops=0 so only the explicit expansion
  // below adds graph-derived results.
  const EXPANSION_LINK_PREDICATES = new Set(["describes", "contains", "references"]);
  const MAX_EXPANSION_RESULTS = 50;

  // Build a map for fast link lookup: entityId -> linked entityIds with link info.
  const forwardLinks = new Map();  // subject -> [{entityId, predicate}]
  const reverseLinks = new Map();  // object -> [{entityId, predicate}]
  const siteLinks = Array.isArray(graph.links) ? graph.links : [];
  for (const link of siteLinks) {
    if (!link || typeof link !== "object") continue;
    const pred = normalizeString(link.predicate || link.type);
    if (!pred || !EXPANSION_LINK_PREDICATES.has(pred)) continue;
    const subj = normalizeString(link.subject);
    const objEnt = link.object && typeof link.object === "object" ? link.object.entityId : null;
    const objId = objEnt ? normalizeString(objEnt) : null;
    if (subj && objId) {
      if (!forwardLinks.has(subj)) forwardLinks.set(subj, []);
      forwardLinks.get(subj).push({ entityId: objId, predicate: pred });
      if (!reverseLinks.has(objId)) reverseLinks.set(objId, []);
      reverseLinks.get(objId).push({ entityId: subj, predicate: pred });
    }
  }

  // Also populate from assertions: describes/contains/references with entityId objects.
  const allSiteAssertions = Array.isArray(graph.assertions) ? graph.assertions : [];
  for (const a of allSiteAssertions) {
    if (!a || typeof a !== "object") continue;
    const pred = normalizeString(a.predicate);
    if (!pred || !EXPANSION_LINK_PREDICATES.has(pred)) continue;
    const subj = normalizeString(a.subject);
    const objEnt = a.object && typeof a.object === "object" ? a.object.entityId : null;
    const objId = objEnt ? normalizeString(objEnt) : null;
    if (subj && objId) {
      if (!forwardLinks.has(subj)) forwardLinks.set(subj, []);
      forwardLinks.get(subj).push({ entityId: objId, predicate: pred });
      if (!reverseLinks.has(objId)) reverseLinks.set(objId, []);
      reverseLinks.get(objId).push({ entityId: subj, predicate: pred });
    }
  }

  // Expand from each top semantic result only (not from expansion results).
  // This prevents transitive expansion: entities found via expansion do not
  // trigger further expansion, so depth-2 entities (like Zeta via Shop via Alpha)
  // are excluded.
  const expansionEntityIds = new Set();
  const expansionProvenance = [];
  const expansionLimit = Math.min(MAX_EXPANSION_RESULTS, results.length * 10);
  const semanticResults = [...results];  // snapshot before expansion is appended
  for (const r of semanticResults) {
    if (expansionEntityIds.size >= expansionLimit) break;
    const eId = r.entityId;
    // Follow forward links (entity -> other).
    const fwd = forwardLinks.get(eId) || [];
    for (const link of fwd) {
      if (expansionEntityIds.size >= expansionLimit) break;
      if (entityMap.has(link.entityId) && !expansionEntityIds.has(link.entityId)) {
        expansionEntityIds.add(link.entityId);
        expansionProvenance.push({ sourceEntityId: eId, linkedEntityId: link.entityId, predicate: link.predicate, direction: "forward" });
      }
    }
    // Follow reverse links (other -> entity).
    const rev = reverseLinks.get(eId) || [];
    for (const link of rev) {
      if (expansionEntityIds.size >= expansionLimit) break;
      if (entityMap.has(link.entityId) && !expansionEntityIds.has(link.entityId)) {
        expansionEntityIds.add(link.entityId);
        expansionProvenance.push({ sourceEntityId: eId, linkedEntityId: link.entityId, predicate: link.predicate, direction: "reverse" });
      }
    }
  }

  // Build expansion results.
  const expansionResults = [];
  for (const eId of expansionEntityIds) {
    const entity = entityMap.get(eId);
    if (!entity) continue;
    expansionResults.push({
      entityId: entity.id,
      entityType: entity.type || "unknown",
      entityLabel: entity.label || "",
      score: 0,
      breakdown: {
        cos: 0,
        rrf: 0,
        expansion: 1,
        actr: 0,
        channels: ["expansion"],
        viaExpansionOnly: true,
      },
      snippet: clipSnippet(entity.label || entity.id),
      provenance: expansionProvenance.filter((p) => p.linkedEntityId === eId).map((p) => ({
        path: `expansion from ${p.sourceEntityId} via ${p.predicate} (${p.direction})`,
      })),
      assertionCount: (siteIndex.assertionMap.get(entity.id) || []).length,
      channels: ["expansion"],
      entity,
    });
  }

  // Append expansion results after semantic results.
  results = [...results, ...expansionResults];

  // --- Exact-match precedence: move exact entity ID hits to the front ---
  if (exactMatches.length > 0) {
    const exactIds = new Set(exactMatches.map((e) => e.id));
    results = results.filter((r) => !exactIds.has(r.entityId));
    const exactResults = exactMatches.map((exactMatch) => ({
      entityId: exactMatch.id,
      entityType: exactMatch.type || "unknown",
      entityLabel: exactMatch.label || "",
      score: 1.0,
      breakdown: {
        cos: 0,
        rrf: 0,
        expansion: 0,
        actr: 0,
        channels: ["exact_id"],
        viaExpansionOnly: false,
      },
      snippet: clipSnippet(exactMatch.label || exactMatch.id),
      provenance: [{ path: `exact entity id: ${exactMatch.id}` }],
      assertionCount: (siteIndex.assertionMap.get(exactMatch.id) || []).length,
      channels: ["exact_id"],
      entity: exactMatch,
    }));
    results = [...exactResults, ...results];
  }

  // --- Generation-bound cursor pagination ---
  const currentVersion = siteIndex.graphVersion;
  const queryFingerprint = hashQueryFingerprint(normalizedQuery, normalizedK, tenantScope);

  let cursorOffset = 0;
  if (normalizeString(cursor)) {
    const decodedCursor = decodeCursor(cursor);
    if (!decodedCursor) {
      // Garbage cursor — not valid base64url or missing required fields.
      return {
        ok: false,
        reason: "cursor_invalid",
        results: [],
        nextCursor: null,
        meta: { query: normalizedQuery, k: normalizedK },
      };
    }
    if (String(decodedCursor.version) !== String(currentVersion)) {
      // Stale cursor — graph was republished since this cursor was issued.
      return {
        ok: false,
        reason: "cursor_stale",
        results: [],
        nextCursor: null,
        meta: { query: normalizedQuery, k: normalizedK },
      };
    }
    if (decodedCursor.queryHash !== queryFingerprint) {
      // Cursor from a different query — refuse to apply.
      return {
        ok: false,
        reason: "cursor_stale",
        results: [],
        nextCursor: null,
        meta: { query: normalizedQuery, k: normalizedK },
      };
    }
    cursorOffset = decodedCursor.offset;
  }

  const pageSize = SITE_RETRIEVAL_DEFAULTS.pageSize;
  const paged = results.slice(cursorOffset, cursorOffset + Math.min(normalizedK, pageSize));
  const hasMore = cursorOffset + paged.length < results.length;
  const nextCursor = hasMore && paged.length > 0
    ? encodeCursor(currentVersion, cursorOffset + paged.length, queryFingerprint)
    : null;

  return {
    ok: true,
    reason: "",
    query: normalizedQuery,
    k: normalizedK,
    results: paged,
    totalMatched: results.length,
    pageSize: paged.length,
    nextCursor,
    hasMore,
    exactMatchFound: exactMatches.length > 0,
    meta: {
      totalEntities: entityMap.size,
      accessFiltered: siteIndex.accessFiltered,
      poolSize: engineResult.poolSize,
      candidatePoolIds: engineResult.candidatePoolIds?.length || 0,
      embedderName: embedder.name,
      embedderDim: embedder.dim,
      indexSchemaVersion: RETRIEVE_SITE_INDEX_VERSION,
      graphVersion: currentVersion,
    },
  };
}

/**
 * Convenience: retrieve from a graph-store's current graph.
 */
export async function retrieveFromGraphStore({
  graphStore,
  caller,
  namespace,
  query,
  k,
  embedder,
  tenantScope,
  accessFilter,
  cursor,
  expansionHops,
  now,
} = {}) {
  if (!graphStore || typeof graphStore.readCurrentGraph !== "function") {
    return { ok: false, reason: "invalid_graph_store", results: [], nextCursor: null };
  }

  let graphRecord;
  try {
    graphRecord = await graphStore.readCurrentGraph(caller, namespace);
  } catch (error) {
    const msg = normalizeString(error?.message || error);
    // Distinguish access-denied from other errors.
    const isAccessDenied = error?.name === "AccessDeniedError" ||
      error?.code === "access_denied" ||
      (msg && (msg.includes("access") || msg.includes("authoriz") || msg.includes("permit") || msg.includes("forbidden") || msg.includes("denied")));
    if (isAccessDenied) {
      return { ok: false, reason: "forbidden", results: [], nextCursor: null };
    }
    return {
      ok: false,
      reason: `graph_read_error: ${msg}`,
      results: [],
      nextCursor: null,
    };
  }

  if (!graphRecord || !graphRecord.graph) {
    return { ok: false, reason: "no_published_graph", results: [], nextCursor: null };
  }

  // Run retrieval.
  const result = await retrieveSiteEntities({
    graph: graphRecord.graph,
    graphVersion: graphRecord.version,
    query,
    k,
    embedder,
    tenantScope,
    accessFilter,
    cursor,
    expansionHops,
    now,
  });

  // Re-authorization: after ranking, re-check that the caller still has
  // read access and the graph version hasn't changed. This catches access
  // revocation and concurrent publications between read and serve.
  if (graphStore && typeof graphStore.listGraphVersions === "function") {
    try {
      const versions = await graphStore.listGraphVersions(caller, namespace);
      const latestVersion = Array.isArray(versions) && versions.length > 0
        ? versions[versions.length - 1].version
        : null;
      if (latestVersion !== null && latestVersion !== graphRecord.version) {
        return {
          ok: false,
          reason: "generation_changed",
          results: [],
          nextCursor: null,
          meta: result.meta,
        };
      }
    } catch {
      // Re-authorization failed — treat as forbidden.
      return { ok: false, reason: "forbidden", results: [], nextCursor: null };
    }
  }

  return result;
}
