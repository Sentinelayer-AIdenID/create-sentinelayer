import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveActiveAuthSession } from "../auth/service.js";
import { resolveCredentialsFilePath } from "../auth/session-store.js";
import { isValidSessionId, normalizeSessionId } from "./paths.js";
import { getSession, isSessionCacheExpired, listAllSessions } from "./store.js";
import { resolveApiBaseUrl } from "./sync.js";

const METADATA_FIELDS = [
  "status", "archiveStatus", "createdAt", "updatedAt", "expiresAt",
  "lastActivityAt", "lastInteractionAt", "codebasePath",
];

// Capture authentication once so the cache scope and the HTTP read cannot use
// different accounts. Like the session read transport, these read-only commands
// never rotate a stored token (including when the cache is read offline).
export async function resolveSessionMetadataContext({
  targetPath = process.cwd(),
  homeDir,
  resolveAuthSession = resolveActiveAuthSession,
} = {}) {
  const authSession = await resolveAuthSession({ cwd: targetPath, env: process.env, autoRotate: false });
  const api = new URL(resolveApiBaseUrl(authSession || {}));
  const apiUrl = `${api.origin}${api.pathname}`.replace(/\/+$/, "");
  const userId = String(authSession?.user?.id || "").trim();
  // A room admission must not prune or replace the human's cache catalog.
  // The non-secret admission ID scopes its limited authority; no token is stored
  // or hashed, and it still cannot import server-only membership without a user.
  const principal = authSession?.source === "session_admission"
    ? ["admission", authSession.admissionId || ""] : ["user", userId];
  const scope = createHash("sha256").update(JSON.stringify([apiUrl, principal, path.resolve(targetPath)])).digest("hex");
  return {
    authSession,
    userId,
    cacheDir: path.join(path.dirname(resolveCredentialsFilePath({ homeDir })), "session-metadata-cache", scope),
  };
}

