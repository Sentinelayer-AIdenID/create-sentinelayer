/**
 * ENGRAM §EW05 — Compile source snapshots into the canonical capability graph.
 *
 * Reads a site's snapshots through the EW03 graph store and publishes ONE validated
 * generation atomically. Implements mandatory constraints:
 *
 *   • Stable tenant/source IDs; pages link to entities rather than replacing all
 *     business entities with URLs.
 *   • Resolve identifiers deterministically first; ambiguous entity links remain
 *     candidates.
 *   • Inferred claims cannot overwrite authoritative facts. Preserve validity time,
 *     locale and source precedence.
 *   • No action generated from a guessed button coordinate, guessed SKU or arbitrary
 *     executable text.
 *
 * Adds what a top professional would add:
 *   • Candidate/published generations with contradiction records.
 *   • Deterministic rebuild: same snapshots → same graph identities.
 *   • Graph cycles/bounds detection.
 *
 * Library only. Node builtins + existing EW02/EW03 contracts. No new dependency.
 */

import { createHash } from 'node:crypto';

import { graphSchema } from './contracts/graph.js';
import { GRAPH_SCHEMA_VERSION } from './contracts/versions.js';

// ---------------------------------------------------------------------------
// Canonical predicate vocabulary (from the EW05 proposed solution)
// ---------------------------------------------------------------------------

export const EW05_PREDICATES = Object.freeze({
  CONTAINS: 'contains',
  DESCRIBES: 'describes',
  VARIANT_OF: 'variant_of',
  HAS_MEDIA: 'has_media',
  SUPPORTED_BY: 'supported_by',
  REFERENCES: 'references',
});

export const EW05_PREDICATE_SET = new Set(Object.values(EW05_PREDICATES));

// ---------------------------------------------------------------------------
// Entity kinds (deterministic, stable identifiers)
// ---------------------------------------------------------------------------

export const ENTITY_KIND = Object.freeze({
  PAGE: 'page',
  PRODUCT: 'product',
  OFFERING: 'offering',
  DOCUMENT: 'document',
  CAPABILITY: 'capability',
  MEDIA: 'media',
  ORGANISATION: 'organisation',
  UNKNOWN: 'unknown',
});

// ---------------------------------------------------------------------------
// Generation status
// ---------------------------------------------------------------------------

export const GENERATION_STATUS = Object.freeze({
  CANDIDATE: 'candidate',
  PUBLISHED: 'published',
  SUPERSEDED: 'superseded',
});

// ---------------------------------------------------------------------------
// Identity helpers — deterministic, source-normalised
// ---------------------------------------------------------------------------

const ID_SEPARATOR = ':';

/**
 * Deterministic entity id from tenant scope + kind + normalised key.
 */
function entityId(tenantScope, kind, key) {
  // Identifier-first: identity is derived from the normalised key first.
  // The kind is included in the final id only for human-readability but
  // the digest is key-only so the same name resolves to the same identity
  // regardless of how different sources classify the @type.
  const normalised = String(key ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalised) return null;
  const digest = createHash('sha256').update(`${tenantScope}|${normalised}`, 'utf-8').digest('hex').slice(0, 16);
  return `${tenantScope}${ID_SEPARATOR}${kind}${ID_SEPARATOR}${digest}`;
}

/**
 * Deterministic assertion id scoped to a source snapshot.
 */
function assertionId(sourceId, index) {
  return `${sourceId}${ID_SEPARATOR}assertion${ID_SEPARATOR}${index}`;
}

// ---------------------------------------------------------------------------
// Normalisation: canonical URL → page identity
// ---------------------------------------------------------------------------

/**
 * Normalise a URL for deterministic identity.
 */
function normaliseUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  u.hash = '';
  const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'fbclid', 'gclid', 'msclkid', 'ref', 'source'];
  for (const p of trackingParams) {
    u.searchParams.delete(p);
  }
  u.searchParams.sort();
  u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

