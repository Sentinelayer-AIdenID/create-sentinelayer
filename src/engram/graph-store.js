/**
 * ENGRAM §EW03 — Site-scoped immutable source snapshots + atomically published
 * graph generations.
 *
 * Extends the §2 namespace store with:
 *   - Immutable content-addressed source snapshots per site (EW02 sourceSnapshotSchema)
 *   - Graph projection from observations (EW02 graphSchema + validateGraphIntegrity)
 *   - Atomic graph publish (readers always see one complete version)
 *   - Versioned rollback (republish any prior version)
 *   - Site-scoped read isolation via namespace.js authorize() — fail-closed
 *   - Integrity verification on every read (sha256 mismatch = refused)
 *   - Tombstone support + restart cleanup of stale *.tmp files
 *
 * No database, no network, no new dependencies. Node builtins + existing zod
 * contracts only.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { authorize, AccessDeniedError } from "./namespace.js";
import { sourceSnapshotSchema } from "./contracts/source-snapshot.js";
import { graphSchema, validateGraphIntegrity } from "./contracts/graph.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Version validation — prevents path traversal through version numbers
// ---------------------------------------------------------------------------

function validateVersion(v, label) {
  if (!Number.isSafeInteger(v) || v < 1) {
    if (Number.isFinite(v) && v > 0 && Number.isInteger(v) && !Number.isSafeInteger(v)) {
      throw Object.assign(new Error(`${label}: version must be a safe integer, got ${String(v)}`), { name: "TypeError" });
    }
    throw Object.assign(new Error(`${label}: version must be a positive safe integer, got ${String(v)}`), { name: "TypeError" });
  }
}

// ---------------------------------------------------------------------------
// Namespace directory — collision-resistant via sha256, not sanitization
// ---------------------------------------------------------------------------

function graphNamespaceDir(root, namespace) {
  const h = sha256(Buffer.from(namespace.raw, "utf-8"));
  return path.join(root, ".sentinelayer", "engram-graph", h);
}

async function ensureNamespaceDir(root, namespace) {
  const dir = graphNamespaceDir(root, namespace);
  const nsFile = path.join(dir, "namespace.json");

  try {
    await fsp.mkdir(dir, { recursive: true });
    // Try to create namespace.json with wx (exclusive write-once)
    const fd = await fsp.open(nsFile, "wx");
    try {
      await fd.writeFile(JSON.stringify({ raw: namespace.raw }) + "\n", "utf-8");
    } finally {
      await fd.close();
    }
  } catch (err) {
    if (err && err.code === "EEXIST") {
      // File already exists — verify it matches
      const stored = await readJSON(nsFile);
      if (!stored || stored.raw !== namespace.raw) {
        throw new AccessDeniedError(
          `Namespace directory collision: expected raw "${namespace.raw}" but found "${stored?.raw || "corrupt"}"`,
        );
      }
      return dir;
    }
    throw err;
  }

  return dir;
}

async function readJSON(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, "utf-8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readRaw(file) {
  try {
    return await fsp.readFile(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Graph record: store + verify integrity
// ---------------------------------------------------------------------------

async function readGraphRecord(file) {
  // Read raw bytes and parse JSON
  const raw = await readRaw(file);
  if (raw === null) return null;
  let record;
  try {
    record = JSON.parse(raw.toString("utf-8"));
  } catch {
    return null;
  }
  // Recompute hash from content fields only (excludes contentHash itself)
  if (!record.contentHash) return null;
  const content = { graph: record.graph, version: record.version, publishedAt: record.publishedAt };
  const computedHash = sha256(Buffer.from(JSON.stringify(content, null, 2) + "\n", "utf-8"));
  if (record.contentHash !== computedHash) {
    return null; // tampered or corrupt — refuse to serve
  }
  return record;
}
function makeGraphRecord(graph, version, publishedAt) {
  const content = { graph, version, publishedAt };
  const contentHash = sha256(Buffer.from(JSON.stringify(content, null, 2) + "\n", "utf-8"));
  return { ...content, contentHash };
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

class GraphValidationError extends Error {
  constructor(message) { super(message); this.name = "GraphValidationError"; this.status = 422; }
}

class VersionNotFoundError extends Error {
  constructor(message) { super(message); this.name = "VersionNotFoundError"; this.status = 404; }
}

class IntegrityError extends Error {
  constructor(message) { super(message); this.name = "IntegrityError"; this.status = 500; }
}

export { AccessDeniedError, GraphValidationError, VersionNotFoundError, IntegrityError };

// ---------------------------------------------------------------------------
// Source snapshots (immutable, content-addressed, site-scoped)
// ---------------------------------------------------------------------------

const SOURCES_DIR = "sources";
const OBJECTS_DIR = "objects";
const TOMBSTONES_DIR = "tombstones";

async function writeSourceSnapshot(root, consent, caller, namespace, snapshot, bytes) {
  authorize(caller, namespace, "write", { consent });
  await ensureNamespaceDir(root, namespace);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new GraphValidationError("bytes must be a non-empty Buffer");
  }

  const parsed = sourceSnapshotSchema.parse(snapshot);

  // Tenant scope IS the namespace: refuse if tenantScope differs
  if (parsed.tenantScope !== namespace.raw) {
    throw new AccessDeniedError(
      `Source snapshot tenantScope "${parsed.tenantScope}" does not match namespace "${namespace.raw}"`,
    );
  }

  // Compute content hash from bytes (not caller-supplied)
  const computedHash = sha256(bytes);
  if (parsed.contentHash && parsed.contentHash !== computedHash) {
    throw new GraphValidationError(
      `Supplied contentHash "${parsed.contentHash}" does not match computed sha256 "${computedHash}"`,
    );
  }

  // P2-1: Store bytes using link-based atomic create.
  // Write to temp, then fsp.link(tmp, objects/<sha>).
  // On EEXIST, verify integrity; if corrupt, atomically replace.
  const objectsDir = path.join(graphNamespaceDir(root, namespace), OBJECTS_DIR);
  await fsp.mkdir(objectsDir, { recursive: true });
  const objFile = path.join(objectsDir, computedHash);
  const objTmp = `${objFile}.${process.pid}.${randomUUID()}.objtmp`;

  let reused = false;
  await fsp.writeFile(objTmp, bytes);

  try {
    await fsp.link(objTmp, objFile);
    // Success — clean up temp
    await fsp.unlink(objTmp).catch(() => {});
  } catch (error) {
    await fsp.unlink(objTmp).catch(() => {});
    if (error && error.code === "EEXIST") {
      // Object already exists — verify integrity
      const existing = await readRaw(objFile);
      if (existing === null) {
        // Race: file vanished between EEXIST and read. Try again.
        await fsp.writeFile(objTmp, bytes);
        await fsp.rename(objTmp, objFile);
      } else {
        const existingHash = sha256(existing);
        if (existingHash !== computedHash) {
          // Corrupt object detected — atomically replace (rename temp over it)
          await fsp.writeFile(objTmp, bytes);
          await fsp.rename(objTmp, objFile);
          // Log the repair (NOT reported as reused)
        } else {
          reused = true;
        }
      }
    } else {
      throw error;
    }
  }

  // P2-4: Write snapshot metadata as ONE FILE PER RECORD (not NDJSON append)
  // Bound: snapshot metadata must be <= 64 KiB
  const sourcesDir = path.join(graphNamespaceDir(root, namespace), SOURCES_DIR);
  const snapshotRecord = { ...parsed, contentHash: computedHash };
  const snapMeta = JSON.stringify(snapshotRecord);
  if (Buffer.byteLength(snapMeta, "utf-8") > 65536) {
    throw new GraphValidationError(
      "Snapshot metadata exceeds 64 KiB limit (" + Buffer.byteLength(snapMeta, "utf-8") + " bytes)"
    );
  }
  const snapFile = path.join(sourcesDir, `${computedHash}-${randomUUID()}.json`);
  await fsp.mkdir(sourcesDir, { recursive: true });
  const snapTmp = `${snapFile}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.writeFile(snapTmp, snapMeta + "\n", "utf-8");
  await fsp.rename(snapTmp, snapFile);

  return { written: true, reused, contentHash: computedHash, snapshot: snapshotRecord };
}

async function listSourceSnapshots(root, consent, caller, namespace) {
  authorize(caller, namespace, "read", { consent });
  await ensureNamespaceDir(root, namespace);
  const dir = path.join(graphNamespaceDir(root, namespace), SOURCES_DIR);
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const raw = await fsp.readFile(path.join(dir, entry.name), "utf-8");
      try { items.push(JSON.parse(raw)); } catch { /* skip corrupt files */ }
    }
    return items;
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function tombstoneSource(root, consent, caller, namespace, sourceId, reason) {
  authorize(caller, namespace, "write", { consent });
  await ensureNamespaceDir(root, namespace);

  const reasonStr = String(reason || "removed");

  // P2-4: Bound — tombstone reason at most 4 KiB
  if (Buffer.byteLength(reasonStr, "utf-8") > 4096) {
    throw new GraphValidationError(
      "Tombstone reason exceeds 4 KiB limit (" + Buffer.byteLength(reasonStr, "utf-8") + " bytes)"
    );
  }

  const dir = path.join(graphNamespaceDir(root, namespace), TOMBSTONES_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const record = {
    sourceId,
    reason: reasonStr,
    tombstonedAt: new Date().toISOString(),
  };

  // P2-4: ONE FILE PER RECORD (not NDJSON append)
  const recordFile = path.join(dir, `${randomUUID()}.json`);
  const recTmp = `${recordFile}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.writeFile(recTmp, JSON.stringify(record) + "\n", "utf-8");
  await fsp.rename(recTmp, recordFile);

  return { tombstoned: true, sourceId, reason: reasonStr };
}

// ---------------------------------------------------------------------------
// Graph publishing (atomic, versioned, integrity-checked)
// ---------------------------------------------------------------------------

const GRAPHS_DIR = "graphs";
const INDEX_CACHE_FILE = "index.cache.json";

const LOCK_FILE = ".publish.lock";
const LOCK_STALE_MS = 30_000;
const LOCK_BACKOFF_MIN = 10;
const LOCK_BACKOFF_MAX = 50;
const LOCK_TIMEOUT_MS = 5_000;
const RENAME_MAX_RETRIES = 5;
const RELEASE_LOCK_DEADLINE_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientFsErr(err) {
  return err && (err.code === "EPERM" || err.code === "EBUSY");
}

async function withPublishLock(dir, fn) {
  const lockFile = path.join(dir, LOCK_FILE);
  let lastLockErr = null;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const token = randomUUID();

  // R9-2: back-off helper with jitter
  const jitterWait = () => sleep(
    Math.floor(Math.random() * (LOCK_BACKOFF_MAX - LOCK_BACKOFF_MIN)) + LOCK_BACKOFF_MIN
  );

  let attempt = 0;
  while (true) {
    attempt++;

    // Write lock content to a temp file, then atomically link to lockFile.
    // link(2) is atomic and fails with EEXIST if the target exists.
    // This eliminates the empty-lock window.

    // R9-2: check deadline at top of every iteration so NO path can skip it
    if (Date.now() >= deadline) {
      const lastErr = lastLockErr && lastLockErr.code ? " (last error: " + lastLockErr.code + ")" : "";
      throw new Error("Timed out acquiring publish lock for namespace" + lastErr);
    }

    const tmpFile = `${lockFile}.${process.pid}.${randomUUID()}.locktmp`;
    const lockContent = JSON.stringify({
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    await fsp.mkdir(path.dirname(lockFile), { recursive: true });
    await fsp.writeFile(tmpFile, lockContent, "utf-8");

    // R12-2: Acquire the lock in its own try/catch.
    // Run fn() OUTSIDE that catch, in try/finally (release in finally).
    // fn errors propagate unchanged, exactly once.
    let acquired = false;
    try {
      await fsp.link(tmpFile, lockFile);
      acquired = true;
    } catch (linkErr) {
      // Clean up the temp file
      await fsp.unlink(tmpFile).catch(() => {});
      if (linkErr && linkErr.code === "EEXIST") {
        // Lock is held — check if it is breakable (below)
        lastLockErr = linkErr;
      } else if (linkErr && (linkErr.code === "EPERM" || linkErr.code === "EBUSY")) {
        // R9-2: Transient contention — back off and retry
        lastLockErr = linkErr;
        await jitterWait();
      } else {
        throw linkErr;
      }
    }

    if (acquired) {
      // We hold the lock — clean up the temp file
      await fsp.unlink(tmpFile).catch(() => {});

      try {
        return await fn();
      } finally {
        // R13-1: one release routine for both paths — retry reads and unlinks
        // until RELEASE_LOCK_DEADLINE_MS; never swallow silently
        const releaseDeadline = Date.now() + RELEASE_LOCK_DEADLINE_MS;
        let ownLock = false;

        // Phase 1: read the lock with backoff for transient EPERM/EBUSY
        while (true) {
          try {
            const current = await readJSON(lockFile);
            if (current && current.token === token) {
              ownLock = true;
            }
            break;
          } catch (re) {
            if (isTransientFsErr(re) && Date.now() < releaseDeadline) {
              await jitterWait();
              continue;
            }
            // unrecoverable read error or deadline — we created this lock;
            // proceed to unlink as if it were ours
            ownLock = true;
            break;
          }
        }

        // Phase 2: unlink if ours; retry with backoff
        if (ownLock) {
          let released = false;
          while (Date.now() < releaseDeadline) {
            try {
              await fsp.unlink(lockFile);
              released = true;
              break;
            } catch (ue) {
              if (!isTransientFsErr(ue)) {
                // Non-transient unlink error — surface it
                if (typeof process.emitWarning === "function") {
                  process.emitWarning(
                    "Publish committed but lock unlink failed at " + lockFile + ": " + (ue && ue.message),
                    { type: "PublishLockReleaseWarning" }
                  );
                }
                break;
              }
              await jitterWait();
            }
          }
          if (!released) {
            // Lock still exists at deadline — emit warning
            try {
              const stillThere = await fsp.stat(lockFile).then(() => true, () => false);
              if (stillThere) {
                if (typeof process.emitWarning === "function") {
                  process.emitWarning(
                    "Publish committed but lock was not released at " + lockFile,
                    { type: "PublishLockReleaseWarning" }
                  );
                }
              }
            } catch { /* best-effort */ }
          }
        }
      }
      // If we got here without returning, the lock is released but we didn't return fn()'s value
      // This should not happen — fn() either returns or throws.
      // But if it somehow resolves to undefined after finally, re-throw.
    }

    // Lock held by another process (or transient EPERM/EBUSY) — check if we can break it
    let raw;
    try {
      raw = await fsp.readFile(lockFile, "utf-8");
    } catch (err2) {
      if (err2 && err2.code === "ENOENT") {
        // Owner released the lock — retry immediately (once is fine)
        lastLockErr = err2;
        continue;
      } else if (err2 && (err2.code === "EPERM" || err2.code === "EBUSY")) {
        // R10-1: Windows deletion-pending — back off with jitter and retry
        lastLockErr = err2;
        await jitterWait();
        continue;
      }
      throw err2;
    }

    let lockInfo;
    try {
      lockInfo = JSON.parse(raw);
    } catch {
      lockInfo = null;
    }

    if (lockInfo === null || typeof lockInfo !== "object") {
      // Corrupt or unparsable lock — NEVER break it
      throw new Error(
        "Publish lock is corrupt or unparsable at " + lockFile + ". " +
        "Manual intervention may be required."
      );
    }

    if (typeof lockInfo.pid !== "number" || typeof lockInfo.createdAt !== "string") {
      // Malformed lock — NEVER break it
      throw new Error(
        "Publish lock is malformed (missing pid or createdAt) at " + lockFile + ". " +
        "Manual intervention may be required."
      );
    }

    const age = Date.now() - new Date(lockInfo.createdAt).getTime();
    const ownerDead = !isAlive(lockInfo.pid);

    if (ownerDead && age > LOCK_STALE_MS) {
      // Dead owner + stale — safe to break
      await fsp.unlink(lockFile).catch(() => {});
      continue;
    }

    // R9-2: Back off before retrying — deadline already checked at loop top
    await jitterWait();
  }
}
// ---------------------------------------------------------------------------
// Derive the version index from committed vN.json files on disk.
// The index is BUILT from verified files — it is never a separately
// overwritten list. index.cache.json is a write-through cache for speed.
// ---------------------------------------------------------------------------

async function buildIndexFromDisk(graphsDir) {
  const versions = [];
  let entries;
  try {
    entries = await fsp.readdir(graphsDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return { lastVersion: 0, versions: [] };
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const m = entry.name.match(/^v(\d+)\.json$/);
    if (!m) continue;
    const v = Number(m[1]);
    if (!Number.isSafeInteger(v) || v < 1) continue;

    const filePath = path.join(graphsDir, entry.name);
    const record = await readGraphRecord(filePath);
    if (record === null) continue; // tampered, corrupt, or unreadable

    versions.push({
      version: record.version,
      publishedAt: record.publishedAt,
      contentHash: record.contentHash,
    });
  }

  versions.sort((a, b) => a.version - b.version);
  const lastVersion = versions.length > 0 ? versions[versions.length - 1].version : 0;

  // Write cache for speed
  const cache = { lastVersion, versions };
  try {
    await fsp.mkdir(graphsDir, { recursive: true });
    const cacheFile = path.join(graphsDir, INDEX_CACHE_FILE);
    const cacheTmp = `${cacheFile}.${process.pid}.${randomUUID()}.tmp`;
    await fsp.writeFile(cacheTmp, JSON.stringify(cache, null, 2) + "\n", "utf-8");
    await fsp.rename(cacheTmp, cacheFile);
  } catch { /* best-effort: cache write failure is non-fatal */ }

  return cache;
}

async function maxVersionOnDisk(dir) {
  let max = 0;
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const m = entry.name.match(/^v(\d+)\.json$/);
      if (m) {
        const v = Number(m[1]);
        // R12-1: Count ALL vN.json files by NAME, valid or not.
        // A corrupt file stays where it is, never listed or served,
        // and its number is skipped forever.
        if (Number.isSafeInteger(v) && v > max) max = v;
      }
    }
  } catch (err) {
    if (err && err.code === "ENOENT") return 0;
    throw err;
  }
  return max;
}


async function readGraphIndex(dir) {
  // Try the write-through cache first
  const cached = await readJSON(path.join(dir, INDEX_CACHE_FILE));
  if (cached !== null && Number.isInteger(cached.lastVersion) && Array.isArray(cached.versions)) {
    // Verify cache: scan disk for any file that would change the index
    const onDisk = await buildIndexFromDisk(dir);
    if (JSON.stringify(onDisk) === JSON.stringify(cached)) {
      return cached;
    }
    return onDisk;
  }
  return buildIndexFromDisk(dir);
}

async function publishGraph(root, consent, caller, namespace, graph) {
  authorize(caller, namespace, "write", { consent });
  await ensureNamespaceDir(root, namespace);

  // Validate through the EW02 contract
  const schemaResult = graphSchema.safeParse(graph);
  if (!schemaResult.success) {
    const messages = schemaResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new GraphValidationError(`Graph schema invalid: ${messages.join("; ")}`);
  }

  const integrity = validateGraphIntegrity(schemaResult.data);
  if (!integrity.valid) {
    throw new GraphValidationError(`Graph integrity failed: ${integrity.errors.join("; ")}`);
  }

  const dir = path.join(graphNamespaceDir(root, namespace), GRAPHS_DIR);
  await fsp.mkdir(dir, { recursive: true });

  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  // Acquire lock as a fairness hint only — correctness does not depend on it
  return withPublishLock(dir, async () => {
    const publishedAt = new Date().toISOString();

    // Retry loop: commit by EXCLUSIVE CREATE via fsp.link
    // EEXIST means another publisher took N — recompute and retry
    while (true) {
      // Recompute N from disk each attempt (new versions may have landed)
      const index = await readGraphIndex(dir);
      const diskMax = await maxVersionOnDisk(dir);
      const nextVersion = Math.max(index.lastVersion, diskMax) + 1;

      const record = makeGraphRecord(graph, nextVersion, publishedAt);
      const versionFile = path.join(dir, `v${nextVersion}.json`);

      // Write to a unique temp file, then link atomically
      const verTmp = `${versionFile}.${process.pid}.${randomUUID()}.vertmp`;
      const raw = JSON.stringify(record, null, 2) + "\n";
      await fsp.writeFile(verTmp, raw, "utf-8");

      try {
        await fsp.link(verTmp, versionFile);
        // Success — clean up temp and exit retry loop
        await fsp.unlink(verTmp).catch(() => {});
        return record;
      } catch (linkErr) {
        await fsp.unlink(verTmp).catch(() => {});
        if (linkErr && linkErr.code === "EEXIST") {
          // R12-1: NEVER overwrite or reuse a version file.
          // EEXIST always means recompute and retry.
          // Corrupt files stay where they are, their number skipped forever.
          if (Date.now() >= deadline) {
            throw new Error("Timed out committing graph version due to contention");
          }
          continue;
        }
        throw linkErr;
      }
    }
  });
}

async function readCurrentGraph(root, consent, caller, namespace) {
  authorize(caller, namespace, "read", { consent });
  await ensureNamespaceDir(root, namespace);

  const dir = path.join(graphNamespaceDir(root, namespace), GRAPHS_DIR);

  // current = highest verified committed version (derived from disk)
  const index = await readGraphIndex(dir);

  if (index.versions.length === 0) {
    return { graph: null, version: 0, reason: "no graph published" };
  }

  const latest = index.versions[index.versions.length - 1];

  const versionFile = path.join(dir, `v${latest.version}.json`);
  const record = await readGraphRecord(versionFile);

  if (record === null) {
    return { graph: null, version: 0, reason: `version ${latest.version} file missing, tampered, or unreadable` };
  }

  return { graph: record.graph, version: record.version, publishedAt: record.publishedAt, contentHash: record.contentHash };
}

async function readGraphVersion(root, consent, caller, namespace, version) {
  authorize(caller, namespace, "read", { consent });
  await ensureNamespaceDir(root, namespace);

  validateVersion(version, "version");
  const graphsDir = path.join(graphNamespaceDir(root, namespace), GRAPHS_DIR);
  const versionFile = path.join(graphsDir, `v${version}.json`);
  // Containment assertion — prevent path traversal
  if (path.dirname(path.resolve(versionFile)) !== path.resolve(graphsDir)) {
    throw Object.assign(new Error(`version traverses outside graphs directory`), { name: "TypeError" });
  }

  const record = await readGraphRecord(versionFile);

  if (record === null) {
    return { graph: null, version, reason: "version not found" };
  }

  // P2-2: Verify the version is in the index (index is derived from verified files)
  const index = await readGraphIndex(graphsDir);
  const idxEntry = index.versions.find((v) => v.version === version);
  if (!idxEntry) {
    return { graph: null, version, reason: `version ${version} not found in index` };
  }

  return { graph: record.graph, version: record.version, publishedAt: record.publishedAt, contentHash: record.contentHash };
}

async function rollbackGraph(root, consent, caller, namespace, targetVersion) {
  authorize(caller, namespace, "write", { consent });
  await ensureNamespaceDir(root, namespace);

  validateVersion(targetVersion, "targetVersion");
  const graphsDir = path.join(graphNamespaceDir(root, namespace), GRAPHS_DIR);
  const versionFile = path.join(graphsDir, `v${targetVersion}.json`);
  // Containment assertion — prevent path traversal
  if (path.dirname(path.resolve(versionFile)) !== path.resolve(graphsDir)) {
    throw Object.assign(new Error(`version traverses outside graphs directory`), { name: "TypeError" });
  }
  const record = await readGraphRecord(versionFile);

  if (record === null) {
    throw new VersionNotFoundError(`Version ${targetVersion} not found`);
  }

  const index = await readGraphIndex(graphsDir);
  if (!index.versions.some((v) => v.version === targetVersion)) {
    throw new VersionNotFoundError(`Version ${targetVersion} not in index`);
  }

  // Rollback creates a NEW version with the rolled-back graph.
  // History is append-only; the new version records rolledBackFrom.
  const rolledGraph = JSON.parse(JSON.stringify(record.graph));
  const publishedAt = new Date().toISOString();

  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  return withPublishLock(graphsDir, async () => {
    while (true) {
      const currentIndex = await readGraphIndex(graphsDir);
      const diskMax = await maxVersionOnDisk(graphsDir);
      const nextVersion = Math.max(currentIndex.lastVersion, diskMax) + 1;

      const newRecord = {
        graph: rolledGraph,
        version: nextVersion,
        publishedAt,
        rolledBackFrom: targetVersion,
        contentHash: undefined,
      };
      newRecord.contentHash = sha256(Buffer.from(
        JSON.stringify({ graph: newRecord.graph, version: newRecord.version, publishedAt: newRecord.publishedAt }, null, 2) + "\n",
        "utf-8"
      ));

      const newVersionFile = path.join(graphsDir, `v${nextVersion}.json`);
      const verTmp = `${newVersionFile}.${process.pid}.${randomUUID()}.vertmp`;
      const raw = JSON.stringify(newRecord, null, 2) + "\n";
      await fsp.writeFile(verTmp, raw, "utf-8");

      try {
        await fsp.link(verTmp, newVersionFile);
        await fsp.unlink(verTmp).catch(() => {});
        return { rolledBack: true, version: nextVersion, rolledBackFrom: targetVersion, previousVersion: currentIndex.lastVersion };
      } catch (linkErr) {
        await fsp.unlink(verTmp).catch(() => {});
        if (linkErr && linkErr.code === "EEXIST") {
          // R12-1: NEVER overwrite or reuse a version file.
          // EEXIST always means recompute and retry.
          if (Date.now() >= deadline) {
            throw new Error("Timed out committing rollback version due to contention");
          }
          continue;
        }
        throw linkErr;
      }
    }
  });
}

async function listGraphVersions(root, consent, caller, namespace) {
  authorize(caller, namespace, "read", { consent });
  await ensureNamespaceDir(root, namespace);

  const dir = path.join(graphNamespaceDir(root, namespace), GRAPHS_DIR);
  const index = await readGraphIndex(dir);

  return index.versions;
}

// ---------------------------------------------------------------------------
// Restart cleanup: remove leftover *.tmp files
// ---------------------------------------------------------------------------

async function cleanupTmpFiles(root, consent, caller, namespace) {
  // P2-3: Require authorization
  authorize(caller, namespace, "write", { consent });
  await ensureNamespaceDir(root, namespace);

  const dir = graphNamespaceDir(root, namespace);
  const graphDir = path.join(dir, GRAPHS_DIR);

  const TMP_CLEANUP_AGE_MS = 10 * 60 * 1000; // 10 minutes
  const tmpPattern = /\.\d+\.[0-9a-f-]+\.tmp$/;
  const cleaned = [];

  // P2-3: Run under the publish lock
  return withPublishLock(graphDir, async () => {
    for (const subdir of [dir, graphDir]) {
      try {
        const entries = await fsp.readdir(subdir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && tmpPattern.test(entry.name)) {
            const fullPath = path.join(subdir, entry.name);
            try {
              const stat = await fsp.stat(fullPath);
              // P2-3: Delete only *.tmp older than 10 minutes
              if (Date.now() - stat.mtimeMs >= TMP_CLEANUP_AGE_MS) {
                await fsp.unlink(fullPath);
                cleaned.push(fullPath);
              }
            } catch (err) {
              if (err && err.code === "ENOENT") continue;
              throw err;
            }
          }
        }
      } catch (error) {
        if (error && error.code === "ENOENT") continue;
        throw error;
      }
    }
    return { cleaned };
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGraphStore({ storeRoot, consent } = {}) {
  const root = path.resolve(String(storeRoot || "."));

  return {
    writeSourceSnapshot: (caller, namespace, snapshot, bytes) =>
      writeSourceSnapshot(root, consent, caller, namespace, snapshot, bytes),
    listSourceSnapshots: (caller, namespace) =>
      listSourceSnapshots(root, consent, caller, namespace),
    tombstoneSource: (caller, namespace, sourceId, reason) =>
      tombstoneSource(root, consent, caller, namespace, sourceId, reason),

    publishGraph: (caller, namespace, graph) =>
      publishGraph(root, consent, caller, namespace, graph),
    readCurrentGraph: (caller, namespace) =>
      readCurrentGraph(root, consent, caller, namespace),
    readGraphVersion: (caller, namespace, version) =>
      readGraphVersion(root, consent, caller, namespace, version),
    listGraphVersions: (caller, namespace) =>
      listGraphVersions(root, consent, caller, namespace),

    rollbackGraph: (caller, namespace, targetVersion) =>
      rollbackGraph(root, consent, caller, namespace, targetVersion),

    cleanupTmpFiles: (caller, namespace) =>
      cleanupTmpFiles(root, consent, caller, namespace),

    _root: root,
    _graphNamespaceDir: (namespace) => graphNamespaceDir(root, namespace),
  };
}
