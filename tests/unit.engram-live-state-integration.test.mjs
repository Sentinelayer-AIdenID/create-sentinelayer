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

/** Create a stub live-source adapter that returns canned values. */
function makeStubAdapter(values = {}, sourceStatus = "available") {
  return {
    sourceId: "test:stub",
    sourceStatus: () => sourceStatus,
    fetchLive: async (_ctx, fields) => {
      const m = new Map();
      for (const f of fields) {
        if (Object.hasOwn(values, f)) m.set(f, values[f]);
      }
      return m;
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
    const adapter = makeStubAdapter({ price: { amount: 9999, amountUnit: "minor_units", currency: "USD", exponent: 2 } });
    const ctx = createCommerceContext({ currency: "USD" });

    const result = await hydrate(CALLER, ns, store, adapter, ctx);

    assert.strictEqual(result.graph, null);
    assert.strictEqual(result.version, 0);
    assert.ok(result.reason);
    assert.strictEqual(result.liveFields.length, 0);
  });

  it("hydrates volatile fields from the live adapter", async () => {
    // Publish a graph with entities containing volatile field attributes
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:1",
          type: "product",
          label: "Widget",
          attributes: { price: { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 }, name: "Widget", delivery_estimate: "3-5 days" },
          tenantScope: "test",
          sourceId: "catalog",
          sourceVersion: "v1",
          capturedAt: "2026-10-27T00:00:00.000Z",
          provenance: "observed",
        },
      ],
      links: [],
      assertions: [
        {
          id: "a1",
          subject: "product:1",
          predicate: "price",
          object: { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 },
          provenance: "observed",
          schemaValidity: "valid",
          source: {
            sourceId: "catalog",
            version: "v1",
            capturedAt: "2026-10-27T00:00:00.000Z",
            tenantScope: "test",
          },
        },
        {
          id: "a2",
          subject: "product:1",
          predicate: "delivery_estimate",
          object: "3-5 days",
          provenance: "observed",
          schemaValidity: "valid",
          source: {
            sourceId: "logistics",
            version: "v2",
            capturedAt: "2026-10-27T00:00:00.000Z",
            tenantScope: "test",
          },
        },
      ],
      generatedAt: "2026-10-27T12:00:00.000Z",
    };

    await store.publishGraph(CALLER, ns, graph);

    const adapter = makeStubAdapter({
      price: { amount: 1299, amountUnit: "minor_units", currency: "USD", exponent: 2 },
      inventory: { count: 42 },
      delivery_estimate: "2 days",
    });
    const ctx = createCommerceContext({ currency: "USD", market: "US" });

    const result = await hydrate(CALLER, ns, store, adapter, ctx);

    assert.ok(result.graph);
    assert.ok(result.version > 0);
    assert.ok(result.hydratedAt);
    assert.strictEqual(result.sourceStatus, "available");

    // Volatile fields should come from the adapter
    const hydratedPrice = result.graph.entities[0].attributes.price;
    assert.deepEqual(hydratedPrice, { amount: 1299, amountUnit: "minor_units", currency: "USD", exponent: 2 });

    const hydratedDelivery = result.graph.entities[0].attributes.delivery_estimate;
    assert.strictEqual(hydratedDelivery, "2 days");

    // Non-volatile fields should be unchanged
    assert.strictEqual(result.graph.entities[0].attributes.name, "Widget");

    // liveFields should list the volatile fields
    assert.ok(result.liveFields.includes("price"));
    assert.ok(result.liveFields.includes("delivery_estimate"));
  });

  it("returns cached graph when no adapter is provided", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:2",
          type: "product",
          label: "Gadget",
          attributes: { price: { amount: 2000, amountUnit: "minor_units", currency: "USD", exponent: 2 }, name: "Gadget" },
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

    const result = await hydrate(CALLER, ns, store, null, null);

    assert.ok(result.graph);
    assert.strictEqual(result.liveFields.length, 0);
    assert.strictEqual(result.sourceStatus, "unavailable");
    // Cached price preserved
    assert.deepEqual(result.graph.entities[0].attributes.price, { amount: 2000, amountUnit: "minor_units", currency: "USD", exponent: 2 });
  });

  it("handles adapter fetch failure gracefully", async () => {
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
  });
});

// ---------------------------------------------------------------------------
// revalidateForAction() integration tests
// ---------------------------------------------------------------------------

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

  it("returns ok when no volatile fields are present", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:10",
          type: "product",
          attributes: { name: "Stable", description: "No volatile fields" },
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

    const adapter = makeStubAdapter({ price: { amount: 9900, amountUnit: "minor_units", currency: "USD", exponent: 2 } });
    const ctx = createCommerceContext({ currency: "USD" });

    const result = await revalidateForAction(CALLER, ns, store, adapter, ctx);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mustRetry, false);
    assert.strictEqual(result.changedFields.size, 0);
  });

  it("detects changed volatile fields", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:20",
          type: "product",
          attributes: { price: { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 }, name: "Widget", delivery_estimate: "3-5 days" },
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

    // Adapter returns different values than cached
    const adapter = makeStubAdapter({ price: { amount: 1500, amountUnit: "minor_units", currency: "USD", exponent: 2 } });
    const ctx = createCommerceContext({ currency: "USD" });

    const result = await revalidateForAction(CALLER, ns, store, adapter, ctx);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mustRetry, true);
    assert.ok(result.changedFields.has("price"));
    assert.deepEqual(result.changedFields.get("price"), { cached: { amount: 1000, amountUnit: "minor_units", currency: "USD", exponent: 2 }, live: { amount: 1500, amountUnit: "minor_units", currency: "USD", exponent: 2 } });
  });

  it("returns mustRetry=false when nothing changed", async () => {
    const graph = {
      version: "1.0.0",
      entities: [
        {
          id: "product:30",
          type: "product",
          attributes: { price: { amount: 2500, amountUnit: "minor_units", currency: "USD", exponent: 2 } },
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

    // Adapter returns same values
    const adapter = makeStubAdapter({ price: { amount: 2500, amountUnit: "minor_units", currency: "USD", exponent: 2 } });
    const ctx = createCommerceContext({ currency: "USD" });

    const result = await revalidateForAction(CALLER, ns, store, adapter, ctx);

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

    const adapter = makeStubAdapter({ price: { amount: 5000, amountUnit: "minor_units", currency: "USD", exponent: 2 } }, "unavailable");
    const ctx = createCommerceContext({ currency: "USD" });

    const result = await revalidateForAction(CALLER, ns, store, adapter, ctx);

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

    const adapter = makeStubAdapter({ price: { amount: 9900, amountUnit: "minor_units", currency: "USD", exponent: 2 } });
    const ctx = createCommerceContext({ currency: "USD" });

    const result = await revalidateForAction(CALLER, ns, store, adapter, ctx);

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
