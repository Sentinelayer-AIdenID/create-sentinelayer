/**
 * ENGRAM §EW14 — hydrate never returns a cached money value as current.
 *
 * A published graph holds stable facts; volatile values (prices, money,
 * availability) come live from the site's adapter. On a source outage or a
 * transport failure every cached volatile value is removed from the graph
 * hydrate returns: from entity attributes at any depth, from the
 * describes_* assertions the compiler copies attributes into, and from the
 * raw values of unresolved facts.
 *
 * Most tests compile realistic schema.org product markup with the real EW05
 * compiler, hydrate the result, and walk the WHOLE hydrated graph for any
 * canonical money object or price-like raw value. A control test runs the
 * same walk on the graph before hydration, so the walk is shown to find the
 * money each fixture is about. Hand-built graphs then pin each rule that
 * keeps a cached value out of the assertions and unresolved facts.
 */
import "./setup-env.mjs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { compileGraph, compileCandidate } from "../src/engram/compile-graph.js";
import { createGraphStore } from "../src/engram/graph-store.js";
import { parseNamespace, createLocalConsent } from "../src/engram/namespace.js";
import { VALID_SOURCE_SNAPSHOT } from "../src/engram/contracts/source-snapshot.js";
import { graphSchema, validateGraphIntegrity } from "../src/engram/contracts/graph.js";
import { moneySchema } from "../src/engram/contracts/money.js";
import { GRAPH_SCHEMA_VERSION } from "../src/engram/contracts/versions.js";
import {
  hydrate,
  revalidateForAction,
  createSourceVersion,
  isVolatileField,
} from "../src/engram/live-state.js";

const CALLER = { id: "agent-ew14", kind: "agent" };
const TENANT = "tenant:ew14-cached-money";

const usd = (amount) => ({ amount, amountUnit: "major_decimal", currency: "USD", exponent: 2 });
const eur = (amount) => ({ amount, amountUnit: "major_decimal", currency: "EUR", exponent: 2 });

// ---------------------------------------------------------------------------
// The walk: every money value left anywhere in a graph
// ---------------------------------------------------------------------------

const MONEY_KEY = /price|amount|cost|fee|total|balance|payment/i;
const AMOUNT = /^\s*-?\d+(?:\.\d+)?\s*$/;
const isMoney = (value) => moneySchema.safeParse(value).success;
const childPath = (at, key, inArray) => (inArray ? `${at}[${key}]` : at ? `${at}.${key}` : key);

/** Paths of every canonical money object anywhere in a JSON value. */
function moneyPaths(value, at = "") {
  if (value === null || typeof value !== "object") return [];
  if (isMoney(value)) return [at];
  return Object.entries(value).flatMap(([key, child]) =>
    moneyPaths(child, childPath(at, key, Array.isArray(value))));
}

/** Paths of every number or decimal string held under a money-like key. */
function rawPricePaths(value, at, key = "") {
  if (value === null || value === undefined) return [];
  if (typeof value === "object") {
    if (isMoney(value)) return []; // reported by moneyPaths
    return Object.entries(value).flatMap(([childKey, child]) => (Array.isArray(value)
      ? rawPricePaths(child, childPath(at, childKey, true), key)
      : rawPricePaths(child, childPath(at, childKey, false), childKey)));
  }
  const priceLike = typeof value === "number" || (typeof value === "string" && AMOUNT.test(value));
  return priceLike && MONEY_KEY.test(key) ? [`${at} = ${JSON.stringify(value)}`] : [];
}

/**
 * Every money value in a graph: a canonical money object anywhere, and every
 * price-like raw value in an entity, in an assertion object (keyed by its
 * predicate) or in an unresolved fact's rawValue (keyed by its field and
 * path, so a raw "19.99" recorded for price counts).
 */
function findMoney(graph) {
  return [
    ...moneyPaths(graph),
    ...(graph.entities ?? []).flatMap((entity, i) => rawPricePaths(entity, `entities[${i}]`)),
    ...(graph.assertions ?? []).flatMap((assertion, i) =>
      rawPricePaths(assertion.object, `assertions[${i}].object`, assertion.predicate)),
    ...(graph.unresolvedFacts ?? []).flatMap((fact, i) => rawPricePaths(
      fact.rawValue, `unresolvedFacts[${i}].rawValue`, `${fact.field ?? ""} ${fact.path ?? ""}`)),
  ];
}

/** Fails on any canonical money object or price-like raw value in the graph. */
function assertNoCachedMoney(graph) {
  assert.deepEqual(findMoney(graph), [], "a cached money value survived hydrate");
}

function assertValidUnderContract(graph, { integrity }) {
  const parsed = graphSchema.safeParse(graph);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  if (integrity) assert.deepEqual(validateGraphIntegrity(graph).errors, []);
}

/** The value at an attribute path such as "offers.priceSpecification[1].price". */
function valueAt(value, attributePath) {
  return attributePath.split(/[.[\]]/).filter(Boolean).reduce((node, key) => node?.[key], value);
}

const predicatesOf = (graph) => graph.assertions.map((assertion) => assertion.predicate);
const sorted = (items) => [...items].sort();

// ---------------------------------------------------------------------------
// Stores and adapters
// ---------------------------------------------------------------------------

/** A graph store that serves one graph as the current version. */
function servingStore(graph) {
  return {
    readCurrentGraph: async () => ({
      graph: structuredClone(graph),
      version: 1,
      publishedAt: "2026-10-27T12:00:00.000Z",
    }),
  };
}

/**
 * Compile one snapshot per page of JSON-LD markup with the real compiler and
 * hand fn a store that serves the result. A publishable site goes through
 * compileGraph and graph-store. A site marked publish: false is compiled with
 * compileCandidate, and its graph, which is what compileGraph publishes, is
 * served directly: those tests do not depend on whether the graph contract in
 * force accepts the markup (versions differ on an offer's priceSpecification
 * object).
 */
