import "./setup-env.mjs";
// unit.engram-compile-markup.test.mjs — common schema.org product markup
// (priceSpecification, MonetaryAmount, AggregateOffer counts, aggregateRating,
// WooCommerce and Google merchant listing output) compiles into a published
// graph instead of failing graph integrity for the whole site. What cannot be
// typed honestly is recorded as an unresolved fact with its path.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { compileCandidate, compileGraph } from '../src/engram/compile-graph.js';
import { createGraphStore } from '../src/engram/graph-store.js';
import { parseNamespace, createLocalConsent } from '../src/engram/namespace.js';
import { VALID_SOURCE_SNAPSHOT } from '../src/engram/contracts/source-snapshot.js';
import { GRAPH_SCHEMA_VERSION } from '../src/engram/contracts/versions.js';
import { graphSchema, validateGraphIntegrity } from '../src/engram/contracts/graph.js';

const consent = createLocalConsent();
const CALLER = { id: 'agent-test', kind: 'agent' };
const TENANT = 'tenant:ew05-markup';

const money = (currency, exponent) => (amount) => ({ amount, amountUnit: 'major_decimal', currency, exponent });
const usd = money('USD', 2);
const eur = money('EUR', 2);
const gbp = money('GBP', 2);
const chf = money('CHF', 2);
const count = (value) => ({ kind: 'quantity', value, unit: 'count' });

async function withGraphStore(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'engram-ew05-markup-'));
  try {
    return await fn(createGraphStore({ storeRoot: root, consent }));
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// Compile one page whose JSON-LD item is `product` (publishing by default).
async function compileProduct(store, product, compile = compileGraph) {
  const ns = parseNamespace(TENANT);
  const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;
  const snap = { ...snapBase, sourceId: 'src-product-page', tenantScope: TENANT, sourceType: 'ingest' };
  await store.writeSourceSnapshot(CALLER, ns, snap, Buffer.from('<html>Product page</html>'));
  return compile({
    graphStore: store,
    caller: CALLER,
    namespace: ns,
    factsProvider: async () => ({
      title: 'Product page',
      description: 'A product page',
      canonical: 'https://example.com/product',
      headings: [],
      links: [],
      jsonLd: [product],
    }),
  });
}

function entityAttributes(result, type) {
  const entity = result.entities.find((e) => e.type === type);
  assert.ok(entity, `should have a ${type} entity`);
  return entity.attributes;
}

const productAttributes = (result) => entityAttributes(result, 'product');

// unresolved facts with `reason`, keyed by path
function unresolvedByPath(result, reason) {
  return Object.fromEntries(result.unresolvedFacts
    .filter((f) => f.reason === reason)
    .map((f) => [f.path, f.rawValue]));
}

// every unresolved fact as path → [reason, rawValue]
function unresolved(result) {
  return Object.fromEntries(result.unresolvedFacts.map((f) => [f.path, [f.reason, f.rawValue]]));
}

// A hand-built graph with one product entity and, optionally, one assertion.
function handBuiltGraph({ attributes = {}, assertion } = {}) {
  const at = '2026-10-26T08:00:00Z';
  return {
    version: GRAPH_SCHEMA_VERSION,
    generatedAt: '2026-10-26T09:00:00Z',
    entities: [{
      id: 'e1', type: 'product', label: 'Widget', attributes, provenance: 'observed',
      tenantScope: TENANT, sourceId: 'src-hand-built', sourceVersion: '1.0.0', capturedAt: at,
    }],
    assertions: assertion ? [{
      id: 'a1', subject: 'e1', predicate: assertion[0], object: assertion[1],
      provenance: 'observed', schemaValidity: 'unvalidated',
      source: { sourceId: 'src-hand-built', version: '1.0.0', capturedAt: at, tenantScope: TENANT },
    }] : [],
  };
}

// ---------------------------------------------------------------------------
// priceSpecification
// ---------------------------------------------------------------------------

test('EW05 markup: Offer with a strikethrough priceSpecification publishes canonical prices', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Sale',
      sku: 'WS-1',
      offers: {
        '@type': 'Offer',
        price: '19.99',
        priceCurrency: 'USD',
        priceSpecification: {
          '@type': 'UnitPriceSpecification',
          priceType: 'https://schema.org/StrikethroughPrice',
          price: '24.99',
          priceCurrency: 'USD',
        },
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    const { offers } = productAttributes(result);
    assert.deepEqual(offers.price, usd('19.99'));
    assert.deepEqual(offers.priceSpecification.price,
      { amount: '24.99', amountUnit: 'major_decimal', currency: 'USD', exponent: 2 });
    assert.equal(offers.priceSpecification.priceType, 'https://schema.org/StrikethroughPrice');
  });
});

test('EW05 markup: priceSpecification array normalizes every price', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Unit',
      sku: 'WU-1',
      offers: {
        '@type': 'Offer',
        price: '19.99',
        priceCurrency: 'USD',
        priceSpecification: [
          { '@type': 'UnitPriceSpecification', price: '19.99', priceCurrency: 'USD' },
          {
            '@type': 'UnitPriceSpecification',
            priceType: 'https://schema.org/StrikethroughPrice',
            price: '24.99',
            priceCurrency: 'USD',
          },
        ],
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    const specs = productAttributes(result).offers.priceSpecification;
    assert.equal(specs.length, 2);
    assert.deepEqual(specs[0].price, usd('19.99'));
    assert.deepEqual(specs[1].price, usd('24.99'));
    assert.equal(specs[1].priceType, 'https://schema.org/StrikethroughPrice');
  });
});

test('EW05 markup: offers variants with a priceSpecification publish', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Variants',
      sku: 'WV-1',
      offers: [
        {
          '@type': 'Offer',
          sku: 'WV-1-S',
          price: '19.99',
          priceCurrency: 'USD',
          priceSpecification: {
            '@type': 'UnitPriceSpecification',
            priceType: 'https://schema.org/StrikethroughPrice',
            price: '24.99',
            priceCurrency: 'USD',
          },
        },
        { '@type': 'Offer', sku: 'WV-1-L', price: '29.99', priceCurrency: 'USD' },
      ],
    });

    assert.ok(result.version > 0, 'graph should publish');
    const { offers } = productAttributes(result);
    assert.deepEqual(offers[0].price, usd('19.99'));
    assert.deepEqual(offers[0].priceSpecification.price, usd('24.99'));
    assert.equal(offers[0].priceSpecification.priceType, 'https://schema.org/StrikethroughPrice');
    assert.deepEqual(offers[1].price, usd('29.99'));
  });
});

test('EW05 markup: priceSpecification minPrice and maxPrice take the currency in scope of each variant', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Range',
      sku: 'WR-1',
      offers: [
        {
          '@type': 'Offer',
          priceCurrency: 'USD',
          priceSpecification: { '@type': 'PriceSpecification', minPrice: '10.00', maxPrice: '15.00' },
        },
        {
          '@type': 'Offer',
          priceCurrency: 'EUR',
          priceSpecification: [{ '@type': 'PriceSpecification', minPrice: '12.00', maxPrice: '18.00' }],
        },
      ],
    });

    assert.ok(result.version > 0, 'graph should publish');
    const { offers } = productAttributes(result);
    assert.deepEqual(offers[0].priceSpecification,
      { '@type': 'PriceSpecification', minPrice: usd('10.00'), maxPrice: usd('15.00') });
    assert.deepEqual(offers[1].priceSpecification,
      [{ '@type': 'PriceSpecification', minPrice: eur('12.00'), maxPrice: eur('18.00') }]);
  });
});

test('EW05 markup: priceSpecification prices with no currency in scope are reported by path', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget No Currency',
      sku: 'WN-1',
      offers: [{
        '@type': 'Offer',
        priceSpecification: [
          { '@type': 'UnitPriceSpecification', price: '19.99' },
          { '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/StrikethroughPrice', price: '24.99' },
        ],
      }],
    });

    assert.ok(result.version > 0, 'graph should publish without the unpriceable prices');
    assert.deepEqual(productAttributes(result).offers[0].priceSpecification, [
      { '@type': 'UnitPriceSpecification' },
      { '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/StrikethroughPrice' },
    ]);
    assert.deepEqual(unresolvedByPath(result, 'currency_missing'), {
      'offers[0].priceSpecification[0].price': '19.99',
      'offers[0].priceSpecification[1].price': '24.99',
    });
  });
});

// ---------------------------------------------------------------------------
// Counts and ratings
// ---------------------------------------------------------------------------

test('EW05 markup: AggregateOffer offerCount becomes a count quantity', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Market',
      sku: 'WM-1',
      offers: {
        '@type': 'AggregateOffer',
        lowPrice: '1.00',
        highPrice: '9.00',
        priceCurrency: 'USD',
        offerCount: 3,
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    const { offers } = productAttributes(result);
    assert.deepEqual(offers.offerCount, { kind: 'quantity', value: 3, unit: 'count' });
    assert.deepEqual(offers.lowPrice, usd('1.00'));
    assert.deepEqual(offers.highPrice, usd('9.00'));
  });
});

