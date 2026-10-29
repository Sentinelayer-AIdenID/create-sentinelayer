import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { SentinelayerApiError, requestJson, requestJsonMutation } from "../auth/http.js";
import { credentialFor, isAuthenticated } from "../auth/credential-destinations.js";
import { resolveActiveAuthSession } from "../auth/service.js";

const ATTACHMENT_INIT_OP = "session-attachment-init";
const ATTACHMENT_COMPLETE_OP = "session-attachment-complete";
const ATTACHMENT_POLL_OP = "session-attachment-poll";
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const UPLOAD_RETRY_MAX = 3;
const UPLOAD_RETRY_DELAY_MS = 500;
const COMPLETE_POLL_MAX = 30;
const COMPLETE_POLL_DELAY_MS = 1000;
const MAX_ATTACHMENT_FILENAME_LENGTH = 180;

function normalizeString(value) {
  return String(value == null ? "" : value).trim();
}

function urlPathSegment(value, { label = "value" } = {}) {
  const encoded = encodeURIComponent(String(value || "").trim());
  if (!encoded) throw new Error(label + " is required.");
  return encoded;
}

function normalizeFileName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed || trimmed.length > MAX_ATTACHMENT_FILENAME_LENGTH) return "";
  return path.basename(trimmed);
}

const DEFAULT_API_BASE_URL = "https://api.sentinelayer.com";

function resolveApiBaseUrl(session) {
  if (session && session.apiUrl) return String(session.apiUrl).replace(/\/+$/, "");
  return DEFAULT_API_BASE_URL;
}

async function resolveSessionAuth({ targetPath = process.cwd() } = {}) {
  const session = await resolveActiveAuthSession({
    cwd: targetPath,
    env: process.env,
    autoRotate: false,
  });
  if (!session || !isAuthenticated(session)) {
    throw new SentinelayerApiError("Not authenticated for the session.", {
      status: 401,
      code: "NOT_AUTHENTICATED",
    });
  }
  return session;
}

export async function initAttachment(sessionId, fileName, mimeType, fileSize, {
  targetPath = process.cwd(),
  sha256,
} = {}) {
  if (!sha256 || !/^[0-9a-f]{64}$/.test(String(sha256))) { throw new Error("sha256 is required (64 lowercase hex chars)."); }
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) throw new Error("session id is required.");

  const session = await resolveSessionAuth({ targetPath });
  const apiBaseUrl = resolveApiBaseUrl(session);
  const endpoint = `${apiBaseUrl}/api/v1/sessions/${urlPathSegment(normalizedSessionId, { label: "sessionId" })}/attachments/init`;

  const body = {
    filename: normalizeFileName(fileName),
    contentType: String(mimeType || "application/octet-stream"),
    sizeBytes: Number(fileSize),
    sha256: String(sha256),
  };

  const credential = await credentialFor(session);
  return requestJsonMutation(endpoint, {
    method: "POST",
    credential,
    body,
    operationName: ATTACHMENT_INIT_OP,
  });
}

export async function completeAttachment(sessionId, attachmentId, sha256, {
  targetPath = process.cwd(),
} = {}) {
  if (!sha256 || !/^[0-9a-f]{64}$/.test(String(sha256))) { throw new Error("sha256 is required (64 lowercase hex chars)."); }
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) throw new Error("session id is required.");

  const session = await resolveSessionAuth({ targetPath });
  const apiBaseUrl = resolveApiBaseUrl(session);
  const endpoint = `${apiBaseUrl}/api/v1/sessions/${urlPathSegment(normalizedSessionId, { label: "sessionId" })}/attachments/${urlPathSegment(String(attachmentId), { label: "attachmentId" })}/complete`;

  const credential = await credentialFor(session);
  return requestJsonMutation(endpoint, {
    method: "POST",
    credential,
    operationName: ATTACHMENT_COMPLETE_OP,
    allowEmptyBody: true,
  });
}