async function withCompiledSite(site, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-ew14-money-"));
  try {
    const store = createGraphStore({ storeRoot: root, consent: createLocalConsent() });
    const ns = parseNamespace(TENANT);
    const { contentHash: _hash, ...snapshotBase } = VALID_SOURCE_SNAPSHOT;
    const markupBySource = new Map();
    for (const [i, jsonLd] of site.pages.entries()) {
      const sourceId = `src-page-${i}`;
      markupBySource.set(sourceId, jsonLd);
      await store.writeSourceSnapshot(
        CALLER, ns,
        { ...snapshotBase, sourceId, tenantScope: TENANT, sourceType: "ingest" },
        Buffer.from(`<html><body>${site.name} ${i}</body></html>`),
      );
    }
    const options = {
      graphStore: store,
      caller: CALLER,
      namespace: ns,
      factsProvider: async (snapshot) => ({
        title: site.name,
        canonical: `https://shop.example/pages/${snapshot.sourceId}`,
        headings: [],
        links: [],
        jsonLd: markupBySource.get(snapshot.sourceId),
      }),
    };
    if (site.publish) {
      await compileGraph(options);
      return await fn(store, ns);
    }
    const candidate = await compileCandidate(options);
    assert.equal(candidate.status, "candidate", JSON.stringify(candidate.schemaErrors));
    return await fn(servingStore(candidate.graph), ns);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/** Publish a hand-built graph through graph-store and hand fn the store. */
async function withPublishedGraph(graph, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-ew14-money-"));
  try {
    const store = createGraphStore({ storeRoot: root, consent: createLocalConsent() });
    const ns = parseNamespace(TENANT);
    await store.publishGraph(CALLER, ns, graph);
    return await fn(store, ns);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

function countingAdapter(sourceStatus, fetchLive) {
  const adapter = {
    sourceId: "shop:live",
    calls: 0,
    sourceStatus: () => sourceStatus,
    fetchLive: async (...args) => {
      adapter.calls += 1;
      return fetchLive(...args);
    },
  };
  return adapter;
}

/** The ways hydrate gets no live values. */
const FAILURES = [
  {
    name: "source outage",
    adapter: () => countingAdapter("unavailable", async () => new Map()),
    expectedCalls: 0,
  },
  {
    name: "transport failure",
    adapter: () => countingAdapter("available", async () => { throw new Error("ECONNRESET"); }),
    expectedCalls: 1,
  },
  {
    name: "malformed response",
    // Per-entity plain objects instead of Maps: outside the adapter contract.
    adapter: () => countingAdapter("available", async (_context, entityIds) =>
      new Map(entityIds.map((id) => [id, { price: usd("1.00") }]))),
    expectedCalls: 1,
  },
  {
    name: "status check throws",
    adapter: () => {
      const adapter = countingAdapter("available", async () => new Map());
      adapter.sourceStatus = () => { throw new Error("status endpoint down"); };
      return adapter;
    },
    expectedCalls: 0,
  },
  {
    name: "no live source",
    adapter: () => null,
  },
];

/**
 * An available source that returns `live` (path -> value) for one entity and
 * records the fields it was asked for. With onlyAsked false it also returns
 * paths it was not asked for, as a source keyed by item index might.
 */
function liveAdapter(entityId, live, { onlyAsked = true } = {}) {
  const adapter = countingAdapter("available", async (_context, entityIds, fieldNames) => {
    adapter.requested = [...fieldNames];
    const values = new Map();
    if (entityIds.includes(entityId)) {
      const answered = Object.entries(live).filter(([field]) => !onlyAsked || fieldNames.includes(field));
      values.set(entityId, new Map(answered));
    }
    return values;
  });
  return adapter;
}

// ---------------------------------------------------------------------------
// Realistic product markup, compiled by the real compiler
// ---------------------------------------------------------------------------

const productOf = (graph) => graph.entities.find((entity) => entity.type === "product");
const subjectIndex = (graph) => graph.entities.findIndex((entity) => entity.attributes);

const SITES = [
  {
    name: "a single offer with a price",
    publish: true,
    pages: [[{
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Trail Runner 2",
      sku: "TR2-BLK-42",
      brand: { "@type": "Brand", name: "Northwind" },
      // No priceValidUntil: compiler versions differ on a date under a price
      // name (refused, or recorded as an unresolved fact).
      offers: {
        "@type": "Offer",
        url: "https://shop.example/products/trail-runner-2",
        price: "89.00",
        priceCurrency: "USD",
        availability: "https://schema.org/InStock",
        itemCondition: "https://schema.org/NewCondition",
      },
    }]],
    money: ["entities[0].attributes.offers.price"],
    check(graph) {
      const { attributes } = productOf(graph);
      assert.equal(attributes.offers.availability, undefined);
      assert.equal(attributes.name, "Trail Runner 2");
      assert.deepEqual(attributes.brand, { "@type": "Brand", name: "Northwind" });
      assert.equal(attributes.offers.url, "https://shop.example/products/trail-runner-2");
      assert.equal(attributes.offers.priceCurrency, "USD");
      assert.equal(attributes.offers.itemCondition, "https://schema.org/NewCondition");
    },
  },
  {
    name: "an AggregateOffer (lowPrice, highPrice, offerCount)",
    publish: true,
    pages: [[{
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Trail Runner 2",
      sku: "TR2",
      offers: {
        "@type": "AggregateOffer",
        lowPrice: "79.00",
        highPrice: "99.00",
        priceCurrency: "USD",
        // A string, which compiler versions keep as is; they differ on a bare number.
        offerCount: "3",
      },
    }]],
    money: ["entities[0].attributes.offers.lowPrice", "entities[0].attributes.offers.highPrice"],
    check(graph) {
      assert.deepEqual(productOf(graph).attributes.offers, {
        "@type": "AggregateOffer",
        priceCurrency: "USD",
        offerCount: "3",
      });
    },
  },
  {
    name: "an offer with a priceSpecification object",
    publish: false,
    pages: [[{
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Espresso Beans 1kg",
      sku: "EB-1KG",
      offers: {
        "@type": "Offer",
        price: "24.00",
        priceCurrency: "EUR",
        availability: "https://schema.org/InStock",
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price: "24.00",
          priceCurrency: "EUR",
          referenceQuantity: { "@type": "QuantitativeValue", value: "1", unitCode: "KGM" },
        },
      },
    }]],
    money: ["entities[0].attributes.offers.price", "entities[0].attributes.offers.priceSpecification.price"],
    volatile: ["offers.price", "offers.availability", "offers.priceSpecification.price"],
    live: { "offers.priceSpecification.price": eur("26.00") },
    check(graph) {
      assert.deepEqual(productOf(graph).attributes.offers, {
        "@type": "Offer",
        priceCurrency: "EUR",
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          priceCurrency: "EUR",
          referenceQuantity: { "@type": "QuantitativeValue", value: "1", unitCode: "KGM" },
        },
      });
    },
  },
  {
    name: "a describes_price assertion (a top-level Offer)",
    publish: true,
    pages: [[{
      "@context": "https://schema.org",
      "@type": "Offer",
      "@id": "https://shop.example/products/gift-card#offer",
      price: "50.00",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    }]],
    money: ["entities[0].attributes.price", "assertions[2].object"],
    volatile: ["price", "availability"],
    live: { price: usd("45.00") },
    check(graph) {
      assert.deepEqual(predicatesOf(graph), ["describes", "describes_@id", "describes_priceCurrency"]);
      assert.equal(graph.coverage.totalAssertions, 3);
      assert.deepEqual(graph.entities[0].attributes, {
        "@id": "https://shop.example/products/gift-card#offer",
        priceCurrency: "USD",
      });
    },
  },
  {
    name: "a price with no currency (currency_missing)",
    publish: true,
    pages: [[{
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Trail Runner 2",
      sku: "TR2-NC",
      offers: { "@type": "Offer", price: "89.00", availability: "https://schema.org/InStock" },
    }]],
    money: ["unresolvedFacts[0].rawValue = \"89.00\""],
    check(graph, published) {
      // The gap stays disclosed: each published record, without its raw value.
      assert.ok(published.unresolvedFacts.some((fact) =>
        fact.field === "price" && fact.reason === "currency_missing" && fact.rawValue === "89.00"));
      assert.deepEqual(graph.unresolvedFacts, published.unresolvedFacts.map(({ rawValue: _raw, ...rest }) => rest));
    },
  },
  {
    name: "a top-level AggregateOffer entity (money outside offers)",
    publish: true,
    pages: [[{
      "@context": "https://schema.org",
      "@type": "AggregateOffer",
      "@id": "https://shop.example/products/trail-runner-2#offers",
      lowPrice: "79.00",
      highPrice: "99.00",
      priceCurrency: "USD",
      offerCount: "3",
    }]],
    money: [
      "entities[0].attributes.lowPrice",
      "entities[0].attributes.highPrice",
      "assertions[2].object",
      "assertions[3].object",
    ],
    volatile: ["lowPrice", "highPrice"],
    live: { lowPrice: usd("75.00") },
    check(graph) {
      assert.deepEqual(predicatesOf(graph),
        ["describes", "describes_@id", "describes_priceCurrency", "describes_offerCount"]);
      assert.equal(graph.entities[0].attributes.offerCount, "3");
    },
  },
  {
    name: "a priceSpecification on the product itself",
    publish: false,
    pages: [[{
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Espresso Beans 1kg",
      sku: "EB-1KG-PS",
      priceSpecification: { "@type": "PriceSpecification", price: "24.00", priceCurrency: "EUR" },
    }]],
    money: ["entities[0].attributes.priceSpecification.price"],
    volatile: ["priceSpecification.price"],
    live: { "priceSpecification.price": eur("26.00") },
    check(graph) {
      assert.deepEqual(productOf(graph).attributes.priceSpecification,
        { "@type": "PriceSpecification", priceCurrency: "EUR" });
    },
  },
  {
    name: "a top-level Offer with sale and strikethrough priceSpecifications",
    publish: false,
    pages: [[{
      "@context": "https://schema.org",
      "@type": "Offer",
      "@id": "https://shop.example/products/espresso-beans#offer",
      priceCurrency: "EUR",
      availability: "https://schema.org/InStock",
      priceSpecification: [
        { "@type": "UnitPriceSpecification", price: "24.00", priceCurrency: "EUR" },
        {
          "@type": "UnitPriceSpecification",
          priceType: "https://schema.org/StrikethroughPrice",
          price: "29.00",
          priceCurrency: "EUR",
        },
      ],
    }]],
    money: [
      "entities[0].attributes.priceSpecification[0].price",
      "entities[0].attributes.priceSpecification[1].price",
    ],
    volatile: ["availability", "priceSpecification[0].price", "priceSpecification[1].price"],
    live: { "priceSpecification[1].price": eur("31.00") },
    check(graph) {
      // Both specifications keep their positions and stable fields.
      assert.deepEqual(graph.entities[0].attributes.priceSpecification, [
        { "@type": "UnitPriceSpecification", priceCurrency: "EUR" },
        {
          "@type": "UnitPriceSpecification",
          priceType: "https://schema.org/StrikethroughPrice",
          priceCurrency: "EUR",
        },
      ]);
      assert.equal(graph.entities[0].attributes.availability, undefined);
    },
  },
  {
    name: "a UnitPriceSpecification entity with minPrice and maxPrice",
    publish: true,
    // minPrice/maxPrice as canonical money, which compilers pass through
    // unchanged; versions differ on raw strings under those names.
    pages: [[{
      "@context": "https://schema.org",
      "@type": "UnitPriceSpecification",
      "@id": "https://shop.example/products/espresso-beans#unit-price",
      price: "24.00",
      priceCurrency: "EUR",
      minPrice: eur("20.00"),
      maxPrice: eur("28.00"),
      referenceQuantity: { "@type": "QuantitativeValue", value: "1", unitCode: "KGM" },
    }]],
    money: [
      "entities[0].attributes.price",
      "entities[0].attributes.minPrice",
      "entities[0].attributes.maxPrice",
      "assertions[2].object",
      "assertions[4].object",
      "assertions[5].object",
    ],
    volatile: ["price", "minPrice", "maxPrice"],
    live: { minPrice: eur("21.00"), maxPrice: eur("27.00") },
    check(graph) {
      assert.deepEqual(predicatesOf(graph), [
        "describes", "describes_@id", "describes_priceCurrency", "describes_referenceQuantity",
      ]);
    },
  },
  {
    name: "one product on two pages that disagree (per-source offers)",
    publish: true,
    pages: [
      [{
        "@type": "Product",
        name: "Trail Runner 2",
        sku: "TR2-SPLIT",
        offers: {
          "@type": "Offer",
          price: "89.00",
          priceCurrency: "USD",
          availability: "https://schema.org/InStock",
        },
      }],
      [{
        "@type": "Product",
        name: "Trail Runner 2",
        sku: "TR2-SPLIT",
        offers: {
          "@type": "Offer",
          price: "79.00",
          priceCurrency: "USD",
          availability: "https://schema.org/LimitedAvailability",
        },
      }],
    ],
    money: ["entities[0].attributes.offers[0].value.price", "entities[0].attributes.offers[1].value.price"],
    check(graph) {
      const { offers } = productOf(graph).attributes;
      assert.equal(offers.length, 2);
      for (const offer of offers) {
        assert.deepEqual(offer.value, { "@type": "Offer", priceCurrency: "USD" });
        assert.equal(offer.provenance, "observed");
      }
      assert.deepEqual(sorted(offers.map((offer) => offer.sourceId)), ["src-page-0", "src-page-1"]);
    },
  },
  {
    name: "an AggregateOffer that lists its offers",
    publish: true,
    pages: [[{
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Trail Runner 2",
      sku: "TR2-LIST",
      offers: {
        "@type": "AggregateOffer",
        lowPrice: "79.00",
        highPrice: "89.00",
        priceCurrency: "USD",
        offerCount: "2",
        offers: [
          { "@type": "Offer", price: "79.00", priceCurrency: "USD", availability: "https://schema.org/InStock" },
          {
            "@type": "Offer",
            price: "89.00",
            priceCurrency: "USD",
            availability: "https://schema.org/OutOfStock",
          },
        ],
      },
    }]],
    money: [
      "entities[0].attributes.offers.lowPrice",
      "entities[0].attributes.offers.highPrice",
      "entities[0].attributes.offers.offers[0].price",
      "entities[0].attributes.offers.offers[1].price",
    ],
    check(graph) {
      assert.deepEqual(productOf(graph).attributes.offers.offers, [
        { "@type": "Offer", priceCurrency: "USD" },
        { "@type": "Offer", priceCurrency: "USD" },
      ]);
    },
  },
  {
    name: "capitalised keys (Offers, Price, Availability)",
    publish: true,
    pages: [[
      {
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Lamp",
        sku: "LAMP-1",
        Offers: {
          "@type": "Offer",
          Price: "40.00",
          PriceCurrency: "USD",
          Availability: "https://schema.org/OutOfStock",
        },
      },
      {
        "@context": "https://schema.org",
        "@type": "Offer",
        "@id": "https://shop.example/products/lamp#offer",
        price: "5.00",
        priceCurrency: "USD",
        Availability: "https://schema.org/InStock",
      },
    ]],
    money: ["entities[0].attributes.Offers.Price", "entities[1].attributes.price", "assertions[6].object"],
    volatile: ["Offers.Price", "Offers.Availability", "price", "Availability"],
    live: { "Offers.Availability": "https://schema.org/InStock" },
    check(graph) {
      const [lamp, offer] = graph.entities;
      assert.deepEqual(lamp.attributes.Offers, { "@type": "Offer", PriceCurrency: "USD" });
      assert.deepEqual(offer.attributes, { "@id": "https://shop.example/products/lamp#offer", priceCurrency: "USD" });
      assert.ok(!predicatesOf(graph).includes("describes_Availability"));
    },
  },
  {
    name: "an offer with inventoryLevel and shippingDetails (shippingRate, deliveryTime)",
    publish: true,
    // shippingRate as canonical money, which compilers pass through unchanged;
    // versions differ on a MonetaryAmount's raw value.
    pages: [[{
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Mug",
      sku: "MUG-1",
      offers: {
        "@type": "Offer",
        price: "12.00",
        priceCurrency: "USD",
        inventoryLevel: { "@type": "QuantitativeValue", value: "17" },
        shippingDetails: {
          "@type": "OfferShippingDetails",
          shippingRate: usd("3.49"),
          deliveryTime: {
            "@type": "ShippingDeliveryTime",
            handlingTime: { "@type": "QuantitativeValue", minValue: "0", maxValue: "1", unitCode: "DAY" },
            transitTime: { "@type": "QuantitativeValue", minValue: "1", maxValue: "5", unitCode: "DAY" },
          },
        },
      },
    }]],
    money: ["entities[0].attributes.offers.price", "entities[0].attributes.offers.shippingDetails.shippingRate"],
    volatile: [
      "offers.price",
      "offers.inventoryLevel",
      "offers.shippingDetails.shippingRate",
      "offers.shippingDetails.deliveryTime",
    ],
    live: {
      "offers.shippingDetails.shippingRate": usd("4.99"),
      "offers.inventoryLevel": { "@type": "QuantitativeValue", value: "3" },
    },
    check(graph) {
      assert.deepEqual(productOf(graph).attributes.offers, {
        "@type": "Offer",
        priceCurrency: "USD",
        shippingDetails: { "@type": "OfferShippingDetails" },
      });
    },
  },
];

describe("hydrate on compiled product markup: no cached money survives", () => {
  for (const site of SITES) {
    describe(site.name, () => {
      it("control: the walk finds the cached money in the graph before hydration", async () => {
        await withCompiledSite(site, async (store, ns) => {
          const { graph } = await store.readCurrentGraph(CALLER, ns);
          // Every listed copy is found. A compiler may keep more (in describes_
          // assertions, say); the hydration tests then require those gone too.
          const found = new Set(findMoney(graph));
          assert.deepEqual(site.money.filter((entry) => !found.has(entry)), []);
        });
      });

      for (const failure of FAILURES) {
        it(`${failure.name}: no money value remains anywhere in the hydrated graph`, async () => {
          await withCompiledSite(site, async (store, ns) => {
            const published = (await store.readCurrentGraph(CALLER, ns)).graph;
            const adapter = failure.adapter();
            const result = await hydrate(CALLER, ns, store, adapter, null);

            assert.equal(result.sourceStatus, "unavailable");
            if (adapter) assert.equal(adapter.calls, failure.expectedCalls);
            assertNoCachedMoney(result.graph);
            assertValidUnderContract(result.graph, { integrity: site.publish });
            site.check(result.graph, published);
          });
        });
      }
    });
  }
});

describe("hydrate on compiled product markup: money outside offers comes live, at its own path", () => {
  for (const site of SITES.filter((candidate) => candidate.live)) {
    it(`${site.name}: asks for every volatile path, serves only the live values`, async () => {
      await withCompiledSite(site, async (store, ns) => {
        const { graph } = await store.readCurrentGraph(CALLER, ns);
        const index = subjectIndex(graph);
        const adapter = liveAdapter(graph.entities[index].id, site.live);

        const result = await hydrate(CALLER, ns, store, adapter, null);

        assert.equal(result.sourceStatus, "available");
        assert.deepEqual(sorted(adapter.requested), sorted(site.volatile));
        const { attributes } = result.graph.entities[index];
        for (const [field, value] of Object.entries(site.live)) {
          assert.deepEqual(valueAt(attributes, field), value, field);
        }
        for (const field of site.volatile.filter((name) => !(name in site.live))) {
          assert.equal(valueAt(attributes, field), undefined, `${field} was not returned: cleared`);
        }
        // Every money value left is a live one, at its own path: no cached
        // copy in another attribute, an assertion or an unresolved fact.
        const liveMoney = Object.entries(site.live).filter(([, value]) => isMoney(value));
        assert.deepEqual(
          sorted(findMoney(result.graph)),
          sorted(liveMoney.map(([field]) => `entities[${index}].attributes.${field}`)),
        );
        assert.deepEqual(sorted(result.liveFields), sorted(Object.keys(site.live)));
        assertValidUnderContract(result.graph, { integrity: site.publish });
      });
    });
  }

  it("revalidateForAction checks a top-level AggregateOffer's lowPrice against the source", async () => {
    const site = SITES.find((candidate) => candidate.name.startsWith("a top-level AggregateOffer"));
    await withCompiledSite(site, async (store, ns) => {
      const { graph } = await store.readCurrentGraph(CALLER, ns);
      const id = graph.entities[subjectIndex(graph)].id;
      const adapter = liveAdapter(id, { lowPrice: usd("75.00") });
      const expectedVersions = new Map([[id, new Map([["lowPrice", usd("79.00")]])]]);

      const result = await revalidateForAction(CALLER, ns, store, adapter, null, null, expectedVersions);

      assert.equal(result.ok, true, result.reason);
      assert.equal(result.mustRetry, true);
      assert.deepEqual(result.changedFields.get(`${id}:lowPrice`), {
        callerVersion: usd("79.00"),
        live: usd("75.00"),
      });
    });
  });

  it("revalidateForAction checks a product's own priceSpecification price", async () => {
    const site = SITES.find((candidate) => candidate.name === "a priceSpecification on the product itself");
    await withCompiledSite(site, async (store, ns) => {
      const { graph } = await store.readCurrentGraph(CALLER, ns);
      const id = productOf(graph).id;
      const adapter = liveAdapter(id, { "priceSpecification.price": eur("24.00") });
      const expectedVersions = new Map([[id, new Map([["priceSpecification.price", eur("24.00")]])]]);

      const result = await revalidateForAction(CALLER, ns, store, adapter, null, null, expectedVersions);

      assert.equal(result.ok, true, result.reason);
      assert.equal(result.mustRetry, false);
    });
  });
});

// ---------------------------------------------------------------------------
// Hand-built graphs: each rule that keeps a cached value out of hydrate
// ---------------------------------------------------------------------------

const CAPTURED = "2026-10-27T00:00:00.000Z";
const SOURCE = { sourceId: "src-shop", version: "v1", capturedAt: CAPTURED, tenantScope: TENANT };

function entityOf(id, attributes, type = "product") {
  return {
    id,
    type,
    ...(attributes ? { attributes } : {}),
    provenance: "observed",
    tenantScope: TENANT,
    sourceId: "src-shop",
    sourceVersion: "v1",
    capturedAt: CAPTURED,
  };
}

function assertionOf(id, subject, predicate, object) {
  return {
    id,
    subject,
    predicate,
    object,
    provenance: "observed",
    schemaValidity: "unvalidated",
    modelConfidence: "unavailable",
    freshness: { asOf: CAPTURED },
    source: SOURCE,
  };
}

function linkOf(source, target, predicate) {
  return {
    source,
    target,
    predicate,
    provenance: "derived",
    tenantScope: TENANT,
    sourceId: "src-shop",
    sourceVersion: "v1",
    capturedAt: CAPTURED,
  };
}

function graphOf({ entities, assertions, links, unresolvedFacts }) {
  const count = (field) => assertions.reduce(
    (counts, assertion) => ({ ...counts, [assertion[field]]: (counts[assertion[field]] ?? 0) + 1 }), {});
  return {
    version: GRAPH_SCHEMA_VERSION,
    entities,
    ...(links ? { links } : {}),
    assertions,
    ...(unresolvedFacts ? { unresolvedFacts } : {}),
    coverage: {
      totalAssertions: assertions.length,
      byProvenance: count("provenance"),
      bySchemaValidity: count("schemaValidity"),
    },
    generatedAt: "2026-10-27T12:00:00.000Z",
  };
}

const PAGE = "page:shop";
const WIDGET = "product:widget";

/** The ways hydrate gets no live values, then a live source for one entity. */
const withLive = (entityId, live) => [
  ...FAILURES,
  { name: "live source", adapter: () => liveAdapter(entityId, live) },
];

describe("hydrate on hand-built graphs: assertions, links and unresolved facts", () => {
  it("keeps a link only when both its ends are returned, and recounts coverage", async () => {
    const graph = graphOf({
      entities: [
        entityOf(PAGE, undefined, "page"),
        entityOf(WIDGET, { name: "Widget", price: usd("19.99") }),
      ],
      assertions: [
        assertionOf("a:describes", PAGE, "describes", { entityId: WIDGET }),
        assertionOf("a:name", WIDGET, "describes_name", "Widget"),
        assertionOf("a:price", WIDGET, "describes_price", usd("19.99")),
      ],
      links: [
        linkOf(PAGE, WIDGET, "describes"),
        linkOf("a:name", PAGE, "supported_by"),
        linkOf("a:price", PAGE, "supported_by"),
        linkOf(PAGE, "a:price", "cites"),
      ],
    });
    const ends = (result) => result.graph.links.map((link) => `${link.source} > ${link.target}`);
    await withPublishedGraph(graph, async (store, ns) => {
      for (const failure of withLive(WIDGET, { price: usd("18.99") })) {
        const result = await hydrate(CALLER, ns, store, failure.adapter(), null);

        assert.deepEqual(result.graph.assertions.map((assertion) => assertion.id), ["a:describes", "a:name"]);
        // The removed assertion was the source of one link and the target of another
        assert.deepEqual(ends(result), [`${PAGE} > ${WIDGET}`, `a:name > ${PAGE}`], failure.name);
        assert.deepEqual(result.graph.coverage, {
          totalAssertions: 2,
          byProvenance: { observed: 2 },
          bySchemaValidity: { unvalidated: 2 },
        });
        assertValidUnderContract(result.graph, { integrity: true });
      }

      // An entity left out by entityIds takes its links with it
      const widgetOnly = await hydrate(CALLER, ns, store, FAILURES[0].adapter(), null, { entityIds: [WIDGET] });
      assert.deepEqual(ends(widgetOnly), []);
      assertValidUnderContract(widgetOnly.graph, { integrity: true });
      const pageOnly = await hydrate(CALLER, ns, store, FAILURES[0].adapter(), null, { entityIds: [PAGE] });
      assert.deepEqual(ends(pageOnly), [`a:name > ${PAGE}`]);
      assertValidUnderContract(pageOnly.graph, { integrity: true });
    });
  });

  it("removes describes_<field> when that field of its subject is volatile, whatever the object", async () => {
    // A cached price stated as text: neither a volatile field name nor money,
    // but lowPrice is a money value on its subject in the published graph.
    // The rule reads the published entity: on an outage the hydrated one has
    // no lowPrice left. Served directly, since the contract's
    // monetary-predicate check would refuse to publish it.
    const graph = graphOf({
      entities: [entityOf(WIDGET, { name: "Widget", lowPrice: usd("79.00") })],
      assertions: [
        assertionOf("a:name", WIDGET, "describes_name", "Widget"),
        assertionOf("a:low", WIDGET, "describes_lowPrice", "79.00"),
      ],
    });
    assert.deepEqual(findMoney(graph), ["entities[0].attributes.lowPrice", "assertions[1].object = \"79.00\""]);

    for (const failure of withLive(WIDGET, { lowPrice: usd("75.00") })) {
      const result = await hydrate(CALLER, parseNamespace(TENANT), servingStore(graph), failure.adapter(), null);

      assert.deepEqual(predicatesOf(result.graph), ["describes_name"], failure.name);
      const lowPrice = failure.name === "live source" ? usd("75.00") : undefined;
      assert.deepEqual(result.graph.entities[0].attributes.lowPrice, lowPrice, failure.name);
    }
  });

  it("removes an assertion whose predicate names a volatile field its subject does not carry", async () => {
    const graph = graphOf({
      entities: [entityOf(PAGE, undefined, "page"), entityOf(WIDGET, { name: "Widget" })],
      assertions: [
        assertionOf("a:name", WIDGET, "describes_name", "Widget"),
        assertionOf("a:availability", WIDGET, "describes_availability", "https://schema.org/InStock"),
        assertionOf("a:availability-cap", WIDGET, "describes_Availability", "https://schema.org/InStock"),
        assertionOf("a:availability-ns", WIDGET, "describes_schema:availability", "https://schema.org/InStock"),
        assertionOf("a:delivery", PAGE, "deliveryEstimate", "2 business days"),
      ],
    });
    await withPublishedGraph(graph, async (store, ns) => {
      const result = await hydrate(CALLER, ns, store, liveAdapter(WIDGET, {}), null);

      assert.deepEqual(predicatesOf(result.graph), ["describes_name"]);
      assertValidUnderContract(result.graph, { integrity: true });
    });
  });

  it("removes an assertion that is or holds money at any depth, whatever its predicate", async () => {
    const graph = graphOf({
      entities: [entityOf(PAGE, undefined, "page")],
      assertions: [
        assertionOf("a:heading", PAGE, "contains", { kind: "h1", text: "Widget" }),
        assertionOf("a:quote", PAGE, "quotes", { offer: { sku: "W-1", price: usd("19.99") } }),
        assertionOf("a:banner", PAGE, "advertises", usd("14.99")),
      ],
    });
    await withPublishedGraph(graph, async (store, ns) => {
      const result = await hydrate(CALLER, ns, store, liveAdapter(PAGE, {}), null);

      assert.deepEqual(predicatesOf(result.graph), ["contains"]);
      assertNoCachedMoney(result.graph);
      assertValidUnderContract(result.graph, { integrity: true });
    });
  });

  it("returns every unresolved fact without its rawValue, keeping field, path and reason", async () => {
    const record = { entityLabel: "Widget", entityKind: "product", sourceId: "src-shop", tenantScope: TENANT };
    const facts = [
      { field: "price", path: "offers[0].priceSpecification[1].price", rawValue: "19.99", reason: "currency_missing" },
      {
        field: "hasVariant",
        path: "hasVariant",
        rawValue: [
          { "@type": "Product", sku: "W-S", offers: { "@type": "Offer", price: 19.99, priceCurrency: "USD" } },
          { "@type": "Product", sku: "W-L", offers: { "@type": "Offer", price: 24.99, priceCurrency: "USD" } },
        ],
        reason: "untyped_number",
      },
      { field: "price", path: "offers.price", rawValue: "call for price", reason: "amount_invalid" },
      { field: "ratingValue", path: "aggregateRating.ratingValue", rawValue: 4.6, reason: "untyped_number" },
    ].map((fact) => ({ ...fact, ...record }));
    const graph = graphOf({
      entities: [entityOf(WIDGET, { name: "Widget" })],
      assertions: [assertionOf("a:name", WIDGET, "describes_name", "Widget")],
      unresolvedFacts: facts,
    });
    await withPublishedGraph(graph, async (store, ns) => {
      const served = (await store.readCurrentGraph(CALLER, ns)).graph;
      assert.deepEqual(findMoney(served), [
        "unresolvedFacts[0].rawValue = \"19.99\"",
        "unresolvedFacts[1].rawValue[0].offers.price = 19.99",
        "unresolvedFacts[1].rawValue[1].offers.price = 24.99",
      ]);

      const expected = facts.map(({ rawValue: _raw, ...rest }) => rest);
      for (const failure of withLive(WIDGET, {})) {
        const result = await hydrate(CALLER, ns, store, failure.adapter(), null);

        assert.deepEqual(result.graph.unresolvedFacts, expected, failure.name);
        assertNoCachedMoney(result.graph);
        assertValidUnderContract(result.graph, { integrity: true });
      }
    });
  });
});

describe("hydrate on hand-built graphs: where a money value sits", () => {
  it("never serves attributes that are themselves a money value, sliced by fieldNames or not", async () => {
    const graph = graphOf({ entities: [entityOf("rate:standard", usd("4.99"))], assertions: [] });
    const slices = [undefined, ["amount"], ["amount", "currency"], ["amount", "amountUnit", "currency", "exponent"]];
    await withPublishedGraph(graph, async (store, ns) => {
      for (const fieldNames of slices) {
        for (const failure of withLive("rate:standard", { "": usd("5.99") })) {
          const label = `${failure.name}, fieldNames ${JSON.stringify(fieldNames)}`;
          const adapter = failure.adapter();
          const result = await hydrate(CALLER, ns, store, adapter, null, { fieldNames });

          assert.deepEqual(result.graph.entities[0].attributes, {}, label);
          // No field path names it, so the source is never asked for it
          if (adapter) assert.equal(adapter.calls, 0, label);
          assert.deepEqual(result.liveFields, [], label);
          assertNoCachedMoney(result.graph);
          assertValidUnderContract(result.graph, { integrity: true });
        }
      }
    });
  });

  it("treats money under an empty attribute key as volatile too", async () => {
    // The compiler copies every JSON-LD key into the attributes, "" included.
    const graph = graphOf({
      entities: [entityOf(WIDGET, { name: "Widget", "": usd("19.99") })],
      assertions: [assertionOf("a:name", WIDGET, "describes_name", "Widget")],
    });
    await withPublishedGraph(graph, async (store, ns) => {
      const adapter = liveAdapter(WIDGET, { "": usd("18.99") });
      const live = await hydrate(CALLER, ns, store, adapter, null);
      assert.deepEqual(adapter.requested, [""]);
      assert.deepEqual(live.graph.entities[0].attributes, { name: "Widget", "": usd("18.99") });
      assert.deepEqual(live.liveFields, [""]);

      const outage = await hydrate(CALLER, ns, store, FAILURES[0].adapter(), null);
      assert.deepEqual(outage.graph.entities[0].attributes, { name: "Widget" });
      assert.deepEqual(outage.liveFields, []);
      assertNoCachedMoney(outage.graph);
    });
  });

  it("fetches, merges and clears a list holding money as one value, never by item", async () => {
    const graph = graphOf({
      entities: [entityOf(WIDGET, {
        name: "Gift card",
        denominations: ["small", "large"],
        prices: [usd("25.00"), usd("50.00")],
        // Money in nested lists makes the outer list the one value
        tiers: [[usd("10.00"), usd("9.00")], [usd("8.00")]],
      })],
      assertions: [assertionOf("a:name", WIDGET, "describes_name", "Gift card")],
    });
    const stable = { name: "Gift card", denominations: ["small", "large"] };
    await withPublishedGraph(graph, async (store, ns) => {
      for (const failure of FAILURES) {
        const result = await hydrate(CALLER, ns, store, failure.adapter(), null);
        assert.deepEqual(result.graph.entities[0].attributes, stable, failure.name);
        assertValidUnderContract(result.graph, { integrity: true });
      }

      // A source that answers one item by index has not answered the list, so
      // its value lands nowhere rather than at the wrong item.
      const byItem = liveAdapter(WIDGET, { "prices[1]": usd("45.00") }, { onlyAsked: false });
      const partial = await hydrate(CALLER, ns, store, byItem, null);
      assert.deepEqual(byItem.requested, ["prices", "tiers"]);
      assert.deepEqual(partial.graph.entities[0].attributes, stable);
      assert.deepEqual(partial.liveFields, []);

      const whole = liveAdapter(WIDGET, { prices: [usd("25.00"), usd("45.00")] });
      const full = await hydrate(CALLER, ns, store, whole, null);
      assert.deepEqual(full.graph.entities[0].attributes, { ...stable, prices: [usd("25.00"), usd("45.00")] });
      assert.deepEqual(full.liveFields, ["prices"]);
      assertValidUnderContract(full.graph, { integrity: true });
    });
  });

  it("never moves a live value to another item of a list that mixes money and offers", async () => {
    const graph = graphOf({
      entities: [entityOf(WIDGET, { name: "Mixed", offers: [usd("25.00"), { sku: "B", price: usd("50.00") }] })],
      assertions: [assertionOf("a:name", WIDGET, "describes_name", "Mixed")],
    });
    await withPublishedGraph(graph, async (store, ns) => {
      const byItem = liveAdapter(WIDGET, { "offers[1].price": usd("45.00") }, { onlyAsked: false });
      const result = await hydrate(CALLER, ns, store, byItem, null);

      assert.deepEqual(byItem.requested, ["offers"]);
      assert.deepEqual(result.graph.entities[0].attributes, { name: "Mixed" });
      assertNoCachedMoney(result.graph);
    });
  });
});

// ---------------------------------------------------------------------------
// The caller's view, liveFields, and a source that misbehaves
// ---------------------------------------------------------------------------

const SINGLE_OFFER = SITES.find((site) => site.name === "a single offer with a price");

describe("hydrate: the caller's view, liveFields and a misbehaving source", () => {
  it("keeps a compiled graph valid when entityIds leaves out one end of its links", async () => {
    await withCompiledSite(SINGLE_OFFER, async (store, ns) => {
      const { graph } = await store.readCurrentGraph(CALLER, ns);
      const product = productOf(graph);
      const page = graph.entities.find((entity) => entity.type === "page");
      assert.ok(graph.links.some((link) => link.source === page.id && link.target === product.id));

      for (const adapter of [FAILURES[0].adapter(), liveAdapter(product.id, { "offers.price": usd("85.00") })]) {
        const result = await hydrate(CALLER, ns, store, adapter, null, { entityIds: [product.id] });

        assert.deepEqual(result.graph.entities.map((entity) => entity.id), [product.id]);
        assert.deepEqual(result.graph.links, []);
        assertValidUnderContract(result.graph, { integrity: true });
      }
    });
  });

  it("filters to the requested fields with or without a source, asking only inside them", async () => {
    await withCompiledSite(SINGLE_OFFER, async (store, ns) => {
      const { graph } = await store.readCurrentGraph(CALLER, ns);
      const id = productOf(graph).id;

      const noSource = await hydrate(CALLER, ns, store, null, null, { fieldNames: ["name", "offers"] });
      assert.deepEqual(Object.keys(productOf(noSource.graph).attributes), ["name", "offers"]);
      assert.equal(productOf(noSource.graph).attributes.offers.price, undefined);

      const nameOnly = liveAdapter(id, { "offers.price": usd("85.00") });
      const named = await hydrate(CALLER, ns, store, nameOnly, null, { fieldNames: ["name"] });
      assert.equal(nameOnly.calls, 0);
      assert.deepEqual(productOf(named.graph).attributes, { name: "Trail Runner 2" });

      const offersOnly = liveAdapter(id, { "offers.price": usd("85.00") });
      const offered = await hydrate(CALLER, ns, store, offersOnly, null, { fieldNames: ["offers"] });
      assert.deepEqual(sorted(offersOnly.requested), ["offers.availability", "offers.price"]);
      assert.deepEqual(productOf(offered.graph).attributes.offers.price, usd("85.00"));
    });
  });

  it("lists in liveFields only the paths that hold a live value", async () => {
    await withCompiledSite(SINGLE_OFFER, async (store, ns) => {
      const { graph } = await store.readCurrentGraph(CALLER, ns);
      const id = productOf(graph).id;
      for (const failure of FAILURES) {
        const result = await hydrate(CALLER, ns, store, failure.adapter(), null);
        assert.deepEqual(result.liveFields, [], failure.name);
      }

      const partial = await hydrate(CALLER, ns, store, liveAdapter(id, { "offers.price": usd("85.00") }), null);
      assert.deepEqual(partial.liveFields, ["offers.price"]);
    });
  });

  it("serves a degraded source's live values and reports the source as degraded", async () => {
    await withCompiledSite(SINGLE_OFFER, async (store, ns) => {
      const { graph } = await store.readCurrentGraph(CALLER, ns);
      const id = productOf(graph).id;
      const adapter = countingAdapter("degraded", async () =>
        new Map([[id, new Map([["offers.price", usd("85.00")]])]]));
      const result = await hydrate(CALLER, ns, store, adapter, null);

      assert.equal(result.sourceStatus, "degraded");
      assert.equal(adapter.calls, 1);
      assert.deepEqual(productOf(result.graph).attributes.offers.price, usd("85.00"));
      assert.equal(productOf(result.graph).attributes.offers.availability, undefined);
      assert.deepEqual(result.liveFields, ["offers.price"]);
    });
  });

  it("treats an unknown source status, or a response that is not a Map, as an outage", async () => {
    await withCompiledSite(SINGLE_OFFER, async (store, ns) => {
      const adapters = [
        countingAdapter("maintenance", async () => new Map()),
        countingAdapter("available", async () => ({})),
        countingAdapter("available", async () => undefined),
      ];
      for (const adapter of adapters) {
        const result = await hydrate(CALLER, ns, store, adapter, null);

        assert.equal(result.sourceStatus, "unavailable");
        assertNoCachedMoney(result.graph);
      }
      assert.deepEqual(adapters.map((adapter) => adapter.calls), [0, 1, 1]);
    });
  });
});

describe("revalidateForAction: dependencies and malformed input fail closed", () => {
  const record = (sourceId, sourceStatus) => createSourceVersion({
    sourceId,
    version: "v7",
    fetchedAt: "2026-10-27T11:00:00.000Z",
    sourceStatus,
  });
  const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
  const seen = (id) => new Map([[id, new Map([["offers.price", usd("89.00")]])]]);
  const current = (id) => liveAdapter(id, {
    "offers.price": usd("89.00"),
    "offers.availability": "https://schema.org/InStock",
  });

  async function withProduct(fn) {
    await withCompiledSite(SINGLE_OFFER, async (store, ns) => {
      const { graph } = await store.readCurrentGraph(CALLER, ns);
      await fn(store, ns, productOf(graph).id);
    });
  }

  it("blocks the action when a dependency is unavailable, wherever it is listed", async () => {
    await withProduct(async (store, ns, id) => {
      for (const dependencies of [
        [record("catalog", "available"), record("payments", "unavailable")],
        [record("payments", "unavailable"), record("catalog", "available")],
        [record("catalog", "degraded"), record("payments", "unavailable")],
      ]) {
        const adapter = current(id);
        const result = await revalidateForAction(CALLER, ns, store, adapter, null, dependencies, seen(id));

        assert.equal(result.ok, false);
        assert.match(result.reason, /payments.*unavailable/);
        assert.equal(adapter.calls, 0, "blocked before the source is asked");
      }
    });
  });

  it("revalidates against a degraded source and reports it, as degraded too", async () => {
    await withProduct(async (store, ns, id) => {
      const degradedSource = () => countingAdapter("degraded", async () =>
        new Map([[id, new Map([["offers.price", usd("89.00")]])]]));
      const adapter = degradedSource();
      const result = await revalidateForAction(CALLER, ns, store, adapter, null, null, seen(id));

      assert.equal(result.ok, true, result.reason);
      assert.equal(result.mustRetry, false);
      assert.equal(result.sourceStatus, "degraded");
      assert.equal(result.degraded, true);
      assert.match(result.reason, /live source is degraded/);
      assert.equal(adapter.calls, 1);

      // A degraded dependency as well: both are named
      const both = await revalidateForAction(CALLER, ns, store, degradedSource(), null,
        [record("payments", "degraded")], seen(id));
      assert.equal(both.ok, true, both.reason);
      assert.equal(both.degraded, true);
      assert.match(both.reason, /live source is degraded/);
      assert.match(both.reason, /payments.*degraded/);
    });
  });

  it("counts the worse of two records for one source, in either order", async () => {
    await withProduct(async (store, ns, id) => {
      const down = createSourceVersion({
        sourceId: "payments", version: "v2", fetchedAt: "2026-10-27T11:00:00.000Z", sourceStatus: "unavailable",
      });
      const up = createSourceVersion({
        sourceId: "payments", version: "v1", fetchedAt: "2026-10-27T10:00:00.000Z", sourceStatus: "available",
      });
      for (const dependencies of [[down, up], [up, down]]) {
        const adapter = current(id);
        const result = await revalidateForAction(CALLER, ns, store, adapter, null, dependencies, seen(id));

        assert.equal(result.ok, false, dependencies.map((dep) => dep.version).join(","));
        assert.match(result.reason, /payments.*unavailable/);
        assert.equal(adapter.calls, 0);
      }

      const slow = record("payments", "degraded");
      for (const dependencies of [[slow, up], [up, slow]]) {
        const result = await revalidateForAction(CALLER, ns, store, current(id), null, dependencies, seen(id));

        assert.equal(result.ok, true, result.reason);
        assert.equal(result.degraded, true);
      }
    });
  });

  it("discloses a degraded dependency and goes on to revalidate", async () => {
    await withProduct(async (store, ns, id) => {
      const degraded = await revalidateForAction(CALLER, ns, store, current(id), null,
        [record("catalog", "available"), record("payments", "degraded")], seen(id));
      assert.equal(degraded.ok, true);
      assert.equal(degraded.mustRetry, false);
      assert.equal(degraded.degraded, true);
      assert.match(degraded.reason, /payments.*degraded/);

      const healthy = await revalidateForAction(CALLER, ns, store, current(id), null,
        [record("catalog", "available")], seen(id));
      assert.equal(healthy.ok, true);
      assert.equal(healthy.degraded, undefined);
    });
  });

  it("blocks dependencies that are not SourceVersion records, without throwing", async () => {
    await withProduct(async (store, ns, id) => {
      for (const dependencies of [
        ["catalog"],
        "catalog",
        {},
        [{ sourceId: "catalog", sourceStatus: "available" }],
        [{ ...record("catalog", "available"), sourceStatus: "maintenance" }],
        [{ ...record("catalog", "available"), fetchedAt: "" }],
        [without(record("catalog", "available"), "fetchedAt")],
        [without(record("catalog", "available"), "version")],
      ]) {
        const result = await revalidateForAction(CALLER, ns, store, current(id), null, dependencies, seen(id));

        assert.equal(result.ok, false, JSON.stringify(dependencies));
        assert.match(result.reason, /SourceVersion/);
      }
    });
  });

  it("blocks a missing or misbehaving source, or malformed expectations, without throwing", async () => {
    await withProduct(async (store, ns, id) => {
      const throwingStatus = current(id);
      throwingStatus.sourceStatus = () => { throw new Error("status endpoint down"); };
      const cases = [
        ["no adapter", null, seen(id), /unavailable/],
        ["status check throws", throwingStatus, seen(id), /unavailable/],
        ["unknown status", countingAdapter("maintenance", async () => new Map()), seen(id), /unavailable/],
        ["response not a Map", countingAdapter("available", async () => ({})), seen(id), /malformed/],
        ["entity values not Maps", countingAdapter("available", async () =>
          new Map([[id, { "offers.price": usd("89.00") }]])), seen(id), /malformed/],
        ["expectedVersions not a Map", current(id), { [id]: { "offers.price": usd("89.00") } }, /expectedVersions/],
        ["expected fields not a Map", current(id),
          new Map([[id, { "offers.price": usd("89.00") }]]), /expectedVersions/],
      ];
      for (const [name, adapter, expectedVersions, reason] of cases) {
        const result = await revalidateForAction(CALLER, ns, store, adapter, null, null, expectedVersions);

        assert.equal(result.ok, false, name);
        assert.match(result.reason, reason, name);
      }
    });
  });
});

describe("volatile field names", () => {
  it("match in any case, with any separator, under a namespace prefix", () => {
    for (const name of [
      "price", "Price", "AVAILABILITY", "Availability", "inventory", "INVENTORY", "inventory_level",
      "InventoryLevel", "delivery-estimate", "DeliveryEstimate", "Delivery_Time", "deliveryLeadTime",
      "schema:availability", "https://schema.org/availability", "http://schema.org/inventoryLevel",
    ]) {
      assert.equal(isVolatileField(name), true, name);
    }
  });

  it("do not match other fields", () => {
    for (const name of [
      "name", "priceCurrency", "PriceCurrency", "priceValidUntil", "availabilityStarts",
      "itemCondition", "deliveryMethod", "schema:name", "", undefined, null, 42, ["price"],
    ]) {
      assert.equal(isVolatileField(name), false, String(name));
    }
  });

  it("are volatile wherever they appear: a store's shipping policy is served live or cleared", async () => {
    // Not limited to offer paths, which would miss an estimate on a top-level
    // Offer entity or under makesOffer: the adapter serves these, or they go.
    const store = "organization:northwind";
    const policy = { name: "Northwind", deliveryTime: "Ships within 2 business days" };
    const graph = graphOf({
      entities: [entityOf(store, policy, "organisation")],
      assertions: [assertionOf("a:store-name", store, "describes_name", "Northwind")],
    });
    await withPublishedGraph(graph, async (graphStore, ns) => {
      for (const failure of FAILURES) {
        const result = await hydrate(CALLER, ns, graphStore, failure.adapter(), null);
        assert.deepEqual(result.graph.entities[0].attributes, { name: "Northwind" }, failure.name);
      }

      const serving = liveAdapter(store, { deliveryTime: "Ships within 3 business days" });
      const served = await hydrate(CALLER, ns, graphStore, serving, null);
      assert.deepEqual(serving.requested, ["deliveryTime"]);
      assert.deepEqual(served.graph.entities[0].attributes,
        { name: "Northwind", deliveryTime: "Ships within 3 business days" });

      const unserved = await hydrate(CALLER, ns, graphStore, liveAdapter(store, {}), null);
      assert.deepEqual(unserved.graph.entities[0].attributes, { name: "Northwind" });
    });
  });
});