test('EW05 markup: aggregateRating publishes its count and reports the untyped rating by path', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Rated',
      sku: 'WT-1',
      aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.6, reviewCount: 128 },
    });

    assert.ok(result.version > 0, 'graph should publish');
    const { aggregateRating } = productAttributes(result);
    assert.deepEqual(aggregateRating.reviewCount, count(128));
    assert.equal(Object.hasOwn(aggregateRating, 'ratingValue'), false, 'an untyped rating is not published');

    const fact = result.unresolvedFacts.find((f) => f.path === 'aggregateRating.ratingValue');
    assert.ok(fact, 'the rating should be reported with its path');
    assert.equal(fact.field, 'ratingValue');
    assert.equal(fact.rawValue, 4.6);
    assert.equal(fact.reason, 'untyped_number');
    const published = result.graph.unresolvedFacts.find((f) => f.field === 'ratingValue');
    assert.equal(published?.reason, 'untyped_number', 'the published graph records the rating too');
    assert.equal(published.path, 'aggregateRating.ratingValue', 'and publishes its path');
  });
});

test('EW05 markup: only whole non-negative counts become quantities; other numbers are reported by path', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Measured',
      sku: 'WE-1',
      offers: {
        '@type': 'AggregateOffer',
        lowPrice: '1.00',
        priceCurrency: 'USD',
        offerCount: 2.5,
        priceSpecification: {
          '@type': 'UnitPriceSpecification',
          price: '1.00',
          referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'KGM' },
        },
      },
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: 4.6,
        bestRating: 5,
        worstRating: 1,
        ratingCount: 140,
        reviewCount: -1,
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    const { offers, aggregateRating } = productAttributes(result);
    assert.deepEqual(aggregateRating, { '@type': 'AggregateRating', ratingCount: count(140) });
    assert.equal(Object.hasOwn(offers, 'offerCount'), false);
    assert.deepEqual(offers.priceSpecification, {
      '@type': 'UnitPriceSpecification',
      price: usd('1.00'),
      referenceQuantity: { '@type': 'QuantitativeValue', unitCode: 'KGM' },
    });
    assert.deepEqual(unresolvedByPath(result, 'untyped_number'), {
      'offers.offerCount': 2.5,
      'offers.priceSpecification.referenceQuantity.value': 1,
      'aggregateRating.ratingValue': 4.6,
      'aggregateRating.bestRating': 5,
      'aggregateRating.worstRating': 1,
      'aggregateRating.reviewCount': -1,
    });
  });
});

test('EW05 markup: an array holding bare numbers is reported whole, never spliced', async () => {
  await withGraphStore(async (store) => {
    const review = [{
      '@type': 'Review',
      reviewRating: { '@type': 'Rating', ratingValue: 5 },
      author: { '@type': 'Person', name: 'Sam' },
    }];
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Sizes',
      sku: 'WZ-1',
      size: [8, 9, 10],
      review,
      image: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
      offers: { '@type': 'Offer', price: '19.99', priceCurrency: 'USD' },
    });

    assert.ok(result.version > 0, 'graph should publish');
    const attributes = productAttributes(result);
    assert.equal(Object.hasOwn(attributes, 'size'), false);
    assert.equal(Object.hasOwn(attributes, 'review'), false);
    assert.deepEqual(attributes.image, ['https://example.com/a.jpg', 'https://example.com/b.jpg']);
    assert.deepEqual(attributes.offers.price, usd('19.99'));
    assert.deepEqual(unresolvedByPath(result, 'untyped_number'), { size: [8, 9, 10], review });
  });
});

test('EW05 markup: a number JSON reads as Infinity is reported without a raw value and the graph publishes', async () => {
  await withGraphStore(async (store) => {
    // JSON.parse turns an overflowing literal such as 1e999 into Infinity.
    const result = await compileProduct(store, JSON.parse(`{
      "@type": "Product",
      "name": "Widget Overflow",
      "sku": "WO-1",
      "offers": { "@type": "Offer", "price": 1e999, "priceCurrency": "USD" },
      "aggregateRating": { "@type": "AggregateRating", "ratingValue": 1e999, "reviewCount": 3 }
    }`));

    assert.ok(result.version > 0, 'graph should publish');
    const { offers, aggregateRating } = productAttributes(result);
    assert.deepEqual(offers, { '@type': 'Offer', priceCurrency: 'USD' });
    assert.deepEqual(aggregateRating, { '@type': 'AggregateRating', reviewCount: count(3) });
    assert.deepEqual(
      result.unresolvedFacts.map((f) => [f.path, f.reason, Object.hasOwn(f, 'rawValue')]),
      [['offers.price', 'amount_invalid', false], ['aggregateRating.ratingValue', 'untyped_number', false]],
    );
  });
});

// ---------------------------------------------------------------------------
// Unchanged behaviour
// ---------------------------------------------------------------------------

test('EW05 markup: a plain Offer compiles exactly as before', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Plain',
      sku: 'WP-1',
      offers: {
        '@type': 'Offer',
        price: '29.99',
        priceCurrency: 'USD',
        availability: 'https://schema.org/InStock',
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(productAttributes(result), {
      name: 'Widget Plain',
      sku: 'WP-1',
      offers: {
        '@type': 'Offer',
        price: usd('29.99'),
        priceCurrency: 'USD',
        availability: 'https://schema.org/InStock',
      },
    });
    assert.equal(result.graph.unresolvedFacts, undefined);
    const offers = result.assertions.find((a) => a.predicate === 'describes_offers');
    assert.equal(typeof offers?.object, 'string', 'an offer attribute assertion is still a string');
  });
});

test('EW05 markup: a two-variant offers array compiles exactly as before', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Pair',
      sku: 'WP-2',
      offers: [
        { '@type': 'Offer', sku: 'WP-2-S', price: '7.00', priceCurrency: 'USD', url: 'https://example.com/product?variant=1' },
        { '@type': 'Offer', sku: 'WP-2-L', price: '12.00', priceCurrency: 'USD', url: 'https://example.com/product?variant=2' },
      ],
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(productAttributes(result), {
      name: 'Widget Pair',
      sku: 'WP-2',
      offers: [
        { '@type': 'Offer', sku: 'WP-2-S', price: usd('7.00'), priceCurrency: 'USD', url: 'https://example.com/product?variant=1' },
        { '@type': 'Offer', sku: 'WP-2-L', price: usd('12.00'), priceCurrency: 'USD', url: 'https://example.com/product?variant=2' },
      ],
    });
    assert.equal(result.graph.unresolvedFacts, undefined);
  });
});

test('EW05 markup: explicit quantities and canonical money pass through unchanged', async () => {
  await withGraphStore(async (store) => {
    const typed = {
      weight: { kind: 'quantity', value: 1.5, unit: 'kg' },
      offers: { '@type': 'AggregateOffer', lowPrice: usd('1.00'), offerCount: count(3) },
    };
    const result = await compileProduct(store, { '@type': 'Product', name: 'Widget Typed', sku: 'WY-1', ...typed });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(productAttributes(result), { name: 'Widget Typed', sku: 'WY-1', ...typed });
    assert.equal(result.graph.unresolvedFacts, undefined);
  });
});

test('EW05 markup: negative canonical money is rejected in the pass-through', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Negative Canonical',
      sku: 'WNC-1',
      offers: {
        '@type': 'Offer',
        priceCurrency: 'USD',
        price: usd('-5.00'),
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(unresolved(result), {
      'offers.price': ['amount_invalid', usd('-5.00')],
    });
  });
});

test('EW05 markup: the graph contract still rejects a hand-built bare number', async () => {
  await withGraphStore(async (store) => {
    const ns = parseNamespace(TENANT);
    const graphWithScore = (score) => ({
      version: GRAPH_SCHEMA_VERSION,
      generatedAt: '2026-10-26T09:00:00Z',
      entities: [{
        id: 'e1',
        type: 'product',
        label: 'Widget',
        attributes: { score },
        provenance: 'observed',
        tenantScope: TENANT,
        sourceId: 'src-hand-built',
        sourceVersion: '1.0.0',
        capturedAt: '2026-10-26T08:00:00Z',
      }],
      assertions: [],
    });

    // Control: the same graph publishes once the number is typed.
    const typed = await store.publishGraph(CALLER, ns, graphWithScore({ kind: 'quantity', value: 4.6, unit: 'ratio' }));
    assert.ok(typed.version > 0);

    await assert.rejects(
      () => store.publishGraph(CALLER, ns, graphWithScore(4.6)),
      (err) => err.name === 'GraphValidationError' && /attributes\.score: untyped numeric fact/.test(err.message),
    );
  });
});

// ---------------------------------------------------------------------------
// priceSpecification holds prices; a bare value under it is a price
// ---------------------------------------------------------------------------