export async function uploadStreamToUrl(uploadUrl, filePath, { maxRetries = UPLOAD_RETRY_MAX, headers } = {}) {
  const fileStat = await stat(filePath);
  const fileSize = fileStat.size;
  if (fileSize > MAX_FILE_SIZE_BYTES) {
    throw new SentinelayerApiError("File exceeds maximum upload size.", {
      status: 413,
      code: "FILE_TOO_LARGE",
    });
  }

  const putHeaders = headers && typeof headers === "object" ? { ...headers } : {};
  if (!putHeaders["content-length"] && !putHeaders["Content-Length"]) {
    putHeaders["Content-Length"] = String(fileSize);
  }

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const readStream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
      const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: putHeaders,
        body: readStream,
        duplex: "half",
      });
      if (!response.ok) {
        const errBody = await response.text().catch(function() { return ""; });
        throw new SentinelayerApiError("Upload failed: " + response.status, {
          status: response.status,
          code: "UPLOAD_FAILED",
          detail: errBody.slice(0, 500),
        });
      }
      return true;
    } catch (error) {
      lastError = error;
      if (error instanceof SentinelayerApiError && error.status && error.status < 500) {
        throw error;
      }
      if (attempt < maxRetries) {
        await new Promise(function(resolve) { return setTimeout(resolve, UPLOAD_RETRY_DELAY_MS * (attempt + 1)); });
      }
    }
  }
  throw lastError || new Error("Upload failed after retries.");
}

export async function getAttachmentDownload(sessionId, attachmentId, {
  targetPath = process.cwd(),
  thumbnail = false,
} = {}) {

  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) throw new Error("session id is required.");

  const session = await resolveSessionAuth({ targetPath });
  const apiBaseUrl = resolveApiBaseUrl(session);
  const qs = thumbnail ? "?thumbnail=1" : "";
  const endpoint = `${apiBaseUrl}/api/v1/sessions/${urlPathSegment(normalizedSessionId, { label: "sessionId" })}/attachments/${urlPathSegment(String(attachmentId), { label: "attachmentId" })}${qs}`;

  const credential = await credentialFor(session);
  return requestJson(endpoint, {
    method: "GET",
    credential,
  });
}

export async function downloadAttachmentToFile(downloadUrl, outputPath, expectedSha256, {
  maxRetries = UPLOAD_RETRY_MAX,
} = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new SentinelayerApiError("Download failed: " + response.status, {
          status: response.status,
          code: "DOWNLOAD_FAILED",
        });
      }

      const writeStream = createWriteStream(outputPath);
      const hash = createHash("sha256");

      const reader = response.body.getReader();
      const pump = async function() {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          hash.update(chunk.value);
          writeStream.write(chunk.value);
        }
      };
      await pump();
      await new Promise(function(resolve, reject) {
        writeStream.end(function(err) { return err ? reject(err) : resolve(); });
      });

      const actualSha256 = hash.digest("hex");
      if (expectedSha256 && actualSha256 !== expectedSha256) {
        throw new SentinelayerApiError(
          "SHA-256 mismatch: expected " + expectedSha256 + ", got " + actualSha256,
          { status: 422, code: "SHA256_MISMATCH" },
        );
      }
      return { sha256: actualSha256 };
    } catch (error) {
      lastError = error;
      if (error instanceof SentinelayerApiError && error.code === "SHA256_MISMATCH") {
        throw error;
      }
      if (attempt < maxRetries) {
        await new Promise(function(resolve) { return setTimeout(resolve, UPLOAD_RETRY_DELAY_MS * (attempt + 1)); });
      }
    }
  }
  throw lastError || new Error("Download failed after retries.");
}

export async function fileSha256(filePath) {
  const hash = createHash("sha256");
  const readStream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  for await (const chunk of readStream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export function guessMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".ico": "image/x-icon",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".ts": "text/typescript",
    ".csv": "text/csv",
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
  };
  return map[ext] || "application/octet-stream";
}

export function isImageMimeType(mimeType) {
  return /^image\//.test(String(mimeType || ""));
}

export function isPdfMimeType(mimeType) {
  return String(mimeType || "") === "application/pdf";
}

