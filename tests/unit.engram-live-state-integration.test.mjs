/**
 * ENGRAM §EW14 — Live-state integration tests.
 *
 * Tests hydrate() and revalidateForAction() end-to-end through graph-store
 * with a stub live-source adapter. Complements the pure-helper unit tests in
 * unit.engram-live-state.test.mjs.
 */
import "./setup-env.mjs";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  validateAdapterShape,
  hydrate,
  revalidateForAction,
  LiveStateError,
  VOLATILE_FIELD_NAMES,
  isVolatileField,
  createCommerceContext,
} from "../src/engram/live-state.js";

import { createGraphStore } from "../src/engram/graph-store.js";
import { createLocalConsent } from "../src/engram/namespace.js";
import { AccessDeniedError, createScopedConsent } from "../src/engram/namespace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a stub live-source adapter that returns per-entity values.
 * values: Map<entityId, Map<field, value>> or a plain object {entityId: {field: value}}
 */
function makeStubAdapter(values = {}, sourceStatus = "available") {
  return {
    sourceId: "test:stub",
    sourceStatus: () => sourceStatus,
    fetchLive: async (_ctx, entityIds, _fieldNames) => {
      const outer = new Map();
      for (const eid of entityIds) {
        const perEntity = values[eid];
        if (perEntity && typeof perEntity === "object") {
          const inner = new Map(Object.entries(perEntity));
          outer.set(eid, inner);
        }
      }
      return outer;
    },
  };
}

/** Minimal caller identity for local consent. */
const CALLER = { id: "test-agent", kind: "agent" };

/** Create a namespace object that authorize() accepts. */
function makeNamespace(raw) {
  return { raw };
}

// ---------------------------------------------------------------------------
// validateAdapterShape
// ---------------------------------------------------------------------------

describe("validateAdapterShape", () => {
  it("accepts a valid adapter", () => {
    const issues = validateAdapterShape(makeStubAdapter());
    assert.deepEqual(issues, []);
  });

  it("rejects null", () => {
    assert.deepEqual(validateAdapterShape(null), ["adapter must be an object"]);
  });

  it("rejects missing fetchLive", () => {
    const issues = validateAdapterShape({ sourceId: "x", sourceStatus: () => "available" });
    assert.ok(issues.some((s) => s.includes("fetchLive")));
  });

  it("rejects missing sourceId", () => {
    const issues = validateAdapterShape({
      fetchLive: async () => new Map(),
      sourceStatus: () => "available",
    });
    assert.ok(issues.some((s) => s.includes("sourceId")));
  });

  it("rejects empty sourceId", () => {
    const issues = validateAdapterShape({
      fetchLive: async () => new Map(),
      sourceId: "",
      sourceStatus: () => "available",
    });
    assert.ok(issues.some((s) => s.includes("sourceId")));
  });

  it("rejects missing sourceStatus", () => {
    const issues = validateAdapterShape({
      fetchLive: async () => new Map(),
      sourceId: "test",
    });
    assert.ok(issues.some((s) => s.includes("sourceStatus")));
  });
});

// ---------------------------------------------------------------------------
// VOLATILE_FIELD_NAMES / isVolatileField
// ---------------------------------------------------------------------------

describe("VOLATILE_FIELD_NAMES", () => {
  it("is frozen", () => {
    assert.ok(Object.isFrozen(VOLATILE_FIELD_NAMES));
  });

  it("includes the expected volatile fields", () => {
    assert.ok(VOLATILE_FIELD_NAMES.includes("price"));
    assert.ok(VOLATILE_FIELD_NAMES.includes("availability"));
    assert.ok(VOLATILE_FIELD_NAMES.includes("inventory"));
    assert.ok(VOLATILE_FIELD_NAMES.includes("delivery_estimate"));
  });

  it("isVolatileField returns true for volatile fields", () => {
    assert.strictEqual(isVolatileField("price"), true);
    assert.strictEqual(isVolatileField("inventory"), true);
  });

  it("isVolatileField returns false for non-volatile fields", () => {
    assert.strictEqual(isVolatileField("name"), false);
    assert.strictEqual(isVolatileField("description"), false);
    assert.strictEqual(isVolatileField(""), false);
  });
});

// ---------------------------------------------------------------------------
// hydrate() integration tests
// ---------------------------------------------------------------------------

