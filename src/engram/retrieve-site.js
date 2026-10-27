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
 * Build a stable cursor for pagination from entity id + score.
 * Format: base64url(json({e:<entityId>,s:<score>}))
 */
function encodeCursor(entityId, score) {
  const payload = JSON.stringify({ e: entityId, s: Number(score.toFixed(6)) });
  return Buffer.from(payload, "utf-8").toString("base64url");
}

/**
 * Decode a pagination cursor back to { entityId, score }.
 */
function decodeCursor(cursor) {
  const raw = normalizeString(cursor);
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf-8");
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed.e === "string" && typeof parsed.s === "number") {
      return { entityId: parsed.e, score: parsed.s };
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
 * Each entity becomes one observation, enriched with its assertions' text.
 */
function entityToObservation(entity, assertions, index) {
  const text = entitySearchText(entity, assertions);
  const displayText = text || [entity.label, entity.type].filter(Boolean).join(" ");

  return {
    id: entity.id,
    sessionId: entity.tenantScope || "",
    sequenceId: index + 1,
    index,
    ts: entity.capturedAt || new Date(0).toISOString(),
    tsMs: Date.parse(entity.capturedAt) || 0,
    kind: entity.type || "unknown",
    agentId: entity.sourceId || "graph",
    agentModel: "",
    text: displayText,
    tokens: tokenize(displayText),
    mentions: [],
    files: [],
    prRefs: [],
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
 */
function findExactEntityIdMatch(query, entities) {
  const normalizedQuery = normalizeString(query);
  if (!normalizedQuery) return null;

  // Try exact id match first.
  for (const entity of entities) {
    if (normalizeString(entity.id) === normalizedQuery) return entity;
  }

  // Try prefix match on the digest part (last 16 hex chars after last colon).
  const digestMatch = normalizedQuery.match(/^[a-f0-9]{12,16}$/i);
  if (digestMatch) {
    const digest = digestMatch[0].toLowerCase();
    for (const entity of entities) {
      const lastColon = entity.id.lastIndexOf(":");
      if (lastColon >= 0 && entity.id.slice(lastColon + 1).toLowerCase() === digest) {
        return entity;
      }
    }
  }

  return null;
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
  };
}

/**
 * Retrieve site entities from a compiled graph.
 *
 * This is the main entry point. It builds an index from the graph, then
 * queries it using the ENGRAM §1 recall engine (dense + BM25 + bounded
 * graph diffusion). Exact entity-ID matches always rank first.
 */
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
  const exactMatch = findExactEntityIdMatch(normalizedQuery, allEntities);

  // --- Run the §1 recall engine ---
  const recallConfig = {
    ...RECALL_DEFAULTS,
    expansionHops: Math.max(1, Math.floor(Number(expansionHops) || SITE_RETRIEVAL_DEFAULTS.expansionHops)),
  };

  const engineResult = recallEngine(index, {
    query: normalizedQuery,
    k: Math.min(100, index.observations.length), // fetch enough for pagination
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

  // --- Exact-match precedence: move exact entity ID hit to position 0 ---
  if (exactMatch) {
    results = results.filter((r) => r.entityId !== exactMatch.id);
    const exactResult = {
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
    };
    results.unshift(exactResult);
  }

  // --- Cursor pagination ---
  let cursorOffset = 0;
  const decodedCursor = decodeCursor(cursor);
  if (decodedCursor) {
    const cursorIdx = results.findIndex(
      (r) => r.entityId === decodedCursor.entityId && r.score <= decodedCursor.score,
    );
    if (cursorIdx >= 0) {
      cursorOffset = cursorIdx + 1;
    }
  }

  const pageSize = SITE_RETRIEVAL_DEFAULTS.pageSize;
  const paged = results.slice(cursorOffset, cursorOffset + Math.min(normalizedK, pageSize));
  const hasMore = cursorOffset + paged.length < results.length;
  const nextCursor = hasMore && paged.length > 0
    ? encodeCursor(paged[paged.length - 1].entityId, paged[paged.length - 1].score)
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
    exactMatchFound: Boolean(exactMatch),
    meta: {
      totalEntities: entityMap.size,
      accessFiltered: siteIndex.accessFiltered,
      poolSize: engineResult.poolSize,
      candidatePoolIds: engineResult.candidatePoolIds?.length || 0,
      embedderName: embedder.name,
      embedderDim: embedder.dim,
      indexSchemaVersion: RETRIEVE_SITE_INDEX_VERSION,
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
    return {
      ok: false,
      reason: `graph_read_error: ${normalizeString(error?.message || error)}`,
      results: [],
      nextCursor: null,
    };
  }

  if (!graphRecord || !graphRecord.graph) {
    return { ok: false, reason: "no_published_graph", results: [], nextCursor: null };
  }

  return retrieveSiteEntities({
    graph: graphRecord.graph,
    query,
    k,
    embedder,
    tenantScope,
    accessFilter,
    cursor,
    expansionHops,
    now,
  });
}
