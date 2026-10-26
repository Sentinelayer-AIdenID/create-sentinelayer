/**
 * Ticket 2a885ea8: namespace storage isolation.
 *
 * Every ENGRAM namespace must get its own storage, so a grant on one namespace
 * can never read or write another's memory — regardless of sanitized-name
 * collisions or case-insensitive filesystems.
 *
 * NS5: Top-level imports only reference symbols that exist on the pre-fix
 * main (a1ee2dc).  New symbols (LegacyStorageError, NamespaceOwnershipError,
 * ensureNamespace, legacyNamespaceDirName, verifyNamespace) are loaded via
 * await import() inside the tests that need them, so this file produces
 * per-test FAIL results on main instead of a whole-file import SyntaxError.
 */

import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Symbols that exist on base main (a1ee2dc)
import { createStore, namespaceDir } from "../src/engram/store.js";
import { createBuildState } from "../src/engram/build-state.js";
import { parseNamespace } from "../src/engram/namespace.js";
import { createMemoryService } from "../src/engram/index.js";

async function tmpRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "engram-ns-iso-"));
}

// ── Helpers to load new (post-2a885ea8) symbols ──

async function getLegacyNamespaceDirName() {
  const mod = await import("../src/engram/store.js");
  return mod.legacyNamespaceDirName;
}

async function getEnsureNamespace() {
  const mod = await import("../src/engram/store.js");
  return mod.ensureNamespace;
}

async function getLegacyStorageError() {
  const mod = await import("../src/engram/store.js");
  return mod.LegacyStorageError;
}

async function getNamespaceOwnershipError() {
  const mod = await import("../src/engram/store.js");
  return mod.NamespaceOwnershipError;
}

async function getVerifyNamespace() {
  const mod = await import("../src/engram/store.js");
  return mod.verifyNamespace;
}

// ── (a) project:a:b and project:a_b are isolated ──

