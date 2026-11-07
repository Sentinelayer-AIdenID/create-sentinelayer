import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { unlinkSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withCacheWriteLock } from "../src/session/cache-write-lock.js";

const DEAD_PID = 2_147_483_646;
const owner = (pid = DEAD_PID) => ({ pid, host: os.hostname(), token: randomUUID() });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-cache-lock-"));
  const context = { cacheDir: path.join(root, "cache") };
  await fsp.mkdir(context.cacheDir, { mode: 0o700 });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return { context, lock: path.join(context.cacheDir, ".refresh.lock"), guard: path.join(context.cacheDir, ".refresh-recovery.lock") };
}

function mockDeadPid(t) {
  const originalKill = process.kill;
  t.mock.method(process, "kill", (pid, signal) => {
    if (pid === DEAD_PID) throw Object.assign(new Error("fixture dead owner"), { code: "ESRCH" });
    return originalKill(pid, signal);
  });
}

async function publishGuard(context, record) {
  const prepared = path.join(context.cacheDir, `.fixture-${record.token}.tmp`);
  await fsp.mkdir(prepared, { mode: 0o700 });
  await fsp.writeFile(path.join(prepared, `${record.token}.json`), JSON.stringify(record), { mode: 0o600, flag: "wx" });
  const guard = path.join(context.cacheDir, ".refresh-recovery.lock");
  await fsp.rename(prepared, guard);
  return path.join(guard, `${record.token}.json`);
}

test("a killed process's complete owner record is recovered without the contention timeout", { timeout: 10_000 }, async (t) => {
  const { context, lock } = await fixture(t);
  const moduleUrl = new URL("../src/session/cache-write-lock.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { withCacheWriteLock } from ${JSON.stringify(moduleUrl)};
    await withCacheWriteLock(${JSON.stringify(context)}, async () => {
      process.send("locked");
      await new Promise(() => setInterval(() => {}, 1000));
    }, 1500);
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  });
  const [message] = await once(child, "message");
  assert.equal(message, "locked");
  assert.equal(JSON.parse(await fsp.readFile(lock, "utf8")).pid, child.pid);
  child.kill("SIGKILL");
  await exited;
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  const started = performance.now();
  assert.equal(await withCacheWriteLock(context, async () => "recovered", 1_500), "recovered");
  assert.ok(performance.now() - started < 1_000, "a confirmed dead owner must not wait for the 1.5 s contention timeout");
  assert.deepEqual(await fsp.readdir(context.cacheDir), []);
});

test("a dead recovery guard is reclaimed and both private locks are released", async (t) => {
  const { context, lock, guard } = await fixture(t);
  mockDeadPid(t);
  await fsp.writeFile(lock, JSON.stringify(owner()), { mode: 0o600 });
  await publishGuard(context, owner());
  const originalUnlink = fsp.unlink;
  let inspected = false;
  t.mock.method(fsp, "unlink", async (filePath) => {
    if (filePath === lock && !inspected) {
      inspected = true;
      const names = await fsp.readdir(guard);
      assert.equal(names.length, 1);
      assert.equal(JSON.parse(await fsp.readFile(path.join(guard, names[0]), "utf8")).pid, process.pid);
      if (process.platform !== "win32") {
        assert.equal((await fsp.stat(guard)).mode & 0o777, 0o700);
        assert.equal((await fsp.stat(path.join(guard, names[0]))).mode & 0o777, 0o600);
      }
    }
    return originalUnlink(filePath);
  });
  assert.equal(await withCacheWriteLock(context, async () => "published", 500), "published");
  assert.equal(inspected, true);
  assert.deepEqual(await fsp.readdir(context.cacheDir), []);
});

test("two stale guard reapers cannot remove an atomically published live successor", { timeout: 5_000 }, async (t) => {
  const { context, lock, guard } = await fixture(t);
  mockDeadPid(t);
  const originalOwner = JSON.stringify(owner());
  await fsp.writeFile(lock, originalOwner);
  const oldClaim = await publishGuard(context, owner());
  const successor = owner(process.pid);
  const bothReapers = deferred();
  const successorPublished = deferred();
  t.after(() => { bothReapers.resolve(); successorPublished.resolve(); });
  const originalUnlink = fsp.unlink;
  const originalRmdir = fsp.rmdir;
  let reapers = 0;
  let replaced = false;
  t.mock.method(fsp, "unlink", async (filePath) => {
    if (filePath === oldClaim) {
      const position = ++reapers;
      if (position === 2) bothReapers.resolve();
      await bothReapers.promise;
      if (position === 2) await successorPublished.promise;
    }
    return originalUnlink(filePath);
  });
  t.mock.method(fsp, "rmdir", async (directory) => {
    if (directory === guard && !replaced) {
      replaced = true;
      await originalRmdir(directory);
      await publishGuard(context, successor);
      successorPublished.resolve();
      return;
    }
    return originalRmdir(directory);
  });
  let entered = 0;
  const results = await Promise.allSettled([1, 2].map(() =>
    withCacheWriteLock(context, async () => { entered += 1; }, 250)));
  assert.equal(reapers, 2, "both reapers must have reached the stale child's unlink");
  assert.equal(entered, 0);
  assert.ok(results.every((result) => result.status === "rejected"));
  // Windows may report a rename collision as a permission error; it must be
  // preserved, not converted into timeout or used to delete the live guard.
  assert.ok(results.every((result) => ["CACHE_LOCK_TIMEOUT", "EPERM", "EACCES"].includes(result.reason.code)));
  assert.deepEqual(await fsp.readdir(guard), [`${successor.token}.json`]);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(guard, `${successor.token}.json`), "utf8")), successor);
  assert.equal(await fsp.readFile(lock, "utf8"), originalOwner);
  assert.equal((await fsp.readdir(context.cacheDir)).some((name) => name.endsWith(".tmp")), false);
});