test('EW05 markup: the graph contract reads a bare value under a price specification name as a price', () => {
  for (const attributes of [
    { offers: { priceSpecification: '19.99' } },
    { priceSpecification: [{ price: usd('10.00') }, '24.99'] },
    { priceSpecification: [{ price: usd('10.00') }, 24.99] },
    { priceSpecification: [[{ price: usd('10.00') }]] },
    { fooPriceSpecification: '19.99' },
    { shippingCostSpecification: '5.00' },
  ]) {
    assert.equal(validateGraphIntegrity(handBuiltGraph({ attributes })).valid, false, JSON.stringify(attributes));
  }
  for (const attributes of [
    { offers: { priceSpecification: { price: usd('10.00') } } },
    { priceSpecification: [{ price: usd('10.00') }, null] },
    { priceSpecification: [] },
    { priceSpecification: null },
    { fooPriceSpecification: { price: usd('10.00') } },
  ]) {
    assert.equal(validateGraphIntegrity(handBuiltGraph({ attributes })).valid, true, JSON.stringify(attributes));
  }
  assert.equal(validateGraphIntegrity(handBuiltGraph({
    assertion: ['describes_priceSpecification', '19.99'],
  })).valid, false, 'an assertion cannot publish a bare price specification either');
  assert.equal(validateGraphIntegrity(handBuiltGraph({
    assertion: ['describes_priceSpecification', { price: usd('10.00') }],
  })).valid, true);
});

test('EW05 markup: a bare value under priceSpecification is recorded, and list items keep their paths', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Bare Spec',
      sku: 'WB-1',
      priceSpecification: '19.99',
      offers: [
        { '@type': 'Offer', price: '9.99', priceCurrency: 'USD', priceSpecification: '19.99' },
        {
          '@type': 'Offer',
          price: '9.99',
          priceCurrency: 'USD',
          priceSpecification: ['8.99', { price: '7.99', priceCurrency: 'points' }, { price: '6.99' }, null],
        },
      ],
    });

    assert.ok(result.version > 0, 'graph should publish');
    const attributes = productAttributes(result);
    assert.equal(Object.hasOwn(attributes, 'priceSpecification'), false);
    assert.deepEqual(attributes.offers, [
      { '@type': 'Offer', price: usd('9.99'), priceCurrency: 'USD' },
      {
        '@type': 'Offer',
        price: usd('9.99'),
        priceCurrency: 'USD',
        priceSpecification: [null, { priceCurrency: 'points' }, { price: usd('6.99') }, null],
      },
    ]);
    assert.deepEqual(unresolved(result), {
      priceSpecification: ['not_an_object', '19.99'],
      'offers[0].priceSpecification': ['not_an_object', '19.99'],
      'offers[1].priceSpecification[0]': ['not_an_object', '8.99'],
      'offers[1].priceSpecification[1].price': ['currency_missing', '7.99'],
    });
    assert.equal(result.assertions.some((a) => a.predicate === 'describes_priceSpecification'), false,
      'no assertion publishes the bare value');
  });
});

test('EW05 markup: a priceSpecification of a top-level Offer takes its currency and its assertion carries the object', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Offer',
      '@id': 'https://example.com/product#offer',
      price: '19.99',
      priceCurrency: 'USD',
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        priceType: 'https://schema.org/StrikethroughPrice',
        price: '24.99',
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    const offer = entityAttributes(result, 'offering');
    assert.deepEqual(offer.priceSpecification, {
      '@type': 'UnitPriceSpecification',
      priceType: 'https://schema.org/StrikethroughPrice',
      price: usd('24.99'),
    });
    const spec = result.assertions.find((a) => a.predicate === 'describes_priceSpecification');
    assert.deepEqual(spec?.object, offer.priceSpecification, 'the assertion is the typed object, not a string');
    assert.equal(result.graph.unresolvedFacts, undefined);
  });
});

test('EW05 markup: a null priceSpecification is kept and a null price is recorded', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Nulls',
      sku: 'WN-2',
      offers: { '@type': 'Offer', price: null, priceCurrency: 'USD', priceSpecification: null },
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(productAttributes(result).offers,
      { '@type': 'Offer', priceCurrency: 'USD', priceSpecification: null });
    assert.deepEqual(unresolved(result), { 'offers.price': ['amount_invalid', null] });
  });
});

// ---------------------------------------------------------------------------
// Currency in scope
// ---------------------------------------------------------------------------

test('EW05 markup: a declared currency the registry does not know is never replaced by the offer currency', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Currencies',
      sku: 'WC-1',
      offers: {
        '@type': 'Offer',
        price: '12.00',
        priceCurrency: 'USD',
        priceSpecification: [
          {
            price: '1200',
            priceCurrency: 'points',
            eligibleTransactionVolume: { '@type': 'PriceSpecification', price: '100' },
          },
          { price: '93.00', priceCurrency: 'HKD' },
          { price: '11.00', minPrice: '10.00', priceCurrency: 'eur' },
          { price: '13.00', priceCurrency: 'USD', currency: 'EUR' },
          { price: '14.00', priceCurrency: null },
          { price: '15.00' },
        ],
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(productAttributes(result).offers.priceSpecification, [
      { priceCurrency: 'points', eligibleTransactionVolume: { '@type': 'PriceSpecification' } },
      { priceCurrency: 'HKD' },
      { priceCurrency: 'eur' },
      { priceCurrency: 'USD', currency: 'EUR' },
      { price: usd('14.00'), priceCurrency: null },
      { price: usd('15.00') },
    ]);
    assert.deepEqual(unresolvedByPath(result, 'currency_missing'), {
      'offers.priceSpecification[0].price': '1200',
      'offers.priceSpecification[0].eligibleTransactionVolume.price': '100',
      'offers.priceSpecification[1].price': '93.00',
      'offers.priceSpecification[2].price': '11.00',
      'offers.priceSpecification[2].minPrice': '10.00',
      'offers.priceSpecification[3].price': '13.00',
    });
  });
});

test('EW05 markup: a price specification or MonetaryAmount keeps its own currency inside an offer in another', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Own Currency',
      sku: 'WO-2',
      offers: [{
        '@type': 'Offer',
        price: '10.00',
        priceCurrency: 'USD',
        priceSpecification: [{ '@type': 'UnitPriceSpecification', price: '9.00', priceCurrency: 'EUR' }],
        shippingDetails: {
          '@type': 'OfferShippingDetails',
          shippingRate: { '@type': 'MonetaryAmount', value: '3.49', currency: 'GBP' },
        },
      }],
    });

    assert.ok(result.version > 0, 'graph should publish');
    const [offer] = productAttributes(result).offers;
    assert.deepEqual(offer.price, usd('10.00'));
    assert.deepEqual(offer.priceSpecification[0].price, eur('9.00'));
    assert.deepEqual(offer.shippingDetails.shippingRate, gbp('3.49'));
  });
});

test('EW05 markup: an amount that is not a decimal is amount_invalid even with no currency in scope', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget No Offer Currency',
      sku: 'WN-3',
      offers: { '@type': 'Offer', price: '19.99', priceValidUntil: '2026-11-30' },
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(unresolved(result), {
      'offers.price': ['currency_missing', '19.99'],
      'offers.priceValidUntil': ['amount_invalid', '2026-11-30'],
    });
  });
});

// ---------------------------------------------------------------------------
// MonetaryAmount
// ---------------------------------------------------------------------------

