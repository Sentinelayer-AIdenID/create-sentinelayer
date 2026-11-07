import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveActiveAuthSession } from "../auth/service.js";
import { isValidSessionId, normalizeSessionId } from "./paths.js";
import { getSession, isSessionCacheExpired, listAllSessions } from "./store.js";
import { resolveApiBaseUrl } from "./sync.js";

const METADATA_FIELDS = [
  "status", "archiveStatus", "createdAt", "updatedAt", "expiresAt",
  "lastActivityAt", "lastInteractionAt", "codebasePath",
];

// Capture authentication once so the cache scope and the HTTP read cannot use
// different accounts. Offline reads disable rotation to avoid contacting the API.
export async function resolveSessionMetadataContext({
  targetPath = process.cwd(),
  offline = false,
  resolveAuthSession = resolveActiveAuthSession,
} = {}) {
  const authSession = await resolveAuthSession({ cwd: targetPath, env: process.env, autoRotate: !offline });
  const api = new URL(resolveApiBaseUrl(authSession || {}));
  const apiUrl = `${api.origin}${api.pathname}`.replace(/\/+$/, "");
  const userId = String(authSession?.user?.id || "").trim();
  const scope = createHash("sha256").update(JSON.stringify([apiUrl, userId])).digest("hex");
  return {
    authSession,
    userId,
    cacheDir: path.join(path.resolve(targetPath), ".sentinelayer", "session-metadata-cache", scope),
  };
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
  targetPath = process.cwd(), context, requestedAt = new Date().toISOString(),
} = {}) {
  const metadata = sessions.map(normalizeRemoteMetadata);
  let refreshed = 0;
  let skipped = 0;
  for (const session of metadata) {
    const local = await getSession(session.sessionId, { targetPath });
    // Token-only authentication carries no stable account ID. Refresh titles of
    // rooms already in this workspace, but do not import account membership.
    if (!context.userId && !local) {
      skipped += 1;
      continue;
    }
    await fsp.mkdir(context.cacheDir, { recursive: true });
    const filePath = path.join(context.cacheDir, `${session.sessionId}.json`);
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temporaryPath, `${JSON.stringify({
        session, requestedAt, fetchedAt: new Date().toISOString(), localTitleAtRead: local?.title ?? null,
      })}\n`, { encoding: "utf8", mode: 0o600 });
      await fsp.rename(temporaryPath, filePath);
    } finally {
      await fsp.rm(temporaryPath, { force: true });
    }
    refreshed += 1;
  }
  return {
    refreshed,
    skipped,
    reason: skipped ? "stable_account_id_unavailable" : "",
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
  return mergeCachedMetadata(local, await readCacheFile(context, sessionId));
}

export async function listOfflineSessionMetadata({
  targetPath = process.cwd(), context, includeArchived = false,
} = {}) {
  const local = await listAllSessions({ targetPath });
  const byId = new Map(local.map((session) => [session.sessionId, session]));
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
    if (cached) byId.set(sessionId, mergeCachedMetadata(byId.get(sessionId), cached));
  }
  return [...byId.values()].filter((session) => includeArchived || (
    !["archived", "expired", "killed"].includes(session.archiveStatus || session.status)
    && (!session.expiresAt || !isSessionCacheExpired(session))
  ));
}