/**
 * Deterministic page entity id from a normalised URL.
 */
function pageEntityId(tenantScope, url) {
  const normalised = normaliseUrl(url);
  if (!normalised) return null;
  return entityId(tenantScope, ENTITY_KIND.PAGE, normalised);
}

// ---------------------------------------------------------------------------
// Fact extraction from snapshots — never guesses, always cites source
// ---------------------------------------------------------------------------

function extractEntities(tenantScope, sourceId, sourceVersion, capturedAt, facts) {
  const entities = [];
  if (!facts) return entities;

  for (const item of facts.jsonLd || []) {
    if (!item || typeof item !== 'object') continue;
    const type = Array.isArray(item['@type'])
      ? item['@type'][0]
      : item['@type'];
    if (!type || typeof type !== 'string') continue;

    let kind = ENTITY_KIND.UNKNOWN;
    const typeLower = type.toLowerCase();
    if (typeLower === 'product') kind = ENTITY_KIND.PRODUCT;
    else if (typeLower === 'offering' || typeLower === 'offer') kind = ENTITY_KIND.OFFERING;
    else if (typeLower === 'organization' || typeLower === 'organisation') kind = ENTITY_KIND.ORGANISATION;
    else if (typeLower === 'mediaobject' || typeLower === 'imageobject' || typeLower === 'videoobject') kind = ENTITY_KIND.MEDIA;
    else if (typeLower === 'webpage' || typeLower === 'website') continue;

    const key = item.name || item.identifier || item['@id'];
    if (!key) continue;

    const id = entityId(tenantScope, kind, key);
    if (!id) continue;

    const attributes = {};
    for (const [k, v] of Object.entries(item)) {
      if (k === '@context' || k === '@type') continue;
      if (v !== undefined && v !== null) attributes[k] = v;
    }

    entities.push({
      id,
      type: kind,
      label: item.name || undefined,
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
      provenance: 'observed',
      tenantScope,
      sourceId,
      sourceVersion,
      capturedAt,
    });
  }

  return entities;
}

function extractAssertions(tenantScope, sourceId, sourceVersion, capturedAt, facts, entities) {
  const assertions = [];
  if (!facts) return assertions;

  const add = (subject, predicate, object, opts = {}) => {
    const id = assertionId(sourceId, assertions.length);
    assertions.push({
      id,
      subject,
      predicate,
      object,
      provenance: opts.provenance || 'observed',
      schemaValidity: 'unvalidated',
      modelConfidence: 'unavailable',
      freshness: { asOf: capturedAt },
      source: { sourceId, version: sourceVersion, capturedAt, tenantScope },
      ...(opts.evidenceRef ? { evidenceRef: opts.evidenceRef } : {}),
    });
  };

  const canonicalStr = typeof facts.canonical === 'string' ? facts.canonical : null;
  const pageId = canonicalStr
    ? pageEntityId(tenantScope, canonicalStr)
    : pageEntityId(tenantScope, sourceId);

  if (pageId) {
    const pageExists = entities.some((e) => e.id === pageId);
    if (!pageExists) {
      entities.push({
        id: pageId,
        type: ENTITY_KIND.PAGE,
        label: facts.title || undefined,
        provenance: 'observed',
        tenantScope,
        sourceId,
        sourceVersion,
        capturedAt,
      });
    }
  }

  if (pageId) {
    for (const entity of entities) {
      if (entity.type === ENTITY_KIND.PAGE) continue;
      add(pageId, EW05_PREDICATES.DESCRIBES, { entityId: entity.id }, { provenance: 'derived' });
    }
  }

  // Entity attribute assertions: create assertions for each entity attribute
  // so that conflicting attribute values from different sources are detectable.
  for (const entity of entities) {
    if (!entity.id || !entity.attributes) continue;
    for (const [attrKey, attrVal] of Object.entries(entity.attributes)) {
      if (attrVal === undefined || attrVal === null) continue;
      const attrPredicate = `${EW05_PREDICATES.DESCRIBES}_${attrKey}`;
      add(entity.id, attrPredicate, String(attrVal).slice(0, 1000), { provenance: 'observed' });
    }
  }

  for (const heading of facts.headings || []) {
    if (pageId && heading && typeof heading === 'object' && heading !== null && typeof heading.text === 'string' && heading.text) {
      // Heading level encoded in text to avoid numeric type issues
      const level = Number(heading.level);
      if (!Number.isSafeInteger(level) || level < 1 || level > 6) continue;
      const headingLevel = `h${level}`;
      add(pageId, EW05_PREDICATES.CONTAINS, {
        kind: headingLevel,
        text: heading.text,
      });
    }
  }

  for (const link of facts.links || []) {
    if (!link.href) continue;
    const targetUrl = normaliseUrl(link.href);
    if (!targetUrl) continue;
    const targetPageId = pageEntityId(tenantScope, targetUrl);
    if (targetPageId && pageId && targetPageId !== pageId) {
      add(pageId, EW05_PREDICATES.REFERENCES, {
        entityId: targetPageId,
        url: targetUrl,
        text: link.text || undefined,
      });
    }
  }

  return assertions;
}