test('EW05 markup: a MonetaryAmount { value, currency } publishes as canonical money or is recorded whole', async () => {
  await withGraphStore(async (store) => {
    const rate = (shippingRate) => ({ '@type': 'OfferShippingDetails', shippingRate });
    const points = { '@type': 'MonetaryAmount', value: '7.00', currency: 'points' };
    const free = { '@type': 'MonetaryAmount', value: 'free', currency: 'USD' };
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Shipping',
      sku: 'WS-2',
      offers: {
        '@type': 'Offer',
        price: '39.99',
        priceCurrency: 'USD',
        shippingDetails: [
          rate({ '@type': 'MonetaryAmount', value: '3.49', currency: 'USD' }),
          rate({ value: 0, currency: 'USD' }),
          rate({ '@type': 'MonetaryAmount', value: 5 }),
          rate(points),
          rate(free),
        ],
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(productAttributes(result).offers.shippingDetails, [
      rate(usd('3.49')),
      rate(usd('0')),
      rate(usd('5')),
      { '@type': 'OfferShippingDetails' },
      { '@type': 'OfferShippingDetails' },
    ]);
    assert.deepEqual(unresolved(result), {
      'offers.shippingDetails[3].shippingRate': ['currency_missing', points],
      'offers.shippingDetails[4].shippingRate': ['amount_invalid', free],
    });
  });
});

test('EW05 markup: the amounts of a larger MonetaryAmount are typed in place; a QuantitativeValue is not money', async () => {
  await withGraphStore(async (store) => {
    const fee = { '@type': 'MonetaryAmount', value: '2.99', currency: 'USD', validThrough: '2026-12-31' };
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Amounts',
      sku: 'WA-1',
      offers: {
        '@type': 'Offer',
        price: '39.99',
        priceCurrency: 'USD',
        priceSpecification: {
          price: '39.99',
          referenceQuantity: { '@type': 'QuantitativeValue', value: '1', unitCode: 'KGM' },
          eligibleQuantity: { value: '2', unitCode: 'C62' },
        },
        shippingDetails: [
          {
            '@type': 'OfferShippingDetails',
            shippingRate: { '@type': 'MonetaryAmount', value: '3.49', currency: 'EUR', validThrough: '2026-12-31' },
          },
          {
            '@type': 'OfferShippingDetails',
            shippingRate: { '@type': 'MonetaryAmount', minValue: 0, maxValue: '10.00', currency: 'USD' },
          },
        ],
        hasMerchantReturnPolicy: { '@type': 'MerchantReturnPolicy', returnShippingFeesAmount: fee },
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    const { offers } = productAttributes(result);
    assert.deepEqual(offers.priceSpecification, {
      price: usd('39.99'),
      referenceQuantity: { '@type': 'QuantitativeValue', value: '1', unitCode: 'KGM' },
      eligibleQuantity: { value: '2', unitCode: 'C62' },
    });
    assert.deepEqual(offers.shippingDetails, [
      {
        '@type': 'OfferShippingDetails',
        shippingRate: { '@type': 'MonetaryAmount', value: eur('3.49'), currency: 'EUR', validThrough: '2026-12-31' },
      },
      {
        '@type': 'OfferShippingDetails',
        shippingRate: { '@type': 'MonetaryAmount', minValue: usd('0'), maxValue: usd('10.00'), currency: 'USD' },
      },
    ]);
    // Under a money name the graph contract requires canonical money itself.
    assert.deepEqual(offers.hasMerchantReturnPolicy, { '@type': 'MerchantReturnPolicy' });
    assert.deepEqual(unresolved(result), {
      'offers.hasMerchantReturnPolicy.returnShippingFeesAmount': ['amount_invalid', fee],
    });
  });
});

test('EW05 markup: a MonetaryAmount whose value is a QuantitativeValue is not one amount', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'JobPosting',
      title: 'Barista',
      identifier: 'job-1',
      baseSalary: {
        '@type': 'MonetaryAmount',
        currency: 'USD',
        value: { '@type': 'QuantitativeValue', value: 40, unitText: 'HOUR' },
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(entityAttributes(result, 'unknown').baseSalary, {
      '@type': 'MonetaryAmount',
      currency: 'USD',
      value: { '@type': 'QuantitativeValue', unitText: 'HOUR' },
    });
    assert.deepEqual(unresolved(result), { 'baseSalary.value.value': ['untyped_number', 40] });
  });
});

// ---------------------------------------------------------------------------
// Money is decided by field name, as the graph contract decides it
// ---------------------------------------------------------------------------

test('EW05 markup: every value under a money name is typed as money or recorded', async () => {
  await withGraphStore(async (store) => {
    const notMoney = { amount: '12.00', amountUnit: 'major_decimal', currency: 'USD', exponent: 2, note: 'x' };
    const tier = { kind: 'quantity', value: 2, unit: 'count' };
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Names',
      sku: 'WM-2',
      offers: {
        '@type': 'Offer',
        priceCurrency: 'USD',
        price: '-5.00',
        salePrice: '9.99',
        balance: '-5.00',
        listPrice: notMoney,
        priceValidUntil: '2026-11-30',
        valueAddedTaxIncluded: true,
        priceTier: tier,
        priceType: 'https://schema.org/SalePrice',
        shippingCostSpecification: '4.99',
        handlingPriceSpecification: { price: '2.00' },
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(productAttributes(result).offers, {
      '@type': 'Offer',
      priceCurrency: 'USD',
      salePrice: usd('9.99'),
      priceType: 'https://schema.org/SalePrice',
      shippingCostSpecification: usd('4.99'),
      handlingPriceSpecification: { price: usd('2.00') },
    });
    assert.deepEqual(unresolved(result), {
      'offers.price': ['amount_invalid', '-5.00'],
      'offers.balance': ['amount_invalid', '-5.00'],
      'offers.listPrice': ['amount_invalid', notMoney],
      'offers.priceValidUntil': ['amount_invalid', '2026-11-30'],
      'offers.valueAddedTaxIncluded': ['amount_invalid', true],
      'offers.priceTier': ['amount_invalid', tier],
    });
  });
});

test('EW05 markup: a list of canonical money publishes under a plural money name only', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Price List',
      sku: 'WL-2',
      prices: [usd('1.00'), usd('2.00')],
      price: [usd('3.00')],
    });

    assert.ok(result.version > 0, 'graph should publish');
    const attributes = productAttributes(result);
    assert.deepEqual(attributes.prices, [usd('1.00'), usd('2.00')]);
    assert.equal(Object.hasOwn(attributes, 'price'), false);
    assert.deepEqual(unresolved(result), { price: ['amount_invalid', [usd('3.00')]] });
    const prices = result.assertions.find((a) => a.predicate === 'describes_prices');
    assert.deepEqual(prices?.object, [usd('1.00'), usd('2.00')], 'the assertion is the list, not a string');
  });
});

// WooCommerce class-wc-structured-data.php (trunk), generate_product_data():
// prices are formatted decimal strings, valueAddedTaxIncluded is a boolean set
// when taxes are enabled, priceValidUntil is a date on every offer, and the
// offer price is copied from the first UnitPriceSpecification.
test('EW05 markup: a WooCommerce simple product on sale publishes', async () => {
  await withGraphStore(async (store) => {
    const seller = { '@type': 'Organization', name: 'Shop', url: 'https://shop.example' };
    const review = [{
      '@type': 'Review',
      reviewRating: { '@type': 'Rating', bestRating: '5', ratingValue: '5', worstRating: '1' },
      author: { '@type': 'Person', name: 'Sam' },
      reviewBody: 'Warm and soft.',
      datePublished: '2026-10-01T10:00:00+00:00',
    }];
    const result = await compileProduct(store, {
      '@type': 'Product',
      '@id': 'https://shop.example/product/hoodie/#product',
      name: 'Hoodie',
      url: 'https://shop.example/product/hoodie/',
      description: 'A warm hoodie.',
      image: 'https://shop.example/wp-content/uploads/hoodie.jpg',
      sku: 'woo-hoodie',
      offers: [{
        '@type': 'Offer',
        priceSpecification: [
          {
            '@type': 'UnitPriceSpecification',
            price: '42.00',
            priceCurrency: 'USD',
            validThrough: '2026-11-30',
            valueAddedTaxIncluded: false,
          },
          {
            '@type': 'UnitPriceSpecification',
            price: '45.00',
            priceCurrency: 'USD',
            validThrough: '2027-12-31',
            valueAddedTaxIncluded: false,
            priceType: 'https://schema.org/ListPrice',
          },
        ],
        priceValidUntil: '2026-11-30',
        availability: 'https://schema.org/InStock',
        url: 'https://shop.example/product/hoodie/',
        seller,
        price: '42.00',
        priceCurrency: 'USD',
      }],
      aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.50', reviewCount: 2 },
      review,
    });

    assert.ok(result.version > 0, 'graph should publish');
    const attributes = productAttributes(result);
    assert.deepEqual(attributes.offers, [{
      '@type': 'Offer',
      priceSpecification: [
        { '@type': 'UnitPriceSpecification', price: usd('42.00'), priceCurrency: 'USD', validThrough: '2026-11-30' },
        {
          '@type': 'UnitPriceSpecification',
          price: usd('45.00'),
          priceCurrency: 'USD',
          validThrough: '2027-12-31',
          priceType: 'https://schema.org/ListPrice',
        },
      ],
      availability: 'https://schema.org/InStock',
      url: 'https://shop.example/product/hoodie/',
      seller,
      price: usd('42.00'),
      priceCurrency: 'USD',
    }]);
    assert.deepEqual(attributes.aggregateRating,
      { '@type': 'AggregateRating', ratingValue: '4.50', reviewCount: count(2) });
    assert.deepEqual(attributes.review, review);
    assert.deepEqual(unresolved(result), {
      'offers[0].priceSpecification[0].valueAddedTaxIncluded': ['amount_invalid', false],
      'offers[0].priceSpecification[1].valueAddedTaxIncluded': ['amount_invalid', false],
      'offers[0].priceValidUntil': ['amount_invalid', '2026-11-30'],
    });
  });
});

