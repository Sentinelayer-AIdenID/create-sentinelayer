import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";

import {
  ingestSite,
  createGraphStore,
  SourceIntakeError,
} from "../src/engram/index.js";
import { parseNamespace, createLocalConsent } from "../src/engram/namespace.js";

const CALLER = { id: "ingester", kind: "agent" };
const TENANT = "project:ew04-test";
const SOURCE_ID = "ew04:test-site";
const HTML = "<html><head><title>Test</title></head><body><p>Hello</p></body></html>";

async function withGraphStore(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-ingest-site-"));
  const gs = createGraphStore({ storeRoot: root, consent: createLocalConsent() });
  try {
    return await fn(gs, root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// ingestSite end-to-end: safe-reader → source-intake → graph-store
// These use source-intake-style fixtures with a mock read function.
// The source registry and intake enforce HTTPS; the reader is only called
// after intake passes, so we inject a mock reader that returns controlled bytes.
// ---------------------------------------------------------------------------

test("ingestSite: full pipeline stores snapshot and extracts facts", async () => {
  await withGraphStore(async (graphStore) => {
    const bodyBytes = Buffer.from(HTML, "utf-8");
    const reader = {
      read: async (url, opts) => ({
        bytes: bodyBytes,
        contentType: "text/html; charset=utf-8",
        finalUrl: "https://example.com/",
        version: "sha256:" + createHash("sha256").update(bodyBytes).digest("hex"),
        fetchedAt: "2026-10-26T00:00:00.000Z",
      }),
    };

    const sources = new Map();
    sources.set(SOURCE_ID, {
      tenantScope: TENANT,
      visibility: "public",
      url: "https://example.com/",
      version: "sha256:fc0c3bc0f1cccea0ab36b2f2ce90e05c02cbfa183935e8ae2ad43a9d6cd0b82a",
      sourceType: "ingest",
      mediaType: "text/html",
    });

    const allowedOrigins = new Set(["https://example.com"]);

    const result = await ingestSite({
      sourceId: SOURCE_ID,
      tenantScope: TENANT,
      sources,
      allowedOrigins,
      authorize: async () => true,
      reader,
      graphStore,
      caller: CALLER,
      namespace: TENANT,
      maxBytes: 1024 * 1024,
    });

    // Snapshot returned
    assert.ok(result.snapshot);
    assert.equal(result.snapshot.sourceId, SOURCE_ID);
    assert.equal(result.snapshot.tenantScope, TENANT);
    assert.equal(typeof result.snapshot.contentHash, "string");
    assert.ok(result.snapshot.contentHash.startsWith("sha256:"));

    // Facts extracted with byte offsets
    assert.ok(result.facts);
    assert.equal(result.facts.title, "Test");

    // Not reused on first ingest
    assert.equal(result.reused, false);

    // Verify the snapshot is actually persisted in the graph store
    const existing = await graphStore.listSourceSnapshots(CALLER, parseNamespace(TENANT));
    const match = existing.find((s) => s.sourceId === SOURCE_ID);
    assert.ok(match, "snapshot must be persisted in graph store");
    // Graph store returns contentHash without sha256: prefix
    const expectedHash = createHash("sha256").update(bodyBytes).digest("hex");
    assert.equal(match.contentHash, expectedHash);
  });
});

test("ingestSite: re-ingest of identical content is reused", async () => {
  await withGraphStore(async (graphStore) => {
    const bodyBytes = Buffer.from(HTML, "utf-8");
    const reader = {
      read: async (url, opts) => ({
        bytes: bodyBytes,
        contentType: "text/html; charset=utf-8",
        finalUrl: "https://example.com/",
        version: "sha256:" + createHash("sha256").update(bodyBytes).digest("hex"),
        fetchedAt: "2026-10-26T00:00:00.000Z",
      }),
    };

    const sources = new Map();
    sources.set(SOURCE_ID, {
      tenantScope: TENANT,
      visibility: "public",
      url: "https://example.com/",
      version: "sha256:fc0c3bc0f1cccea0ab36b2f2ce90e05c02cbfa183935e8ae2ad43a9d6cd0b82a",
      sourceType: "ingest",
      mediaType: "text/html",
    });

    const opts = {
      sourceId: SOURCE_ID,
      tenantScope: TENANT,
      sources,
      allowedOrigins: new Set(["https://example.com"]),
      authorize: async () => true,
      reader,
      graphStore,
      caller: CALLER,
      namespace: TENANT,
      maxBytes: 1024 * 1024,
    };

    const first = await ingestSite(opts);
    assert.equal(first.reused, false);

    const second = await ingestSite(opts);
    assert.equal(second.reused, true, "identical content must be reused");
    // source-intake snapshots keep sha256: prefix
    const expectedPrefixedHash = "sha256:" + createHash("sha256").update(bodyBytes).digest("hex");
    assert.equal(second.snapshot.contentHash, expectedPrefixedHash);
    assert.equal(second.facts.title, "Test");
  });
});

test("ingestSite: unapproved origin is blocked by source-intake", async () => {
  await withGraphStore(async (graphStore) => {
    const reader = { read: async () => ({}) };
    const sources = new Map();
    sources.set(SOURCE_ID, {
      tenantScope: TENANT,
      visibility: "public",
      url: "https://other.example/",
      version: "sha256:fc0c3bc0f1cccea0ab36b2f2ce90e05c02cbfa183935e8ae2ad43a9d6cd0b82a",
      sourceType: "ingest",
      mediaType: "text/html",
    });

    await assert.rejects(
      ingestSite({
        sourceId: SOURCE_ID,
        tenantScope: TENANT,
        sources,
        allowedOrigins: new Set(["https://allowed.example"]),
        authorize: async () => true,
        reader,
        graphStore,
        caller: CALLER,
        namespace: TENANT,
      }),
      (err) => err instanceof SourceIntakeError && err.code === "source_not_approved",
    );
  });
});

test("ingestSite: authorization denial is propagated", async () => {
  await withGraphStore(async (graphStore) => {
    const reader = { read: async () => ({}) };
    const sources = new Map();
    sources.set(SOURCE_ID, {
      tenantScope: TENANT,
      visibility: "public",
      url: "https://allowed.example/",
      version: "sha256:fc0c3bc0f1cccea0ab36b2f2ce90e05c02cbfa183935e8ae2ad43a9d6cd0b82a",
      sourceType: "ingest",
      mediaType: "text/html",
    });

    await assert.rejects(
      ingestSite({
        sourceId: SOURCE_ID,
        tenantScope: TENANT,
        sources,
        allowedOrigins: new Set(["https://allowed.example"]),
        authorize: async () => false,
        reader,
        graphStore,
        caller: CALLER,
        namespace: TENANT,
      }),
      (err) => err instanceof SourceIntakeError && err.code === "source_access_denied",
    );
  });
});

test("ingestSite: non-HTML content returns empty facts gracefully", async () => {
  await withGraphStore(async (graphStore) => {
    const bodyBytes = Buffer.from("plain text", "utf-8");
    const reader = {
      read: async (url, opts) => ({
        bytes: bodyBytes,
        contentType: "text/plain",
        finalUrl: "https://example.com/",
        version: "sha256:" + createHash("sha256").update(bodyBytes).digest("hex"),
        fetchedAt: "2026-10-26T00:00:00.000Z",
      }),
    };

    const sources = new Map();
    sources.set(SOURCE_ID, {
      tenantScope: TENANT,
      visibility: "public",
      url: "https://example.com/",
      version: "sha256:c9ecf5e54c7b3f2640ecca21f96d4c3625a2b7935104f41c5ede29935a9e52c9",
      sourceType: "ingest",
      mediaType: "text/plain",
    });

    const result = await ingestSite({
      sourceId: SOURCE_ID,
      tenantScope: TENANT,
      sources,
      allowedOrigins: new Set(["https://example.com"]),
      authorize: async () => true,
      reader,
      graphStore,
      caller: CALLER,
      namespace: TENANT,
      maxBytes: 1024 * 1024,
    });

    // Facts are graceful fallback for non-HTML
    assert.equal(result.facts.title, null);
    assert.equal(result.facts.headings.length, 0);
    assert.equal(result.reused, false);
    assert.ok(result.snapshot);
  });
});

test("ingestSite: extracts JSON-LD with byte offsets through pipeline", async () => {
  await withGraphStore(async (graphStore) => {
    const htmlWithJsonLd = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Test Site"}</script>
</head><body></body></html>`;
    const bodyBytes = Buffer.from(htmlWithJsonLd, "utf-8");
    const reader = {
      read: async (url, opts) => ({
        bytes: bodyBytes,
        contentType: "text/html; charset=utf-8",
        finalUrl: "https://example.com/",
        version: "sha256:" + createHash("sha256").update(bodyBytes).digest("hex"),
        fetchedAt: "2026-10-26T00:00:00.000Z",
      }),
    };

    const sources = new Map();
    sources.set(SOURCE_ID, {
      tenantScope: TENANT,
      visibility: "public",
      url: "https://example.com/",
      version: "sha256:f71ac0f0f9f9b2ccc70a87de1729f701dc4395d42b3d077c237ae57f22aad041",
      sourceType: "ingest",
      mediaType: "text/html",
    });

    const result = await ingestSite({
      sourceId: SOURCE_ID,
      tenantScope: TENANT,
      sources,
      allowedOrigins: new Set(["https://example.com"]),
      authorize: async () => true,
      reader,
      graphStore,
      caller: CALLER,
      namespace: TENANT,
      maxBytes: 1024 * 1024,
    });

    assert.equal(result.facts.jsonLd.length, 1);
    assert.equal(result.facts.jsonLd[0].verified, true);
    assert.deepEqual(result.facts.jsonLd[0].data, {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": "Test Site",
    });
    assert.equal(typeof result.facts.jsonLd[0].evidence.start, "number");
    assert.ok(result.facts.jsonLd[0].evidence.start < result.facts.jsonLd[0].evidence.end);
  });
});

test("ingestSite: snapshot contentHash is sha256 of bytes", async () => {
  await withGraphStore(async (graphStore) => {
    const bodyBytes = Buffer.from(HTML, "utf-8");
    const reader = {
      read: async (url, opts) => ({
        bytes: bodyBytes,
        contentType: "text/html; charset=utf-8",
        finalUrl: "https://example.com/",
        version: "sha256:" + createHash("sha256").update(bodyBytes).digest("hex"),
        fetchedAt: "2026-10-26T00:00:00.000Z",
      }),
    };

    const sources = new Map();
    sources.set(SOURCE_ID, {
      tenantScope: TENANT,
      visibility: "public",
      url: "https://example.com/",
      version: "sha256:fc0c3bc0f1cccea0ab36b2f2ce90e05c02cbfa183935e8ae2ad43a9d6cd0b82a",
      sourceType: "ingest",
      mediaType: "text/html",
    });

    const result = await ingestSite({
      sourceId: SOURCE_ID,
      tenantScope: TENANT,
      sources,
      allowedOrigins: new Set(["https://example.com"]),
      authorize: async () => true,
      reader,
      graphStore,
      caller: CALLER,
      namespace: TENANT,
      maxBytes: 1024 * 1024,
    });

    const expectedHash = `sha256:${createHash("sha256").update(bodyBytes).digest("hex")}`;
    assert.equal(result.snapshot.contentHash, expectedHash);
  });
});

// =============================================================================
// Witness tests (ex witness-finding3.mjs): version matching
// =============================================================================

test("Witness F3: matched version is stored", async () => {
  await withGraphStore(async (graphStore) => {
    const bodyBytes = Buffer.from("<html><title>Match</title></html>", "utf-8");
    const actualHash = "sha256:" + createHash("sha256").update(bodyBytes).digest("hex");

    const reader = {
      read: async (url, opts) => ({
        bytes: bodyBytes,
        contentType: "text/html; charset=utf-8",
        finalUrl: "https://example.com/",
        version: actualHash,
        fetchedAt: "2026-10-26T00:00:00.000Z",
      }),
    };

    const sources = new Map();
    sources.set("ew04:f3-test", {
      tenantScope: TENANT,
      visibility: "public",
      url: "https://example.com/",
      version: actualHash,
      sourceType: "ingest",
      mediaType: "text/html",
    });

    const result = await ingestSite({
      sourceId: "ew04:f3-test",
      tenantScope: TENANT,
      sources,
      allowedOrigins: new Set(["https://example.com"]),
      authorize: async () => true,
      reader,
      graphStore,
      caller: CALLER,
      namespace: TENANT,
      maxBytes: 1024 * 1024,
    });

    assert.equal(result.reused, false);
    const existing = await graphStore.listSourceSnapshots(CALLER, parseNamespace(TENANT));
    const match = existing.find((s) => s.sourceId === "ew04:f3-test");
    assert.ok(match, "snapshot must be persisted when version matches");
  });
});

test("Witness F3: mismatched version is rejected with NO snapshot written", async () => {
  await withGraphStore(async (graphStore) => {
    const bodyBytes = Buffer.from("<html><title>Mismatch</title></html>", "utf-8");
    const actualHash = "sha256:" + createHash("sha256").update(bodyBytes).digest("hex");

    const reader = {
      read: async (url, opts) => ({
        bytes: bodyBytes,
        contentType: "text/html; charset=utf-8",
        finalUrl: "https://example.com/",
        version: actualHash,
        fetchedAt: "2026-10-26T00:00:00.000Z",
      }),
    };

    const sources = new Map();
    sources.set("ew04:f3-mismatch", {
      tenantScope: TENANT,
      visibility: "public",
      url: "https://example.com/",
      version: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      sourceType: "ingest",
      mediaType: "text/html",
    });

    await assert.rejects(
      ingestSite({
        sourceId: "ew04:f3-mismatch",
        tenantScope: TENANT,
        sources,
        allowedOrigins: new Set(["https://example.com"]),
        authorize: async () => true,
        reader,
        graphStore,
        caller: CALLER,
        namespace: TENANT,
        maxBytes: 1024 * 1024,
      }),
      (err) => err instanceof SourceIntakeError && err.code === "source_rejected",
    );

    const existing = await graphStore.listSourceSnapshots(CALLER, parseNamespace(TENANT));
    const match = existing.find((s) => s.sourceId === "ew04:f3-mismatch");
    assert.equal(match, undefined, "no snapshot must be written when version mismatches");
  });
});

// =============================================================================
// Witness tests (ex witness-finding7.mjs): re-ingest duplicate detection
// =============================================================================

const W7_HTML = "<html><head><title>Reuse Test</title></head><body><h1>Same</h1></body></html>";

test("Witness F7 / R7-2: same bytes re-ingest sets reused:true, returns existing snapshot, store has exactly 1 record", async () => {
  await withGraphStore(async (graphStore) => {
    const bodyBytes = Buffer.from(W7_HTML, "utf-8");
    const actualHash = "sha256:" + createHash("sha256").update(bodyBytes).digest("hex");
    const sourceId = "ew04:f7-reuse";

    const makeReader = () => ({
      read: async (url, opts) => ({
        bytes: bodyBytes,
        contentType: "text/html; charset=utf-8",
        finalUrl: "https://example.com/",
        version: actualHash,
        fetchedAt: "2026-10-26T00:00:00.000Z",
      }),
    });

    const makeSources = (version) => {
      const m = new Map();
      m.set(sourceId, {
        tenantScope: TENANT,
        visibility: "public",
        url: "https://example.com/",
        version,
        sourceType: "ingest",
        mediaType: "text/html",
      });
      return m;
    };

    const baseOpts = {
      sourceId,
      tenantScope: TENANT,
      allowedOrigins: new Set(["https://example.com"]),
      authorize: async () => true,
      reader: makeReader(),
      graphStore,
      caller: CALLER,
      namespace: TENANT,
      maxBytes: 1024 * 1024,
    };

    // First ingest
    const r1 = await ingestSite({ ...baseOpts, sources: makeSources(actualHash) });
    assert.equal(r1.reused, false);

    // Second ingest: same bytes, same version hash
    const r2 = await ingestSite({ ...baseOpts, sources: makeSources(actualHash) });
    assert.equal(r2.reused, true, "same bytes should be detected as reused");

    // The returned snapshot should deep-equal the stored record
    const existing = await graphStore.listSourceSnapshots(CALLER, parseNamespace(TENANT));
    const stored = existing.filter(s => s.sourceId === sourceId);
    assert.equal(stored.length, 1, "exactly 1 record in store after re-ingest of identical bytes");
    // Normalize: the returned snapshot has sha256: prefix; stored record has raw hex
    const expected = { ...stored[0], contentHash: "sha256:" + stored[0].contentHash };
    assert.deepStrictEqual(r2.snapshot, expected);
  });
});
