/**
 * ENGRAM §2 — the ONE shared namespace store.
 *
 * This is the single substrate the 3 tools, the 8-Needle SLA, and the
 * token-cut measurement all read (relay ruling #5: no second store). A
 * namespace's observations are the UNION of:
 *   - a read-only SOURCE ADAPTER for its kind, if one is registered
 *     (e.g. kind `session` -> the SL session adapter that maps session
 *     events to observations). Adapters are INJECTED, so this module imports
 *     NO session runtime and stays detachable.
 *   - a generic append-log the tools write to (`memory.write`), one NDJSON
 *     file per namespace, with content-hash dedup (ENGRAM §3 — idempotent).
 *
 * Detachability: imports ONLY the §1 engine core (observations + text) and
 * node builtins. No SentinelLayer session/mcp/auth imports.
 *
 * --- On-disk layout (since 2a885ea8) ---
 *
 * Each namespace lives under `.sentinelayer/engram/ns-<sha256hex(raw)>/`.
 * The sha256-hex directory name makes every namespace's storage independent:
 * distinct namespaces never share a directory, even on case-insensitive
 * filesystems.  A `namespace.json` sidecar is written on first write and
 * verified on every subsequent access as defence-in-depth (the stored item
 * records carry no namespace field, so ownership of a legacy lossy directory
 * can never be proven from contents alone).
 *
 * Before 2a885ea8, namespaceDir mapped a namespace to a lossy sanitized name
 * (`raw.replace(/[^A-Za-z0-9._-]/g, "_")`), which let distinct namespaces
 * collide.  The `legacyLossyDirs` option controls what happens when the hashed
 * directory is absent but the old lossy directory exists:
 *   - "refuse" (default): throw a typed error, never read or write.
 *   - "first-claim": atomically rename the legacy dir to the hashed dir, write
 *     namespace.json with a legacyFrom marker, and proceed.  Two concurrent
 *     claims yield exactly one owner (rename is the arbiter).
 *
 * A `namespace.json` sidecar is written on first write and verified on every
 * access.  A sidecar whose `raw` names a different namespace causes a
 * `NamespaceOwnershipError`.
 */

import fsp from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

import { buildObservationsFromItems } from "./observations.js";
import { contentHash, normalizeString } from "../session/recall/text.js";

function sha256hex(str) {
  return crypto.createHash("sha256").update(str, "utf-8").digest("hex");
}

const ENGRAM_ROOT = ".sentinelayer";
const ENGRAM_DIR = "engram";

export class LegacyStorageError extends Error {
  constructor(message) {
    super(message);
    this.name = "LegacyStorageError";
  }
}

export class NamespaceOwnershipError extends Error {
  constructor(message) {
    super(message);
    this.name = "NamespaceOwnershipError";
  }
}

/**
 * The old (pre-2a885ea8) lossy directory name for a namespace.
 * Exported for legacy migration logic.
 */