test('EW05 markup: a WooCommerce variable product (AggregateOffer with a sale price) publishes', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      '@id': 'https://shop.example/product/tee/#product',
      name: 'Tee',
      url: 'https://shop.example/product/tee/',
      description: 'A tee.',
      // With no SKU, WooCommerce falls back to the numeric product id.
      sku: 1234,
      offers: [{
        '@type': 'AggregateOffer',
        lowPrice: '18.00',
        highPrice: '24.00',
        offerCount: 3,
        priceSpecification: [{
          '@type': 'UnitPriceSpecification',
          priceType: 'https://schema.org/SalePrice',
          price: '15.00',
          priceCurrency: 'USD',
          validThrough: '2026-11-30',
          valueAddedTaxIncluded: true,
        }],
        priceValidUntil: '2026-11-30',
        availability: 'https://schema.org/InStock',
        url: 'https://shop.example/product/tee/',
        seller: { '@type': 'Organization', name: 'Shop', url: 'https://shop.example' },
        priceCurrency: 'USD',
      }],
    });

    assert.ok(result.version > 0, 'graph should publish');
    const [offer] = productAttributes(result).offers;
    assert.deepEqual(offer.lowPrice, usd('18.00'));
    assert.deepEqual(offer.highPrice, usd('24.00'));
    assert.deepEqual(offer.offerCount, count(3));
    assert.deepEqual(offer.priceSpecification, [{
      '@type': 'UnitPriceSpecification',
      priceType: 'https://schema.org/SalePrice',
      price: usd('15.00'),
      priceCurrency: 'USD',
      validThrough: '2026-11-30',
    }]);
    assert.deepEqual(unresolved(result), {
      'offers[0].priceSpecification[0].valueAddedTaxIncluded': ['amount_invalid', true],
      'offers[0].priceValidUntil': ['amount_invalid', '2026-11-30'],
    });
  });
});

// Google Search Central, merchant listing structured data: the "Return
// details" and "Shipping details" examples.
test('EW05 markup: the Google merchant listing return details example publishes', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      sku: 'trinket-12345',
      gtin14: '00012345600012',
      image: ['https://example.com/photos/16x9/trinket.jpg', 'https://example.com/photos/1x1/trinket.jpg'],
      name: 'Nice trinket',
      description: 'Trinket with clean lines',
      brand: { '@type': 'Brand', name: 'MyBrand' },
      offers: {
        '@type': 'Offer',
        url: 'https://www.example.com/trinket_offer',
        itemCondition: 'https://schema.org/NewCondition',
        availability: 'https://schema.org/InStock',
        priceSpecification: { '@type': 'PriceSpecification', price: 39.99, priceCurrency: 'CHF' },
        hasMerchantReturnPolicy: {
          '@type': 'MerchantReturnPolicy',
          applicableCountry: 'CH',
          returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
          merchantReturnDays: 60,
          returnMethod: 'https://schema.org/ReturnByMail',
          returnFees: 'https://schema.org/ReturnShippingFees',
          returnShippingFeesAmount: { '@type': 'MonetaryAmount', value: 3.49, currency: 'CHF' },
        },
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    const { offers } = productAttributes(result);
    assert.deepEqual(offers.priceSpecification,
      { '@type': 'PriceSpecification', price: chf('39.99'), priceCurrency: 'CHF' });
    assert.deepEqual(offers.hasMerchantReturnPolicy, {
      '@type': 'MerchantReturnPolicy',
      applicableCountry: 'CH',
      returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
      returnMethod: 'https://schema.org/ReturnByMail',
      returnShippingFeesAmount: chf('3.49'),
    });
    assert.deepEqual(unresolved(result), {
      'offers.hasMerchantReturnPolicy.merchantReturnDays': ['untyped_number', 60],
      'offers.hasMerchantReturnPolicy.returnFees': ['amount_invalid', 'https://schema.org/ReturnShippingFees'],
    });
  });
});

test('EW05 markup: the Google merchant listing shipping details example publishes', async () => {
  await withGraphStore(async (store) => {
    const days = (minValue, maxValue) => ({ '@type': 'QuantitativeValue', minValue, maxValue, unitCode: 'DAY' });
    const result = await compileProduct(store, {
      '@type': 'Product',
      sku: 'trinket-12345',
      gtin14: '00012345600012',
      name: 'Nice trinket',
      description: 'Trinket with clean lines',
      offers: {
        '@type': 'Offer',
        url: 'https://www.example.com/trinket_offer',
        itemCondition: 'https://schema.org/NewCondition',
        availability: 'https://schema.org/InStock',
        price: 39.99,
        priceCurrency: 'USD',
        priceValidUntil: '2024-11-20',
        shippingDetails: {
          '@type': 'OfferShippingDetails',
          shippingRate: { '@type': 'MonetaryAmount', value: 3.49, currency: 'USD' },
          shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'US' },
          deliveryTime: { '@type': 'ShippingDeliveryTime', handlingTime: days(0, 1), transitTime: days(1, 5) },
        },
      },
      review: {
        '@type': 'Review',
        reviewRating: { '@type': 'Rating', ratingValue: 4, bestRating: 5 },
        author: { '@type': 'Person', name: 'Fred Benson' },
      },
      aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.4, reviewCount: 89 },
    });

    assert.ok(result.version > 0, 'graph should publish');
    const { offers, aggregateRating } = productAttributes(result);
    assert.deepEqual(offers.price, usd('39.99'));
    assert.deepEqual(offers.shippingDetails.shippingRate, usd('3.49'));
    assert.deepEqual(aggregateRating.reviewCount, count(89));
    assert.deepEqual(unresolved(result), {
      'offers.priceValidUntil': ['amount_invalid', '2024-11-20'],
      'offers.shippingDetails.deliveryTime.handlingTime.minValue': ['untyped_number', 0],
      'offers.shippingDetails.deliveryTime.handlingTime.maxValue': ['untyped_number', 1],
      'offers.shippingDetails.deliveryTime.transitTime.minValue': ['untyped_number', 1],
      'offers.shippingDetails.deliveryTime.transitTime.maxValue': ['untyped_number', 5],
      'review.reviewRating.ratingValue': ['untyped_number', 4],
      'review.reviewRating.bestRating': ['untyped_number', 5],
      'aggregateRating.ratingValue': ['untyped_number', 4.4],
    });
  });
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

test('EW05 markup: a bare value in a money-container list is recorded and nulled; later items keep their index', async () => {
  await withGraphStore(async (store) => {
    const nested = [{ '@type': 'Offer', price: '11.00', priceCurrency: 'USD' }, 3];
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Mixed Lists',
      sku: 'WX-1',
      offers: [
        {
          '@type': 'Offer',
          price: '10.00',
          priceCurrency: 'USD',
          priceSpecification: [{ price: '10.00' }, 24.99, { price: '12.00' }],
        },
        19.99,
        nested,
        null,
        { '@type': 'Offer', price: '13.00' },
      ],
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(productAttributes(result).offers, [
      {
        '@type': 'Offer',
        price: usd('10.00'),
        priceCurrency: 'USD',
        priceSpecification: [{ price: usd('10.00') }, null, { price: usd('12.00') }],
      },
      null,
      null,
      null,
      { '@type': 'Offer' },
    ]);
    assert.deepEqual(unresolved(result), {
      'offers[0].priceSpecification[1]': ['not_an_object', 24.99],
      'offers[1]': ['not_an_object', 19.99],
      'offers[2]': ['not_an_object', nested],
      'offers[4].price': ['currency_missing', '13.00'],
    });
  });
});

test('EW05 markup: a list outside the money containers publishes when typed, else is recorded whole with its reason', async () => {
  await withGraphStore(async (store) => {
    // JSON.parse turns the overflowing literal 1e999 into Infinity.
    const result = await compileProduct(store, JSON.parse(`{
      "@type": "Product",
      "name": "Widget Lists",
      "sku": "WL-3",
      "sizes": [{ "kind": "quantity", "value": 8, "unit": "count" }],
      "deposits": [{ "amount": "5.00", "amountUnit": "major_decimal", "currency": "USD", "exponent": 2 }],
      "size": [8, 1e999],
      "isRelatedTo": [{ "@type": "Product", "sku": "WL-3-S", "offers": { "price": 17.5, "priceCurrency": "USD" } }],
      "history": [{ "price": { "amount": "1.00", "amountUnit": "major_decimal", "currency": "USD", "exponent": 2 }, "views": 3 }]
    }`));

    assert.ok(result.version > 0, 'graph should publish');
    const attributes = productAttributes(result);
    assert.deepEqual(attributes.sizes, [count(8)]);
    assert.deepEqual(attributes.deposits, [usd('5.00')]);
    for (const key of ['size', 'isRelatedTo', 'history']) assert.equal(Object.hasOwn(attributes, key), false, key);
    assert.deepEqual(
      result.unresolvedFacts.map((f) => [f.path, f.reason, Object.hasOwn(f, 'rawValue')]),
      [['size', 'untyped_number', false], ['isRelatedTo', 'untyped_money', true], ['history', 'untyped_number', true]],
    );
  });
});

// ---------------------------------------------------------------------------
// Counts and ranges
// ---------------------------------------------------------------------------