test("a reaper re-reads under the guard after an old owner exits and a successor acquires", async (t) => {
  const { context, lock } = await fixture(t);
  await fsp.writeFile(lock, JSON.stringify(owner()));
  const successor = JSON.stringify(owner(process.pid));
  const originalKill = process.kill;
  let replaced = false;
  t.mock.method(process, "kill", (pid, signal) => {
    if (pid === DEAD_PID) {
      if (!replaced) {
        replaced = true;
        unlinkSync(lock);
        writeFileSync(lock, successor, { flag: "wx", mode: 0o600 });
      }
      throw Object.assign(new Error("old process exited"), { code: "ESRCH" });
    }
    return originalKill(pid, signal);
  });
  await assert.rejects(withCacheWriteLock(context, async () => assert.fail("successor owns the lock"), 100), { code: "CACHE_LOCK_TIMEOUT" });
  assert.equal(replaced, true);
  assert.equal(await fsp.readFile(lock, "utf8"), successor);
  assert.deepEqual(await fsp.readdir(context.cacheDir), [".refresh.lock"]);
});

test("owner cleanup does not unlink a replacement file", async (t) => {
  const { context, lock } = await fixture(t);
  const successor = JSON.stringify(owner(process.pid));
  await withCacheWriteLock(context, async () => {
    await fsp.unlink(lock);
    await fsp.writeFile(lock, successor, { flag: "wx", mode: 0o600 });
  }, 100);
  assert.equal(await fsp.readFile(lock, "utf8"), successor);
});

for (const [name, record] of [
  ["live owner regardless of age", () => JSON.stringify({ ...owner(process.pid), createdAt: "1970-01-01T00:00:00Z" })],
  ["foreign host", () => JSON.stringify({ ...owner(), host: `${os.hostname()}-other` })],
  ["partial record", () => '{"pid":'],
  ["invalid PID", () => JSON.stringify({ ...owner(), pid: -1 })],
]) {
  test(`${name} remains a bounded cache failure`, async (t) => {
    const { context, lock } = await fixture(t);
    mockDeadPid(t);
    const text = record();
    await fsp.writeFile(lock, text);
    await assert.rejects(withCacheWriteLock(context, async () => assert.fail("unproven owner must not be reclaimed"), 75), { code: "CACHE_LOCK_TIMEOUT" });
    assert.equal(await fsp.readFile(lock, "utf8"), text);
  });
}

test("EPERM probing a PID does not establish death", async (t) => {
  const { context, lock } = await fixture(t);
  await fsp.writeFile(lock, JSON.stringify(owner()));
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("probe refused"), { code: "EPERM" }); });
  await assert.rejects(withCacheWriteLock(context, async () => assert.fail("unproven owner"), 75), { code: "CACHE_LOCK_TIMEOUT" });
  assert.equal(JSON.parse(await fsp.readFile(lock, "utf8")).pid, DEAD_PID);
});

test("an empty abandoned guard is removable but a malformed guard is preserved", async (t) => {
  const { context, lock, guard } = await fixture(t);
  mockDeadPid(t);
  await fsp.writeFile(lock, JSON.stringify(owner()));
  await fsp.mkdir(guard);
  assert.equal(await withCacheWriteLock(context, async () => "recovered", 200), "recovered");
  await fsp.writeFile(lock, JSON.stringify(owner()));
  await fsp.mkdir(guard);
  await fsp.writeFile(path.join(guard, "unknown"), "not an owner");
  await assert.rejects(withCacheWriteLock(context, async () => assert.fail("unknown guard owner"), 75), { code: "CACHE_LOCK_TIMEOUT" });
  assert.equal(await fsp.readFile(path.join(guard, "unknown"), "utf8"), "not an owner");
});

for (const code of ["EPERM", "EACCES", "EBUSY", "EROFS"]) {
  test(`${code} opening the file lock is reported promptly without a timeout label`, async (t) => {
    const { context, lock } = await fixture(t);
    const originalOpen = fsp.open;
    let attempts = 0;
    t.mock.method(fsp, "open", async (filePath, ...args) => {
      if (filePath === lock) {
        attempts += 1;
        throw Object.assign(new Error("storage refused"), { code });
      }
      return originalOpen(filePath, ...args);
    });
    const started = performance.now();
    await assert.rejects(withCacheWriteLock(context, async () => assert.fail("lock was not acquired"), 1_500), { code });
    assert.equal(attempts, 1);
    assert.ok(performance.now() - started < 500);
  });
}

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`${code} publishing the recovery guard preserves its code and removes its private preparation`, async (t) => {
    const { context, lock, guard } = await fixture(t);
    mockDeadPid(t);
    const original = JSON.stringify(owner());
    await fsp.writeFile(lock, original);
    const originalRename = fsp.rename;
    t.mock.method(fsp, "rename", async (source, destination) => {
      if (destination === guard) throw Object.assign(new Error("guard permission denied"), { code });
      return originalRename(source, destination);
    });
    const started = performance.now();
    await assert.rejects(withCacheWriteLock(context, async () => assert.fail("guard was not acquired"), 1_500), { code });
    assert.ok(performance.now() - started < 500);
    assert.equal(await fsp.readFile(lock, "utf8"), original);
    assert.deepEqual(await fsp.readdir(context.cacheDir), [".refresh.lock"]);
  });
}
