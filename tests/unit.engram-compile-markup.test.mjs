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
      balance: usd('-5.00'),
      priceType: 'https://schema.org/SalePrice',
      shippingCostSpecification: usd('4.99'),
      handlingPriceSpecification: { price: usd('2.00') },
    });
    assert.deepEqual(unresolved(result), {
      'offers.price': ['amount_invalid', '-5.00'],
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
      sku: ['untyped_number', 1234],
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
      "hasVariant": [{ "@type": "Product", "sku": "WL-3-S", "offers": { "price": 17.5, "priceCurrency": "USD" } }],
      "history": [{ "price": { "amount": "1.00", "amountUnit": "major_decimal", "currency": "USD", "exponent": 2 }, "views": 3 }]
    }`));

    assert.ok(result.version > 0, 'graph should publish');
    const attributes = productAttributes(result);
    assert.deepEqual(attributes.sizes, [count(8)]);
    assert.deepEqual(attributes.deposits, [usd('5.00')]);
    for (const key of ['size', 'hasVariant', 'history']) assert.equal(Object.hasOwn(attributes, key), false, key);
    assert.deepEqual(
      result.unresolvedFacts.map((f) => [f.path, f.reason, Object.hasOwn(f, 'rawValue')]),
      [['size', 'untyped_number', false], ['hasVariant', 'untyped_money', true], ['history', 'untyped_number', true]],
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
});

test('EW05 markup: a quantity-shaped priceSpecification in markup never publishes as a count', async () => {
  await withGraphStore(async (store) => {
    let result = null;
    try {
      result = await compileProduct(store, {
        '@type': 'Product', name: 'W', sku: 'W-1',
        offers: { priceCurrency: 'USD', price: '5.00', priceSpecification: { kind: 'quantity', value: 19.99, unit: 'count' } },
      });
    } catch {
      return; // failing closed is acceptable
    }
    const offers = productAttributes(result).offers;
    assert.notDeepEqual(offers?.priceSpecification, count(19.99), 'a count must not stand where a price belongs');
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
