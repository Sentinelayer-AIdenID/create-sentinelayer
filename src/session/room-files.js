// Room files: list the files published in a session room, and download one of them.
//
// The API publishes an uploaded file when a message that references it is sent. That message
// event carries the file's pointer in payload.attachments (markdown and JSON uploads also emit a
// session_attachment event). There is no list endpoint yet, so listing reads the room's history
// newest first and collects those pointers.
//
// A download asks the API for the file's metadata and a short-lived signed link
// (GET /api/v1/sessions/{id}/attachments/{attachmentId}?download=true), fetches the link from
// the file store WITHOUT API credentials, streams it into a temporary file next to the
// destination while hashing it, checks the size and sha256 the API reported, and only then
// renames the temporary file into place. An expired link is fetched again once.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { authLoginHint } from "../ui/command-hints.js";
import { fetchSessionAttachment, pollSessionEventsBefore } from "./sync.js";

const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9._:-]{8,120}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FILE_EVENT_TYPES = new Set(["session_message", "session_attachment"]);
const LIST_PAGE_EVENTS = 200;
export const DEFAULT_ROOM_FILES_LIMIT = 50;
export const MAX_ROOM_FILES_LIMIT = 500;
export const DEFAULT_ROOM_FILES_MAX_PAGES = 10;
export const MAX_ROOM_FILES_MAX_PAGES = 50;
// Treat a link this close to its expiry as expired, and fetch a fresh one first.
const LINK_EXPIRY_SKEW_MS = 30_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_FILE_NAME_LENGTH = 255;
// Windows device names, with or without an extension, cannot name a regular file.
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export class RoomFileError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RoomFileError";
    this.code = code;
    this.details = details;
  }
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function clampInteger(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function eventSequence(event = {}) {
  const value = Number(event?.sequenceId ?? event?.sequence_id);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function eventAuthorId(event = {}) {
  const agent = event?.agent;
  return normalizeString((agent && typeof agent === "object" ? agent.id : agent) || event?.agentId || event?.agent_id);
}

function attachmentPointersOf(event = {}) {
  if (!FILE_EVENT_TYPES.has(normalizeString(event?.event || event?.type))) return [];
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  const pointers = Array.isArray(payload.attachments) ? [...payload.attachments] : [];
  if (payload.attachment && typeof payload.attachment === "object") pointers.unshift(payload.attachment);
  return pointers.filter((pointer) => pointer && typeof pointer === "object" && !Array.isArray(pointer));
}

/**
 * One published file, from an attachment pointer and the event that carried it; null when the
 * pointer is not a usable file record.
 */
export function roomFileFromPointer(pointer = {}, event = {}) {
  const attachmentId = normalizeString(pointer.attachmentId || pointer.attachment_id || pointer.id);
  const sizeBytes = Number(pointer.sizeBytes ?? pointer.size_bytes);
  if (!ATTACHMENT_ID_PATTERN.test(attachmentId) || attachmentId.includes("..")) return null;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return null;
  const sha256 = normalizeString(pointer.sha256).toLowerCase();
  return {
    attachmentId,
    filename: normalizeString(pointer.filename || pointer.name),
    sizeBytes,
    contentType: normalizeString(pointer.contentType || pointer.content_type) || null,
    kind: normalizeString(pointer.kind) || null,
    sha256: SHA256_PATTERN.test(sha256) ? sha256 : null,
    status: normalizeString(pointer.status) || null,
    uploadedBy: normalizeString(pointer.uploadedBy || pointer.uploaded_by) || eventAuthorId(event) || null,
    uploadedAt: normalizeString(pointer.uploadedAt || pointer.uploaded_at) || null,
    publishedAt: normalizeString(event.ts || event.timestamp || event.createdAt) || null,
    publishedBy: eventAuthorId(event) || null,
    publishedSequenceId: eventSequence(event) || null,
  };
}

/**
 * The files published in a room, newest first, read from its message history.
 *
 * @returns {Promise<{ok: boolean, reason: string, files: Array<object>, count: number,
 *   complete: boolean, pages: number, scannedEvents: number, skippedPointers: number}>}
 *   complete is true when the whole history was read and every file found is listed; raise
 *   limit or maxPages to see more when it is false.
 */
export async function listRoomFiles(
  sessionId,
  {
    targetPath = process.cwd(),
    limit = DEFAULT_ROOM_FILES_LIMIT,
    maxPages = DEFAULT_ROOM_FILES_MAX_PAGES,
    timeoutMs = 15_000,
    pollSessionEventsBeforeFn = pollSessionEventsBefore,
  } = {},
) {
  const wanted = clampInteger(limit, DEFAULT_ROOM_FILES_LIMIT, MAX_ROOM_FILES_LIMIT);
  const pageBudget = clampInteger(maxPages, DEFAULT_ROOM_FILES_MAX_PAGES, MAX_ROOM_FILES_MAX_PAGES);
  const files = [];
  const seen = new Set();
  let beforeSequence = null;
  let pages = 0;
  let scannedEvents = 0;
  let skippedPointers = 0;
  let complete = false;
  let reason = "";

  while (pages < pageBudget && files.length < wanted) {
    const result = await pollSessionEventsBeforeFn(sessionId, {
      targetPath,
      beforeSequence,
      limit: LIST_PAGE_EVENTS,
      timeoutMs,
    });
    pages += 1;
    if (!result?.ok) {
      reason = normalizeString(result?.reason) || "history_read_failed";
      if (pages === 1) {
        return {
          ok: false,
          reason,
          files: [],
          count: 0,
          complete: false,
          pages,
          scannedEvents,
          skippedPointers,
        };
      }
      break;
    }
    const events = Array.isArray(result.events) ? result.events : [];
    scannedEvents += events.length;
    const newestFirst = [...events].sort((left, right) => eventSequence(right) - eventSequence(left));
    for (const event of newestFirst) {
      for (const pointer of attachmentPointersOf(event)) {
        const file = roomFileFromPointer(pointer, event);
        if (!file) {
          skippedPointers += 1;
          continue;
        }
        if (seen.has(file.attachmentId)) continue;
        seen.add(file.attachmentId);
        files.push(file);
      }
    }
    const next = Number(result.beforeSequence || 0);
    if (!events.length || result.hasMore === false || !next || (beforeSequence && next >= beforeSequence)) {
      complete = true;
      break;
    }
    beforeSequence = next;
  }

  const listed = files.slice(0, wanted);
  return {
    ok: true,
    reason,
    files: listed,
    count: listed.length,
    complete: complete && listed.length === files.length,
    pages,
    scannedEvents,
    skippedPointers,
  };
}

function hasControlCharacter(text) {
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The server-provided file name, when it is one plain file name; otherwise a RoomFileError.
 * The API cleans names before it stores them, so a name that fails here is refused, not
 * rewritten.
 */
export function requirePlainFileName(name) {
  const text = String(name ?? "");
  const plain =
    text.trim() !== "" &&
    text === text.trim() &&
    text !== "." &&
    text !== ".." &&
    text.length <= MAX_FILE_NAME_LENGTH &&
    !/[\\/:*?"<>|]/.test(text) &&
    !hasControlCharacter(text) &&
    !text.endsWith(".") &&
    !WINDOWS_DEVICE_NAME.test(text);
  if (!plain) {
    throw new RoomFileError(
      "unsafe_file_name",
      `The server-provided file name ${JSON.stringify(text)} is not a plain file name; choose where to save it with --out <path>.`,
    );
  }
  return text;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Where the file is written. Without `out`, the server's file name in the workspace. A relative
 * `out` is resolved in the workspace and must stay inside it, through links too; an absolute
 * `out` is allowed only when workspaceOnly is false (the CLI, where a person chose it). An
 * `out` naming an existing directory, or ending with a separator, gets the server's file name.
 */
export async function resolveRoomFileDestination({ targetPath = process.cwd(), out = "", filename = "", workspaceOnly = false } = {}) {
  const workspace = path.resolve(targetPath);
  const requested = normalizeString(out);
  let destination;
  if (!requested) {
    destination = path.join(workspace, requirePlainFileName(filename));
  } else {
    if (path.isAbsolute(requested) && workspaceOnly) {
      throw new RoomFileError("out_outside_workspace", `out must be a path inside the workspace ${workspace}, not an absolute path.`);
    }
    const resolved = path.resolve(workspace, requested);
    if (!path.isAbsolute(requested) && !isInside(workspace, resolved)) {
      throw new RoomFileError("out_outside_workspace", `--out ${requested} leaves the workspace ${workspace}.`);
    }
    const existing = await fsp.stat(resolved).catch(() => null);
    const namesDirectory = Boolean(existing?.isDirectory()) || /[\\/]$/.test(requested);
    destination = namesDirectory ? path.join(resolved, requirePlainFileName(filename)) : resolved;
  }

  const directory = path.dirname(destination);
  const realDirectory = await fsp.realpath(directory).catch(() => null);
  if (!realDirectory) {
    throw new RoomFileError("out_directory_missing", `The directory ${directory} does not exist.`);
  }
  if (workspaceOnly || !requested || !path.isAbsolute(requested)) {
    const realWorkspace = await fsp.realpath(workspace);
    if (!isInside(realWorkspace, realDirectory)) {
      throw new RoomFileError("out_outside_workspace", `${directory} resolves outside the workspace ${workspace} through a link.`);
    }
  }
  return path.join(realDirectory, path.basename(destination));
}

async function existingEntry(destination) {
  const entry = await fsp.lstat(destination).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!entry) return null;
  if (entry.isDirectory()) {
    throw new RoomFileError("destination_is_directory", `${destination} is a directory; choose a file path with --out.`);
  }
  if (entry.isSymbolicLink()) {
    throw new RoomFileError("destination_is_link", `${destination} is a link; refusing to write through it.`);
  }
  return entry;
}

function attachmentReadError(result, sessionId, attachmentId) {
  const status = result?.status ?? null;
  const details = { status, apiCode: result?.errorCode || null };
  if (status === 404) {
    return new RoomFileError(
      "not_found",
      `Attachment ${attachmentId} was not found in room ${sessionId}. A file is visible to the room once a sent message references it (until then only its uploader can fetch it), and a removed file is gone.`,
      details,
    );
  }
  if (status === 403) {
    return new RoomFileError("forbidden", `You cannot read room ${sessionId}: the signed-in account is not a member.`, details);
  }
  if (status === 401) {
    return new RoomFileError(
      "unauthorized",
      `The API refused this credential for room files. Downloading needs your user login (\`${authLoginHint()}\`); agent admission credentials cannot fetch download links.`,
      details,
    );
  }
  if (status === 409) {
    return new RoomFileError("not_ready", `The upload of attachment ${attachmentId} is not complete yet; try again once its uploader finishes.`, details);
  }
  if (status === 429) {
    const seconds = Math.max(1, Math.ceil(Number(result?.retryAfterMs || 0) / 1000));
    return new RoomFileError("rate_limited", `Too many attachment reads; try again in ${seconds} s.`, { ...details, retryAfterMs: result?.retryAfterMs || null });
  }
  if (status === 503) {
    return new RoomFileError("storage_unavailable", "The file store is unavailable right now; try again shortly.", details);
  }
  if (result?.reason === "not_authenticated" || result?.reason === "no_session") {
    return new RoomFileError("not_authenticated", `Downloading room files requires authentication. Run \`${authLoginHint()}\` first.`, details);
  }
  if (result?.reason === "invalid_attachment_id" || result?.reason === "invalid_session_id") {
    return new RoomFileError(result.reason, `The ${result.reason === "invalid_session_id" ? "room id" : "attachment id"} is not valid.`, details);
  }
  return new RoomFileError("api_error", `Reading attachment ${attachmentId} failed (${result?.reason || "unknown"}).`, details);
}

function validatedAttachment(attachment, attachmentId) {
  const file = roomFileFromPointer(attachment || {}, {});
  if (!file || file.attachmentId !== attachmentId) {
    throw new RoomFileError("invalid_metadata", `The API answered with no usable metadata for attachment ${attachmentId}.`);
  }
  if (!file.sha256) {
    throw new RoomFileError("invalid_metadata", `The API gave no sha256 for attachment ${attachmentId}, so the download cannot be verified.`);
  }
  return file;
}

function validatedLink(download, attachmentId) {
  const url = normalizeString(download?.url);
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  const loopback = parsed && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (!parsed || !(parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback))) {
    throw new RoomFileError("invalid_link", `The API answered with no usable download link for attachment ${attachmentId}.`);
  }
  const expiresAtMs = Date.parse(normalizeString(download?.expiresAt));
  return { url: parsed.toString(), expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null };
}

// Counts and hashes the bytes as they stream, and stops a body longer than the API reported.
function verifyingCounter(expectedBytes, state) {
  return new Transform({
    transform(chunk, _encoding, done) {
      state.bytes += chunk.length;
      if (state.bytes > expectedBytes) {
        done(new RoomFileError(
          "size_mismatch",
          `The download is larger than the ${expectedBytes} bytes the API reported; it was not saved.`,
        ));
        return;
      }
      state.hash.update(chunk);
      done(null, chunk);
    },
  });
}

/**
 * Download one published room file to disk, verified and atomic.
 *
 * @returns {Promise<{ok: true, path: string, bytes: number, sha256: string, verified: true,
 *   overwritten: boolean, linkRefetched: boolean, attachment: object}>}
 * @throws {RoomFileError} with a code: not_found, forbidden, unauthorized, not_ready,
 *   rate_limited, storage_unavailable, not_authenticated, invalid_*, unsafe_file_name,
 *   out_outside_workspace, out_directory_missing, destination_exists, destination_is_*,
 *   link_expired, download_failed, size_mismatch, checksum_mismatch.
 */
export async function downloadRoomFile(
  sessionId,
  attachmentId,
  {
    targetPath = process.cwd(),
    out = "",
    force = false,
    workspaceOnly = false,
    timeoutMs = 15_000,
    downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
    fetchAttachmentFn = fetchSessionAttachment,
    fetchImpl = (url, init) => fetch(url, init),
    nowMs = Date.now,
  } = {},
) {
  const sid = normalizeString(sessionId);
  const aid = normalizeString(attachmentId);
  if (!ATTACHMENT_ID_PATTERN.test(aid) || aid.includes("..")) {
    throw new RoomFileError("invalid_attachment_id", `${JSON.stringify(aid)} is not an attachment id.`);
  }

  const requestLink = async () => {
    const result = await fetchAttachmentFn(sid, aid, { targetPath, timeoutMs });
    if (!result?.ok) throw attachmentReadError(result, sid, aid);
    return {
      attachment: validatedAttachment(result.attachment, aid),
      link: validatedLink(result.download, aid),
    };
  };

  let { attachment, link } = await requestLink();
  const destination = await resolveRoomFileDestination({ targetPath, out, filename: attachment.filename, workspaceOnly });
  const existedBefore = Boolean(await existingEntry(destination));
  if (existedBefore && !force) {
    throw new RoomFileError("destination_exists", `${destination} already exists; pass --force to overwrite it.`);
  }

  let linkRefetched = false;
  const refetchLink = async () => {
    linkRefetched = true;
    const fresh = await requestLink();
    if (fresh.attachment.sha256 !== attachment.sha256 || fresh.attachment.sizeBytes !== attachment.sizeBytes) {
      throw new RoomFileError("download_failed", `Attachment ${aid} changed while it was being downloaded; try again.`);
    }
    link = fresh.link;
  };
  if (link.expiresAtMs !== null && link.expiresAtMs - LINK_EXPIRY_SKEW_MS <= (Number(nowMs()) || Date.now())) {
    await refetchLink();
  }

  const signal = AbortSignal.timeout(downloadTimeoutMs);
  // The signed link carries its own authorization: no API credential or header is sent with it.
  let response = await fetchImpl(link.url, { method: "GET", redirect: "error", signal });
  if ((response?.status === 401 || response?.status === 403) && !linkRefetched) {
    await response.body?.cancel?.().catch?.(() => {});
    await refetchLink();
    response = await fetchImpl(link.url, { method: "GET", redirect: "error", signal });
  }
  if (!response?.ok) {
    const status = response?.status ?? "no response";
    await response?.body?.cancel?.().catch?.(() => {});
    if (status === 401 || status === 403) {
      throw new RoomFileError(
        "link_expired",
        `The file store refused the download link (HTTP ${status}) even after a fresh link was fetched; try again.`,
        { status },
      );
    }
    throw new RoomFileError("download_failed", `The file store answered HTTP ${status}.`, { status });
  }

  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.part`);
  const state = { bytes: 0, hash: createHash("sha256") };
  let renamed = false;
  try {
    const source = response.body ? Readable.fromWeb(response.body) : Readable.from([]);
    await pipeline(source, verifyingCounter(attachment.sizeBytes, state), fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    const sha256 = state.hash.digest("hex");
    if (state.bytes !== attachment.sizeBytes || sha256 !== attachment.sha256) {
      throw new RoomFileError(
        "checksum_mismatch",
        `The download does not match the server's checksum (expected ${attachment.sizeBytes} bytes, sha256 ${attachment.sha256}; got ${state.bytes} bytes, sha256 ${sha256}). Nothing was saved.`,
        { expectedSha256: attachment.sha256, actualSha256: sha256, expectedBytes: attachment.sizeBytes, actualBytes: state.bytes },
      );
    }
    if (!force && (await existingEntry(destination))) {
      throw new RoomFileError("destination_exists", `${destination} appeared during the download; pass --force to overwrite it.`);
    }
    await fsp.rename(temporary, destination);
    renamed = true;
    return {
      ok: true,
      path: destination,
      bytes: state.bytes,
      sha256,
      verified: true,
      overwritten: existedBefore,
      linkRefetched,
      attachment,
    };
  } finally {
    if (!renamed) await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}
