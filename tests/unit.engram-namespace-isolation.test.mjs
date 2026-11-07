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

// Ticket 82e1b04d: namespace metadata is visible only after its complete write.
test("NS marker publication: held first write preserves a concurrent winner's inode and bytes", async () => {
  const root = await tmpRoot();
  const ns = parseNamespace("project:namespace-publication");
  const dir = namespaceDir(root, ns);
  const final = path.join(dir, "namespace.json");
  const store = createStore({ storeRoot: root });
  const realOpen = fsp.open;
  const realWriteFile = fsp.writeFile;
  let signalWrite;
  const writeStarted = new Promise((resolve) => { signalWrite = resolve; });
  let releaseWrite;
  const writeReleased = new Promise((resolve) => { releaseWrite = resolve; });
  let held = false;
  let first;
  let second;
  let winnerHandle;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("namespace marker barrier timed out")), 5_000);
  });
  const settle = (operation) => operation.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  const hold = (handle) => {
    held = true;
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async (...args) => {
      signalWrite();
      await writeReleased;
      return write(...args);
    };
    return handle;
  };
  fsp.open = async (file, flags, ...args) => {
    const handle = await realOpen(file, flags, ...args);
    if (!held && flags === "wx" && path.dirname(String(file)) === dir
      && path.basename(String(file)).startsWith("namespace.json")) hold(handle);
    return handle;
  };
  // The old initializer uses writeFile(path, {flag: "wx"}), whose internal
  // open is not the exported fsp.open. Model its native open/write boundary
  // with a real exclusive open; competing calls and verification stay native.
  fsp.writeFile = async (file, data, options) => {
    if (!held && String(file) === final && options?.flag === "wx") {
      const handle = hold(await realOpen(file, "wx", options.mode));
      try { return await handle.writeFile(data, options); }
      finally { await handle.close(); }
    }
    return realWriteFile(file, data, options);
  };
  try {
    first = settle(store.appendItems(ns, [{ id: "first", kind: "note", text: "first", ts: "2026-01-01T00:00:00Z" }]));
    await Promise.race([writeStarted, deadline]);
    second = settle(store.appendItems(ns, [{ id: "second", kind: "note", text: "second", ts: "2026-01-01T00:00:00Z" }]));
    const result = await Promise.race([second, deadline]);
    assert.equal(result.status, "fulfilled",
      `a concurrent initializer read incomplete namespace metadata: ${result.reason?.message}`);

    // Keep the winning inode alive so unlink-and-republish cannot hide behind
    // inode reuse, even if the losing initializer publishes identical bytes.
    winnerHandle = await realOpen(final, "r");
    const winner = await winnerHandle.stat({ bigint: true });
    const bytes = await fsp.readFile(final);
    releaseWrite();
    const results = await Promise.race([Promise.all([first, second]), deadline]);
    assert.ok(results.every((entry) => entry.status === "fulfilled"));
    assert.deepEqual(results.map((entry) => entry.value.written), [1, 1]);
    const current = await fsp.stat(final, { bigint: true });
    assert.deepEqual({ dev: current.dev, ino: current.ino }, { dev: winner.dev, ino: winner.ino },
      "a valid concurrent winner's inode must never be replaced");
    assert.deepEqual(await fsp.readFile(final), bytes, "the winner's bytes must remain unchanged");
    assert.equal(bytes.toString(), JSON.stringify({ raw: ns.raw }, null, 2) + "\n");
    assert.deepEqual((await store.readObservations(ns)).map((item) => item.text).sort(), ["first", "second"]);
    assert.deepEqual((await fsp.readdir(dir)).filter((name) => name.startsWith("namespace.json.")), []);
  } finally {
    releaseWrite();
    clearTimeout(timer);
    try {
      await Promise.allSettled([first, second].filter(Boolean));
      await winnerHandle?.close();
    } finally {
      fsp.open = realOpen;
      fsp.writeFile = realWriteFile;
      await fsp.rm(root, { recursive: true, force: true });
    }
  }
});

async function withNamespaceMarker(fn) {
  const root = await tmpRoot();
  const ns = parseNamespace("project:marker-contract");
  const dir = namespaceDir(root, ns);
  try { return await fn({ root, ns, dir, final: path.join(dir, "namespace.json"), ensure: await getEnsureNamespace() }); }
  finally { await fsp.rm(root, { recursive: true, force: true }); }
}

