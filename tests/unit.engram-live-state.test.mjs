/**
 * ENGRAM §EW14 — Live-state hydration tests.
 *
 * Covers: freshness classes, freshness markers, source versioning,
 * authoritative priority resolution, revalidation gate (TOCTOU guard),
 * source outage handling, and commerce context.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FRESHNESS_CLASSES,
  classifyFreshness,
  isValidFreshnessClass,
  createFreshnessMarker,
  isFreshnessStale,
  FreshnessClassError,
  SOURCE_STATUSES,
  createSourceVersion,
  resolveAuthoritativeSource,
  SourceVersionError,
  mustRevalidate,
  RevalidationRequiredError,
  disabledByOutage,
  SourceOutageError,
  createCommerceContext,
  CommerceContextError,
} from "../src/engram/live-state.js";

// ---------------------------------------------------------------------------
// Freshness data classes
// ---------------------------------------------------------------------------

describe("FRESHNESS_CLASSES", () => {
  it("contains exactly four canonical classes", () => {
    assert.deepStrictEqual(FRESHNESS_CLASSES, [
      "static",
      "stale_readable",
      "live_required",
      "private_session",
    ]);
  });

  it("is frozen", () => {
    assert.throws(() => { FRESHNESS_CLASSES.push("foo"); }, TypeError);
  });
});

describe("classifyFreshness", () => {
  it("classifies hash/version/schema/fingerprint kinds as static", () => {
    for (const kind of ["hash", "version", "schema", "fingerprint"]) {
      assert.strictEqual(classifyFreshness({ kind }), "static");
    }
  });

  it("classifies isSessionScoped as private_session", () => {
    assert.strictEqual(classifyFreshness({ kind: "price", isSessionScoped: true }), "private_session");
  });

  it("classifies isAuth as live_required", () => {
    assert.strictEqual(classifyFreshness({ kind: "price", isAuth: true }), "live_required");
  });

  it("classifies live/realtime sourceKind as live_required", () => {
    for (const sourceKind of ["live", "realtime"]) {
      assert.strictEqual(classifyFreshness({ kind: "price", sourceKind }), "live_required");
    }
  });

  it("defaults to stale_readable for unknown kinds", () => {
    assert.strictEqual(classifyFreshness({ kind: "price" }), "stale_readable");
    assert.strictEqual(classifyFreshness({ kind: "inventory" }), "stale_readable");
  });

  it("handles empty params", () => {
    assert.strictEqual(classifyFreshness(), "stale_readable");
    assert.strictEqual(classifyFreshness({}), "stale_readable");
  });
});

describe("isValidFreshnessClass", () => {
  it("accepts all four canonical classes", () => {
    for (const cls of FRESHNESS_CLASSES) {
      assert.strictEqual(isValidFreshnessClass(cls), true);
    }
  });

  it("rejects unknown classes", () => {
    assert.strictEqual(isValidFreshnessClass("fresh"), false);
    assert.strictEqual(isValidFreshnessClass(""), false);
    assert.strictEqual(isValidFreshnessClass("cached"), false);
  });
});

// ---------------------------------------------------------------------------
// Freshness marker
// ---------------------------------------------------------------------------

describe("createFreshnessMarker", () => {
  it("creates a static marker", () => {
    const m = createFreshnessMarker({ freshnessClass: "static" });
    assert.strictEqual(m.freshnessClass, "static");
    assert.ok(m.asOf);
  });

  it("creates a stale_readable marker with asOf", () => {
    const m = createFreshnessMarker({
      freshnessClass: "stale_readable",
      asOf: "2026-10-27T16:00:00Z",
      staleAfterMs: 60000,
      sourceVersion: "etag-abc123",
    });
    assert.strictEqual(m.freshnessClass, "stale_readable");
    assert.strictEqual(m.asOf, "2026-10-27T16:00:00Z");
    assert.strictEqual(m.staleAfterMs, 60000);
    assert.strictEqual(m.sourceVersion, "etag-abc123");
  });

  it("creates a live_required marker with asOf and sourceVersion", () => {
    const m = createFreshnessMarker({
      freshnessClass: "live_required",
      asOf: "2026-10-27T16:00:00Z",
      sourceVersion: "v2.3.0",
      sourceStatus: "available",
    });
    assert.strictEqual(m.freshnessClass, "live_required");
    assert.strictEqual(m.sourceStatus, "available");
  });

  it("rejects invalid freshness class", () => {
    assert.throws(
      () => createFreshnessMarker({ freshnessClass: "fast" }),
      FreshnessClassError,
    );
  });

  it("requires asOf for stale_readable", () => {
    assert.throws(
      () => createFreshnessMarker({ freshnessClass: "stale_readable" }),
      FreshnessClassError,
    );
  });

  it("requires asOf for live_required", () => {
    assert.throws(
      () => createFreshnessMarker({ freshnessClass: "live_required" }),
      FreshnessClassError,
    );
  });

  it("rejects zero staleness on stale_readable", () => {
    assert.throws(
      () => createFreshnessMarker({ freshnessClass: "stale_readable", asOf: "2026-10-27T16:00:00Z", staleAfterMs: 0 }),
      FreshnessClassError,
    );
  });

  it("rejects negative staleness on stale_readable", () => {
    assert.throws(
      () => createFreshnessMarker({ freshnessClass: "stale_readable", asOf: "2026-10-27T16:00:00Z", staleAfterMs: -100 }),
      FreshnessClassError,
    );
  });

  it("returns frozen object", () => {
    const m = createFreshnessMarker({ freshnessClass: "static" });
    assert.throws(() => { m.asOf = "hacked"; }, TypeError);
  });

  it("sets revalidatedAt when provided", () => {
    const m = createFreshnessMarker({
      freshnessClass: "live_required",
      asOf: "2026-10-27T16:00:00Z",
      revalidatedAt: "2026-10-27T16:05:00Z",
    });
    assert.strictEqual(m.revalidatedAt, "2026-10-27T16:05:00Z");
  });
});

describe("isFreshnessStale", () => {
  it("returns false for static markers", () => {
    const m = createFreshnessMarker({ freshnessClass: "static" });
    assert.strictEqual(isFreshnessStale(m), false);
  });

  it("returns true for live_required without revalidation", () => {
    const m = createFreshnessMarker({
      freshnessClass: "live_required",
      asOf: "2026-10-27T16:00:00Z",
    });
    assert.strictEqual(isFreshnessStale(m), true);
  });

  it("returns true when isStale is explicitly true", () => {
    const m = createFreshnessMarker({
      freshnessClass: "stale_readable",
      asOf: "2026-10-27T16:00:00Z",
      staleAfterMs: 60000,
      isStale: true,
    });
    assert.strictEqual(isFreshnessStale(m), true);
  });

  it("returns true when past staleAfterMs", () => {
    const pastDate = new Date(Date.now() - 120000).toISOString(); // 2 min ago
    const m = createFreshnessMarker({
      freshnessClass: "stale_readable",
      asOf: pastDate,
      staleAfterMs: 60000, // 1 min deadline
    });
    assert.strictEqual(isFreshnessStale(m), true);
  });

  it("returns undefined when staleness cannot be determined", () => {
    const m = createFreshnessMarker({
      freshnessClass: "stale_readable",
      asOf: "2026-10-27T16:00:00Z",
    });
    assert.strictEqual(isFreshnessStale(m, new Date("2026-10-27T16:00:00Z")), undefined);
  });
});

// ---------------------------------------------------------------------------
// Source versioning
// ---------------------------------------------------------------------------

describe("SOURCE_STATUSES", () => {
  it("contains three canonical statuses", () => {
    assert.deepStrictEqual(SOURCE_STATUSES, ["available", "degraded", "unavailable"]);
  });
});

describe("createSourceVersion", () => {
  it("creates a valid source version", () => {
    const sv = createSourceVersion({
      sourceId: "shopify-products",
      version: "2026-10-27T12:00:00Z",
      etag: '"abc123"',
      fetchedAt: "2026-10-27T12:00:00Z",
      tenantScope: "tenant/acme",
      sourceStatus: "available",
    });
    assert.strictEqual(sv.sourceId, "shopify-products");
    assert.strictEqual(sv.version, "2026-10-27T12:00:00Z");
    assert.strictEqual(sv.etag, '"abc123"');
    assert.strictEqual(sv.tenantScope, "tenant/acme");
    assert.strictEqual(sv.sourceStatus, "available");
  });

  it("defaults tenantScope to 'default'", () => {
    const sv = createSourceVersion({
      sourceId: "s1",
      version: "v1",
      fetchedAt: "2026-10-27T12:00:00Z",
      sourceStatus: "available",
    });
    assert.strictEqual(sv.tenantScope, "default");
  });

  it("accepts Date objects for fetchedAt", () => {
    const sv = createSourceVersion({
      sourceId: "s1",
      version: "v1",
      fetchedAt: new Date("2026-10-27T12:00:00Z"),
      sourceStatus: "available",
    });
    assert.strictEqual(sv.fetchedAt, "2026-10-27T12:00:00.000Z");
  });

  it("rejects missing sourceId", () => {
    assert.throws(
      () => createSourceVersion({ version: "v1", fetchedAt: "now", sourceStatus: "available" }),
      SourceVersionError,
    );
  });

  it("rejects empty sourceId", () => {
    assert.throws(
      () => createSourceVersion({ sourceId: "", version: "v1", fetchedAt: "now", sourceStatus: "available" }),
      SourceVersionError,
    );
  });

  it("rejects missing version", () => {
    assert.throws(
      () => createSourceVersion({ sourceId: "s1", fetchedAt: "now", sourceStatus: "available" }),
      SourceVersionError,
    );
  });

  it("rejects missing fetchedAt", () => {
    assert.throws(
      () => createSourceVersion({ sourceId: "s1", version: "v1", sourceStatus: "available" }),
      SourceVersionError,
    );
  });

  it("rejects invalid sourceStatus", () => {
    assert.throws(
      () => createSourceVersion({ sourceId: "s1", version: "v1", fetchedAt: "now", sourceStatus: "down" }),
      SourceVersionError,
    );
  });

  it("returns frozen object", () => {
    const sv = createSourceVersion({
      sourceId: "s1", version: "v1", fetchedAt: "2026-10-27T12:00:00Z", sourceStatus: "available",
    });
    assert.throws(() => { sv.sourceId = "hacked"; }, TypeError);
  });
});

// ---------------------------------------------------------------------------
// Authoritative priority resolution
// ---------------------------------------------------------------------------

describe("resolveAuthoritativeSource", () => {
  const avail = { sourceId: "a", version: "v1", fetchedAt: "2026-10-27T10:00:00Z", sourceStatus: "available" };
  const degraded = { sourceId: "b", version: "v1", fetchedAt: "2026-10-27T10:00:00Z", sourceStatus: "degraded" };
  const unavail = { sourceId: "c", version: "v1", fetchedAt: "2026-10-27T10:00:00Z", sourceStatus: "unavailable" };

  it("prefers available over degraded", () => {
    assert.strictEqual(resolveAuthoritativeSource(avail, degraded), avail);
  });

  it("prefers degraded over unavailable", () => {
    assert.strictEqual(resolveAuthoritativeSource(degraded, unavail), degraded);
  });

  it("prefers available over unavailable", () => {
    assert.strictEqual(resolveAuthoritativeSource(avail, unavail), avail);
  });

  it("returns the only non-null when one is null", () => {
    assert.strictEqual(resolveAuthoritativeSource(avail, null), avail);
    assert.strictEqual(resolveAuthoritativeSource(null, avail), avail);
  });

  it("returns null when both are null", () => {
    assert.strictEqual(resolveAuthoritativeSource(null, null), null);
  });

  it("prefers fresher timestamp when same status", () => {
    const older = { ...avail, fetchedAt: "2026-10-27T09:00:00Z" };
    const newer = { ...avail, fetchedAt: "2026-10-27T11:00:00Z" };
    assert.strictEqual(resolveAuthoritativeSource(older, newer), newer);
  });

  it("prefers higher version when same status and timestamp", () => {
    const v1 = { ...avail, version: "v1.0.0" };
    const v2 = { ...avail, version: "v2.0.0" };
    assert.strictEqual(resolveAuthoritativeSource(v1, v2), v2);
  });
});

// ---------------------------------------------------------------------------
// Revalidation gate (TOCTOU guard)
// ---------------------------------------------------------------------------

describe("mustRevalidate", () => {
  it("requires revalidation when no marker", () => {
    const result = mustRevalidate(null);
    assert.strictEqual(result.mustRevalidate, true);
    assert.ok(result.reason.includes("no freshness marker"));
  });

  it("does not require revalidation for static", () => {
    const m = createFreshnessMarker({ freshnessClass: "static" });
    const result = mustRevalidate(m);
    assert.strictEqual(result.mustRevalidate, false);
  });

  it("always requires revalidation for live_required", () => {
    const m = createFreshnessMarker({
      freshnessClass: "live_required",
      asOf: "2026-10-27T16:00:00Z",
    });
    const result = mustRevalidate(m);
    assert.strictEqual(result.mustRevalidate, true);
    assert.ok(result.reason.includes("live_required"));
  });

  it("does not require revalidation for private_session", () => {
    const m = createFreshnessMarker({
      freshnessClass: "private_session",
      asOf: "2026-10-27T16:00:00Z",
    });
    const result = mustRevalidate(m);
    assert.strictEqual(result.mustRevalidate, false);
  });

  it("requires revalidation when isStale is true", () => {
    const m = createFreshnessMarker({
      freshnessClass: "stale_readable",
      asOf: "2026-10-27T16:00:00Z",
      staleAfterMs: 60000,
      isStale: true,
    });
    const result = mustRevalidate(m);
    assert.strictEqual(result.mustRevalidate, true);
    assert.ok(result.reason.includes("marked stale"));
  });

  it("requires revalidation when past staleAfterMs", () => {
    const pastDate = new Date(Date.now() - 120000).toISOString();
    const m = createFreshnessMarker({
      freshnessClass: "stale_readable",
      asOf: pastDate,
      staleAfterMs: 60000,
    });
    const result = mustRevalidate(m);
    assert.strictEqual(result.mustRevalidate, true);
    assert.ok(result.reason.includes("staleness deadline exceeded"));
  });

  it("escalates when source is unavailable", () => {
    const m = createFreshnessMarker({
      freshnessClass: "stale_readable",
      asOf: "2026-10-27T16:00:00Z",
      sourceStatus: "unavailable",
    });
    const result = mustRevalidate(m);
    assert.strictEqual(result.mustRevalidate, true);
    assert.strictEqual(result.escalate, true);
    assert.ok(result.reason.includes("unavailable"));
  });

  it("does not require revalidation for fresh stale_readable within deadline", () => {
    const recentDate = new Date(Date.now() - 10000).toISOString(); // 10s ago
    const m = createFreshnessMarker({
      freshnessClass: "stale_readable",
      asOf: recentDate,
      staleAfterMs: 60000, // 1 min deadline
    });
    const result = mustRevalidate(m);
    assert.strictEqual(result.mustRevalidate, false);
  });
});

// ---------------------------------------------------------------------------
// Source outage handling
// ---------------------------------------------------------------------------

describe("disabledByOutage", () => {
  const available = { sourceId: "shopify", version: "v1", fetchedAt: "2026-10-27T10:00:00Z", sourceStatus: "available", tenantScope: "t1" };
  const degraded = { sourceId: "shopify", version: "v1", fetchedAt: "2026-10-27T10:00:00Z", sourceStatus: "degraded", tenantScope: "t1" };
  const unavail = { sourceId: "shopify", version: "v1", fetchedAt: "2026-10-27T10:00:00Z", sourceStatus: "unavailable", tenantScope: "t1" };

  it("returns not disabled when source is available", () => {
    const result = disabledByOutage([available], ["shopify"]);
    assert.strictEqual(result.disabled, false);
  });

  it("returns disabled when source is unavailable", () => {
    const result = disabledByOutage([unavail], ["shopify"]);
    assert.strictEqual(result.disabled, true);
    assert.ok(result.reason.includes("unavailable"));
  });

  it("returns degraded flag when source is degraded", () => {
    const result = disabledByOutage([degraded], ["shopify"]);
    assert.strictEqual(result.disabled, false);
    assert.strictEqual(result.degraded, true);
  });

  it("returns disabled when source has no recorded version", () => {
    const result = disabledByOutage([], ["shopify"]);
    assert.strictEqual(result.disabled, true);
    assert.ok(result.reason.includes("no recorded version"));
  });

  it("returns not disabled with empty dependencies", () => {
    const result = disabledByOutage([], []);
    assert.strictEqual(result.disabled, false);
  });

  it("returns not disabled with null/undefined dependencies", () => {
    const resultNone = disabledByOutage([], null);
    assert.strictEqual(resultNone.disabled, false);
    const resultUndef = disabledByOutage([], undefined);
    assert.strictEqual(resultUndef.disabled, false);
  });
});

// ---------------------------------------------------------------------------
// Commerce context
// ---------------------------------------------------------------------------

describe("createCommerceContext", () => {
  it("creates a full commerce context", () => {
    const ctx = createCommerceContext({
      currency: "USD",
      market: "US",
      variant: "sku-1234-large",
      customerEligibility: "premium",
      quantity: 2,
      priceContext: { listPrice: 1999, salePrice: 1499 },
    });
    assert.strictEqual(ctx.currency, "USD");
    assert.strictEqual(ctx.market, "US");
    assert.strictEqual(ctx.variant, "sku-1234-large");
    assert.strictEqual(ctx.customerEligibility, "premium");
    assert.strictEqual(ctx.quantity, 2);
    assert.deepStrictEqual(ctx.priceContext, { listPrice: 1999, salePrice: 1499 });
  });

  it("creates a minimal commerce context with only currency", () => {
    const ctx = createCommerceContext({ currency: "EUR" });
    assert.strictEqual(ctx.currency, "EUR");
    assert.strictEqual(ctx.market, undefined);
  });

  it("creates an empty commerce context", () => {
    const ctx = createCommerceContext();
    assert.deepStrictEqual(Object.keys(ctx), []);
  });

  it("rejects invalid currency code", () => {
    assert.throws(
      () => createCommerceContext({ currency: "usd" }),
      CommerceContextError,
    );
    assert.throws(
      () => createCommerceContext({ currency: "US" }),
      CommerceContextError,
    );
    assert.throws(
      () => createCommerceContext({ currency: "" }),
      CommerceContextError,
    );
  });

  it("rejects empty market", () => {
    assert.throws(
      () => createCommerceContext({ market: "" }),
      CommerceContextError,
    );
  });

  it("rejects empty variant", () => {
    assert.throws(
      () => createCommerceContext({ variant: "" }),
      CommerceContextError,
    );
  });

  it("rejects negative quantity", () => {
    assert.throws(
      () => createCommerceContext({ quantity: -1 }),
      CommerceContextError,
    );
  });

  it("rejects non-integer quantity", () => {
    assert.throws(
      () => createCommerceContext({ quantity: 1.5 }),
      CommerceContextError,
    );
  });

  it("rejects non-integer priceContext", () => {
    assert.throws(
      () => createCommerceContext({ priceContext: "invalid" }),
      CommerceContextError,
    );
    assert.throws(
      () => createCommerceContext({ priceContext: null }),
      CommerceContextError,
    );
  });

  it("returns frozen object", () => {
    const ctx = createCommerceContext({ currency: "USD" });
    assert.throws(() => { ctx.currency = "EUR"; }, TypeError);
  });
});

// Additional safety tests for unknown/malformed freshness class in mustRevalidate
describe("mustRevalidate safety edge-cases", () => {
  it("requires revalidation for unknown freshness class", () => {
    const result = mustRevalidate({ freshnessClass: "not-a-real-class", asOf: "2026-10-27T16:00:00Z" });
    assert.strictEqual(result.mustRevalidate, true);
    assert.ok(result.reason.includes("unknown freshness class"));
  });

  it("requires revalidation for empty freshness class", () => {
    const result = mustRevalidate({ freshnessClass: "", asOf: "2026-10-27T16:00:00Z" });
    assert.strictEqual(result.mustRevalidate, true);
  });

  it("requires revalidation for missing freshness class", () => {
    const result = mustRevalidate({ asOf: "2026-10-27T16:00:00Z" });
    assert.strictEqual(result.mustRevalidate, true);
  });
});

describe("createFreshnessMarker sourceStatus validation", () => {
  it("rejects invalid sourceStatus", () => {
    assert.throws(
      () => createFreshnessMarker({
        freshnessClass: "stale_readable",
        asOf: "2026-10-27T16:00:00Z",
        sourceStatus: "fast",
      }),
      FreshnessClassError,
    );
  });

  it("accepts valid sourceStatus values", () => {
    for (const status of SOURCE_STATUSES) {
      const m = createFreshnessMarker({
        freshnessClass: "stale_readable",
        asOf: "2026-10-27T16:00:00Z",
        sourceStatus: status,
      });
      assert.strictEqual(m.sourceStatus, status);
    }
  });
});
