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
const INVALID_PID = -2_147_483_646; // Unlike -1, this nonexistent Linux process group returns ESRCH.
const SCOPE = { bootId: "4e69cc45-cfa3-4192-9d8a-45e049d75810", pidNamespaceId: "linux:5:4026531836" };
const owner = (pid = DEAD_PID) => ({ pid, host: os.hostname(), token: randomUUID(), ...SCOPE });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function mockProcessScope(t) {
  const readFile = fsp.readFile;
  const stat = fsp.stat;
  t.mock.method(os, "platform", () => "linux");
  t.mock.method(fsp, "readFile", (filePath, ...args) => filePath === "/proc/sys/kernel/random/boot_id"
    ? Promise.resolve(`${SCOPE.bootId}\n`) : readFile(filePath, ...args));
  t.mock.method(fsp, "stat", (filePath, ...args) => filePath === "/proc/self/ns/pid"
    ? Promise.resolve({ dev: 5n, ino: 4026531836n }) : stat(filePath, ...args));
}

async function fixture(t, { nativeIdentity = false } = {}) {
  if (!nativeIdentity) mockProcessScope(t);
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

async function publishGuard(context, record, nameToken = record.token) {
  const prepared = path.join(context.cacheDir, `.fixture-${record.token}.tmp`);
  await fsp.mkdir(prepared, { mode: 0o700 });
  await fsp.writeFile(path.join(prepared, `${nameToken}.json`), JSON.stringify(record), { mode: 0o600, flag: "wx" });
  const guard = path.join(context.cacheDir, ".refresh-recovery.lock");
  await fsp.rename(prepared, guard);
  return path.join(guard, `${nameToken}.json`);
}

test("a killed process is recovered only with proven native boot and PID namespace", { timeout: 10_000 }, async (t) => {
  const { context, lock } = await fixture(t, { nativeIdentity: true });
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
  const nativeOwner = JSON.parse(await fsp.readFile(lock, "utf8"));
  assert.equal(nativeOwner.pid, child.pid);
  if (process.platform === "linux") {
    // Supported CI must prove real kernel discovery and real recovery. A broken
    // identity reader must not make this silently take the unsupported branch.
    assert.match(nativeOwner.bootId, /^[0-9a-f-]{36}$/);
    const namespace = await fsp.stat("/proc/self/ns/pid", { bigint: true });
    assert.equal(nativeOwner.bootId, (await fsp.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim());
    assert.equal(nativeOwner.pidNamespaceId, `linux:${namespace.dev}:${namespace.ino}`);
  } else {
    assert.equal(nativeOwner.bootId, null);
    assert.equal(nativeOwner.pidNamespaceId, null);
  }
  child.kill("SIGKILL");
  await exited;
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  if (process.platform !== "linux") {
    await assert.rejects(withCacheWriteLock(context, async () => assert.fail("native identity is unproven"), 75), { code: "CACHE_LOCK_TIMEOUT" });
    assert.deepEqual(JSON.parse(await fsp.readFile(lock, "utf8")), nativeOwner);
    return;
  }
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
      const guardOwner = JSON.parse(await fsp.readFile(path.join(guard, names[0]), "utf8"));
      assert.equal(guardOwner.pid, process.pid);
      assert.equal(guardOwner.bootId, SCOPE.bootId);
      assert.equal(guardOwner.pidNamespaceId, SCOPE.pidNamespaceId);
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

test("owner cleanup checks identity while its original handle is still open", async (t) => {
  const { context, lock } = await fixture(t);
  const open = fsp.open;
  const lstat = fsp.lstat;
  let handle;
  let checks = 0;
  t.mock.method(fsp, "open", async (filePath, ...args) => {
    const result = await open(filePath, ...args);
    if (filePath === lock && args[0] === "wx") handle = result;
    return result;
  });
  t.mock.method(fsp, "lstat", (filePath, ...args) => {
    if (filePath === lock) {
      checks += 1;
      assert.ok(handle.fd >= 0, "closing first permits inode reuse before ownership is checked");
    }
    return lstat(filePath, ...args);
  });
  await withCacheWriteLock(context, async () => {
    const record = JSON.parse(await fsp.readFile(lock, "utf8"));
    assert.equal(record.bootId, SCOPE.bootId);
    assert.equal(record.pidNamespaceId, SCOPE.pidNamespaceId);
  }, 100);
  assert.equal(checks, 1);
  assert.equal(handle.fd, -1);
  assert.deepEqual(await fsp.readdir(context.cacheDir), []);
});

test("owner cleanup requires the full record even if the path still has the same inode", async (t) => {
  const { context, lock } = await fixture(t);
  await withCacheWriteLock(context, async () => { await fsp.truncate(lock, 0); }, 100);
  assert.equal(await fsp.readFile(lock, "utf8"), "", "an empty record is not evidence of our token");
});

test("a recovery guard with a different token in its valid UUID filename is not reaped", async (t) => {
  const { context, lock, guard } = await fixture(t);
  mockDeadPid(t);
  const record = owner();
  const nameToken = randomUUID();
  const claim = await publishGuard(context, record, nameToken);
  const text = JSON.stringify(owner());
  await fsp.writeFile(lock, text);
  let entered = 0;
  await assert.rejects(withCacheWriteLock(context, async () => { entered += 1; }, 75), { code: "CACHE_LOCK_TIMEOUT" });
  assert.equal(entered, 0);
  assert.deepEqual(await fsp.readdir(guard), [`${nameToken}.json`]);
  assert.deepEqual(JSON.parse(await fsp.readFile(claim, "utf8")), record);
  assert.equal(await fsp.readFile(lock, "utf8"), text);
});

for (const [name, fields] of [
  ["different boot", { bootId: "806fcc09-51fa-49e2-b0c2-3cbfc8e4a52a" }],
  ["different PID namespace", { pidNamespaceId: "linux:5:4026532999" }],
  ["missing legacy identity", { bootId: undefined, pidNamespaceId: undefined }],
  ["unproven identity", { bootId: null, pidNamespaceId: null }],
]) {
  test(`${name} is never probed or reclaimed despite the same hostname`, async (t) => {
    const { context, lock } = await fixture(t);
    const text = JSON.stringify({ ...owner(), ...fields });
    await fsp.writeFile(lock, text);
    let probes = 0;
    t.mock.method(process, "kill", () => { probes += 1; throw Object.assign(new Error("not visible here"), { code: "ESRCH" }); });
    await assert.rejects(withCacheWriteLock(context, async () => assert.fail("unproven PID domain"), 75), { code: "CACHE_LOCK_TIMEOUT" });
    assert.equal(probes, 0);
    assert.equal(await fsp.readFile(lock, "utf8"), text);
  });
}

for (const unavailable of ["boot read denied", "namespace read denied", "malformed boot", "unsupported platform"]) {
  test(`${unavailable} still permits ordinary locking but never stale-owner recovery`, async (t) => {
    const { context, lock } = await fixture(t);
    const readFile = fsp.readFile;
    const stat = fsp.stat;
    if (unavailable === "unsupported platform") t.mock.method(os, "platform", () => "win32");
    if (unavailable === "boot read denied" || unavailable === "malformed boot") {
      t.mock.method(fsp, "readFile", (filePath, ...args) => {
        if (filePath !== "/proc/sys/kernel/random/boot_id") return readFile(filePath, ...args);
        return unavailable === "malformed boot" ? Promise.resolve("not-a-boot-id")
          : Promise.reject(Object.assign(new Error("identity denied"), { code: "EACCES" }));
      });
    }
    if (unavailable === "namespace read denied") t.mock.method(fsp, "stat", (filePath, ...args) => filePath === "/proc/self/ns/pid"
      ? Promise.reject(Object.assign(new Error("identity denied"), { code: "EACCES" })) : stat(filePath, ...args));
    await withCacheWriteLock(context, async () => {
      const record = JSON.parse(await fsp.readFile(lock, "utf8"));
      assert.equal(record.bootId, null);
      assert.equal(record.pidNamespaceId, null);
    }, 100);
    assert.deepEqual(await fsp.readdir(context.cacheDir), []);
    const text = JSON.stringify(owner());
    await fsp.writeFile(lock, text);
    let probes = 0;
    t.mock.method(process, "kill", () => { probes += 1; throw Object.assign(new Error("not visible here"), { code: "ESRCH" }); });
    await assert.rejects(withCacheWriteLock(context, async () => assert.fail("local identity is unavailable"), 75), { code: "CACHE_LOCK_TIMEOUT" });
    assert.equal(probes, 0);
    assert.equal(await fsp.readFile(lock, "utf8"), text);
  });
}

test("an invalid negative process-group PID is rejected before probing on every platform", async (t) => {
  const { context, lock } = await fixture(t);
  const text = JSON.stringify(owner(INVALID_PID));
  await fsp.writeFile(lock, text);
  const kill = process.kill;
  let probes = 0;
  t.mock.method(process, "kill", (pid, signal) => { probes += 1; return kill(pid, signal); });
  await assert.rejects(withCacheWriteLock(context, async () => assert.fail("invalid owner PID"), 75), { code: "CACHE_LOCK_TIMEOUT" });
  assert.equal(probes, 0);
  assert.equal(await fsp.readFile(lock, "utf8"), text);
});

for (const [name, record] of [
  ["live owner regardless of age", () => JSON.stringify({ ...owner(process.pid), createdAt: "1970-01-01T00:00:00Z" })],
  ["foreign host", () => JSON.stringify({ ...owner(), host: `${os.hostname()}-other` })],
  ["partial record", () => '{"pid":'],
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