test("NS marker publication: existing valid metadata and read APIs need no directory writes", async () => {
  await withNamespaceMarker(async ({ root, ns, dir, final, ensure }) => {
    const legacyFrom = "project_marker-contract";
    await ensure(dir, ns, legacyFrom);
    const store = createStore({ storeRoot: root });
    await store.appendItems(ns, [{ id: "read-only", kind: "note", text: "retained", ts: "2026-01-01T00:00:00Z" }]);
    const builds = createBuildState({ storeRoot: root });
    await builds.begin(ns, { docDigest: "retained", expectedChunks: 1 });
    const marker = await fsp.readFile(final, "utf-8");
    assert.equal(marker, JSON.stringify({ raw: ns.raw, legacyFrom }, null, 2) + "\n");
    const originals = Object.fromEntries(["open", "mkdir", "writeFile", "appendFile", "link", "rename", "unlink"]
      .map((method) => [method, fsp[method]]));
    let writes = 0;
    for (const method of Object.keys(originals)) {
      fsp[method] = async () => { writes++; throw Object.assign(new Error("read-only store"), { code: "EROFS" }); };
    }
    try {
      await ensure(dir, ns, "must-not-replace-legacyFrom");
      assert.equal((await store.readObservations(ns))[0].text, "retained");
      assert.equal((await builds.read(ns)).state, "building");
      assert.equal(writes, 0);
      assert.equal(await fsp.readFile(final, "utf-8"), marker);
    } finally { Object.assign(fsp, originals); }
  });
});

for (const [name, marker] of [
  ["empty", ""], ["malformed", "{"], ["null", "null"],
  ["foreign", JSON.stringify({ raw: "project:other-owner" }) + "\n"],
]) {
  test(`NS marker publication: existing ${name} metadata is refused without mutation`, async () => {
    await withNamespaceMarker(async ({ ns, dir, final, ensure }) => {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(final, marker);
      const OwnershipError = await getNamespaceOwnershipError();
      await assert.rejects(() => ensure(dir, ns), (error) => name === "foreign"
        ? error instanceof OwnershipError && error.message.includes("already owned by")
        : error.constructor === Error && error.message.startsWith(`corrupt namespace sidecar in ${dir}:`));
      assert.equal(await fsp.readFile(final, "utf-8"), marker);
      assert.deepEqual(await fsp.readdir(dir), ["namespace.json"]);
    });
  });
}

test("NS marker publication: reads refuse an existing directory with no marker without repairing it", async () => {
  await withNamespaceMarker(async ({ root, ns, dir }) => {
    await fsp.mkdir(dir, { recursive: true });
    const OwnershipError = await getNamespaceOwnershipError();
    await assert.rejects(() => createStore({ storeRoot: root }).readObservations(ns), OwnershipError);
    await assert.rejects(() => createBuildState({ storeRoot: root }).read(ns), OwnershipError);
    assert.deepEqual(await fsp.readdir(dir), []);
  });
});

test("NS marker publication: an existing marker read error retains the verifier's error format", async () => {
  await withNamespaceMarker(async ({ ns, dir, final, ensure }) => {
    await ensure(dir, ns);
    const realReadFile = fsp.readFile;
    fsp.readFile = async (file, ...args) => {
      if (String(file) === final) throw Object.assign(new Error("marker read denied"), { code: "EACCES" });
      return realReadFile(file, ...args);
    };
    try {
      await assert.rejects(() => ensure(dir, ns), (error) => error.constructor === Error
        && error.message === `corrupt namespace sidecar in ${dir}: marker read denied`);
    } finally { fsp.readFile = realReadFile; }
    assert.deepEqual(await fsp.readdir(dir), ["namespace.json"]);
  });
});

for (const [code, partial] of [["ENOSPC", false], ["EIO", true]]) {
  test(`NS marker publication: ${code} ${partial ? "partial UTF-8" : "empty"} write removes only its owned temporary`, async () => {
    await withNamespaceMarker(async ({ ns, dir, final, ensure }) => {
      const originals = { open: fsp.open, link: fsp.link };
      const failure = Object.assign(new Error("metadata write failed"), { code });
      let closed = false;
      let links = 0;
      fsp.link = async (...args) => { links++; return originals.link(...args); };
      fsp.open = async (file, ...args) => {
        const handle = await originals.open(file, ...args);
        if (path.dirname(String(file)) === dir && path.basename(String(file)).startsWith("namespace.json.")) {
          const write = handle.writeFile.bind(handle);
          const close = handle.close.bind(handle);
          handle.writeFile = async (bytes) => {
            if (partial) {
              const offset = bytes.indexOf(Buffer.from("π"));
              assert.ok(offset >= 0);
              await write(bytes.subarray(0, offset + 1));
            }
            throw failure;
          };
          handle.close = async () => { await close(); closed = true; };
        }
        return handle;
      };
      try {
        await assert.rejects(() => ensure(dir, ns, "legacy-π"), (error) => error === failure && error.code === code);
        assert.equal(closed, true);
        assert.equal(links, 0, "incomplete metadata must never be published");
        assert.deepEqual(await fsp.readdir(dir), []);
      } finally { Object.assign(fsp, originals); }
      await ensure(dir, ns, "legacy-π");
      assert.equal(await fsp.readFile(final, "utf-8"), JSON.stringify({ raw: ns.raw, legacyFrom: "legacy-π" }, null, 2) + "\n");
      assert.deepEqual(await fsp.readdir(dir), ["namespace.json"]);
    });
  });
}