test("(a) sanitized-name collision: project:a:b and project:a_b are isolated", async () => {
  const root = await tmpRoot();
  try {
    const nsA = parseNamespace("project:a:b");
    const nsB = parseNamespace("project:a_b");
    const legacyNamespaceDirName = await getLegacyNamespaceDirName();

    // Verify old lossy mapping would collide
    assert.equal(
      legacyNamespaceDirName(nsA),
      legacyNamespaceDirName(nsB),
      "precondition: old sanitization produces the same name",
    );

    // Verify new dirs are distinct
    const dirA = namespaceDir(root, nsA);
    const dirB = namespaceDir(root, nsB);
    assert.notEqual(dirA, dirB, "new dirs must be distinct");

    // Write to one, read the other — must be isolated
    const store = createStore({ storeRoot: root });
    await store.appendItems(nsA, [{ kind: "note", text: "alpha", ts: "2026-01-01T00:00:00Z" }]);
    const obsB = await store.readObservations(nsB);
    assert.equal(obsB.length, 0, "nsB must see no observations from nsA");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── (b) project:Alpha and project:alpha are isolated ──

test("(b) case collision: project:Alpha and project:alpha are isolated", async () => {
  const root = await tmpRoot();
  try {
    const nsA = parseNamespace("project:Alpha");
    const nsB = parseNamespace("project:alpha");

    // Old sanitization: both map to project_Alpha on most OS, project_alpha on others
    // The key: their dir basenames must differ even when lowercased
    const dirA = namespaceDir(root, nsA);
    const dirB = namespaceDir(root, nsB);
    assert.notEqual(dirA, dirB, "dirs must be distinct");
    assert.notEqual(
      path.basename(dirA).toLowerCase(),
      path.basename(dirB).toLowerCase(),
      "dir basenames must differ case-insensitively",
    );

    // Write to one, read the other — must be isolated
    const store = createStore({ storeRoot: root });
    await store.appendItems(nsA, [{ kind: "note", text: "case test A", ts: "2026-01-01T00:00:00Z" }]);
    const obsB = await store.readObservations(nsB);
    assert.equal(obsB.length, 0, "nsB must see no observations from nsA");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── (c) namespace.json mismatch is refused with NamespaceOwnershipError ──

test("(c) namespace.json whose raw does not match is refused", async () => {
  const root = await tmpRoot();
  try {
    const nsA = parseNamespace("project:owner-a");
    const nsB = parseNamespace("project:owner-b");
    const dirA = namespaceDir(root, nsA);
    const dirB = namespaceDir(root, nsB);
    const ensureNamespace = await getEnsureNamespace();
    const NamespaceOwnershipError = await getNamespaceOwnershipError();

    // Set up dirA owned by nsA, then tamper with dirB to point to nsA
    await ensureNamespace(dirA, nsA);
    await fsp.mkdir(dirB, { recursive: true });
    await fsp.writeFile(
      path.join(dirB, "namespace.json"),
      JSON.stringify({ raw: nsA.raw }) + "\n",
      "utf-8",
    );

    // Accessing dirB as nsB must throw NamespaceOwnershipError (NS3)
    await assert.rejects(
      () => ensureNamespace(dirB, nsB),
      NamespaceOwnershipError,
      "sidecar mismatch must throw NamespaceOwnershipError",
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── (d) legacy lossy dir with default "refuse" throws ──

test("(d) default refuse: legacy lossy dir is never read, throws LegacyStorageError", async () => {
  const root = await tmpRoot();
  try {
    const ns = parseNamespace("project:a:b");
    const legacyNamespaceDirName = await getLegacyNamespaceDirName();
    const LegacyStorageError = await getLegacyStorageError();
    const oldDir = path.join(root, ".sentinelayer", "engram", legacyNamespaceDirName(ns));

    // Create old lossy dir with data
    await fsp.mkdir(oldDir, { recursive: true });
    await fsp.appendFile(
      path.join(oldDir, "items.ndjson"),
      JSON.stringify({ kind: "note", text: "legacy data", ts: "2026-01-01T00:00:00Z" }) + "\n",
      "utf-8",
    );

    // createStore with default "refuse" must throw
    const store = createStore({ storeRoot: root });
    await assert.rejects(
      () => store.readObservations(ns),
      LegacyStorageError,
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── (e) first-claim: legacy dir migrates once, second gets empty ──

test("(e) first-claim: second namespace sees empty after first claimed legacy", async () => {
  const root = await tmpRoot();
  try {
    const nsA = parseNamespace("project:a:b");
    const nsB = parseNamespace("project:a_b");
    const legacyNamespaceDirName = await getLegacyNamespaceDirName();
    const oldDir = path.join(root, ".sentinelayer", "engram", legacyNamespaceDirName(nsA));

    // Create old lossy dir with data
    await fsp.mkdir(oldDir, { recursive: true });
    await fsp.appendFile(
      path.join(oldDir, "items.ndjson"),
      JSON.stringify({ kind: "note", text: "legacy data", ts: "2026-01-01T00:00:00Z", id: "h:abc123" }) + "\n",
      "utf-8",
    );

    // Claim with nsA first
    const storeA = createStore({ storeRoot: root, legacyLossyDirs: "first-claim" });
    const obsA = await storeA.readObservations(nsA);
    assert.equal(obsA.length, 1, "first claimant should see the legacy data");

    // nsB sees empty
    const storeB = createStore({ storeRoot: root, legacyLossyDirs: "first-claim" });
    const obsB = await storeB.readObservations(nsB);
    assert.equal(obsB.length, 0, "second namespace must see nothing");

    // Verify sidecars
    const dirA = namespaceDir(root, nsA);
    const sidecarA = JSON.parse(await fsp.readFile(path.join(dirA, "namespace.json"), "utf-8"));
    assert.equal(sidecarA.raw, nsA.raw);
    assert.ok(sidecarA.legacyFrom, "should record legacyFrom");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── (f) two concurrent first-claims yield exactly one owner ──

test("(f) two concurrent first-claims yield exactly one owner", async () => {
  const root = await tmpRoot();
  try {
    const nsA = parseNamespace("project:a:b");
    const nsB = parseNamespace("project:a_b");
    const legacyNamespaceDirName = await getLegacyNamespaceDirName();
    const oldDir = path.join(root, ".sentinelayer", "engram", legacyNamespaceDirName(nsA));

    // Create old lossy dir with data
    await fsp.mkdir(oldDir, { recursive: true });
    await fsp.appendFile(
      path.join(oldDir, "items.ndjson"),
      JSON.stringify({ kind: "note", text: "legacy data", ts: "2026-01-01T00:00:00Z", id: "h:abc123" }) + "\n",
      "utf-8",
    );

    // Fire both claims concurrently
    const storeA = createStore({ storeRoot: root, legacyLossyDirs: "first-claim" });
    const storeB = createStore({ storeRoot: root, legacyLossyDirs: "first-claim" });

    const [obsA, obsB] = await Promise.all([
      storeA.readObservations(nsA).catch(() => []),
      storeB.readObservations(nsB).catch(() => []),
    ]);

    // One must have the data, the other must be empty
    const hasData = (obsA.length === 1 ? 1 : 0) + (obsB.length === 1 ? 1 : 0);
    assert.equal(hasData, 1, "exactly one claimant gets the legacy data");

    // Neither should see both
    if (obsA.length === 1 && obsB.length === 1) {
      assert.fail("both claimants got data — isolation broken");
    }

    // Verify sidecars.  The winner's dir is created by the rename;
    // the loser's dir may not exist yet (NS1: reads never create).
    const dirA = namespaceDir(root, nsA);
    const dirB = namespaceDir(root, nsB);

    async function readSidecarIfExists(dir, ns) {
      try {
        const s = JSON.parse(await fsp.readFile(path.join(dir, "namespace.json"), "utf-8"));
        assert.equal(s.raw, ns.raw);
        return true;
      } catch (e) {
        if (e && e.code === "ENOENT") return false;
        throw e;
      }
    }

    const aExists = await readSidecarIfExists(dirA, nsA);
    const bExists = await readSidecarIfExists(dirB, nsB);

    // At least one must exist (the winner of the rename)
    assert.ok(aExists || bExists, "at least one claimant must have a sidecar");
    // The one with data must have a sidecar
    if (obsA.length === 1) assert.ok(aExists, "winner nsA must have a sidecar");
    if (obsB.length === 1) assert.ok(bExists, "winner nsB must have a sidecar");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── (g) createMemoryService uses first-claim without consent, refuse with ──

test("(g) createMemoryService: default consent uses first-claim, injected consent uses refuse", async () => {
  const rootDefault = await tmpRoot();
  const rootInjected = await tmpRoot();
  try {
    const ns = parseNamespace("project:a:b");
    const legacyNamespaceDirName = await getLegacyNamespaceDirName();
    const LegacyStorageError = await getLegacyStorageError();

    // Default consent (no consent injected) → first-claim
    const svcDefault = createMemoryService({ storeRoot: rootDefault });
    const oldDir = path.join(rootDefault, ".sentinelayer", "engram", legacyNamespaceDirName(ns));

    // Create legacy dir
    await fsp.mkdir(oldDir, { recursive: true });
    await fsp.appendFile(
      path.join(oldDir, "items.ndjson"),
      JSON.stringify({ kind: "note", text: "legacy", ts: "2026-01-01T00:00:00Z", id: "h:abc" }) + "\n",
      "utf-8",
    );

    // Default: should claim successfully
    const obsDefault = await svcDefault.store.readObservations(ns);
    assert.equal(obsDefault.length, 1, "default consent should claim legacy data");

    // Injected consent → refuse
    const injectedConsent = { allows: () => true };
    const svcInjected = createMemoryService({ storeRoot: rootInjected, consent: injectedConsent });
    const oldDir2 = path.join(rootInjected, ".sentinelayer", "engram", legacyNamespaceDirName(ns));
    await fsp.mkdir(oldDir2, { recursive: true });
    await fsp.appendFile(
      path.join(oldDir2, "items.ndjson"),
      JSON.stringify({ kind: "note", text: "legacy", ts: "2026-01-01T00:00:00Z", id: "h:abc" }) + "\n",
      "utf-8",
    );

    await assert.rejects(
      () => svcInjected.store.readObservations(ns),
      LegacyStorageError,
      "injected consent must refuse legacy",
    );
  } finally {
    await fsp.rm(rootDefault, { recursive: true, force: true });
    await fsp.rm(rootInjected, { recursive: true, force: true });
  }
});

// ── (h) build-state for two colliding namespaces is isolated ──

test("(h) build-state for colliding namespaces is isolated", async () => {
  const root = await tmpRoot();
  try {
    const nsA = parseNamespace("project:a:b");
    const nsB = parseNamespace("project:a_b");
    const bs = createBuildState({ storeRoot: root });

    // Begin a build for nsA
    await bs.begin(nsA, { docDigest: "aaa", expectedChunks: 3 });

    // nsA should be BUILDING
    assert.equal((await bs.read(nsA)).state, "building");

    // nsB should be ABSENT — no cross-namespace leakage
    assert.equal((await bs.read(nsB)).state, "absent",
      "nsB must not see nsA's build state");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── (i) CONTROL: write-then-read round-trip still works ──

test("(i) CONTROL: write-then-read round-trip still works", async () => {
  const root = await tmpRoot();
  try {
    const ns = parseNamespace("document:roundtrip");
    const store = createStore({ storeRoot: root });

    const { written } = await store.appendItems(ns, [
      { kind: "note", text: "hello", ts: "2026-01-01T00:00:00Z" },
    ]);
    assert.equal(written, 1);

    const obs = await store.readObservations(ns);
    assert.equal(obs.length, 1);
    assert.equal(obs[0].text, "hello");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ROUND 2 regression tests
// ═══════════════════════════════════════════════════════════════════════

// ── (j) NS1: a read of a never-written namespace creates nothing on disk ──

test("(j) NS1: a read of a never-written namespace creates nothing on disk", async () => {
  const root = await tmpRoot();
  try {
    const ns = parseNamespace("project:never-written");
    const engramRoot = path.join(root, ".sentinelayer", "engram");

    // List contents before
    let beforeEntries = [];
    try {
      beforeEntries = await fsp.readdir(engramRoot);
    } catch {
      // engram dir doesn't exist yet — that's fine
    }

    // Read a namespace that was never written
    const store = createStore({ storeRoot: root });
    const obs = await store.readObservations(ns);
    assert.equal(obs.length, 0, "read of never-written namespace must return empty");

    // Verify nothing was created
    const dir = namespaceDir(root, ns);
    try {
      await fsp.access(dir);
      assert.fail("hashed dir must not exist after a read-only operation");
    } catch (e) {
      assert.equal(e.code, "ENOENT", "hashed dir must not exist");
    }

    // Verify engram root wasn't created either (or is unchanged)
    let afterEntries = [];
    try {
      afterEntries = await fsp.readdir(engramRoot);
    } catch {
      // still doesn't exist — fine
    }
    assert.deepEqual(
      beforeEntries.sort(),
      afterEntries.sort(),
      "engram root must be unchanged by a read",
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── (k) NS2: build-state read refuses a hashed dir whose sidecar names another namespace ──

test("(k) NS2: build-state read refuses a hashed dir whose sidecar names another namespace", async () => {
  const root = await tmpRoot();
  try {
    const nsA = parseNamespace("project:owner-a");
    const nsB = parseNamespace("project:owner-b");
    const ensureNamespace = await getEnsureNamespace();
    const NamespaceOwnershipError = await getNamespaceOwnershipError();

    // Create dirA legitimately owned by nsA
    const dirA = namespaceDir(root, nsA);
    await ensureNamespace(dirA, nsA);

    // Tamper: write a build-state.json in a dir whose sidecar says nsA,
    // but access it as nsB by pointing nsB's hashed dir at the same path.
    // Actually, the hashed dir for nsB is different, so we tamper with
    // the sidecar in nsB's dir to claim nsA.
    const dirB = namespaceDir(root, nsB);
    await fsp.mkdir(dirB, { recursive: true });
    await fsp.writeFile(
      path.join(dirB, "namespace.json"),
      JSON.stringify({ raw: nsA.raw }) + "\n",
      "utf-8",
    );
    // Write a valid build-state to dirB
    await fsp.writeFile(
      path.join(dirB, "build-state.json"),
      JSON.stringify({ state: "ready", namespace: nsA.raw, writtenChunks: 1, expectedChunks: 1, completedAt: "2026-01-01T00:00:00Z" }) + "\n",
      "utf-8",
    );

    // Accessing dirB as nsB via build-state read must throw
    const bs = createBuildState({ storeRoot: root });
    await assert.rejects(
      () => bs.read(nsB),
      NamespaceOwnershipError,
      "build-state read must verify sidecar and refuse mismatched namespace",
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