describe("hydrate", () => {
  /** @type {string} */
  let storeRoot;
  /** @type {ReturnType<typeof createGraphStore>} */
  let store;
  let consent;
  let ns;

  before(() => {
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sl-hydrate-test-"));
    store = createGraphStore({ storeRoot, consent: createLocalConsent({ allowGuests: true }) });
    consent = createLocalConsent({ allowGuests: true });
    ns = makeNamespace("test:hydrate");
  });

  after(() => {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  });

  it("returns null graph when no graph is published", async () => {
    const adapter = makeStubAdapter({ "product:1": { price: { amount: 9999, amountUnit: "minor_units", currency: "USD", exponent: 2 } } });
    const ctx = createCommerceContext({ currency: "USD" });

    const result = await hydrate(CALLER, ns, store, adapter, ctx);

    assert.strictEqual(result.graph, null);
    assert.ok(result.reason.includes("no graph"));
  });

  it("hydrates volatile fields per entity from the live adapter", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:1",
          type: "product",
          attributes: {
            price: { amount: 1999, amountUnit: "minor_units", currency: "USD", exponent: 2 },
            name: "Widget",
          },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
        {
          id: "product:2",
          type: "product",
          attributes: {
            price: { amount: 2999, amountUnit: "minor_units", currency: "USD", exponent: 2 },
            name: "Gadget",
          },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    // Each entity gets its own live price — NOT shared
    const adapter = makeStubAdapter({
      "product:1": { price: { amount: 2499, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
      "product:2": { price: { amount: 4999, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
    });
    const ctx = createCommerceContext({ currency: "USD" });

    const result = await hydrate(CALLER, ns, store, adapter, ctx);

    assert.ok(result.graph);
    assert.strictEqual(result.sourceStatus, "available");
    assert.ok(result.liveFields.includes("price"));

    // Product 1 gets its own live price
    const p1 = result.graph.entities.find((e) => e.id === "product:1");
    assert.deepEqual(p1.attributes.price, { amount: 2499, amountUnit: "minor_units", currency: "USD", exponent: 2 });
    // Non-volatile field preserved
    assert.strictEqual(p1.attributes.name, "Widget");

    // Product 2 gets its OWN live price — not the same as product 1
    const p2 = result.graph.entities.find((e) => e.id === "product:2");
    assert.deepEqual(p2.attributes.price, { amount: 4999, amountUnit: "minor_units", currency: "USD", exponent: 2 });
  });

  it("clears volatile fields when source is unavailable (never serves cached)", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:99",
          type: "product",
          label: "Gadget",
          attributes: {
            price: { amount: 2000, amountUnit: "minor_units", currency: "USD", exponent: 2 },
            name: "Gadget",
          },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    // Source unavailable — adapter not even needed
    const adapter = makeStubAdapter({}, "unavailable");

    const result = await hydrate(CALLER, ns, store, adapter, null);

    assert.ok(result.graph);
    assert.strictEqual(result.sourceStatus, "unavailable");
    // Volatile field price is CLEARED, not cached
    assert.strictEqual(result.graph.entities[0].attributes.price, undefined);
    // Non-volatile field is preserved
    assert.strictEqual(result.graph.entities[0].attributes.name, "Gadget");
  });

  it("handles adapter fetch failure gracefully (clears volatiles)", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:3",
          type: "product",
          attributes: { price: { amount: 3000, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    const badAdapter = {
      sourceId: "bad",
      sourceStatus: () => "available",
      fetchLive: async () => { throw new Error("transport error"); },
    };

    const result = await hydrate(CALLER, ns, store, badAdapter, null);

    assert.ok(result.graph);
    assert.strictEqual(result.sourceStatus, "unavailable");
    // Price cleared on fetch failure
    assert.strictEqual(result.graph.entities[0].attributes.price, undefined);
  });

  it("filters to requested entities when entityIds provided", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:a",
          type: "product",
          attributes: { name: "A" },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
        {
          id: "product:b",
          type: "product",
          attributes: { name: "B" },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    const adapter = makeStubAdapter({});
    const result = await hydrate(CALLER, ns, store, adapter, null, { entityIds: ["product:a"] });

    assert.ok(result.graph);
    assert.strictEqual(result.graph.entities.length, 1);
    assert.strictEqual(result.graph.entities[0].id, "product:a");
  });

  it("filters to requested fields when fieldNames provided", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:c",
          type: "product",
          attributes: { price: { amount: 500, amountUnit: "minor_units", currency: "USD", exponent: 2 }, name: "C", description: "Desc" },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    const adapter = makeStubAdapter({ "product:c": { price: { amount: 750, amountUnit: "minor_units", currency: "USD", exponent: 2 } } });
    const result = await hydrate(CALLER, ns, store, adapter, null, { fieldNames: ["price"] });

    assert.ok(result.graph);
    const attrs = result.graph.entities[0].attributes;
    assert.ok(attrs.price);
    assert.strictEqual(attrs.name, undefined);
    assert.strictEqual(attrs.description, undefined);
  });

  it("walks schema.org offers for volatile fields", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:offer1",
          type: "product",
          attributes: {
            name: "OfferProduct",
            offers: { price: { amount: 1999, amountUnit: "minor_units", currency: "USD", exponent: 2 }, availability: "InStock" },
          },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    const adapter = makeStubAdapter({
      "product:offer1": {
        "offers.price": { amount: 2599, amountUnit: "minor_units", currency: "USD", exponent: 2 },
        "offers.availability": "OutOfStock",
      },
    });
    const result = await hydrate(CALLER, ns, store, adapter, null);

    assert.ok(result.graph);
    assert.ok(result.liveFields.includes("offers.price"));
    assert.ok(result.liveFields.includes("offers.availability"));
    // offers price updated
    assert.deepEqual(result.graph.entities[0].attributes.offers.price, { amount: 2599, amountUnit: "minor_units", currency: "USD", exponent: 2 });
    // offers availability updated
    assert.strictEqual(result.graph.entities[0].attributes.offers.availability, "OutOfStock");
  });
  it("clears AggregateOffer volatile fields on outage", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:agg1",
          type: "product",
          attributes: {
            name: "AggProduct",
            offers: {
              "@type": "AggregateOffer",
              lowPrice: { amount: "9.99", amountUnit: "major_decimal", currency: "USD", exponent: 2 },
              highPrice: { amount: "49.99", amountUnit: "major_decimal", currency: "USD", exponent: 2 },
              price: { amount: "19.99", amountUnit: "major_decimal", currency: "USD", exponent: 2 },
            },
          },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    const adapter = makeStubAdapter({}, "unavailable");
    const result = await hydrate(CALLER, ns, store, adapter, null);

    assert.ok(result.graph);
    assert.strictEqual(result.sourceStatus, "unavailable");
    const offers = result.graph.entities[0].attributes.offers;
    // Non-volatile fields preserved
    assert.strictEqual(offers["@type"], "AggregateOffer");
    // Volatile fields cleared
    assert.strictEqual(offers.lowPrice, undefined);
    assert.strictEqual(offers.highPrice, undefined);
    assert.strictEqual(offers.price, undefined);
    // Non-volatile top-level preserved
    assert.strictEqual(result.graph.entities[0].attributes.name, "AggProduct");
  });

  it("writes live values to variant array offers at the correct index", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:variants",
          type: "product",
          attributes: {
            name: "VariantProduct",
            offers: [
              { price: { amount: "5.00", amountUnit: "major_decimal", currency: "USD", exponent: 2 }, sku: "V1" },
              { price: { amount: "6.00", amountUnit: "major_decimal", currency: "USD", exponent: 2 }, sku: "V2" },
            ],
          },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    const adapter = makeStubAdapter({
      "product:variants": {
        "offers[0].price": { amount: "7.50", amountUnit: "major_decimal", currency: "USD", exponent: 2 },
        "offers[1].price": { amount: "8.25", amountUnit: "major_decimal", currency: "USD", exponent: 2 },
      },
    });
    const result = await hydrate(CALLER, ns, store, adapter, null);

    assert.ok(result.graph);
    const hydratedOffers = result.graph.entities[0].attributes.offers;
    assert.ok(Array.isArray(hydratedOffers));
    // Variant 0 price updated
    assert.deepEqual(hydratedOffers[0].price, { amount: "7.50", amountUnit: "major_decimal", currency: "USD", exponent: 2 });
    // Variant 0 non-volatile preserved
    assert.strictEqual(hydratedOffers[0].sku, "V1");
    // Variant 1 price updated
    assert.deepEqual(hydratedOffers[1].price, { amount: "8.25", amountUnit: "major_decimal", currency: "USD", exponent: 2 });
    // Variant 1 non-volatile preserved
    assert.strictEqual(hydratedOffers[1].sku, "V2");
    // No top-level price added
    assert.strictEqual(result.graph.entities[0].attributes.price, undefined);
  });

  it("clears priceSpecification from single offer on outage (money contract)", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:ps1",
          type: "product",
          attributes: {
            name: "PSProduct",
            offers: {
              price: { amount: 1999, amountUnit: "minor_units", currency: "USD", exponent: 2 },
              priceSpecification: { amount: 2499, amountUnit: "minor_units", currency: "USD", exponent: 2 },
              availability: "InStock",
            },
          },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    const adapter = makeStubAdapter({}, "unavailable");
    const result = await hydrate(CALLER, ns, store, adapter, null);

    assert.ok(result.graph);
    assert.strictEqual(result.sourceStatus, "unavailable");
    const offers = result.graph.entities[0].attributes.offers;
    // priceSpecification is a canonical money value — must be cleared on outage
    assert.strictEqual(offers.priceSpecification, undefined);
    // price also cleared
    assert.strictEqual(offers.price, undefined);
    // availability also cleared
    assert.strictEqual(offers.availability, undefined);
    // Non-volatile preserved
    assert.strictEqual(offers["@type"], undefined); // not set in this fixture
  });

  it("clears priceSpecification from variant array offers on outage (money contract)", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:ps2",
          type: "product",
          attributes: {
            name: "VariantPSProduct",
            offers: [
              {
                price: { amount: 500, amountUnit: "minor_units", currency: "USD", exponent: 2 },
                priceSpecification: { amount: 600, amountUnit: "minor_units", currency: "USD", exponent: 2 },
                sku: "V1",
              },
              {
                price: { amount: 700, amountUnit: "minor_units", currency: "USD", exponent: 2 },
                priceSpecification: { amount: 800, amountUnit: "minor_units", currency: "USD", exponent: 2 },
                sku: "V2",
              },
            ],
          },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    const adapter = makeStubAdapter({}, "unavailable");
    const result = await hydrate(CALLER, ns, store, adapter, null);

    assert.ok(result.graph);
    assert.strictEqual(result.sourceStatus, "unavailable");
    const hydratedOffers = result.graph.entities[0].attributes.offers;
    assert.ok(Array.isArray(hydratedOffers));
    // Variant 0: priceSpecification cleared, price cleared, sku preserved
    assert.strictEqual(hydratedOffers[0].priceSpecification, undefined);
    assert.strictEqual(hydratedOffers[0].price, undefined);
    assert.strictEqual(hydratedOffers[0].sku, "V1");
    // Variant 1: priceSpecification cleared, price cleared, sku preserved
    assert.strictEqual(hydratedOffers[1].priceSpecification, undefined);
    assert.strictEqual(hydratedOffers[1].price, undefined);
    assert.strictEqual(hydratedOffers[1].sku, "V2");
  });

  it("hydrates priceSpecification as a whole from live adapter on single offer", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:ps3",
          type: "product",
          attributes: {
            name: "HydratePS",
            offers: {
              price: { amount: 1999, amountUnit: "minor_units", currency: "USD", exponent: 2 },
              priceSpecification: { amount: 2499, amountUnit: "minor_units", currency: "USD", exponent: 2 },
            },
          },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    const adapter = makeStubAdapter({
      "product:ps3": {
        "offers.priceSpecification": { amount: 2999, amountUnit: "minor_units", currency: "USD", exponent: 2 },
      },
    });
    const result = await hydrate(CALLER, ns, store, adapter, null);

    assert.ok(result.graph);
    assert.ok(result.liveFields.includes("offers.priceSpecification"));
    // priceSpecification updated from live adapter
    assert.deepEqual(
      result.graph.entities[0].attributes.offers.priceSpecification,
      { amount: 2999, amountUnit: "minor_units", currency: "USD", exponent: 2 },
    );
  });

  it("hydrates priceSpecification from live adapter on variant array offers", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:ps4",
          type: "product",
          attributes: {
            name: "VariantHydratePS",
            offers: [
              {
                price: { amount: 500, amountUnit: "minor_units", currency: "USD", exponent: 2 },
                priceSpecification: { amount: 600, amountUnit: "minor_units", currency: "USD", exponent: 2 },
                sku: "V1",
              },
              {
                price: { amount: 700, amountUnit: "minor_units", currency: "USD", exponent: 2 },
                priceSpecification: { amount: 800, amountUnit: "minor_units", currency: "USD", exponent: 2 },
                sku: "V2",
              },
            ],
          },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    const adapter = makeStubAdapter({
      "product:ps4": {
        "offers[0].priceSpecification": { amount: 750, amountUnit: "minor_units", currency: "USD", exponent: 2 },
        "offers[1].priceSpecification": { amount: 950, amountUnit: "minor_units", currency: "USD", exponent: 2 },
      },
    });
    const result = await hydrate(CALLER, ns, store, adapter, null);

    assert.ok(result.graph);
    const hydratedOffers = result.graph.entities[0].attributes.offers;
    assert.ok(Array.isArray(hydratedOffers));
    // Variant 0 priceSpecification updated
    assert.deepEqual(hydratedOffers[0].priceSpecification, { amount: 750, amountUnit: "minor_units", currency: "USD", exponent: 2 });
    // Variant 1 priceSpecification updated
    assert.deepEqual(hydratedOffers[1].priceSpecification, { amount: 950, amountUnit: "minor_units", currency: "USD", exponent: 2 });
    // Skus preserved
    assert.strictEqual(hydratedOffers[0].sku, "V1");
    assert.strictEqual(hydratedOffers[1].sku, "V2");
  });