// Inject unsupported-link errors; these cases do not claim native FAT/NTFS proof.
for (const code of ["ENOTSUP", "EISDIR"]) {
  test(`NS marker publication: unsupported link ${code} preserves errno and removes its owned temporary`, async () => {
    await withNamespaceMarker(async ({ ns, dir, ensure }) => {
      const realLink = fsp.link;
      const failure = Object.assign(new Error("filesystem does not support this hard link"), { code });
      let links = 0;
      fsp.link = async () => { links++; throw failure; };
      try {
        await assert.rejects(() => ensure(dir, ns), (error) => error === failure && error.code === code);
        assert.equal(links, 1, "no retry or overwrite fallback is permitted");
        assert.deepEqual(await fsp.readdir(dir), []);
      } finally { fsp.link = realLink; }
    });
  });
}

test("NS marker publication: unsupported links after a legacy claim preserve moved data and refuse unmarked reads", async () => {
  await withNamespaceMarker(async ({ root, ns, dir }) => {
    const legacyName = (await getLegacyNamespaceDirName())(ns);
    const oldDir = path.join(root, ".sentinelayer", "engram", legacyName);
    const data = JSON.stringify({ id: "legacy", kind: "note", text: "kept", ts: "2026-01-01T00:00:00Z" }) + "\n";
    await fsp.mkdir(oldDir, { recursive: true });
    await fsp.writeFile(path.join(oldDir, "items.ndjson"), data);
    const store = createStore({ storeRoot: root, legacyLossyDirs: "first-claim" });
    const realLink = fsp.link;
    const failure = Object.assign(new Error("hard links unsupported after legacy rename"), { code: "ENOTSUP" });
    fsp.link = async () => { throw failure; };
    try { await assert.rejects(() => store.readObservations(ns), (error) => error === failure); }
    finally { fsp.link = realLink; }
    assert.equal(await fsp.readFile(path.join(dir, "items.ndjson"), "utf-8"), data);
    assert.deepEqual(await fsp.readdir(dir), ["items.ndjson"]);
    await assert.rejects(() => fsp.access(oldDir), (error) => error.code === "ENOENT");
    await assert.rejects(() => store.readObservations(ns), await getNamespaceOwnershipError());
    assert.deepEqual(await fsp.readdir(dir), ["items.ndjson"]);
  });
});

test("NS marker publication: a temporary name collision preserves the foreign file and original EEXIST", async () => {
  await withNamespaceMarker(async ({ ns, dir, ensure }) => {
    const realOpen = fsp.open;
    let foreign;
    let collision;
    fsp.open = async (file, flags, ...args) => {
      if (flags === "wx" && path.dirname(String(file)) === dir) {
        foreign = String(file);
        await fsp.writeFile(foreign, "foreign temporary", { flag: "wx" });
      }
      try { return await realOpen(file, flags, ...args); }
      catch (error) { collision = error; throw error; }
    };
    try {
      await assert.rejects(() => ensure(dir, ns), (error) => error === collision && error.code === "EEXIST");
      assert.equal(await fsp.readFile(foreign, "utf-8"), "foreign temporary");
      assert.deepEqual(await fsp.readdir(dir), [path.basename(foreign)]);
    } finally { fsp.open = realOpen; }
  });
});