test('EW05 markup: a zero count is a count; capitalized count names count; an unsafe integer does not', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Counts',
      sku: 'WC-2',
      offers: { '@type': 'AggregateOffer', lowPrice: '1.00', priceCurrency: 'USD', offerCount: 0, OfferCount: 1 },
      aggregateRating: { '@type': 'AggregateRating', ReviewCount: 3, RatingCount: 4, reviewCount: 2 ** 53 },
    });

    assert.ok(result.version > 0, 'graph should publish');
    const { offers, aggregateRating } = productAttributes(result);
    assert.deepEqual(offers.offerCount, count(0));
    assert.deepEqual(offers.OfferCount, count(1));
    assert.deepEqual(aggregateRating, { '@type': 'AggregateRating', ReviewCount: count(3), RatingCount: count(4) });
    assert.deepEqual(unresolved(result), { 'aggregateRating.reviewCount': ['untyped_number', 2 ** 53] });
  });
});

test('EW05 markup: an inverted price range publishes neither end', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Ranges',
      sku: 'WR-2',
      offers: [
        { '@type': 'AggregateOffer', lowPrice: '50.00', highPrice: '10.00', priceCurrency: 'USD' },
        { '@type': 'Offer', priceCurrency: 'USD', priceSpecification: { minPrice: '10.00', maxPrice: '10.00' } },
        { '@type': 'Offer', priceCurrency: 'USD', priceSpecification: { minPrice: '9.99', maxPrice: '10.00' } },
        { '@type': 'AggregateOffer', lowPrice: eur('50.00'), highPrice: usd('10.00') },
      ],
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(productAttributes(result).offers, [
      { '@type': 'AggregateOffer', priceCurrency: 'USD' },
      { '@type': 'Offer', priceCurrency: 'USD', priceSpecification: { minPrice: usd('10.00'), maxPrice: usd('10.00') } },
      { '@type': 'Offer', priceCurrency: 'USD', priceSpecification: { minPrice: usd('9.99'), maxPrice: usd('10.00') } },
      { '@type': 'AggregateOffer', lowPrice: eur('50.00'), highPrice: usd('10.00') },
    ]);
    assert.deepEqual(unresolved(result), {
      'offers[0].lowPrice': ['range_inverted', '50.00'],
      'offers[0].highPrice': ['range_inverted', '10.00'],
    });
  });
});

// ---------------------------------------------------------------------------
// Unresolved facts in candidates and in the published graph
// ---------------------------------------------------------------------------

test('EW05 markup: compileCandidate returns unresolved facts and the published graph carries their path', async () => {
  const product = {
    '@type': 'Product',
    name: 'Widget Candidate',
    sku: 'WK-1',
    offers: [{ '@type': 'Offer', priceSpecification: [{ price: '19.99' }] }],
    aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.6 },
  };
  const expected = [
    ['price', 'offers[0].priceSpecification[0].price', 'currency_missing'],
    ['ratingValue', 'aggregateRating.ratingValue', 'untyped_number'],
  ];
  const facts = (list) => list.map((f) => [f.field, f.path, f.reason]);

  await withGraphStore(async (store) => {
    const candidate = await compileProduct(store, product, compileCandidate);
    assert.equal(candidate.status, 'candidate');
    assert.deepEqual(facts(candidate.unresolvedFacts), expected);
    assert.deepEqual(facts(candidate.graph.unresolvedFacts), expected);
  });
  await withGraphStore(async (store) => {
    const published = await compileProduct(store, product);
    assert.ok(published.version > 0, 'graph should publish');
    assert.deepEqual(facts(published.graph.unresolvedFacts), expected);
    assert.deepEqual(facts(published.unresolvedFacts), expected);
  });

  const graph = {
    version: GRAPH_SCHEMA_VERSION,
    generatedAt: '2026-10-26T09:00:00Z',
    assertions: [],
    unresolvedFacts: [{ field: 'price', path: 'offers[0].price', reason: 'currency_missing' }],
  };
  assert.equal(graphSchema.parse(graph).unresolvedFacts[0].path, 'offers[0].price', 'the contract keeps the path');
});

// ---------------------------------------------------------------------------
// review round 2
// ---------------------------------------------------------------------------

test('EW05 markup: the contract refuses a quantity under a price-specification name (no price disguised as a count)', () => {
  const graph = handBuiltGraph({ attributes: { offers: { price: usd('5.00'), priceSpecification: count(19.99) } } });
  assert.equal(validateGraphIntegrity(graph).valid, false);
  const asAssertion = handBuiltGraph({ assertion: ['describes_priceSpecification', count(19.99)] });
  assert.equal(validateGraphIntegrity(asAssertion).valid, false);
  // ...while a real container of prices is still accepted
  const container = handBuiltGraph({ attributes: { offers: { price: usd('5.00'), priceSpecification: { price: usd('4.00') } } } });
  assert.equal(validateGraphIntegrity(container).valid, true);
  // List form: priceSpecification: [count(19.99)] is also invalid
  const listForm = handBuiltGraph({ attributes: { offers: { price: usd('5.00'), priceSpecification: [count(19.99)] } } });
  assert.equal(validateGraphIntegrity(listForm).valid, false);
  // Assertion list form: [count(19.99)] under describes_priceSpecification is also invalid
  const assertionList = handBuiltGraph({ assertion: ['describes_priceSpecification', [count(19.99)]] });
  assert.equal(validateGraphIntegrity(assertionList).valid, false);
});

test('EW05 markup: a quantity-shaped priceSpecification is rejected by the contract', async () => {
  await withGraphStore(async (store) => {
    await assert.rejects(
      () => compileProduct(store, {
        '@type': 'Product', name: 'W', sku: 'W-1',
        offers: { priceCurrency: 'USD', price: '5.00', priceSpecification: { kind: 'quantity', value: 19.99, unit: 'count' } },
      }),
      (err) => err.name === 'GraphValidationError' && /offers\.priceSpecification/.test(err.message),
      'quantity-shaped priceSpecification must be rejected',
    );
  });
});

test('EW05 markup: a list holding a quantity under priceSpecification is rejected by the contract', async () => {
  await withGraphStore(async (store) => {
    await assert.rejects(
      () => compileProduct(store, {
        '@type': 'Product', name: 'W', sku: 'W-2',
        offers: { priceCurrency: 'USD', price: '5.00', priceSpecification: [{ kind: 'quantity', value: 19.99, unit: 'count' }] },
      }),
      (err) => err.name === 'GraphValidationError' && /offers\.priceSpecification/.test(err.message),
      'list with quantity under priceSpecification must be rejected',
    );
  });
});

test('EW05 markup: a list outside the money containers that holds untyped money is recorded whole, and the graph publishes', async () => {
  await withGraphStore(async (store) => {
    const isRelatedTo = [{ '@type': 'Product', name: 'Mate', offers: { price: '7.00', priceCurrency: 'USD' } }];
    const result = await compileProduct(store, {
      '@type': 'Product', name: 'Widget', sku: 'WZ-2', isRelatedTo,
      offers: { '@type': 'Offer', price: '19.99', priceCurrency: 'USD' },
    });
    assert.ok(result.version > 0, 'graph should publish');
    const attributes = productAttributes(result);
    assert.equal(Object.hasOwn(attributes, 'isRelatedTo'), false);
    assert.deepEqual(unresolvedByPath(result, 'untyped_money'), { isRelatedTo });
    assert.deepEqual(attributes.offers.price, usd('19.99'));
  });
});

// ---------------------------------------------------------------------------
// Numeric name crash guard
// ---------------------------------------------------------------------------

test('EW05 markup: a numeric name does not crash the compile', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 2024,
      sku: 'N-2024',
      offers: { '@type': 'Offer', price: '19.99', priceCurrency: 'USD' },
    });

    assert.ok(result.version > 0, 'graph should publish');
    const product = result.entities.find((e) => e.type === 'product');
    assert.ok(product, 'should have a product entity');
    assert.equal(product.label, '2024', 'numeric name is stringified');
  });
});

test('EW05 markup: a language-tagged name object does not become "[object Object]"', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: { '@value': 'Wool coat', '@language': 'en' },
      sku: 'WC-1',
      offers: { '@type': 'Offer', price: '49.99', priceCurrency: 'USD' },
    });

    assert.ok(result.version > 0, 'graph should publish');
    // The entity must have NO label, since the name is an object, not a string.
    // A name that is an object should not produce a label at all.
    const product = result.entities.find((e) => e.type === 'product');
    assert.equal(product.label, undefined, 'object name produces no label');
  });
});