function mergeEntities(entityLists) {
  const map = new Map();
  for (const list of entityLists) {
    for (const entity of list) {
      const existing = map.get(entity.id);
      if (!existing) {
        map.set(entity.id, { ...entity });
      } else {
        mergeTwoEntities(existing, entity);
      }
    }
  }

  // Identifier-first second pass: merge entities that share the same
  // identity digest but ended up with different kinds (e.g. one source
  // says Product, another says UNKNOWN). The kind from the entity with
  // higher provenance rank wins.
  const byDigest = new Map();
  for (const entity of map.values()) {
    // Extract digest from id. Format: tenantScope:kind:digest
    // tenantScope may contain colons (e.g. tenant:ew05-test), so we
    // take everything except the last two colon-separated parts.
    const parts = entity.id.split(ID_SEPARATOR);
    const digest = parts[parts.length - 1];
    // kind is parts[parts.length - 2], tenantScope is parts.slice(0, -2).join(':')
    const tenantScope = parts.slice(0, -2).join(ID_SEPARATOR);
    const digestKey = tenantScope + ID_SEPARATOR + digest;
    if (!byDigest.has(digestKey)) {
      byDigest.set(digestKey, [entity]);
    } else {
      byDigest.get(digestKey).push(entity);
    }
  }

  // Build a map for remapping old ids to merged ids
  const idRemap = new Map();
  for (const [dk, group] of byDigest) {
    if (group.length < 2) continue;
    // Only merge when the kind difference is classification variance
    // (one source says Product, another has UNKNOWN). If both have
    // specific but different kinds (Product vs Organization), they
    // are genuinely different entities.
    const hasUnknown = group.some((e) => e.type === ENTITY_KIND.UNKNOWN);
    if (!hasUnknown) continue;

    // Merge all into the first entity with a known kind
    let target = group.find((e) => e.type !== ENTITY_KIND.UNKNOWN);
    if (!target) target = group[0]; // all UNKNOWN
    const targetIdBefore = target.id;
    for (const other of group) {
      if (other === target) continue;
      // Record remapping: old id -> new resolved id
      idRemap.set(other.id, target.id);
      mergeTwoEntities(target, other);
      map.delete(other.id);
    }
    // Rebuild id with the resolved kind (pick best non-unknown)
    const best = target.type !== ENTITY_KIND.UNKNOWN ? target.type : ENTITY_KIND.UNKNOWN;
    const parts = target.id.split(ID_SEPARATOR);
    const tenantScope = parts.slice(0, -2).join(ID_SEPARATOR);
    target.id = tenantScope + ID_SEPARATOR + best + ID_SEPARATOR + parts[parts.length - 1];
    if (target.id !== targetIdBefore) {
      idRemap.set(targetIdBefore, target.id);
    }
  }

  return { entities: [...map.values()], idRemap };
}