export async function pollAttachmentUntilReady(sessionId, attachmentId, {
  targetPath = process.cwd(),
  maxAttempts = COMPLETE_POLL_MAX,
  delayMs = COMPLETE_POLL_DELAY_MS,
} = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) throw new Error("session id is required.");

  const session = await resolveSessionAuth({ targetPath });
  const apiBaseUrl = resolveApiBaseUrl(session);
  const endpoint = `${apiBaseUrl}/api/v1/sessions/${urlPathSegment(normalizedSessionId, { label: "sessionId" })}/attachments/${urlPathSegment(String(attachmentId), { label: "attachmentId" })}`;
  const credential = await credentialFor(session);

  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const result = await requestJson(endpoint, {
        credential,
        operationName: ATTACHMENT_POLL_OP,
      });
      if (result && result.status === "ready") return result;
      if (result && result.status === "failed") {
        throw new SentinelayerApiError("Attachment processing failed.", {
          status: 422,
          code: "ATTACHMENT_PROCESSING_FAILED",
        });
      }
    } catch (error) {
      if (error instanceof SentinelayerApiError && error.code === "ATTACHMENT_PROCESSING_FAILED") {
        throw error;
      }
      lastError = error;
      if (error instanceof SentinelayerApiError && error.status && error.status < 500) {
        throw error;
      }
    }
    if (attempt < maxAttempts - 1) {
      await new Promise(function(resolve) { return setTimeout(resolve, delayMs * (attempt + 1)); });
    }
  }
  throw lastError || new SentinelayerApiError("Attachment processing timed out.", {
    status: 504,
    code: "ATTACHMENT_PROCESSING_TIMEOUT",
  });
}

export async function uploadAttachment(sessionId, filePath, {
  targetPath = process.cwd(),
  fileName: explicitFileName,
} = {}) {
  const fileStat = await stat(filePath);
  if (fileStat.size > MAX_FILE_SIZE_BYTES) {
    throw new SentinelayerApiError("File exceeds maximum upload size (50 MiB).", {
      status: 413,
      code: "FILE_TOO_LARGE",
    });
  }

  const sha256 = await fileSha256(filePath);
  const resolvedName = explicitFileName || path.basename(filePath);
  const mimeType = guessMimeType(resolvedName);

  const initResult = await initAttachment(sessionId, resolvedName, mimeType, fileStat.size, { targetPath, sha256 });
  const uploadUrl = initResult.upload ? initResult.upload.url : initResult.uploadUrl;
  if (!initResult || !initResult.attachmentId || !uploadUrl) {
    throw new SentinelayerApiError("Attachment init returned incomplete data.", {
      status: 502,
      code: "INCOMPLETE_INIT",
    });
  }

  await uploadStreamToUrl(uploadUrl, filePath, { headers: initResult.upload ? initResult.upload.headers : undefined });

  const completeResult = await completeAttachment(sessionId, initResult.attachmentId, sha256, { targetPath });

  await pollAttachmentUntilReady(sessionId, initResult.attachmentId, { targetPath });

  return { attachmentId: initResult.attachmentId, sha256, fileName: resolvedName, mimeType, completeResult };
}

export async function fetchAndReturnAttachment(sessionId, attachmentId, {
  targetPath = process.cwd(),
  thumbnail = false,
} = {}) {
  const meta = await getAttachmentDownload(sessionId, attachmentId, { targetPath, thumbnail });
  if (!meta || !meta.downloadUrl) {
    throw new SentinelayerApiError("Attachment download info incomplete.", {
      status: 502,
      code: "INCOMPLETE_DOWNLOAD_INFO",
    });
  }

  const response = await fetch(meta.downloadUrl);
  if (!response.ok) {
    throw new SentinelayerApiError("Download failed: " + response.status, {
      status: response.status,
      code: "DOWNLOAD_FAILED",
    });
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const mimeType = meta.mimeType || response.headers.get("content-type") || "application/octet-stream";

  return {
    buffer: buffer,
    mimeType: mimeType,
    fileName: meta.fileName || ("attachment-" + attachmentId),
    sha256: meta.sha256,
    pageCount: meta.pageCount,
    extractedText: meta.extractedText,
  };
}