// ---------------------------------------------------------------------------
// revalidateForAction() integration tests
// ---------------------------------------------------------------------------

});


describe("revalidateForAction", () => {
  let storeRoot;
  let store;
  let consent;
  let ns;

  before(() => {
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sl-reval-test-"));
    store = createGraphStore({ storeRoot, consent: createLocalConsent({ allowGuests: true }) });
    consent = createLocalConsent({ allowGuests: true });
    ns = makeNamespace("test:revalidate");
  });

  after(() => {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  });

  it("returns ok when called with matching expected versions (no TOCTOU)", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:20",
          type: "product",
          attributes: { price: { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    // Adapter returns the SAME values the caller expects
    const adapter = makeStubAdapter({ "product:20": { price: { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 } } });

    // Caller saw this version
    const expectedVersions = new Map();
    expectedVersions.set("product:20", new Map([["price", { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 }]]));

    const result = await revalidateForAction(CALLER, ns, store, adapter, null, null, expectedVersions);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mustRetry, false);
  });

  it("detects TOCTOU when expected version differs from live", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:21",
          type: "product",
          attributes: { price: { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    // Adapter returns DIFFERENT values than the caller expects — TOCTOU!
    const adapter = makeStubAdapter({ "product:21": { price: { amount: 1500, amountUnit: "minor_units", currency: "USD", exponent: 2 } } });

    // Caller saw OLD version
    const expectedVersions = new Map();
    expectedVersions.set("product:21", new Map([["price", { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 }]]));

    const result = await revalidateForAction(CALLER, ns, store, adapter, null, null, expectedVersions);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mustRetry, true);
    assert.ok(result.changedFields.has("product:21:price"));
    assert.deepEqual(result.changedFields.get("product:21:price").callerVersion, { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 });
    assert.deepEqual(result.changedFields.get("product:21:price").live, { amount: 1500, amountUnit: "minor_units", currency: "USD", exponent: 2 });
  });

  it("returns ok with empty changedFields when no expected versions are provided", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:22",
          type: "product",
          attributes: { price: { amount: 2000, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    const adapter = makeStubAdapter({ "product:22": { price: { amount: 2000, amountUnit: "minor_units", currency: "USD", exponent: 2 } } });

    // No expectedVersions at all — nothing to revalidate, so ok with no changes
    const result = await revalidateForAction(CALLER, ns, store, adapter, null, null, new Map());

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mustRetry, false);
    assert.strictEqual(result.changedFields.size, 0);
  });

  it("blocks when source is unavailable", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:40",
          type: "product",
          attributes: { price: { amount: 5000, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    const adapter = makeStubAdapter({ "product:40": { price: { amount: 5000, amountUnit: "minor_units", currency: "USD", exponent: 2 } } }, "unavailable");

    const result = await revalidateForAction(CALLER, ns, store, adapter, null);

    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes("unavailable"));
  });

  it("handles adapter fetch error during revalidation", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:50",
          type: "product",
          attributes: { price: { amount: 6000, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    const badAdapter = {
      sourceId: "bad",
      sourceStatus: () => "available",
      fetchLive: async () => { throw new Error("boom"); },
    };

    const result = await revalidateForAction(CALLER, ns, store, badAdapter, null);

    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes("fetch failed"));
  });

  it("returns ok when graph has no entities", async () => {
    const graph = {
      version: "1.0.0",
      entities: [],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    const adapter = makeStubAdapter({ "product:x": { price: { amount: 9900, amountUnit: "minor_units", currency: "USD", exponent: 2 } } });

    const result = await revalidateForAction(CALLER, ns, store, adapter, null);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mustRetry, false);
  });
});