function mergeTwoEntities(existing, entity) {
  const existingRank = provenanceRank(existing.provenance);
  const newRank = provenanceRank(entity.provenance);

  // Merge label: keep higher-provenance label, fall back to existing
  if (!existing.label && entity.label) {
    existing.label = entity.label;
  } else if (newRank >= existingRank && entity.label) {
    existing.label = entity.label;
  }

  // If new has higher provenance, update scalar fields (type, provenance).
  // Never downgrade a known type to UNKNOWN.
  if (newRank >= existingRank) {
    if (entity.type !== ENTITY_KIND.UNKNOWN || existing.type === ENTITY_KIND.UNKNOWN) {
      existing.type = entity.type;
    }
    existing.provenance = entity.provenance;
  }

  // Per-attribute merge: merge attributes objects by key
  if (entity.attributes && Object.keys(entity.attributes).length > 0) {
    if (!existing.attributes) existing.attributes = {};
    for (const [attrKey, attrVal] of Object.entries(entity.attributes)) {
      if (attrVal === undefined || attrVal === null) continue;
      if (!(attrKey in existing.attributes)) {
        // New attribute: adopt it
        existing.attributes[attrKey] = attrVal;
      } else if (existing.attributes[attrKey] !== attrVal) {
        // Conflicting value: retain both as an array of source-attributed values
        const prev = existing.attributes[attrKey];
        if (Array.isArray(prev)) {
          if (!prev.some((v) => typeof v === 'object' && v.value === attrVal)) {
            prev.push({ value: attrVal, provenance: entity.provenance, sourceId: entity.sourceId });
          }
        } else {
          existing.attributes[attrKey] = [
            { value: prev, provenance: existing.provenance, sourceId: existing.sourceId },
            { value: attrVal, provenance: entity.provenance, sourceId: entity.sourceId },
          ];
        }
      }
    }
  }
}