for (const replacement of ["new inode with identical bytes", "foreign same-inode bytes"]) {
  test(`NS marker publication: failed-link cleanup preserves ${replacement}`, async () => {
    await withNamespaceMarker(async ({ ns, dir, ensure }) => {
      const realLink = fsp.link;
      const failure = Object.assign(new Error("publication failed"), { code: "EIO" });
      let temporary;
      let replacementBytes;
      let replacementIdentity;
      fsp.link = async (source) => {
        temporary = source;
        replacementBytes = replacement.startsWith("new inode") ? await fsp.readFile(source) : Buffer.from("foreign bytes");
        if (replacement.startsWith("new inode")) await fsp.unlink(source);
        await fsp.writeFile(source, replacementBytes);
        replacementIdentity = await fsp.stat(source, { bigint: true });
        throw failure;
      };
      try {
        await assert.rejects(() => ensure(dir, ns), (error) => error === failure);
        assert.deepEqual(await fsp.readFile(temporary), replacementBytes);
        const current = await fsp.stat(temporary, { bigint: true });
        assert.deepEqual({ dev: current.dev, ino: current.ino },
          { dev: replacementIdentity.dev, ino: replacementIdentity.ino });
        assert.deepEqual(await fsp.readdir(dir), [path.basename(temporary)]);
      } finally { fsp.link = realLink; }
    });
  });
}

for (const [name, marker] of [
  ["malformed", "{"], ["foreign", JSON.stringify({ raw: "project:concurrent-owner" }) + "\n"],
]) {
  test(`NS marker publication: a ${name} concurrent winner is refused and preserved`, async () => {
    await withNamespaceMarker(async ({ ns, dir, final, ensure }) => {
      const realLink = fsp.link;
      const OwnershipError = await getNamespaceOwnershipError();
      fsp.link = async (source, target) => {
        await fsp.writeFile(final, marker, { flag: "wx" });
        return realLink(source, target);
      };
      try {
        await assert.rejects(() => ensure(dir, ns), (error) => name === "foreign"
          ? error instanceof OwnershipError
          : error.constructor === Error && error.message.startsWith(`corrupt namespace sidecar in ${dir}:`));
        assert.equal(await fsp.readFile(final, "utf-8"), marker);
        assert.deepEqual(await fsp.readdir(dir), ["namespace.json"]);
      } finally { fsp.link = realLink; }
    });
  });
}

for (const cleanup of ["read", "unlink", "close"]) {
  test(`NS marker publication: ${cleanup} cleanup failure preserves the original write error`, async () => {
    await withNamespaceMarker(async ({ ns, dir, ensure }) => {
      const originals = { open: fsp.open, readFile: fsp.readFile, unlink: fsp.unlink };
      const failure = Object.assign(new Error("primary write failure", { cause: "retained cause" }), { code: "ENOSPC" });
      const secondary = Object.assign(new Error("secondary cleanup failure"), { code: "EACCES" });
      const originalJson = JSON.stringify(failure);
      let writeFailed = false;
      let closed = false;
      fsp.open = async (...args) => {
        const handle = await originals.open(...args);
        const close = handle.close.bind(handle);
        handle.writeFile = async () => { writeFailed = true; throw failure; };
        handle.close = async () => {
          await close(); closed = true;
          if (cleanup === "close") throw secondary;
        };
        return handle;
      };
      for (const [method, kind] of [["readFile", "read"], ["unlink", "unlink"]]) {
        fsp[method] = async (file, ...args) => {
          if (writeFailed && cleanup === kind && path.dirname(String(file)) === dir) throw secondary;
          return originals[method](file, ...args);
        };
      }
      try {
        await assert.rejects(() => ensure(dir, ns), (error) => error === failure);
        assert.equal(closed, true);
        assert.equal(failure.namespaceCleanupError, secondary);
        assert.equal(failure.cause, "retained cause");
        assert.equal(JSON.stringify(failure), originalJson);
      } finally { Object.assign(fsp, originals); }
    });
  });
}

test("NS marker publication: a frozen primary error survives a secondary cleanup failure", async () => {
  await withNamespaceMarker(async ({ ns, dir, ensure }) => {
    const originals = { link: fsp.link, unlink: fsp.unlink };
    const failure = Object.freeze(Object.assign(new Error("primary link failure"), { code: "EIO" }));
    fsp.link = async () => { throw failure; };
    fsp.unlink = async () => { throw Object.assign(new Error("cleanup failed"), { code: "EACCES" }); };
    try { await assert.rejects(() => ensure(dir, ns), (error) => error === failure); }
    finally { Object.assign(fsp, originals); }
  });
});

test("NS marker publication: successful publication still reports its cleanup failure", async () => {
  await withNamespaceMarker(async ({ ns, dir, final, ensure }) => {
    const realUnlink = fsp.unlink;
    const failure = Object.assign(new Error("cleanup failed"), { code: "EACCES" });
    fsp.unlink = async () => { throw failure; };
    try {
      await assert.rejects(() => ensure(dir, ns), (error) => error === failure);
      assert.equal(await fsp.readFile(final, "utf-8"), JSON.stringify({ raw: ns.raw }, null, 2) + "\n");
    } finally { fsp.unlink = realUnlink; }
  });
});