test('EW05 markup: two products with language-tagged names and distinct skus are separate entities', async () => {
  await withGraphStore(async (store) => {
    // Compile both products in one call by passing them as separate jsonLd entries.
    const ns = parseNamespace(TENANT);
    const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;
    const snap = { ...snapBase, sourceId: 'src-product-page', tenantScope: TENANT, sourceType: 'ingest' };
    await store.writeSourceSnapshot(CALLER, ns, snap, Buffer.from('<html>Product page</html>'));
    const result = await compileGraph({
      graphStore: store,
      caller: CALLER,
      namespace: ns,
      factsProvider: async () => ({
        title: 'Product page',
        description: 'A product page',
        canonical: 'https://example.com/product',
        headings: [],
        links: [],
        jsonLd: [
          { '@type': 'Product', name: { '@value': 'Wool coat', '@language': 'en' }, sku: 'WC-EN', offers: { '@type': 'Offer', price: '49.99', priceCurrency: 'USD' } },
          { '@type': 'Product', name: { '@value': 'Wool coat', '@language': 'fr' }, sku: 'WC-FR', offers: { '@type': 'Offer', price: '44.99', priceCurrency: 'EUR' } },
        ],
      }),
    });

    assert.ok(result.version > 0, 'graph should publish');
    // Two distinct products identified by sku, not merged by any label.
    const products = result.entities.filter((e) => e.type === 'product');
    assert.equal(products.length, 2, 'two distinct products');
    // No same_as_candidate links should exist between sku-identified entities.
    const sameAsCandidates = result.graph.links.filter((l) => l.predicate === 'same_as_candidate');
    assert.equal(sameAsCandidates.length, 0, 'no same_as_candidate links for distinct skus');
  });
});

test('EW05 markup: two products with language-tagged names and no identifiers do not merge', async () => {
  await withGraphStore(async (store) => {
    const ns = parseNamespace(TENANT);
    const { contentHash: _ch, ...snapBase } = VALID_SOURCE_SNAPSHOT;
    const snap = { ...snapBase, sourceId: 'src-product-page', tenantScope: TENANT, sourceType: 'ingest' };
    await store.writeSourceSnapshot(CALLER, ns, snap, Buffer.from('<html>Product page</html>'));
    const result = await compileGraph({
      graphStore: store,
      caller: CALLER,
      namespace: ns,
      factsProvider: async () => ({
        title: 'Product page',
        description: 'A product page',
        canonical: 'https://example.com/product',
        headings: [],
        links: [],
        jsonLd: [
          { '@type': 'Product', name: { '@value': 'Wool coat', '@language': 'en' }, offers: { '@type': 'Offer', price: '49.99', priceCurrency: 'USD' } },
          { '@type': 'Product', name: { '@value': 'Wool coat', '@language': 'fr' }, offers: { '@type': 'Offer', price: '44.99', priceCurrency: 'EUR' } },
        ],
      }),
    });

    assert.ok(result.version > 0, 'graph should publish');
    // Neither item has a usable identity: the name is an object and no
    // identifier (sku/gtin/etc) is present. The extractor skips items
    // with no identity key, so no product entities are created.
    const products = result.entities.filter((e) => e.type === 'product');
    assert.equal(products.length, 0, 'items with no usable identity are skipped');
  });
});

test('EW05 markup: @value name object gives no entityLabel on unresolved facts', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: { '@value': 'Coat', '@language': 'en' },
      sku: 'COAT-1',
      aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.6 },
    });

    assert.ok(result.version > 0, 'graph should publish');
    const fact = result.unresolvedFacts.find((f) => f.path === 'aggregateRating.ratingValue');
    assert.ok(fact, 'ratingValue should be an unresolved fact');
    assert.equal(fact.entityLabel, undefined, 'entityLabel undefined for @value name object');
  });
});

test('EW05 markup: Infinity name with sku identity does not crash and has no label', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, JSON.parse('{"@type":"Product","name":1e999,"sku":"PL-2","offers":{"price":"1.00","priceCurrency":"USD"}}'));

    assert.ok(result.version > 0, 'graph should publish');
    const product = result.entities.find((e) => e.type === 'product');
    assert.ok(product, 'product entity should exist');
    assert.equal(product.label, undefined, 'Infinity name produces no label');
    // Verify the entity still has its sku-based identity
    const attributes = productAttributes(result);
    assert.equal(attributes.sku, 'PL-2', 'sku identity is preserved');
  });
});

// ---------------------------------------------------------------------------
// Numeric identifier guard
// ---------------------------------------------------------------------------

test('EW05 markup: numeric identifiers that are safe non-negative integers are stringified; unsafe are untyped_number', async () => {
  // Table-driven over every IDENTIFIER_KEYS key. Safe, non-negative integers are stringified; any other number
  // (unsafe, float, negative) is recorded as untyped_number.
  const cases = [
    // [attrKey, rawValue, expected]
    // Safe non-negative integers — stringified in place.
    ['sku', 12345, '12345'],
    ['gtin', 45678901234567, '45678901234567'],
    ['gtin8', 12345678, '12345678'],
    ['gtin12', 123456789012, '123456789012'],
    ['gtin13', 9876543210123, '9876543210123'],
    ['gtin14', 12345678901234, '12345678901234'],
    ['mpn', 5551212, '5551212'],
    ['isbn', 9783161484100, '9783161484100'],
    ['productID', 42, '42'],
    ['productGroupID', 999, '999'],
    ['identifier', 77001, '77001'],
    ['id', 1, '1'],
    // Unsafe / float — untyped_number, absent from attributes.
    ['gtin13', 12345678901234567890, 'untyped_number'],
    // Negative — untyped_number.
    ['sku', -5, 'untyped_number'],
    ['sku', 12.50, 'untyped_number'],
  ];
  for (const [key, value, expected] of cases) {
    await withGraphStore(async (store) => {
      // Round-trip through JSON to match what real ingest does.
      const jsonLd = JSON.parse(JSON.stringify({
        '@type': 'Product',
        name: `Widget id-${key}`,
        [key]: value,
        offers: { '@type': 'Offer', price: '19.99', priceCurrency: 'USD' },
      }));
      const result = await compileProduct(store, jsonLd);
      assert.ok(result.version > 0, `graph should publish for ${key}=${value}`);
      const attributes = productAttributes(result);
      if (expected === 'untyped_number') {
        assert.equal(Object.hasOwn(attributes, key), false,
          `${key} ${value} must not be in attributes`);
        assert.ok(result.unresolvedFacts.some((f) => f.field === key && f.reason === 'untyped_number'),
          `${key} ${value} must be recorded as untyped_number`);
      } else {
        assert.equal(attributes[key], expected,
          `safe integer ${key} ${value} must stringify to "${expected}"`);
      }
    });
  }
});

test('EW05 markup: a string identifier stays unchanged even when it looks numeric', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, JSON.parse(JSON.stringify({
      '@type': 'Product',
      name: 'Widget Str IDs',
      sku: '00012345600012',
      offers: { '@type': 'Offer', price: '19.99', priceCurrency: 'USD' },
    })));
    assert.ok(result.version > 0, 'graph should publish');
    const attributes = productAttributes(result);
    assert.equal(attributes.sku, '00012345600012', 'leading-zero string is unchanged');
  });
});

// ---------------------------------------------------------------------------
// Negative amount guard (any money name)
// ---------------------------------------------------------------------------

test('EW05 markup: a negative salePrice is rejected like any negative price', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Sale Neg',
      sku: 'WSN-1',
      offers: {
        '@type': 'Offer',
        price: '19.99',
        priceCurrency: 'USD',
        salePrice: '-5.00',
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(unresolved(result)['offers.salePrice'], ['amount_invalid', '-5.00'],
      'negative salePrice in Offer should be amount_invalid');
  });
});

test('EW05 markup: a negative shippingRate value is rejected', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Ship Neg',
      sku: 'WSN-2',
      offers: {
        '@type': 'Offer',
        price: '19.99',
        priceCurrency: 'USD',
        shippingDetails: {
          '@type': 'OfferShippingDetails',
          shippingRate: {
            '@type': 'MonetaryAmount',
            value: '-3.49',
            currency: 'USD',
          },
        },
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    const rateObj = { '@type': 'MonetaryAmount', value: '-3.49', currency: 'USD' };
    assert.deepEqual(unresolved(result)['offers.shippingDetails.shippingRate'],
      ['amount_invalid', rateObj],
      'negative shipping rate should be amount_invalid');
  });
});

test('EW05 markup: a negative shippingRate MonetaryAmount with a number value is rejected', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Ship Num Neg',
      sku: 'WSN-3',
      offers: {
        '@type': 'Offer',
        price: '19.99',
        priceCurrency: 'USD',
        shippingDetails: {
          '@type': 'OfferShippingDetails',
          shippingRate: {
            '@type': 'MonetaryAmount',
            value: -3.49,
            currency: 'USD',
          },
        },
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    const rateObj = { '@type': 'MonetaryAmount', value: -3.49, currency: 'USD' };
    assert.deepEqual(unresolved(result)['offers.shippingDetails.shippingRate'],
      ['amount_invalid', rateObj],
      'negative shipping rate number value should be amount_invalid');
  });
});

test('EW05 markup: a negative shippingRate MonetaryAmount minValue is rejected', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Ship Min Neg',
      sku: 'WSN-4',
      offers: {
        '@type': 'Offer',
        price: '19.99',
        priceCurrency: 'USD',
        shippingDetails: {
          '@type': 'OfferShippingDetails',
          shippingRate: {
            '@type': 'MonetaryAmount',
            minValue: '-1.00',
            currency: 'USD',
          },
        },
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(unresolved(result)['offers.shippingDetails.shippingRate.minValue'],
      ['amount_invalid', '-1.00'],
      'negative minValue should be amount_invalid');
  });
});

