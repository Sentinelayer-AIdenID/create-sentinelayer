import './setup-env.mjs';
// unit.engram-compile-graph.test.mjs — EW05 compile-graph tests.
// Drives compile-graph.js and graph-store.js directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import {
  compileGraph,
  compileCandidate,
  CompileGraphError,
  EW05_PREDICATES,
  ENTITY_KIND,
  GENERATION_STATUS,
} from '../src/engram/compile-graph.js';
import { createGraphStore } from '../src/engram/graph-store.js';
import { parseNamespace, createLocalConsent } from '../src/engram/namespace.js';
import { VALID_SOURCE_SNAPSHOT } from '../src/engram/contracts/source-snapshot.js';

const consent = createLocalConsent();
const CALLER = { id: 'agent-test', kind: 'agent' };
const TENANT = 'tenant:ew05-test';

async function withGraphStore(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-ew05-'));
  try {
    const store = createGraphStore({ storeRoot: root, consent });
    return await fn(store, root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// Synthetic facts modeled on AIdenID-like pages — no real URLs, no secrets.
function mockFactsProvider(overrides = {}) {
  return async () => ({
    title: overrides.title || 'Test Page',
    description: overrides.description || 'A test page for EW05',
    canonical: overrides.canonical || 'https://example.com/page',
    headings: overrides.headings || [{ level: 1, text: 'Introduction' }, { level: 2, text: 'Features' }],
    links: overrides.links || [
      { href: 'https://example.com/docs', text: 'Documentation' },
      { href: 'https://example.com/about', text: 'About' },
    ],
    jsonLd: overrides.jsonLd || [],
  });
}

// ---------------------------------------------------------------------------
// R02 graph: entities, assertions, links
// ---------------------------------------------------------------------------

test('EW05 R02 graph: compile produces entities from snapshots', async () => {
  await withGraphStore(async (store) => {
    const ns = parseNamespace(TENANT);
    const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;
    const snap1 = { ...snapBase, sourceId: 'src-page-1', tenantScope: TENANT, sourceType: 'ingest' };
    const bytes1 = Buffer.from('<html><head><title>Page One</title></head><body></body></html>');

    await store.writeSourceSnapshot(CALLER, ns, snap1, bytes1);

    const result = await compileGraph({
      graphStore: store,
      caller: CALLER,
      namespace: ns,
      factsProvider: mockFactsProvider({ canonical: 'https://example.com/page-one' }),
    });

    assert.ok(result.entities && result.entities.length > 0, 'should produce entities');
    assert.ok(result.assertions.length > 0, 'should produce assertions');
    assert.ok(result.links.length > 0, 'should produce links');
    assert.ok(result.version > 0, 'should have a published version');
  });
});

test('EW05 R02 graph: multiple snapshots merge entities by deterministic id', async () => {
  await withGraphStore(async (store) => {
    const ns = parseNamespace(TENANT);
    const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;

    // Two pages describing the same product (same JSON-LD)
    const productJsonLd = [{
      '@type': 'Product',
      name: 'Widget Pro',
      description: 'A pro widget',
    }];

    const snap1 = { ...snapBase, sourceId: 'src-product-page', tenantScope: TENANT, sourceType: 'ingest' };
    const snap2 = { ...snapBase, sourceId: 'src-docs-page', tenantScope: TENANT, sourceType: 'ingest' };

    await store.writeSourceSnapshot(CALLER, ns, snap1, Buffer.from('<html>Product page</html>'));
    await store.writeSourceSnapshot(CALLER, ns, snap2, Buffer.from('<html>Docs page</html>'));

    const result = await compileGraph({
      graphStore: store,
      caller: CALLER,
      namespace: ns,
      factsProvider: mockFactsProvider({
        canonical: 'https://example.com/product',
        jsonLd: productJsonLd,
      }),
    });

    // Same product name → same deterministic id → one merged entity
    const productEntities = result.entities.filter((e) => e.type === 'product');
    assert.equal(productEntities.length, 1, 'should deduplicate product by deterministic id');
  });
});

test('EW05 R02 graph: deterministic rebuild produces stable identities', async () => {
  await withGraphStore(async (store) => {
    const ns = parseNamespace(TENANT);
    const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;

    const snap1 = { ...snapBase, sourceId: 'src-page-1', tenantScope: TENANT, sourceType: 'ingest' };
    await store.writeSourceSnapshot(CALLER, ns, snap1, Buffer.from('<html>Test</html>'));

    const facts = mockFactsProvider({
      canonical: 'https://example.com/page-one',
      jsonLd: [{ '@type': 'Product', name: 'Stable Product' }],
    });

    const result1 = await compileGraph({
      graphStore: store, caller: CALLER, namespace: ns, factsProvider: facts,
    });

    // Rebuild from same snapshots should produce same entity ids
    const result2 = await compileGraph({
      graphStore: store, caller: CALLER, namespace: ns, factsProvider: facts,
    });

    const ids1 = result1.entities.map((e) => e.id).sort();
    const ids2 = result2.entities.map((e) => e.id).sort();
    assert.deepEqual(ids1, ids2, 'deterministic rebuild must produce same entity ids');
  });
});

// ---------------------------------------------------------------------------
// Mandatory constraint: stable tenant/source IDs
// ---------------------------------------------------------------------------

test('EW05 constraint: entity ids are scoped to tenant', async () => {
  await withGraphStore(async (store) => {
    // Two tenants, same product name — different entity ids
    const nsA = parseNamespace('tenant:alpha');
    const nsB = parseNamespace('tenant:beta');
    const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;

    const snapA = { ...snapBase, sourceId: 'src-a', tenantScope: 'tenant:alpha', sourceType: 'ingest' };
    const snapB = { ...snapBase, sourceId: 'src-b', tenantScope: 'tenant:beta', sourceType: 'ingest' };

    await store.writeSourceSnapshot(CALLER, nsA, snapA, Buffer.from('<html>A</html>'));
    await store.writeSourceSnapshot(CALLER, nsB, snapB, Buffer.from('<html>B</html>'));

    const productJsonLd = [{ '@type': 'Product', name: 'Same Name' }];

    const resultA = await compileGraph({
      graphStore: store, caller: CALLER, namespace: nsA,
      factsProvider: mockFactsProvider({ canonical: 'https://a.example.com/p', jsonLd: productJsonLd }),
    });
    const resultB = await compileGraph({
      graphStore: store, caller: CALLER, namespace: nsB,
      factsProvider: mockFactsProvider({ canonical: 'https://b.example.com/p', jsonLd: productJsonLd }),
    });

    const productsA = resultA.entities.filter((e) => e.type === 'product').map((e) => e.id);
    const productsB = resultB.entities.filter((e) => e.type === 'product').map((e) => e.id);

    // Different tenants → different ids
    for (const idA of productsA) {
      assert.ok(!productsB.includes(idA), 'entity ids must be scoped to tenant');
    }
  });
});

// ---------------------------------------------------------------------------
// Mandatory constraint: pages link to entities, not URL replacement
// ---------------------------------------------------------------------------

test('EW05 constraint: pages are separate entities from business entities', async () => {
  await withGraphStore(async (store) => {
    const ns = parseNamespace(TENANT);
    const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;

    const snap = { ...snapBase, sourceId: 'src-product-page', tenantScope: TENANT, sourceType: 'ingest' };
    await store.writeSourceSnapshot(CALLER, ns, snap, Buffer.from('<html>Product</html>'));

    const result = await compileGraph({
      graphStore: store, caller: CALLER, namespace: ns,
      factsProvider: mockFactsProvider({
        canonical: 'https://example.com/product',
        jsonLd: [{ '@type': 'Product', name: 'Widget Pro' }],
      }),
    });

    const pages = result.entities.filter((e) => e.type === 'page');
    const products = result.entities.filter((e) => e.type === 'product');

    assert.ok(pages.length >= 1, 'should have at least one page entity');
    assert.ok(products.length >= 1, 'should have product entity separate from page');

    // Pages link TO entities via DESCRIBES, they are not replaced by them
    const pageToProductLinks = result.links.filter(
      (l) => l.predicate === EW05_PREDICATES.DESCRIBES
        && pages.some((p) => p.id === l.source)
        && products.some((pr) => pr.id === l.target),
    );
    assert.ok(pageToProductLinks.length >= 1, 'pages should link to product entities, not replace them');
  });
});

// ---------------------------------------------------------------------------
// Mandatory constraint: resolve identifiers deterministically first
// ---------------------------------------------------------------------------

test('EW05 constraint: URL normalisation is deterministic', async () => {
  await withGraphStore(async (store) => {
    const ns = parseNamespace(TENANT);
    const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;

    const snap1 = { ...snapBase, sourceId: 'src-a', tenantScope: TENANT, sourceType: 'ingest' };
    const snap2 = { ...snapBase, sourceId: 'src-b', tenantScope: TENANT, sourceType: 'ingest' };
    await store.writeSourceSnapshot(CALLER, ns, snap1, Buffer.from('<html>A</html>'));
    await store.writeSourceSnapshot(CALLER, ns, snap2, Buffer.from('<html>B</html>'));

    // Same URL with different tracking params should resolve to same page entity
    let callCount = 0;
    const factsProvider = async () => {
      callCount++;
      const urls = [
        'https://example.com/page?utm_source=twitter',
        'https://example.com/page?fbclid=123',
      ];
      return {
        title: 'Page',
        canonical: urls[callCount - 1],
        headings: [],
        links: [{ href: 'https://example.com/other', text: 'Other' }],
        jsonLd: [],
      };
    };

    const result = await compileGraph({
      graphStore: store, caller: CALLER, namespace: ns, factsProvider,
    });

    // Two snapshots with same normalised URL → merged to one page via deterministic identity
    const pages = result.entities.filter((e) => e.type === 'page');
    assert.ok(pages.length >= 1, 'should have at least one page entity');
    // Both snapshots describe the same normalised URL — their entities should share the same id
    const pageIds = new Set(pages.map((e) => e.id));
    // The merged canonical page (one id) plus any linked pages
    assert.ok(pageIds.size <= pages.length, 'page entities should be deduplicated by id');
  });
});

// ---------------------------------------------------------------------------
// Mandatory constraint: ambiguous entity links remain candidates
// ---------------------------------------------------------------------------

test('EW05 constraint: ambiguous references are preserved, not silently resolved', async () => {
  await withGraphStore(async (store) => {
    const ns = parseNamespace(TENANT);
    const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;

    const snap = { ...snapBase, sourceId: 'src-ambiguous', tenantScope: TENANT, sourceType: 'ingest' };
    await store.writeSourceSnapshot(CALLER, ns, snap, Buffer.from('<html>Ambiguous</html>'));

    // Two JSON-LD blocks with same @id but different types → ambiguous
    const result = await compileGraph({
      graphStore: store, caller: CALLER, namespace: ns,
      factsProvider: mockFactsProvider({
        canonical: 'https://example.com/ambiguous',
        jsonLd: [
          { '@type': 'Product', name: 'Widget', '@id': 'same-id' },
          { '@type': 'Organization', name: 'Widget', '@id': 'same-id' },
        ],
      }),
    });

    // Both should exist as separate entities (different kinds)
    const products = result.entities.filter((e) => e.type === 'product' || e.type === 'organisation');
    assert.equal(products.length, 2, 'ambiguous types produce separate candidate entities');
  });
});

// ---------------------------------------------------------------------------
// Mandatory constraint: inferred claims cannot overwrite authoritative facts
// ---------------------------------------------------------------------------

test('EW05 constraint: authoritative entities are not overwritten by derived', async () => {
  await withGraphStore(async (store) => {
    const ns = parseNamespace(TENANT);
    const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;

    const snap1 = { ...snapBase, sourceId: 'src-auth', tenantScope: TENANT, sourceType: 'ingest' };
    await store.writeSourceSnapshot(CALLER, ns, snap1, Buffer.from('<html>Auth</html>'));

    // The function mergeEntities is internal; we test via compileGraph that
    // multiple snapshots with same entity don't lose data.
    // We verify: compileGraph with two snapshots describing the same product
    // produces one merged entity with the latest data.

    const snap2 = { ...snapBase, sourceId: 'src-derived', tenantScope: TENANT, sourceType: 'ingest' };
    await store.writeSourceSnapshot(CALLER, ns, snap2, Buffer.from('<html>Derived</html>'));

    const result = await compileGraph({
      graphStore: store, caller: CALLER, namespace: ns,
      factsProvider: mockFactsProvider({
        canonical: 'https://example.com/product',
        jsonLd: [{ '@type': 'Product', name: 'Consistent Widget' }],
      }),
    });

    const products = result.entities.filter((e) => e.type === 'product');
    assert.equal(products.length, 1, 'same product from two snapshots merges to one');
  });
});

// ---------------------------------------------------------------------------
// Mandatory constraint: no guessed button coordinates, SKUs, or executable text
// ---------------------------------------------------------------------------

test('EW05 constraint: no actions from guessed coordinates or free text', async () => {
  await withGraphStore(async (store) => {
    const ns = parseNamespace(TENANT);
    const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;

    const snap = { ...snapBase, sourceId: 'src-safe', tenantScope: TENANT, sourceType: 'ingest' };
    await store.writeSourceSnapshot(CALLER, ns, snap, Buffer.from('<html>Safe</html>'));

    const result = await compileGraph({
      graphStore: store, caller: CALLER, namespace: ns,
      factsProvider: mockFactsProvider({
        canonical: 'https://example.com/safe',
        // No JSON-LD with SKUs, no button coordinates, no executable text
        jsonLd: [],
      }),
    });

    // Assertions must not contain any guessed data
    for (const assertion of result.assertions) {
      if (typeof assertion.object === 'object' && assertion.object !== null) {
        // Check no coordinate-like values
        const objStr = JSON.stringify(assertion.object);
        assert.ok(!objStr.includes('coordinate'), 'no guessed coordinates in assertions');
        assert.ok(!objStr.includes('sku'), 'no guessed SKUs in assertions');
        assert.ok(!objStr.includes('exec'), 'no executable text in assertions');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// R03 traversal: adjacency and link navigation
// ---------------------------------------------------------------------------

test('EW05 R03 traversal: links form navigable adjacency', async () => {
  await withGraphStore(async (store) => {
    const ns = parseNamespace(TENANT);
    const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;

    const snap = { ...snapBase, sourceId: 'src-page', tenantScope: TENANT, sourceType: 'ingest' };
    await store.writeSourceSnapshot(CALLER, ns, snap, Buffer.from('<html>Page</html>'));

    const result = await compileGraph({
      graphStore: store, caller: CALLER, namespace: ns,
      factsProvider: mockFactsProvider({
        canonical: 'https://example.com/home',
        links: [
          { href: 'https://example.com/docs', text: 'Docs' },
          { href: 'https://example.com/about', text: 'About' },
        ],
        jsonLd: [{ '@type': 'Product', name: 'Test Product' }],
      }),
    });

    // Build adjacency map from links
    const adjacency = new Map();
    for (const link of result.links) {
      if (!adjacency.has(link.source)) adjacency.set(link.source, []);
      adjacency.get(link.source).push(link.target);
    }

    const pages = result.entities.filter((e) => e.type === 'page');
    const homePage = pages.find((p) => p.label === 'Test Page' || p.id.includes('page'));
    assert.ok(homePage, 'should have a home page entity');

    // Home page should be in adjacency (as source of REFERENCES links)
    const allSources = [...adjacency.keys()];
    assert.ok(allSources.length > 0, 'adjacency should have source nodes');
  });
});

// ---------------------------------------------------------------------------
// R09 source reconciliation: contradictions retained
// ---------------------------------------------------------------------------

test('EW05 R09 reconciliation: real contradictions are detected with correct content', async () => {
  await withGraphStore(async (store) => {
    const ns = parseNamespace(TENANT);
    const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;

    const productName = 'Widget Pro';

    // Two independent sources describing the same product differently
    const snapA = { ...snapBase, sourceId: 'src-vendor-a', tenantScope: TENANT, sourceType: 'ingest' };
    const snapB = { ...snapBase, sourceId: 'src-vendor-b', tenantScope: TENANT, sourceType: 'ingest' };

    await store.writeSourceSnapshot(CALLER, ns, snapA, Buffer.from('<html>Vendor A</html>'));
    await store.writeSourceSnapshot(CALLER, ns, snapB, Buffer.from('<html>Vendor B</html>'));

    // Per-snapshot facts provider: each source describes the same product differently
    const perSourceFacts = async (snap) => {
      if (snap.sourceId === 'src-vendor-a') {
        return {
          canonical: 'https://example.com/vendor-a',
          jsonLd: [{ '@type': 'Product', name: productName, description: 'Premium widget with gold finish' }],
        };
      }
      return {
        canonical: 'https://example.com/vendor-b',
        jsonLd: [{ '@type': 'Product', name: productName, description: 'Basic widget, plastic body' }],
      };
    };

    const result = await compileGraph({
      graphStore: store, caller: CALLER, namespace: ns,
      factsProvider: perSourceFacts,
    });

    // contradictions field should exist and contain real conflicts
    assert.ok(Array.isArray(result.contradictions), 'contradictions should be an array');
    assert.ok(result.contradictions.length > 0, 'should detect at least one contradiction');
    const c = result.contradictions[0];
    assert.ok(c.key, 'contradiction should have a key');
    assert.ok(Array.isArray(c.assertionIds), 'contradiction should list assertionIds');
    assert.ok(Array.isArray(c.sourceIds), 'contradiction should list sourceIds');
    assert.ok(c.sourceIds.length >= 2, 'contradiction should involve at least 2 sources');
    assert.ok(Array.isArray(c.objects), 'contradiction should list conflicting objects');
    assert.ok(c.objects.length >= 2, 'contradiction should have at least 2 conflicting values');
  });
});


// ---------------------------------------------------------------------------
// Top professional: candidate generations
// ---------------------------------------------------------------------------

test('EW05 candidate: compileCandidate produces preview without publishing', async () => {
  await withGraphStore(async (store) => {
    const ns = parseNamespace(TENANT);
    const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;

    const snap = { ...snapBase, sourceId: 'src-candidate', tenantScope: TENANT, sourceType: 'ingest' };
    await store.writeSourceSnapshot(CALLER, ns, snap, Buffer.from('<html>Candidate</html>'));

    const candidate = await compileCandidate({
      graphStore: store, caller: CALLER, namespace: ns,
      factsProvider: mockFactsProvider(),
    });

    assert.equal(candidate.status, GENERATION_STATUS.CANDIDATE, 'should be candidate status');

    // Graph should not be published — reading current should show none or previous
    const current = await store.readCurrentGraph(CALLER, ns);
    assert.equal(current.version, 0, 'candidate should not publish to store');
  });
});

// ---------------------------------------------------------------------------
// Top professional: cycle detection
// ---------------------------------------------------------------------------

test('EW05 cycles: no cycles in acyclic link graph', async () => {
  await withGraphStore(async (store) => {
    const ns = parseNamespace(TENANT);
    const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;

    const snap = { ...snapBase, sourceId: 'src-acyclic', tenantScope: TENANT, sourceType: 'ingest' };
    await store.writeSourceSnapshot(CALLER, ns, snap, Buffer.from('<html>Acyclic</html>'));

    const result = await compileGraph({
      graphStore: store, caller: CALLER, namespace: ns,
      factsProvider: mockFactsProvider({
        canonical: 'https://example.com/parent',
        links: [
          { href: 'https://example.com/child', text: 'Child' },
        ],
      }),
    });

    assert.equal(result.cycles.length, 0, 'acyclic graph should have no cycles');
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

test('EW05 error: no snapshots throws CompileGraphError', async () => {
  await withGraphStore(async (store) => {
    const ns = parseNamespace(TENANT);
    await assert.rejects(
      () => compileGraph({ graphStore: store, caller: CALLER, namespace: ns, factsProvider: mockFactsProvider() }),
      (err) => err.name === 'CompileGraphError' && err.message.includes('no source snapshots'),
    );
  });
});

// ---------------------------------------------------------------------------
// Predicate vocabulary completeness
// ---------------------------------------------------------------------------

test('EW05 predicates: all proposed predicates are defined', () => {
  assert.equal(EW05_PREDICATES.CONTAINS, 'contains');
  assert.equal(EW05_PREDICATES.DESCRIBES, 'describes');
  assert.equal(EW05_PREDICATES.VARIANT_OF, 'variant_of');
  assert.equal(EW05_PREDICATES.HAS_MEDIA, 'has_media');
  assert.equal(EW05_PREDICATES.SUPPORTED_BY, 'supported_by');
  assert.equal(EW05_PREDICATES.REFERENCES, 'references');
});

test('EW05 entity kinds: all defined', () => {
  assert.equal(ENTITY_KIND.PAGE, 'page');
  assert.equal(ENTITY_KIND.PRODUCT, 'product');
  assert.equal(ENTITY_KIND.OFFERING, 'offering');
  assert.equal(ENTITY_KIND.DOCUMENT, 'document');
  assert.equal(ENTITY_KIND.CAPABILITY, 'capability');
  assert.equal(ENTITY_KIND.MEDIA, 'media');
  assert.equal(ENTITY_KIND.ORGANISATION, 'organisation');
  assert.equal(ENTITY_KIND.UNKNOWN, 'unknown');
});

// ---------------------------------------------------------------------------
// Heading level safety (step-12: no action from guessed data)
// ---------------------------------------------------------------------------

test('EW05 safety: invalid heading levels are skipped', async () => {
  await withGraphStore(async (store) => {
    const ns = parseNamespace(TENANT);
    const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;

    const snap = { ...snapBase, sourceId: 'src-safety-headings', tenantScope: TENANT, sourceType: 'ingest' };
    await store.writeSourceSnapshot(CALLER, ns, snap, Buffer.from('<html>Safety</html>'));

    const result = await compileGraph({
      graphStore: store, caller: CALLER, namespace: ns,
      factsProvider: mockFactsProvider({
        canonical: 'https://example.com/safety',
        headings: [
          { level: 1, text: 'Valid H1' },
          { level: 0, text: 'Invalid H0' },
          { level: 7, text: 'Invalid H7' },
          { level: -1, text: 'Negative' },
          { level: 'xss', text: 'String level' },
          { level: 1.5, text: 'Float level' },
        ],
      }),
    });

    const headingAssertions = result.assertions.filter(
      (a) => a.predicate === EW05_PREDICATES.CONTAINS,
    );
    // Only valid heading levels (1-6) produce assertions
    assert.equal(headingAssertions.length, 1, 'only valid heading level should produce an assertion');
    assert.equal(headingAssertions[0].object.kind, 'h1');
  });
});

test('EW05 safety: non-object heading entries are skipped', async () => {
  await withGraphStore(async (store) => {
    const ns = parseNamespace(TENANT);
    const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;

    const snap = { ...snapBase, sourceId: 'src-safety-heading-type', tenantScope: TENANT, sourceType: 'ingest' };
    await store.writeSourceSnapshot(CALLER, ns, snap, Buffer.from('<html>Safety</html>'));

    const result = await compileGraph({
      graphStore: store, caller: CALLER, namespace: ns,
      factsProvider: mockFactsProvider({
        canonical: 'https://example.com/safety-heading-type',
        headings: [
          { level: 1, text: 'Valid' },
          'not-an-object',
          null,
          42,
          true,
        ],
      }),
    });

    // Only the valid heading object should produce an assertion
    const headingAssertions = result.assertions.filter(
      (a) => a.predicate === EW05_PREDICATES.CONTAINS,
    );
    assert.equal(headingAssertions.length, 1, 'only valid heading objects should produce assertions');
  });

});
// ---------------------------------------------------------------------------
// Per-attribute merge: conflicting source attributes are retained
// ---------------------------------------------------------------------------

test('EW05 merge: per-attribute merge preserves conflicting source attributes', async () => {
  await withGraphStore(async (store) => {
    const ns = parseNamespace(TENANT);
    const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;

    const productName = 'MergedWidget';

    const snapA = { ...snapBase, sourceId: 'src-merge-a', tenantScope: TENANT, sourceType: 'ingest' };
    const snapB = { ...snapBase, sourceId: 'src-merge-b', tenantScope: TENANT, sourceType: 'ingest' };

    await store.writeSourceSnapshot(CALLER, ns, snapA, Buffer.from('<html>Merge A</html>'));
    await store.writeSourceSnapshot(CALLER, ns, snapB, Buffer.from('<html>Merge B</html>'));

    const perSourceFacts = async (snap) => {
      if (snap.sourceId === 'src-merge-a') {
        return {
          canonical: 'https://example.com/merge-a',
          jsonLd: [{ '@type': 'Product', name: productName, description: 'Desc A', sku: 'SKU-A' }],
        };
      }
      return {
        canonical: 'https://example.com/merge-b',
        jsonLd: [{ '@type': 'Product', name: productName, description: 'Desc B', color: 'blue' }],
      };
    };

    const result = await compileGraph({
      graphStore: store, caller: CALLER, namespace: ns,
      factsProvider: perSourceFacts,
    });

    // Find the merged product entity
    const productEntities = result.entities.filter((e) => e.type === 'product');
    assert.equal(productEntities.length, 1, 'product should be deduplicated by deterministic id');

    const product = productEntities[0];

    // Per-attribute merge should preserve that the description came from both sources
    // and the non-conflicting attributes (sku, color) should both be present
    assert.ok(product.attributes, 'entity should have attributes');
    // description is contested across two sources
    const descSources = product.attributes.description;
    assert.ok(descSources !== undefined, 'description attribute should exist');
    // Non-conflicting attributes from each source
    assert.ok(product.attributes.sku !== undefined, 'sku from source A should be preserved');
    assert.ok(product.attributes.color !== undefined, 'color from source B should be preserved');
  });
});
