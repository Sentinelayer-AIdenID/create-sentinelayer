import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BUILD_STATES,
  EngramNotReadyError,
  createBuildState,
} from "../src/engram/build-state.js";
import { namespaceDir, createStore } from "../src/engram/store.js";
import { parseNamespace } from "../src/engram/namespace.js";
import { ingestDocument } from "../src/engram/document.js";

/**
 * AN ENGRAM NOBODY FINISHED MUST NEVER ANSWER AS THOUGH SOMEONE HAD.
 *
 * The failure this guards is silent by construction: a needle search over a
 * half-ingested document returns the best match among the chunks that happen to
 * exist, with exactly the confidence it would give a complete index. Nothing in the
 * answer says "partial". So the gates below are mostly about the states that must
 * REFUSE -- and the control is that `ready` genuinely lets a query through, without
 * which "refused" would be trivially satisfied by refusing everything.
 */

async function tmpRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "engram-state-"));
}

const NS = parseNamespace("document:lifecycle-test");

test("Unit engram build-state: an unbuilt namespace is ABSENT and refuses queries", async () => {
  const root = await tmpRoot();
  try {
    const bs = createBuildState({ storeRoot: root });
    assert.equal((await bs.read(NS)).state, BUILD_STATES.ABSENT);
    await assert.rejects(() => bs.assertQueryable(NS), EngramNotReadyError);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram build-state: a build in flight REFUSES queries", async () => {
  const root = await tmpRoot();
  try {
    const bs = createBuildState({ storeRoot: root });
    await bs.begin(NS, { docDigest: "abc", expectedChunks: 3 });
    assert.equal((await bs.read(NS)).state, BUILD_STATES.BUILDING);

    await assert.rejects(
      () => bs.assertQueryable(NS),
      (err) => err instanceof EngramNotReadyError && /partial index/.test(err.message),
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram build-state: CONTROL -- a completed build is READY and answers", async () => {
  const root = await tmpRoot();
  try {
    const bs = createBuildState({ storeRoot: root });
    await bs.begin(NS, { docDigest: "abc", expectedChunks: 3 });
    await bs.complete(NS, { writtenChunks: 3 });

    const state = await bs.read(NS);
    assert.equal(state.state, BUILD_STATES.READY);
    // Without this the refusal tests prove nothing -- a module that refused
    // EVERYTHING would pass all of them.
    const ok = await bs.assertQueryable(NS);
    assert.equal(ok.state, BUILD_STATES.READY);
    assert.equal(ok.writtenChunks, 3);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram build-state: a build that DIED halfway stays BUILDING forever", async () => {
  const root = await tmpRoot();
  try {
    const bs = createBuildState({ storeRoot: root });
    // begin() writes BUILDING before any chunk exists; the process then "dies", so
    // complete() is never called. Nothing observes the crash, so the on-disk state
    // has to be wrong in the safe direction by default.
    await bs.begin(NS, { docDigest: "abc", expectedChunks: 5 });

    const reopened = createBuildState({ storeRoot: root });
    assert.equal((await reopened.read(NS)).state, BUILD_STATES.BUILDING);
    await assert.rejects(() => reopened.assertQueryable(NS), EngramNotReadyError);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram build-state: completing with FEWER chunks than promised is REFUSED", async () => {
  const root = await tmpRoot();
  try {
    const bs = createBuildState({ storeRoot: root });
    await bs.begin(NS, { docDigest: "abc", expectedChunks: 10 });

    await assert.rejects(
      () => bs.complete(NS, { writtenChunks: 4 }),
      /expected 10 chunks, wrote 4/,
    );
    // and it must still refuse afterwards -- a rejected completion cannot leave the
    // namespace readable
    assert.equal((await bs.read(NS)).state, BUILD_STATES.BUILDING);
    await assert.rejects(() => bs.assertQueryable(NS), EngramNotReadyError);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram build-state: a READY record that is inconsistent is downgraded", async () => {
  const root = await tmpRoot();
  try {
    const bs = createBuildState({ storeRoot: root });
    await bs.begin(NS, { expectedChunks: 3 });
    await bs.complete(NS, { writtenChunks: 3 });

    // Someone (or something) writes "ready" whose counts disagree with itself.
    const file = path.join(namespaceDir(root, NS), "build-state.json");
    const forged = { state: "ready", expectedChunks: 9, writtenChunks: 2, completedAt: "2026-01-01T00:00:00Z" };
    await fsp.writeFile(file, JSON.stringify(forged), "utf-8");

    const state = await bs.read(NS);
    assert.equal(state.state, BUILD_STATES.BUILDING, "an inconsistent ready record must not be honoured");
    await assert.rejects(() => bs.assertQueryable(NS), EngramNotReadyError);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram build-state: a TORN state file reads as BUILDING, never ready", async () => {
  const root = await tmpRoot();
  try {
    const bs = createBuildState({ storeRoot: root });
    await bs.begin(NS, { expectedChunks: 1 });
    await bs.complete(NS, { writtenChunks: 1 });

    const file = path.join(namespaceDir(root, NS), "build-state.json");
    await fsp.writeFile(file, '{"state":"ready","expected', "utf-8"); // truncated write

    const state = await bs.read(NS);
    assert.equal(state.state, BUILD_STATES.BUILDING, "unparseable state must resolve to the refusing one");
    await assert.rejects(() => bs.assertQueryable(NS), EngramNotReadyError);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram build-state: completing a build that never began is refused", async () => {
  const root = await tmpRoot();
  try {
    const bs = createBuildState({ storeRoot: root });
    await assert.rejects(() => bs.complete(NS, { writtenChunks: 1 }), /never began/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram build-state: end-to-end over a real document ingest", async () => {
  const root = await tmpRoot();
  try {
    const bs = createBuildState({ storeRoot: root });
    const store = createStore({ storeRoot: root });
    const doc = ["alpha", "---", "beta", "---", "gamma"].join("\n");
    const { items, docDigest } = ingestDocument(doc, {
      source: "d.md", ts: "2026-01-01T00:00:00Z", maxChars: 6,
    });

    await bs.begin(NS, { docDigest, expectedChunks: items.length });
    await assert.rejects(() => bs.assertQueryable(NS), EngramNotReadyError);

    const { written } = await store.appendItems(NS, items);
    await bs.complete(NS, { writtenChunks: written });

    const ready = await bs.assertQueryable(NS);
    assert.equal(ready.state, BUILD_STATES.READY);
    assert.equal(ready.docDigest, docDigest);
    assert.equal(ready.writtenChunks, items.length);

    // The state file lives alongside the namespace's items, resolved through the
    // store's own directory function rather than a second copy of the convention.
    const dir = namespaceDir(root, NS);
    const listing = await fsp.readdir(dir);
    assert.deepEqual(listing.sort(), ["build-state.json", "items.ndjson", "namespace.json"]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// --- namespaceDir collision safety ---

import { ensureNamespace } from "../src/engram/store.js";

test("Unit engram namespaceDir: distinct namespaces get distinct directories", async () => {
  const root = await tmpRoot();
  try {
    const a = parseNamespace("project:a:b");
    const b = parseNamespace("project:a_b");
    const dirA = namespaceDir(root, a);
    const dirB = namespaceDir(root, b);
    assert.notEqual(dirA, dirB,
      "project:a:b and project:a_b must not share a directory");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram namespaceDir: case-differing namespaces get distinct directories (case-insensitive FS safety)", async () => {
  const root = await tmpRoot();
  try {
    const a = parseNamespace("project:Alpha");
    const b = parseNamespace("project:alpha");
    const dirA = namespaceDir(root, a);
    const dirB = namespaceDir(root, b);
    assert.notEqual(dirA, dirB,
      "project:Alpha and project:alpha must not share a directory");
    // The stronger claim: even the final path component must differ when
    // lowercased, so the directories cannot collide on a case-insensitive FS.
    const baseA = path.basename(dirA).toLowerCase();
    const baseB = path.basename(dirB).toLowerCase();
    assert.notEqual(baseA, baseB,
      `directory basenames must differ case-insensitively: ${path.basename(dirA)} vs ${path.basename(dirB)}`);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram ensureNamespace: writes namespace.json sidecar on first access", async () => {
  const root = await tmpRoot();
  try {
    const ns = parseNamespace("document:sidecar-test");
    const dir = namespaceDir(root, ns);
    await ensureNamespace(dir, ns);
    const raw = await fsp.readFile(path.join(dir, "namespace.json"), "utf-8");
    const parsed = JSON.parse(raw);
    // kind is not stored in the sidecar (only raw is needed for ownership)
    assert.equal(parsed.raw, "document:sidecar-test");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram ensureNamespace: idempotent on repeated access", async () => {
  const root = await tmpRoot();
  try {
    const ns = parseNamespace("document:idempotent");
    const dir = namespaceDir(root, ns);
    await ensureNamespace(dir, ns);
    await ensureNamespace(dir, ns); // must not throw
    const raw = await fsp.readFile(path.join(dir, "namespace.json"), "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.raw, "document:idempotent");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram ensureNamespace: throws on cross-namespace collision", async () => {
  const root = await tmpRoot();
  try {
    const a = parseNamespace("project:owner-a");
    const b = parseNamespace("project:owner-b");
    const dirA = namespaceDir(root, a);
    const dirB = namespaceDir(root, b);
    // These MUST be different dirs (sha256), but test the sidecar guard anyway:
    // manually write a's sidecar into b's directory to simulate a collision
    await ensureNamespace(dirA, a);
    // Create dirB manually without sidecar, then write a's sidecar there
    await fsp.mkdir(dirB, { recursive: true });
    await fsp.writeFile(
      path.join(dirB, "namespace.json"),
      JSON.stringify({ kind: a.kind, raw: a.raw }) + "\n",
      "utf-8",
    );
    // Now accessing dirB as namespace b must throw
    await assert.rejects(
      () => ensureNamespace(dirB, b),
      /namespace dir collision/,
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram ensureNamespace: null sidecar is not treated as absent (refuses)", async () => {
  const root = await tmpRoot();
  try {
    const ns = parseNamespace("document:null-sidecar");
    const dir = namespaceDir(root, ns);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "namespace.json"), "null", "utf-8");
    // null sidecar is corrupt — ensureNamespace should refuse, not overwrite
    await assert.rejects(
      () => ensureNamespace(dir, ns),
      /corrupt namespace sidecar/,
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram ensureNamespace: throws on malformed sidecar (not an object)", async () => {
  const root = await tmpRoot();
  try {
    const ns = parseNamespace("document:malformed-test");
    const dir = namespaceDir(root, ns);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "namespace.json"), "true", "utf-8");
    await assert.rejects(
      () => ensureNamespace(dir, ns),
      /corrupt namespace sidecar/,
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram ensureNamespace: throws on malformed sidecar (bad JSON)", async () => {
  const root = await tmpRoot();
  try {
    const ns = parseNamespace("document:badjson-test");
    const dir = namespaceDir(root, ns);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "namespace.json"), "{not json}", "utf-8");
    await assert.rejects(
      () => ensureNamespace(dir, ns),
      /corrupt namespace sidecar/,
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
