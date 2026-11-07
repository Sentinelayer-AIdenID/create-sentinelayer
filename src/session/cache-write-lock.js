import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const GUARD_NAME = ".refresh-recovery.lock";
const OWNER_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const sameFile = (left, right) => left?.dev === right?.dev && left?.ino === right?.ino;
const sameOwner = (left, right) => left && right && sameFile(left.stat, right.stat) && left.text === right.text;

async function localProcessScope() {
  const unknown = { bootId: null, pidNamespaceId: null };
  // A hostname is not a PID domain: shared caches may cross containers or OSes.
  // Node exposes no portable boot/namespace proof; never substitute uptime or a
  // hostname when these kernel identities are unavailable.
  if (os.platform() !== "linux") return unknown;
  try {
    const [bootText, namespace] = await Promise.all([
      fsp.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      fsp.stat("/proc/self/ns/pid", { bigint: true }),
    ]);
    const bootId = bootText.trim();
    if (!BOOT_ID.test(bootId) || typeof namespace.dev !== "bigint" || namespace.dev < 0n
      || typeof namespace.ino !== "bigint" || namespace.ino <= 0n) return unknown;
    return { bootId, pidNamespaceId: `linux:${namespace.dev}:${namespace.ino}` };
  } catch {
    return unknown;
  }
}

async function readOwner(filePath) {
  let handle;
  try {
    const before = await fsp.lstat(filePath);
    if (!before.isFile() || before.size > 4_096) return null;
    handle = await fsp.open(filePath, "r");
    const stat = await handle.stat();
    if (!sameFile(before, stat) || !stat.isFile() || stat.size > 4_096) return null;
    const text = await handle.readFile("utf8");
    let owner;
    try { owner = JSON.parse(text); } catch { return null; }
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) return null;
    return { owner, stat, text };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

function isDeadLocalOwner(record, scope) {
  const owner = record?.owner;
  if (!scope.bootId || !scope.pidNamespaceId || owner?.bootId !== scope.bootId
    || owner?.pidNamespaceId !== scope.pidNamespaceId || owner?.host !== os.hostname()
    || !Number.isSafeInteger(owner.pid)
    || owner.pid <= 0 || owner.pid > 2_147_483_647) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    // Permission denial, an invalid probe, and foreign hosts do not prove death.
    return error?.code === "ESRCH";
  }
}

async function retryRemoval(operation) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await operation(); } catch (error) {
      if (attempt >= 3 || !["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

async function removeEmptyDirectory(directory) {
  try {
    await fsp.rmdir(directory);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") return false;
    throw error;
  }
}

async function removeGuardClaim(directory, ownerName) {
  try { await retryRemoval(() => fsp.unlink(path.join(directory, ownerName))); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  // Never recursively remove or rename the shared directory. Another reaper may
  // already have removed it and a successor may now own it. Every successor is
  // published NONEMPTY with a different child name, so rmdir cannot remove it.
  return removeEmptyDirectory(directory);
}

async function reapDeadGuard(directory, scope) {
  let names;
  try {
    if (!(await fsp.lstat(directory)).isDirectory()) return false;
    names = await fsp.readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  // A crash between child unlink and rmdir leaves an empty, unowned directory.
  if (!names.length) return removeEmptyDirectory(directory);
  if (names.length !== 1 || !OWNER_NAME.test(names[0])) return false;
  const filePath = path.join(directory, names[0]);
  const observed = await readOwner(filePath);
  if (observed?.owner.token !== names[0].slice(0, -5) || !isDeadLocalOwner(observed, scope)) return false;
  if (!sameOwner(observed, await readOwner(filePath))) return false;
  return removeGuardClaim(directory, names[0]);
}

async function withRecoveryGuard(cacheDir, operation, scope) {
  const directory = path.join(cacheDir, GUARD_NAME);
  // Inspect first so an existing directory does not rely on platform-specific
  // rename-over-directory error codes to enter the recovery path.
  if (!(await reapDeadGuard(directory, scope))) return false;
  const token = randomUUID();
  const ownerName = `${token}.json`;
  const temporary = path.join(cacheDir, `.refresh-recovery.${token}.tmp`);
  let published = false;
  await fsp.mkdir(temporary, { mode: 0o700 });
  try {
    await fsp.writeFile(path.join(temporary, ownerName), JSON.stringify({
      token, pid: process.pid, host: os.hostname(), ...scope,
    }), { mode: 0o600, flag: "wx" });
    try {
      // Atomic publication of a fully populated directory is essential: mkdir
      // at the fixed path followed by writing a claim would leave an empty gap.
      await fsp.rename(temporary, directory);
      published = true;
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
      return false;
    }
    return await operation();
  } finally {
    await removeGuardClaim(published ? directory : temporary, ownerName);
  }
}

async function reclaimDeadLock(cacheDir, lockPath, scope) {
  const observed = await readOwner(lockPath);
  if (!isDeadLocalOwner(observed, scope)) return false;
  return withRecoveryGuard(cacheDir, async () => {
    // All main-file reapers hold this guard. Re-read after acquiring it: the old
    // owner may have exited normally and a wx contender may already own the file.
    const current = await readOwner(lockPath);
    if (!sameOwner(observed, current) || !isDeadLocalOwner(current, scope)) return false;
    if (!sameOwner(current, await readOwner(lockPath))) return false;
    await fsp.unlink(lockPath);
    return true;
  }, scope);
}

// Serialize metadata publication and pruning across CLI processes. Recovery is
// based only on a verified dead PID in the same proven boot/namespace, never age.
// Legacy records and platforms without that proof remain bounded cache failures.
// A normal writer that dies
// before its wx-created file has a complete owner record remains conservatively
// unavailable; partial, unreadable, foreign-host and live records are not stolen.
export async function withCacheWriteLock(context, operation, timeoutMs) {
  await fsp.mkdir(context.cacheDir, { recursive: true, mode: 0o700 });
  const scope = await localProcessScope();
  const lockPath = path.join(context.cacheDir, ".refresh.lock");
  const deadline = performance.now() + timeoutMs;
  let handle;
  for (;;) {
    try {
      handle = await fsp.open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      // Only an existing file denotes contention. Storage/permission failures
      // keep their own code and do not incur the contention timeout.
      if (error?.code !== "EEXIST") throw error;
      const reclaimed = await reclaimDeadLock(context.cacheDir, lockPath, scope);
      if (performance.now() >= deadline) {
        throw Object.assign(new Error("Metadata cache refresh lock is unavailable."), { code: "CACHE_LOCK_TIMEOUT" });
      }
      if (!reclaimed) await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - performance.now())));
    }
  }
  let identity;
  const text = JSON.stringify({ token: randomUUID(), pid: process.pid, host: os.hostname(), ...scope, createdAt: new Date().toISOString() });
  try {
    identity = await handle.stat();
    await handle.writeFile(text);
    return await operation();
  } finally {
    try {
      await retryRemoval(async () => {
        try {
          const current = await fsp.lstat(lockPath);
          // Keep our handle open through ownership verification and removal:
          // its inode cannot be reused for an empty successor after close.
          if (!current.isFile() || !sameFile(identity, current)) return;
          const content = await fsp.readFile(lockPath, "utf8");
          if (content !== text) return;
          await fsp.unlink(lockPath);
        } catch (error) { if (error?.code !== "ENOENT") throw error; }
      });
    } finally {
      await handle.close();
    }
  }
}