// ---------------------------------------------------------------------------
// LiveStateError
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Money at any depth inside offers
// ---------------------------------------------------------------------------

describe("money at any depth inside offers", () => {
  let storeRoot;
  let store;
  let ns;

  before(() => {
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sl-ovp-test-"));
    store = createGraphStore({ storeRoot, consent: createLocalConsent({ allowGuests: true }) });
    ns = makeNamespace("test:ovp");
  });

  after(() => {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  });

  it("clears a priceSpecification money value and money nested deeper in the offer on outage", async () => {
    // priceSpecification may contain structured money values inside arrays
    // or sub-objects. Every canonical money value must be collected/cleared.
    // We use a graph-safe fixture where priceSpecification is a single money
    // object (valid per graph contract), and add a separate nested money
    // field to prove depth-walking.
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:ps-depth",
          type: "product",
          attributes: {
            name: "Test Product",
            offers: {
              "@type": "Offer",
              priceSpecification: { amount: 2499, amountUnit: "minor_units", currency: "USD", exponent: 2 },
              tierOptions: {
                tier1: { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 },
                tier2: { amount: 2000, amountUnit: "minor_units", currency: "USD", exponent: 2 },
              },
            },
          },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    const adapter = makeStubAdapter({}, "unavailable");

    const result = await hydrate(CALLER, ns, store, adapter, null);

    // On outage, priceSpecification (canonical money) must be cleared
    const offers = result.graph.entities[0].attributes.offers;
    assert.strictEqual(offers.priceSpecification, undefined);
    // Deeply nested money values must also be cleared
    if (offers.tierOptions) {
      assert.strictEqual(offers.tierOptions.tier1, undefined);
      assert.strictEqual(offers.tierOptions.tier2, undefined);
    }
  });

  it("clears deeply nested money fields in offers on outage", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:deep-money",
          type: "product",
          attributes: {
            name: "Deep Money",
            offers: {
              "@type": "Offer",
              tieredPricing: {
                tier1: { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 },
                tier2: { amount: 2000, amountUnit: "minor_units", currency: "USD", exponent: 2 },
              },
            },
          },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    const adapter = makeStubAdapter({}, "unavailable");

    const result = await hydrate(CALLER, ns, store, adapter, null);

    const offers = result.graph.entities[0].attributes.offers;
    // Deeply nested money values must be cleared
    if (offers.tieredPricing) {
      assert.strictEqual(offers.tieredPricing.tier1, undefined);
      assert.strictEqual(offers.tieredPricing.tier2, undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Live values are written only at an entity's own volatile paths
// ---------------------------------------------------------------------------

describe("live values written only at an entity's own volatile paths", () => {
  let storeRoot;
  let store;
  let ns;

  before(() => {
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sl-mlv-test-"));
    store = createGraphStore({ storeRoot, consent: createLocalConsent({ allowGuests: true }) });
    ns = makeNamespace("test:mlv");
  });

  after(() => {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  });
  it("does not add attrs.price to a variants-only product on union field list", async () => {
    // Product A has top-level price; Product B has only variant prices.
    // The adapter returns the UNION of field names. mergeLiveValues must
    // NOT add attrs.price to Product B.
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:A",
          type: "product",
          attributes: { name: "A", price: { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
        {
          id: "product:B",
          type: "product",
          attributes: {
            name: "B",
            offers: [
              { "@type": "Offer", price: { amount: 500, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
              { "@type": "Offer", price: { amount: 600, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
            ],
          },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    // Adapter returns "price" for both (union of field names)
    const adapter = makeStubAdapter({
      "product:A": { price: { amount: 1100, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
      "product:B": { price: { amount: 1100, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
    });

    const result = await hydrate(CALLER, ns, store, adapter, null);

    const entityB = result.graph.entities.find(e => e.id === "product:B");
    // Product B has no top-level price in its own volatile set — must not gain one
    assert.strictEqual(entityB.attributes.price, undefined);
    // But its variant prices still exist (were not cleared — source is available, live returned them)
  });

  it("does not grow offers array: offers[5].price on 2-variant product", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:2var",
          type: "product",
          attributes: {
            name: "Two Variants",
            offers: [
              { "@type": "Offer", price: { amount: 500, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
              { "@type": "Offer", price: { amount: 600, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
            ],
          },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    // Adapter returns "offers[5].price" — should NOT grow offers array
    const adapter = makeStubAdapter({
      "product:2var": { "offers[5].price": { amount: 999, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
    });

    const result = await hydrate(CALLER, ns, store, adapter, null);

    const offers = result.graph.entities[0].attributes.offers;
    assert.strictEqual(offers.length, 2);
  });
});

// ---------------------------------------------------------------------------
// A volatile path with no live value is cleared
// ---------------------------------------------------------------------------

describe("volatile fields the source omits are cleared", () => {
  let storeRoot;
  let store;
  let ns;

  before(() => {
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sl-cov-test-"));
    store = createGraphStore({ storeRoot, consent: createLocalConsent({ allowGuests: true }) });
    ns = makeNamespace("test:cov");
  });

  after(() => {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  });
  it("clears a volatile field the adapter omitted", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:omit-field",
          type: "product",
          attributes: {
            name: "Omit Test",
            price: { amount: 5000, amountUnit: "minor_units", currency: "USD", exponent: 2 },
            availability: "InStock",
          },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    // Adapter returns only availability — omits price
    const adapter = makeStubAdapter({
      "product:omit-field": { availability: "OutOfStock" },
    });

    const result = await hydrate(CALLER, ns, store, adapter, null);

    const entity = result.graph.entities[0];
    // availability updated from live
    assert.strictEqual(entity.attributes.availability, "OutOfStock");
    // price omitted by adapter — must be cleared
    assert.strictEqual(entity.attributes.price, undefined);
  });

  it("clears all volatiles for a whole omitted entity", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:kept",
          type: "product",
          attributes: { name: "Kept", price: { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
        {
          id: "product:omitted",
          type: "product",
          attributes: { name: "Omitted", price: { amount: 2000, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    // Adapter returns only product:kept — omits product:omitted entirely
    const adapter = makeStubAdapter({
      "product:kept": { price: { amount: 1500, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
    });

    const result = await hydrate(CALLER, ns, store, adapter, null);

    const kept = result.graph.entities.find(e => e.id === "product:kept");
    const omitted = result.graph.entities.find(e => e.id === "product:omitted");

    // Kept: price updated from live
    assert.deepEqual(kept.attributes.price, { amount: 1500, amountUnit: "minor_units", currency: "USD", exponent: 2 });
    // Omitted: all volatile fields cleared
    assert.strictEqual(omitted.attributes.price, undefined);
  });
});

// ---------------------------------------------------------------------------
// revalidateForAction fails closed
// ---------------------------------------------------------------------------

describe("revalidateForAction fails closed", () => {
  let storeRoot;
  let store;
  let ns;

  before(() => {
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sl-rva-fc-test-"));
    store = createGraphStore({ storeRoot, consent: createLocalConsent({ allowGuests: true }) });
    ns = makeNamespace("test:rva-fc");
  });

  after(() => {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  });
  it("(a) returns ok when every expected field has a live value, whatever else the source omits", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:partial",
          type: "product",
          attributes: {
            price: { amount: 500, amountUnit: "minor_units", currency: "USD", exponent: 2 },
            availability: "InStock",
            offers: [
              { "@type": "Offer", price: { amount: 500, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
            ],
          },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    // Adapter returns only offers[0].price — omits price and availability
    const adapter = makeStubAdapter({
      "product:partial": { "offers[0].price": { amount: 500, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
    });

    const expectedVersions = new Map();
    expectedVersions.set("product:partial", new Map([
      ["offers[0].price", { amount: 500, amountUnit: "minor_units", currency: "USD", exponent: 2 }],
    ]));

    // offers[0].price exists in live — should be ok
    const result = await revalidateForAction(CALLER, ns, store, adapter, null, null, expectedVersions);
    // expected offers[0].price=500, live returns offers[0].price=500 → ok
    assert.strictEqual(result.ok, true);
  });

  it("(a) returns ok:false when expected offers[0].price present but offers[1].price missing", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:two-offers",
          type: "product",
          attributes: {
            name: "Two Offers",
            offers: [
              { "@type": "Offer", price: { amount: 500, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
              { "@type": "Offer", price: { amount: 600, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
            ],
          },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    // Adapter returns only offers[0].price — omits offers[1].price
    const adapter = makeStubAdapter({
      "product:two-offers": { "offers[0].price": { amount: 500, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
    });

    const expectedVersions = new Map();
    expectedVersions.set("product:two-offers", new Map([
      ["offers[0].price", { amount: 500, amountUnit: "minor_units", currency: "USD", exponent: 2 }],
      ["offers[1].price", { amount: 600, amountUnit: "minor_units", currency: "USD", exponent: 2 }],
    ]));

    const result = await revalidateForAction(CALLER, ns, store, adapter, null, null, expectedVersions);

    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes("offers[1].price"));
  });

  it("(b) returns ok:false when expected price on entity with missing live map", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:missing-live",
          type: "product",
          attributes: { price: { amount: 900, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    // Adapter returns empty map for this entity
    const adapter = makeStubAdapter({});

    const expectedVersions = new Map();
    expectedVersions.set("product:missing-live", new Map([
      ["price", { amount: 900, amountUnit: "minor_units", currency: "USD", exponent: 2 }],
    ]));

    const result = await revalidateForAction(CALLER, ns, store, adapter, null, null, expectedVersions);

    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes("no live values"));
  });

  it("(c) returns ok:false when expected entity is no longer in the graph", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:present",
          type: "product",
          attributes: { name: "Present" },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    const adapter = makeStubAdapter({});

    const expectedVersions = new Map();
    expectedVersions.set("product:gone", new Map([
      ["price", { amount: 100, amountUnit: "minor_units", currency: "USD", exponent: 2 }],
    ]));

    const result = await revalidateForAction(CALLER, ns, store, adapter, null, null, expectedVersions);

    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes("no longer in the graph"));
  });
});



// ---------------------------------------------------------------------------
// AccessDeniedError and live price change
// ---------------------------------------------------------------------------

describe("AccessDeniedError for unauthorized callers", () => {
  let storeRoot;
  let store;
  let ns;

  before(() => {
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sl-auth-test-"));
    ns = makeNamespace("tenant:shop");
    const scopedConsent = createScopedConsent({
      "agent-a": [{ namespace: "tenant:shop", scopes: ["memory:read", "memory:write"] }],
    });
    store = createGraphStore({ storeRoot, consent: scopedConsent });
  });

  after(() => {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  });

  it("hydrate throws AccessDeniedError for caller without grant", async () => {
    // Publish as agent-a (who has grant)
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:auth-1",
          type: "product",
          attributes: { price: { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph({ id: "agent-a", kind: "agent" }, ns, graph);

    const adapter = makeStubAdapter({});

    // Call as agent-b (who has no grant)
    await assert.rejects(
      () => hydrate({ id: "agent-b", kind: "agent" }, ns, store, adapter, null),
      AccessDeniedError,
    );
  });

  it("revalidateForAction throws AccessDeniedError for caller without grant", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:auth-2",
          type: "product",
          attributes: { price: { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph({ id: "agent-a", kind: "agent" }, ns, graph);

    const adapter = makeStubAdapter({});

    // Call as agent-b (who has no grant)
    await assert.rejects(
      () => revalidateForAction({ id: "agent-b", kind: "agent" }, ns, store, adapter, null),
      AccessDeniedError,
    );
  });
});

describe("live price change without re-publish", () => {
  let storeRoot;
  let store;
  let ns;

  before(() => {
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sl-lpc-test-"));
    store = createGraphStore({ storeRoot, consent: createLocalConsent({ allowGuests: true }) });
    ns = makeNamespace("test:lpc");
  });

  after(() => {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  });

  it("live price change shows on next hydrate without publishGraph", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:lpc",
          type: "product",
          attributes: { price: { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    // First hydrate: price = 1000
    const adapter1 = makeStubAdapter({
      "product:lpc": { price: { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
    });

    const result1 = await hydrate(CALLER, ns, store, adapter1, null);
    assert.deepEqual(
      result1.graph.entities[0].attributes.price,
      { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 },
    );

    // Second hydrate with different live price, no publishGraph in between
    const adapter2 = makeStubAdapter({
      "product:lpc": { price: { amount: 1500, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
    });

    const result2 = await hydrate(CALLER, ns, store, adapter2, null);

    // Must see the new live price without re-publishing
    assert.deepEqual(
      result2.graph.entities[0].attributes.price,
      { amount: 1500, amountUnit: "minor_units", currency: "USD", exponent: 2 },
    );
  });
});


// ---------------------------------------------------------------------------
// revalidateForAction must not let a caller widen the live query
// ---------------------------------------------------------------------------

describe("revalidateForAction live-query containment", () => {
  let storeRoot;
  let store;
  let ns;

  before(() => {
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sl-rva-i7-test-"));
    store = createGraphStore({ storeRoot, consent: createLocalConsent({ allowGuests: true }) });
    ns = makeNamespace("test:rva-i7");
  });

  after(() => {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  });

  it("refuses expectedVersions field not in entity volatile set, never asks adapter", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:widen",
          type: "product",
          attributes: {
            name: "Widget",
            price: { amount: 1999, amountUnit: "minor_units", currency: "USD", exponent: 2 },
          },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    // Spy adapter: records requested fieldNames and would return costPrice if asked
    let requestedFieldNames = null;
    const spyingAdapter = {
      sourceId: "test:spy",
      sourceStatus: () => "available",
      fetchLive: async (_ctx, entityIds, fieldNames) => {
        requestedFieldNames = fieldNames;
        const outer = new Map();
        for (const eid of entityIds) {
          const inner = new Map();
          // Would return costPrice if asked — proving the adapter knows it
          if (fieldNames.includes("costPrice")) {
            inner.set("costPrice", { amount: 500, amountUnit: "minor_units", currency: "USD", exponent: 2 });
          }
          // Also return the legitimate price field
          inner.set("price", { amount: 1999, amountUnit: "minor_units", currency: "USD", exponent: 2 });
          outer.set(eid, inner);
        }
        return outer;
      },
    };

    // Caller asks for "costPrice" in expectedVersions — should be refused
    const expectedVersions = new Map();
    expectedVersions.set("product:widen", new Map([
      ["costPrice", { amount: 500, amountUnit: "minor_units", currency: "USD", exponent: 2 }],
    ]));

    const result = await revalidateForAction(CALLER, ns, store, spyingAdapter, null, null, expectedVersions);

    // Must be refused
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.mustRetry, false);
    assert.ok(result.reason.includes("costPrice"), "reason should name the offending field");
    assert.ok(result.reason.includes("not a volatile field"), "reason should explain why");

    // The adapter was never called at all — the query is blocked before fetch
    assert.strictEqual(requestedFieldNames, null, "adapter should not be called when a non-volatile field is requested");

    // No costPrice value appears anywhere in the result
    assert.strictEqual(result.changedFields, undefined);
  });
});


describe("LiveStateError", () => {
  it("is an Error subclass", () => {
    const err = new LiveStateError("test");
    assert.ok(err instanceof Error);
    assert.ok(err instanceof LiveStateError);
    assert.strictEqual(err.name, "LiveStateError");
    assert.strictEqual(err.message, "test");
  });
});