export function legacyNamespaceDirName(namespace) {
  return namespace.raw.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Where a namespace's files live.  Each namespace gets its own sha256-hex
 * directory so distinct namespaces never collide, even on case-insensitive
 * filesystems.  A `namespace.json` sidecar is written on first write and
 * verified on every subsequent access.
 *
 * EXPORTED so siblings (e.g. build-state.js) resolve the same directory rather
 * than re-deriving the convention -- a second copy would drift and silently
 * point at a different namespace.
 */
export function namespaceDir(root, namespace) {
  return path.join(root, ENGRAM_ROOT, ENGRAM_DIR, `ns-${sha256hex(namespace.raw)}`);
}

/** The old lossy directory path (pre-2a885ea8). */
function legacyDir(root, namespace) {
  return path.join(root, ENGRAM_ROOT, ENGRAM_DIR, legacyNamespaceDirName(namespace));
}

const SIDECAR = "namespace.json";

/**
 * Verify the directory's namespace.json sidecar matches the expected namespace.
 * NEVER creates the directory or sidecar.  Throws NamespaceOwnershipError if a
 * different namespace already owns the directory.
 */
export async function verifyNamespace(dir, namespace) {
  const sidecar = path.join(dir, SIDECAR);
  let raw;
  try {
    raw = await fsp.readFile(sidecar, "utf-8");
  } catch (e) {
    if (e && e.code === "ENOENT") {
      throw new NamespaceOwnershipError(
        `namespace dir has no sidecar: directory ${dir} is not a valid engram namespace`,
      );
    }
    throw new Error(`corrupt namespace sidecar in ${dir}: ${e.message}`);
  }
  let existing;
  try {
    existing = JSON.parse(raw);
  } catch (e) {
    throw new Error(`corrupt namespace sidecar in ${dir}: ${e.message}`);
  }
  if (existing && typeof existing === "object" && existing !== null) {
    if (existing.raw !== namespace.raw) {
      throw new NamespaceOwnershipError(
        `namespace dir collision: directory ${dir} already owned by "${existing.raw}" (tried to access as "${namespace.raw}")`,
      );
    }
    return;
  }
  throw new Error(`corrupt namespace sidecar in ${dir}: expected object, got ${typeof existing}`);
}

/**
 * Ensure the directory's namespace.json sidecar matches the expected namespace,
 * writing it on first write with flag "wx" so a concurrent create is detected.
 * Throws NamespaceOwnershipError if a different namespace already owns the
 * directory.
 */
export async function ensureNamespace(dir, namespace, legacyFrom) {
  await fsp.mkdir(dir, { recursive: true });
  const sidecar = path.join(dir, SIDECAR);
  try {
    await fsp.writeFile(
      sidecar,
      JSON.stringify({ raw: namespace.raw, ...(legacyFrom ? { legacyFrom } : {}) }, null, 2) + "\n",
      { flag: "wx" },
    );
    return;
  } catch (e) {
    if (e && e.code === "EEXIST") {
      // Sidecar already exists — verify it matches.
      return verifyNamespace(dir, namespace);
    }
    throw e;
  }
}

/**
 * Resolve the namespace directory, handling legacy migration if configured.
 * Returns the directory path to use.
 */
export async function resolveNamespaceDir(root, namespace, legacyLossyDirs) {
  const dir = namespaceDir(root, namespace);
  try {
    await fsp.access(dir);
    return dir;
  } catch {
    // Hashed dir doesn't exist — check for legacy
  }

  const oldDir = legacyDir(root, namespace);
  let legacyExists = false;
  try {
    await fsp.access(oldDir);
    legacyExists = true;
  } catch {
    // No legacy dir either
  }

  if (!legacyExists) {
    return dir;
  }

  if (legacyLossyDirs === "first-claim") {
    // Atomically claim the legacy directory via rename
    try {
      await fsp.rename(oldDir, dir);
      // Write sidecar with legacy marker
      await ensureNamespace(dir, namespace, legacyNamespaceDirName(namespace));
      // Notify once per claim
      console.error(
        `engram: claimed legacy storage for "${namespace.raw}" from lossy dir "${legacyNamespaceDirName(namespace)}"`,
      );
      return dir;
    } catch (e) {
      if (e && e.code === "ENOENT") {
        // Lost the race — another caller claimed it or it was deleted.
        // Try the hashed dir now (the winner may have renamed to it).
        try {
          await fsp.access(dir);
          return dir;
        } catch {
          // Neither exists — start fresh
          return dir;
        }
      }
      // NS6: on EEXIST/ENOTEMPTY/EPERM, the hashed dir appeared concurrently.
      // Re-check: if its sidecar is ours, use it; otherwise rethrow.
      if (e && (e.code === "EEXIST" || e.code === "ENOTEMPTY" || e.code === "EPERM")) {
        try {
          await verifyNamespace(dir, namespace);
          // Sidecar is ours — use the hashed dir, leave legacy untouched
          return dir;
        } catch {
          // Sidecar names another namespace — rethrow original
        }
      }
      throw e;
    }
  }

  // "refuse" — the default
  // Note: the error message intentionally omits directory paths (public repo).
  throw new LegacyStorageError(
    `ambiguous legacy storage for namespace "${namespace.raw}". The old lossy directory still exists. ` +
    `Run with legacyLossyDirs: "first-claim" to migrate, or delete the legacy dir manually.`,
  );
}

/** Stable, content-addressed item id (idempotent write — §3 dedup for free). */
export function itemId(item = {}) {
  const explicit = normalizeString(item.id) || normalizeString(item.idempotencyToken);
  if (explicit) return explicit;
  const basis = [item.kind, item.author || item.agentId, item.text, item.ts]
    .map((value) => normalizeString(value))
    .join("|");
  return `h:${contentHash(basis)}`;
}

async function readItemsFile(file) {
  try {
    const raw = await fsp.readFile(file, "utf-8");
    const items = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        items.push(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
    return items;
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Create the namespace store.
 * @param {object} options
 * @param {string} options.storeRoot          Root dir for the append-log store.
 * @param {Record<string, (id:string)=>Promise<object[]>>} [options.adapters]
 *        Map of namespace-kind -> async source adapter returning observations.
 * @param {"refuse"|"first-claim"} [options.legacyLossyDirs="refuse"]
 *        Policy for pre-2a885ea8 lossy directories.
 * @returns {{
 *   appendItems: (namespace:object, items:object[]) => Promise<{written:number, deduped:number, namespace:string}>,
 *   readObservations: (namespace:object) => Promise<object[]>,
 * }}
 */
export function createStore({ storeRoot, adapters = {}, legacyLossyDirs = "refuse" } = {}) {
  const root = path.resolve(String(storeRoot || "."));

  return {
    async appendItems(namespace, items = []) {
      const dir = await resolveNamespaceDir(root, namespace, legacyLossyDirs);
      await ensureNamespace(dir, namespace);
      const file = path.join(dir, "items.ndjson");
      const existing = await readItemsFile(file);
      const seen = new Set(existing.map((it) => itemId(it)));
      const lines = [];
      let written = 0;
      let deduped = 0;
      for (const item of Array.isArray(items) ? items : []) {
        const id = itemId(item);
        if (seen.has(id)) {
          deduped += 1;
          continue;
        }
        seen.add(id);
        lines.push(JSON.stringify({ ...item, id }));
        written += 1;
      }
      if (lines.length > 0) {
        await fsp.mkdir(dir, { recursive: true });
        await fsp.appendFile(file, `${lines.join("\n")}\n`, "utf-8");
      }
      return { written, deduped, namespace: namespace.raw };
    },

    async readObservations(namespace) {
      const adapter = adapters[namespace.kind];
      const adapterObservations = adapter
        ? await Promise.resolve(adapter(namespace.id)).catch(() => [])
        : [];
      const dir = await resolveNamespaceDir(root, namespace, legacyLossyDirs);
      // NS1: reads never create.  If the hashed dir is absent, return empty.
      let dirExists = false;
      try {
        await fsp.access(dir);
        dirExists = true;
      } catch {
        // dir absent — no data
      }

      let items = [];
      if (dirExists) {
        // A first-claim rename on read is allowed (the explicit migration policy
        // in resolveNamespaceDir handles it).  If the dir exists after
        // resolution, verify its sidecar without creating anything.
        await verifyNamespace(dir, namespace);
        const file = path.join(dir, "items.ndjson");
        items = await readItemsFile(file);
      }
      // If dir is absent and no adapter observations, items stays []
      // and the union below produces only adapter observations (or []).
      const itemObservations = buildObservationsFromItems(items, { namespace: namespace.raw }).observations;

      // Union, dedup by id (first wins — adapter source is authoritative for its ids).
      const byId = new Map();
      for (const obs of [...(Array.isArray(adapterObservations) ? adapterObservations : []), ...itemObservations]) {
        if (obs && !byId.has(obs.id)) byId.set(obs.id, obs);
      }
      return Array.from(byId.values());
    },
  };
}