// Match the bounded transient-rename retry used by auth/session-store.js.
// Windows readers and antivirus can temporarily hold the destination open.
async function retryTransientFileOperation(operation) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      if (attempt >= 3 || !["EPERM", "EACCES", "EEXIST", "EBUSY"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

async function writePrivateJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await retryTransientFileOperation(() => fsp.rename(temporaryPath, filePath));
  } finally {
    // Cleanup must not turn a successfully published cache into a command error.
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

// Serialize publication and pruning for the whole account/workspace catalog,
// including separate CLI processes. Never steal a lock by age: its writer may
// still be publishing. A busy or abandoned lock is a bounded cache failure,
// not a failed server read.
async function withCacheWriteLock(context, operation, timeoutMs) {
  await fsp.mkdir(context.cacheDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(context.cacheDir, ".refresh.lock");
  const deadline = performance.now() + timeoutMs;
  let handle;
  for (;;) {
    try {
      handle = await fsp.open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (!["EEXIST", "EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
      if (performance.now() >= deadline) {
        throw Object.assign(new Error("Metadata cache refresh lock is unavailable."), { code: "CACHE_LOCK_TIMEOUT" });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString() }));
    return await operation();
  } finally {
    try { await handle.close(); } finally {
      await retryTransientFileOperation(() => fsp.rm(lockPath, { force: true }));
    }
  }
}

async function readListExclusions(context) {
  try {
    const value = JSON.parse(await fsp.readFile(path.join(context.cacheDir, ".list-exclusions.json"), "utf8"));
    if (!Number.isFinite(Date.parse(value.requestedAt)) || !Array.isArray(value.sessionIds)
      || !value.sessionIds.every(isValidSessionId)) throw new Error("Invalid cached list membership.");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function excludedByList(sessionId, cached, exclusions) {
  return exclusions?.sessionIds.includes(sessionId)
    && (!cached || Date.parse(cached.requestedAt || cached.fetchedAt) <= Date.parse(exclusions.requestedAt));
}

async function pruneMissingSessions(seen, { targetPath, context, requestedAt }) {
  const previous = await readListExclusions(context);
  if (Date.parse(previous?.requestedAt || "") >= Date.parse(requestedAt)) return 0;
  const localIds = new Set((await listAllSessions({ targetPath })).map((session) => session.sessionId));
  let names = [];
  try { names = await fsp.readdir(context.cacheDir); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const cachedIds = names.filter((name) => name.endsWith(".json") && isValidSessionId(name.slice(0, -5)))
    .map((name) => name.slice(0, -5));
  // Keep only exclusions still needed to suppress a local copy or a file whose
  // removal failed. This record cannot accumulate deleted server-only history.
  const retained = new Set((previous?.sessionIds || []).filter((id) =>
    !seen.has(id) && (localIds.has(id) || cachedIds.includes(id))));
  const obsolete = [];
  for (const id of cachedIds) {
    if (seen.has(id)) continue;
    const cached = await readCacheFile(context, id);
    if (Date.parse(cached?.requestedAt || cached?.fetchedAt || "") >= Date.parse(requestedAt)) {
      retained.delete(id);
      continue;
    }
    retained.add(id);
    obsolete.push(id);
  }
  await writePrivateJson(path.join(context.cacheDir, ".list-exclusions.json"), {
    requestedAt, sessionIds: [...retained].sort(),
  });
  let pruned = 0;
  for (const id of obsolete) {
    // All cache writers hold the same scope lock. This protects the timestamp
    // check AND removal from a status publication between the two operations.
    const current = await readCacheFile(context, id);
    if (Date.parse(current?.requestedAt || current?.fetchedAt || "") >= Date.parse(requestedAt)) continue;
    await fsp.rm(path.join(context.cacheDir, `${id}.json`), { force: true });
    pruned += 1;
  }
  return pruned;
}

function normalizeRemoteMetadata(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)
    || !Object.hasOwn(session, "title")
    || (session.title !== null && typeof session.title !== "string")) {
    throw new Error("Remote session metadata is missing a valid title; the cache was not refreshed.");
  }
  const sessionId = normalizeSessionId(session.sessionId || session.id);
  const metadata = { sessionId, title: session.title?.trim() || null };
  for (const field of METADATA_FIELDS) {
    if (typeof session[field] === "string" || session[field] === null) metadata[field] = session[field];
  }
  return metadata;
}

async function readCacheFile(context, sessionId) {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(context.cacheDir, `${normalizeSessionId(sessionId)}.json`), "utf8"));
    if (raw?.session?.sessionId !== sessionId || !Number.isFinite(Date.parse(raw.fetchedAt))) return null;
    return { ...raw, session: normalizeRemoteMetadata(raw.session) };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// A separate sidecar never rewrites local TTL, provisioning, pending title sync,
// or transcript state while another command is updating metadata.json.
export async function cacheRemoteSessionMetadata(sessions, {
  targetPath = process.cwd(), context, requestedAt = new Date().toISOString(), completeList = false,
  lockTimeoutMs = 1_500,
} = {}) {
  // Invalid server data is not a cache-write failure: validate before any write.
  const metadata = sessions.map(normalizeRemoteMetadata);
  let refreshed = 0;
  let skipped = 0;
  let pruned = 0;
  let superseded = 0;
  const errors = [];
  const failed = (error, sessionId = null) => errors.push({
    sessionId, code: /^[A-Z0-9_]{1,64}$/.test(error?.code || "") ? error.code : "CACHE_REFRESH_FAILED",
  });
  try {
    await withCacheWriteLock(context, async () => {
      const exclusions = await readListExclusions(context);
      for (const session of metadata) {
        try {
          const local = await getSession(session.sessionId, { targetPath });
          // Token-only authentication carries no stable account ID. Refresh titles
          // of existing local rooms, but never import account membership.
          if (!context.userId && !local) {
            skipped += 1;
            continue;
          }
          const existing = await readCacheFile(context, session.sessionId);
          // Millisecond ties preserve the publication already committed.
          if (Date.parse(existing?.requestedAt || existing?.fetchedAt || "") >= Date.parse(requestedAt)
            // A complete listing is a catalog-wide watermark, including rooms
            // never cached and tombstones already removed after pruning.
            || Date.parse(exclusions?.requestedAt || "") >= Date.parse(requestedAt)) {
            superseded += 1;
            continue;
          }
          await writePrivateJson(path.join(context.cacheDir, `${session.sessionId}.json`), {
            session, requestedAt, fetchedAt: new Date().toISOString(), localTitleAtRead: local?.title ?? null,
          });
          refreshed += 1;
        } catch (error) {
          failed(error, session.sessionId);
        }
      }
      if (completeList) {
        try {
          pruned = await pruneMissingSessions(new Set(metadata.map((session) => session.sessionId)), {
            targetPath, context, requestedAt,
          });
        } catch (error) { failed(error); }
      }
    }, Math.max(0, Math.min(1_500, Number(lockTimeoutMs) || 0)));
  } catch (error) { failed(error); }
  return {
    ok: errors.length === 0,
    refreshed,
    skipped,
    pruned,
    superseded,
    failed: errors.length,
    reason: errors.length ? "cache_refresh_failed" : skipped ? "stable_account_id_unavailable" : "",
    errors,
  };
}

function mergeCachedMetadata(local, cached) {
  if (!cached) return local;
  const metadata = { ...local, ...cached.session, remoteMetadataFetchedAt: cached.fetchedAt };
  // listAllSessions derives archiveStatus from the local lifecycle before this
  // merge. A server status must replace that classification even on APIs that
  // omit the separate archiveStatus field.
  if (cached.session.status && !cached.session.archiveStatus) {
    metadata.archiveStatus = cached.session.status;
  }
  const localRenameAfterRead = local && (
    local.title !== cached.localTitleAtRead
    || Date.parse(local.remoteTitleSync?.lastAttemptAt || "") >= Date.parse(cached.requestedAt)
  );
  if (localRenameAfterRead) metadata.title = local.title;
  return metadata;
}

export async function readOfflineSessionMetadata(sessionId, { targetPath = process.cwd(), context } = {}) {
  const local = await getSession(sessionId, { targetPath });
  if (!local && !context.userId) return null;
  const cached = await readCacheFile(context, sessionId);
  if (excludedByList(sessionId, cached, await readListExclusions(context))) return null;
  return mergeCachedMetadata(local, cached);
}

export async function listOfflineSessionMetadata({
  targetPath = process.cwd(), context, includeArchived = false,
} = {}) {
  const local = await listAllSessions({ targetPath });
  const byId = new Map(local.map((session) => [session.sessionId, session]));
  const exclusions = await readListExclusions(context);
  let filenames = [];
  try {
    filenames = await fsp.readdir(context.cacheDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const filename of filenames) {
    if (!filename.endsWith(".json")) continue;
    const sessionId = filename.slice(0, -5);
    if (!isValidSessionId(sessionId) || (!context.userId && !byId.has(sessionId))) continue;
    const cached = await readCacheFile(context, sessionId);
    if (cached && !excludedByList(sessionId, cached, exclusions)) {
      byId.set(sessionId, mergeCachedMetadata(byId.get(sessionId), cached));
    }
  }
  for (const sessionId of exclusions?.sessionIds || []) {
    if (excludedByList(sessionId, await readCacheFile(context, sessionId), exclusions)) byId.delete(sessionId);
  }
  return [...byId.values()].filter((session) => includeArchived || (
    !["archived", "expired", "killed"].includes(session.archiveStatus || session.status)
    && (!session.expiresAt || !isSessionCacheExpired(session))
  ));
}
