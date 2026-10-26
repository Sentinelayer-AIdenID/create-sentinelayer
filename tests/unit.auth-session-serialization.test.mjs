import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  clearStoredSession, readStoredSession, readStoredSessionMetadata,
  resolveCredentialsFilePath, setKeytarClientForTests, writeStoredSession,
} from "../src/auth/session-store.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t) {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-auth-serialization-"));
  t.after(() => fsp.rm(homeDir, { recursive: true, force: true }));
  return { homeDir, filePath: resolveCredentialsFilePath({ homeDir }) };
}

// Preserve real metadata bytes/errors while making reads settle in the same
// microtask checkpoint. A nextTurn boundary can then observe an operation that
// overtook a deliberately paused writer without timing-dependent sleeps.
function immediateMetadataReads(t, filePath) {
  const original = fsp.readFile;
  t.mock.method(fsp, "readFile", async (file, ...args) =>
    String(file) === filePath ? readFileSync(file, ...args) : original(file, ...args));
}

test("auth store serializes keyring and encrypted metadata as one operation", async (t) => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  immediateMetadataReads(t, f.filePath);
  const passwords = new Map(); let active = 0, peak = 0;
  const restore = setKeytarClientForTests({
    getPassword: async (service, account) => passwords.get(`${service}:${account}`),
    deletePassword: async (service, account) => passwords.delete(`${service}:${account}`),
    setPassword: async (service, account, value) => {
      active++; peak = Math.max(peak, active);
      if (value === "synthetic_first") { entered.resolve(); await release.promise; }
      passwords.set(`${service}:${account}`, value); active--;
    },
  });
  t.after(restore);
  const first = writeStoredSession({ apiUrl: "https://synthetic.invalid", token: "synthetic_first", tokenId: "first" }, f);
  await entered.promise;
  const second = writeStoredSession({ apiUrl: "https://synthetic.invalid", token: "synthetic_second", tokenId: "second" }, f);
  try { await nextTurn(); } finally { release.resolve(); }
  await Promise.all([first, second]);
  assert.equal(peak, 1, "a second keyring mutation must not overtake unfinished publication");
  const stored = await readStoredSession(f);
  assert.equal(stored.token, "synthetic_second"); assert.equal(stored.tokenId, "second");
  const raw = await fsp.readFile(f.filePath, "utf8");
  assert.equal(raw.includes("synthetic_first") || raw.includes("synthetic_second"), false);
  assert.equal(JSON.parse(raw).token, null);
  const restoreUnavailable = setKeytarClientForTests(null);
  try { assert.equal((await readStoredSession(f)).token, "synthetic_second", "encrypted fallback must match the keyring publication"); }
  finally { restoreUnavailable(); }
});

for (const [label, read] of [["token read", readStoredSession], ["metadata read", readStoredSessionMetadata]]) {
  test(`auth store ${label} migration cannot recreate credentials after a queued logout`, async (t) => {
    const f = await fixture(t), entered = deferred(), release = deferred();
    await fsp.mkdir(path.dirname(f.filePath), { recursive: true });
    await fsp.writeFile(f.filePath, JSON.stringify({ apiUrl: "https://synthetic.invalid", storage: "file", token: "synthetic_legacy" }));
    immediateMetadataReads(t, f.filePath);
    const originalRm = fsp.rm;
    t.mock.method(fsp, "rm", async (file, ...args) => {
      if (String(file) !== f.filePath) return originalRm(file, ...args);
      try { unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    });
    const passwords = new Map();
    const restore = setKeytarClientForTests({
      getPassword: async (service, account) => passwords.get(`${service}:${account}`),
      deletePassword: async (service, account) => passwords.delete(`${service}:${account}`),
      setPassword: async (service, account, value) => { entered.resolve(); await release.promise; passwords.set(`${service}:${account}`, value); },
    });
    t.after(restore);
    const migration = read(f); await entered.promise;
    let cleared = false;
    const clearing = clearStoredSession(f).then((result) => { cleared = true; return result; });
    let overtook;
    try { await nextTurn(); overtook = cleared; } finally { release.resolve(); }
    await Promise.all([migration, clearing]);
    assert.equal(overtook, false, "logout must wait for an earlier migrating read");
    assert.equal(await readStoredSession(f), null);
    await assert.rejects(fsp.readFile(f.filePath), { code: "ENOENT" });
    assert.equal(passwords.size, 0);
  });
}

test("auth store reads do not observe the temporary absence during backup replacement", async (t) => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const restore = setKeytarClientForTests(null); t.after(restore);
  await writeStoredSession({ apiUrl: "https://synthetic.invalid", token: "synthetic_before" }, f);
  immediateMetadataReads(t, f.filePath);
  const originalRename = fsp.rename; let refusals = 0;
  t.mock.method(fsp, "rename", async (source, destination) => {
    if (String(source).endsWith(".tmp") && String(destination) === f.filePath && refusals++ < 3) {
      throw Object.assign(new Error("Synthetic Windows sharing contention"), { code: "EPERM" });
    }
    await originalRename(source, destination);
    if (String(source) === f.filePath && String(destination).endsWith(".bak")) { entered.resolve(); await release.promise; }
  });
  const writing = writeStoredSession({ apiUrl: "https://synthetic.invalid", token: "synthetic_after" }, f);
  await entered.promise;
  let readSettled = false;
  const reading = readStoredSession(f).then((value) => { readSettled = true; return value; });
  let observedGap;
  try { await nextTurn(); observedGap = readSettled; } finally { release.resolve(); }
  const [, stored] = await Promise.all([writing, reading]);
  assert.equal(observedGap, false, "a reader must not report signed-out inside another publication");
  assert.equal(stored.token, "synthetic_after");
  assert.deepEqual((await fsp.readdir(path.dirname(f.filePath))).sort(), ["credentials.json", "keys"]);
});

test("auth store publication failure preserves its error and does not poison queued operations", async (t) => {
  const f = await fixture(t); const restore = setKeytarClientForTests(null); t.after(restore);
  await writeStoredSession({ apiUrl: "https://synthetic.invalid", token: "synthetic_seed" }, f);
  const keyPath = path.join(f.homeDir, ".sentinelayer/keys/credentials.key"), beforeKey = await fsp.readFile(keyPath);
  const originalRename = fsp.rename; let failed = false;
  t.mock.method(fsp, "rename", async (source, destination) => {
    if (!failed && String(source).endsWith(".tmp") && String(destination) === f.filePath) {
      failed = true; throw Object.assign(new Error("Synthetic publication failure"), { code: "EIO" });
    }
    return originalRename(source, destination);
  });
  const results = await Promise.allSettled([
    writeStoredSession({ apiUrl: "https://synthetic.invalid", token: "synthetic_failed" }, f),
    writeStoredSession({ apiUrl: "https://synthetic.invalid", token: "synthetic_recovered" }, f),
  ]);
  assert.equal(results[0].status, "rejected"); assert.equal(results[0].reason.code, "EIO");
  assert.equal(results[1].status, "fulfilled"); assert.equal((await readStoredSession(f)).token, "synthetic_recovered");
  assert.deepEqual(await fsp.readFile(keyPath), beforeKey);
  assert.deepEqual((await fsp.readdir(path.dirname(f.filePath))).sort(), ["credentials.json", "keys"]);
});