test('EW05 markup: a negative offers.listPrice is rejected', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget List Neg',
      sku: 'WLN-1',
      offers: {
        '@type': 'Offer',
        price: '19.99',
        priceCurrency: 'USD',
        listPrice: '-5.00',
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(unresolved(result)['offers.listPrice'], ['amount_invalid', '-5.00'],
      'negative listPrice should be amount_invalid');
  });
});

test('EW05 markup: a negative hasMerchantReturnPolicy.restockingFee is rejected', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Restock Neg',
      sku: 'WRN-1',
      offers: {
        '@type': 'Offer',
        price: '19.99',
        priceCurrency: 'USD',
        hasMerchantReturnPolicy: {
          '@type': 'MerchantReturnPolicy',
          restockingFee: -1,
        },
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(unresolved(result)['offers.hasMerchantReturnPolicy.restockingFee'],
      ['amount_invalid', -1],
      'negative restockingFee should be amount_invalid');
  });
});

// Canonical money pass-through (negative)
// ---------------------------------------------------------------------------

test('EW05 markup: negative canonical money (minor_units) is rejected in the pass-through', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Neg Canon',
      sku: 'WNC-2',
      offers: {
        '@type': 'Offer',
        priceCurrency: 'USD',
        price: { amount: -500, amountUnit: 'minor_units', currency: 'USD', exponent: 2 },
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(unresolved(result)['offers.price'],
      ['amount_invalid', { amount: -500, amountUnit: 'minor_units', currency: 'USD', exponent: 2 }],
      'negative canonical money should be amount_invalid');
  });
});


test('EW05 markup: negative canonical money inside a list is rejected', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Prices List Neg',
      sku: 'WPLN-1',
      offers: {
        '@type': 'Offer',
        priceCurrency: 'USD',
        prices: [usd('-1.00'), usd('2.00')],
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(unresolved(result), {
      'offers.prices': ['amount_invalid', [usd('-1.00'), usd('2.00')]],
    });
  });
});

// ---------------------------------------------------------------------------
// hasVariant typed per variant
// ---------------------------------------------------------------------------

test('EW05 markup: hasVariant with string prices is typed per variant, not recorded whole', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'ProductGroup',
      name: 'T-Shirt',
      productGroupID: 'TS-1',
      hasVariant: [
        { '@type': 'Product', name: 'T-Shirt Small', sku: 'TS-S', offers: { '@type': 'Offer', price: '10.00', priceCurrency: 'USD' } },
        { '@type': 'Product', name: 'T-Shirt Large', sku: 'TS-L', offers: { '@type': 'Offer', price: '15.00', priceCurrency: 'USD' } },
      ],
    });

    assert.ok(result.version > 0, 'graph should publish');
    const pg = result.entities.find((e) => e.type === 'unknown' && e.label === 'T-Shirt');
    assert.ok(pg, 'should have a ProductGroup entity');
    // hasVariant should be walked as a money container: each variant is
    // processed individually rather than the whole list being recorded as untyped_money.
    const attributes = pg.attributes;
    assert.ok(attributes.hasVariant, 'hasVariant should be in attributes');
    assert.equal(attributes.hasVariant.length, 2, 'both variants should be preserved');
    assert.deepEqual(attributes.hasVariant[0].offers.price, usd('10.00'));
    assert.deepEqual(attributes.hasVariant[1].offers.price, usd('15.00'));
    assert.equal(result.unresolvedFacts.some((f) => f.reason === 'untyped_money' && f.path === 'hasVariant'), false,
      'hasVariant should not be recorded as untyped_money');
  });
});

// ---------------------------------------------------------------------------
// Inverted MonetaryAmount minValue/maxValue
// ---------------------------------------------------------------------------

test('EW05 markup: an inverted shippingRate MonetaryAmount range is caught', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Range',
      sku: 'WR-1',
      offers: {
        '@type': 'Offer',
        price: '19.99',
        priceCurrency: 'USD',
        shippingDetails: {
          '@type': 'OfferShippingDetails',
          shippingRate: {
            '@type': 'MonetaryAmount',
            minValue: '10.00',
            maxValue: '5.00',
            currency: 'USD',
          },
        },
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(unresolved(result)['offers.shippingDetails.shippingRate.minValue'],
      ['range_inverted', '10.00']);
    assert.deepEqual(unresolved(result)['offers.shippingDetails.shippingRate.maxValue'],
      ['range_inverted', '5.00']);
  });
});

// ---------------------------------------------------------------------------
// not_an_object for containers beyond priceSpecification
// ---------------------------------------------------------------------------

test('EW05 markup: a bare value under offers is recorded as not_an_object', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Bare Offer',
      sku: 'WB-1',
      offers: '19.99',
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(unresolved(result)['offers'], ['not_an_object', '19.99']);
  });
});

test('EW05 markup: a bare value under shippingDetails is recorded as not_an_object', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Bare Ship',
      sku: 'WB-2',
      offers: {
        '@type': 'Offer',
        price: '19.99',
        priceCurrency: 'USD',
        shippingDetails: 'free',
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(unresolved(result)['offers.shippingDetails'], ['not_an_object', 'free']);
  });
});

test('EW05 markup: a bare value under aggregateOffer is recorded as not_an_object', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'Widget Bare Agg',
      sku: 'WB-3',
      aggregateOffer: 'cheap',
    });

    assert.ok(result.version > 0, 'graph should publish');
    assert.deepEqual(unresolved(result)['aggregateOffer'], ['not_an_object', 'cheap']);
  });
});

// ---------------------------------------------------------------------------
// ExchangeRateSpecification currency guard
// ---------------------------------------------------------------------------

test('EW05 markup: ExchangeRateSpecification (top-level, no enclosing currency) blocks its own currency', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'ExchangeRateSpecification',
      name: 'EUR Rate',
      currency: 'EUR',
      currentExchangeRate: { '@type': 'UnitPriceSpecification', price: '1.08' },
    });

    assert.ok(result.version > 0, 'graph should publish');
    const entity = result.entities.find((e) => e.type === 'unknown' && e.label === 'EUR Rate');
    assert.ok(entity, 'should have an entity');
    const rate = entity.attributes.currentExchangeRate;
    assert.ok(rate, 'currentExchangeRate should be in attributes');
    // The price 1.08 must be recorded as currency_missing (no currency in scope
    // because currentExchangeRate blocks cascading) and absent from attributes.
    assert.equal(Object.hasOwn(rate, 'price'), false, 'price must not be in attributes');
    assert.deepEqual(unresolved(result)['currentExchangeRate.price'],
      ['currency_missing', '1.08'],
      'price records currency_missing with raw "1.08"');
  });
});

test('EW05 markup: ExchangeRateSpecification with enclosing priceCurrency is still blocked', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'EUR Rate Product',
      sku: 'ERP-1',
      offers: {
        '@type': 'ExchangeRateSpecification',
        currency: 'EUR',
        currentExchangeRate: { '@type': 'UnitPriceSpecification', price: '1.08', priceCurrency: 'USD' },
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    // The currentExchangeRate has its own priceCurrency, which should be used
    // since the ExchangeRateSpecification currency is blocked.
    const entity = result.entities.find((e) => e.type === 'product');
    const rateSpec = entity.attributes.offers;
    assert.ok(rateSpec, 'ExchangeRateSpecification should be in attributes');
    const rate = rateSpec.currentExchangeRate;
    assert.ok(rate, 'currentExchangeRate should be in attributes');
    assert.deepEqual(rate.price, usd('1.08'), 'price should use inner priceCurrency USD');
  });
});

test('EW05 markup: exchange rate inside an Offer with enclosing priceCurrency blocks outer currency', async () => {
  await withGraphStore(async (store) => {
    const result = await compileProduct(store, {
      '@type': 'Product',
      name: 'EUR Rate Offer',
      sku: 'ERO-1',
      offers: {
        '@type': 'Offer',
        priceCurrency: 'USD',
        price: '19.99',
        exchangeRate: {
          '@type': 'ExchangeRateSpecification',
          currentExchangeRate: { '@type': 'UnitPriceSpecification', price: '1.08' },
        },
      },
    });

    assert.ok(result.version > 0, 'graph should publish');
    const entity = result.entities.find((e) => e.type === 'product');
    const offer = entity.attributes.offers;
    assert.ok(offer, 'Offer should be in attributes');
    assert.deepEqual(offer.price, usd('19.99'), 'Offer price uses its own USD');
    const rate = offer.exchangeRate?.currentExchangeRate;
    assert.ok(rate, 'currentExchangeRate should be in attributes');
    assert.equal(Object.hasOwn(rate, 'price'), false, 'price must not be in attributes');
    assert.deepEqual(unresolved(result)['offers.exchangeRate.currentExchangeRate.price'],
      ['currency_missing', '1.08'],
      'price records currency_missing; outer USD must not leak');
  });
});