function provenanceRank(p) {
  if (p === 'authoritative') return 3;
  if (p === 'derived') return 2;
  if (p === 'observed') return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Contradiction detection
// ---------------------------------------------------------------------------

function detectContradictions(assertions) {
  // Only single-valued attribute assertions can produce contradictions.
  // Multi-valued predicates (CONTAINS, REFERENCES, DESCRIBES) are expected
  // to have multiple values and must not generate false contradictions.
  function isSingleValued(predicate) {
    // Attribute assertions: describes_name, describes_sku, etc.
    return predicate.startsWith(EW05_PREDICATES.DESCRIBES + '_');
  }

  const byKey = new Map();
  for (const a of assertions) {
    if (!isSingleValued(a.predicate)) continue;
    const key = `${a.subject}|${a.predicate}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(a);
  }

  const contradictions = [];
  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    const objects = group.map((a) => JSON.stringify(a.object));
    const unique = new Set(objects);
    if (unique.size > 1) {
      contradictions.push({
        key: `${group[0].subject}|${group[0].predicate}`,
        assertionIds: group.map((a) => a.id),
        sourceIds: [...new Set(group.map((a) => a.source.sourceId))],
        objects: group.map((a) => a.object),
      });
    }
  }

  return contradictions;
}

// ---------------------------------------------------------------------------
// Cycle detection in link graph
// ---------------------------------------------------------------------------

function detectLinkCycles(links) {
  const adjacency = new Map();
  for (const link of links) {
    if (!adjacency.has(link.source)) adjacency.set(link.source, []);
    adjacency.get(link.source).push(link.target);
  }

  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  const cycles = [];

  function dfs(node, path) {
    color.set(node, GRAY);
    const neighbors = adjacency.get(node) || [];
    for (const next of neighbors) {
      if (color.get(next) === GRAY) {
        const cycleStart = path.indexOf(next);
        if (cycleStart !== -1) {
          cycles.push(path.slice(cycleStart).concat(next));
        }
      } else if (color.get(next) !== BLACK) {
        dfs(next, path.concat(next));
      }
    }
    color.set(node, BLACK);
  }

  for (const node of adjacency.keys()) {
    if (!color.has(node)) {
      dfs(node, [node]);
    }
  }

  return cycles;
}

// ---------------------------------------------------------------------------
// Link dedup key (internal, not stored on link object)
// ---------------------------------------------------------------------------

function linkDedupKey(source, target, predicate) {
  return `${source}|${target}|${predicate}`;
}

// ---------------------------------------------------------------------------
// Compilation — main entry point
// ---------------------------------------------------------------------------

/**
 * Extract all data from snapshots into entities, assertions, and links.
 */
async function extractFromSnapshots(snapshots, factsProvider) {
  const allEntities = [];
  const allAssertions = [];
  const allLinks = [];

  for (const snap of snapshots) {
    let facts;
    if (typeof factsProvider === 'function') {
      try {
        facts = await factsProvider(snap);
      } catch {
        facts = null;
      }
    }

    const entities = extractEntities(
      snap.tenantScope, snap.sourceId, snap.version, snap.capturedAt, facts,
    );
    const assertions = extractAssertions(
      snap.tenantScope, snap.sourceId, snap.version, snap.capturedAt, facts, entities,
    );

    const canonicalStr2 = facts && typeof facts.canonical === 'string' ? facts.canonical : null;
    const pageId = canonicalStr2
      ? pageEntityId(snap.tenantScope, canonicalStr2)
      : pageEntityId(snap.tenantScope, snap.sourceId);

    // DESCRIBES links: page → entity
    if (pageId) {
      for (const entity of entities) {
        if (entity.type === ENTITY_KIND.PAGE) continue;
        allLinks.push({
          source: pageId,
          target: entity.id,
          predicate: EW05_PREDICATES.DESCRIBES,
          provenance: 'derived',
          confidence: 'medium',
          tenantScope: snap.tenantScope,
          sourceId: snap.sourceId,
          sourceVersion: snap.version,
          capturedAt: snap.capturedAt,
        });
      }
    }

    // REFERENCES links: page → other page
    if (pageId) {
      for (const link of facts?.links || []) {
        if (!link.href) continue;
        const targetUrl = normaliseUrl(link.href);
        if (!targetUrl) continue;
        const targetPageId = pageEntityId(snap.tenantScope, targetUrl);
        if (targetPageId && targetPageId !== pageId) {
          // Ensure the target page entity exists (as a placeholder if not yet seen)
          if (!entities.some((e) => e.id === targetPageId)) {
            entities.push({
              id: targetPageId,
              type: ENTITY_KIND.PAGE,
              label: link.text || undefined,
              provenance: 'observed',
              tenantScope: snap.tenantScope,
              sourceId: snap.sourceId,
              sourceVersion: snap.version,
              capturedAt: snap.capturedAt,
            });
          }
          allLinks.push({
            source: pageId,
            target: targetPageId,
            predicate: EW05_PREDICATES.REFERENCES,
            provenance: 'observed',
            confidence: 'medium',
            tenantScope: snap.tenantScope,
            sourceId: snap.sourceId,
            sourceVersion: snap.version,
            capturedAt: snap.capturedAt,
          });
        }
      }
    }

    allEntities.push(entities);
    allAssertions.push(assertions);
  }

  return { allEntities, allAssertions, allLinks };
}

/**
 * Build the final graph from extracted data.
 */
function buildGraph(allEntities, allAssertions, allLinks) {
  const { entities: mergedEntities, idRemap } = mergeEntities(allEntities);
  const mergedAssertions = allAssertions.flat();

  // Deduplicate links and remap targets after identifier-first merge
  const linkMap = new Map();
  for (const link of allLinks) {
    // Remap link source/target after identifier-first entity merge
    const remappedLink = { ...link };
    if (idRemap.has(link.source)) remappedLink.source = idRemap.get(link.source);
    if (idRemap.has(link.target)) remappedLink.target = idRemap.get(link.target);
    const key = linkDedupKey(remappedLink.source, remappedLink.target, remappedLink.predicate);
    if (!linkMap.has(key)) {
      linkMap.set(key, remappedLink);
    }
  }
  const mergedLinks = [...linkMap.values()];

  const contradictions = detectContradictions(mergedAssertions);
  const cycles = detectLinkCycles(mergedLinks);

  const generatedAt = new Date().toISOString();
  const graph = {
    version: GRAPH_SCHEMA_VERSION,
    entities: mergedEntities.length > 0 ? mergedEntities : undefined,
    links: mergedLinks.length > 0 ? mergedLinks : undefined,
    assertions: mergedAssertions,
    coverage: {
      totalAssertions: mergedAssertions.length,
      byProvenance: countBy(mergedAssertions, 'provenance'),
      bySchemaValidity: countBy(mergedAssertions, 'schemaValidity'),
    },
    generatedAt,
  };

  return { graph, contradictions, cycles, mergedEntities, mergedAssertions, mergedLinks };
}

async function _compile({
  graphStore,
  caller,
  namespace,
  factsProvider,
  publish = false,
} = {}) {
  if (!graphStore || typeof graphStore.listSourceSnapshots !== 'function') {
    throw new CompileGraphError('graphStore with listSourceSnapshots is required');
  }
  if (!caller || typeof caller !== 'object') {
    throw new CompileGraphError('caller identity is required');
  }
  if (!namespace || typeof namespace.raw !== 'string') {
    throw new CompileGraphError('namespace is required');
  }

  const snapshots = await graphStore.listSourceSnapshots(caller, namespace);
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new CompileGraphError('no source snapshots to compile');
  }

  const { allEntities, allAssertions, allLinks } = await extractFromSnapshots(snapshots, factsProvider);
  const { graph, contradictions, cycles, mergedEntities, mergedAssertions, mergedLinks } =
    buildGraph(allEntities, allAssertions, allLinks);

  const schemaResult = graphSchema.safeParse(graph);
  if (!schemaResult.success && publish) {
    const messages = schemaResult.error.issues.map((i) => i.path.join('.') + ': ' + i.message);
    throw new CompileGraphError('Compiled graph invalid: ' + messages.join('; '));
  }

  if (publish) {
    const published = await graphStore.publishGraph(caller, namespace, schemaResult.data);
    return {
      graph: published.graph,
      version: published.version,
      publishedAt: published.publishedAt,
      contentHash: published.contentHash,
      entities: mergedEntities,
      links: mergedLinks,
      assertions: mergedAssertions,
      contradictions,
      cycles,
      entityCount: mergedEntities.length,
      assertionCount: mergedAssertions.length,
      linkCount: mergedLinks.length,
      sourceCount: snapshots.length,
    };
  }

  return {
    status: schemaResult.success ? GENERATION_STATUS.CANDIDATE : 'invalid',
    graph: schemaResult.success ? schemaResult.data : graph,
    schemaErrors: schemaResult.success ? [] : schemaResult.error.issues,
    contradictions,
    cycles,
    entityCount: mergedEntities.length,
    assertionCount: mergedAssertions.length,
    linkCount: mergedLinks.length,
    sourceCount: snapshots.length,
  };
}

export async function compileGraph(opts = {}) {
  return _compile({ ...opts, publish: true });
}

export async function compileCandidate(opts = {}) {
  return _compile({ ...opts, publish: false });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countBy(items, field) {
  const counts = {};
  for (const item of items) {
    const val = item[field];
    if (val !== undefined) {
      counts[val] = (counts[val] || 0) + 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class CompileGraphError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompileGraphError';
  }
}
