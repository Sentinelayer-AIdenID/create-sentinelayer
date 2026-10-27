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

  it("detects TOCTOU when no expected version was provided for a field", async () => {
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

    // No expectedVersions at all — pessimistic: report all fields as changed
    const result = await revalidateForAction(CALLER, ns, store, adapter, null, null, new Map());

    assert.strictEqual(result.ok, true);
    // No expected version → field reported as changed (pessimistic)
    assert.strictEqual(result.mustRetry, true);
    assert.ok(result.changedFields.has("product:22:price"));
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

describe("LiveStateError", () => {
  it("is an Error subclass", () => {
    const err = new LiveStateError("test");
    assert.ok(err instanceof Error);
    assert.ok(err instanceof LiveStateError);
    assert.strictEqual(err.name, "LiveStateError");
    assert.strictEqual(err.message, "test");
  });
});
