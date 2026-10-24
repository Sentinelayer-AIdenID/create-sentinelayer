/**
 * EW04 source-byte intake. The caller owns the source registry, origin allowlist,
 * authorization decision and byte reader. In particular, `read` must be a
 * trusted connector (for example, a repository blob reader); this module does
 * not turn a URL from page content into a network request.
 *
 * Capture is deliberately before extraction: the returned bytes and digest are
 * the evidence an extractor must cite. A schema-valid snapshot alone does not
 * make extracted assertions authoritative.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { sourceSnapshotSchema } from "./contracts/source-snapshot.js";

export const MAX_SOURCE_BYTES = 1024 * 1024;
const DEFAULT_SOURCE_BYTES = 256 * 1024;
const TEXT_TYPES = new Set(["text/plain", "text/html", "application/json"]);
// Public guides may name credential variables. Reject credential-shaped values
// without treating a variable name such as AIDENID_API_KEY as a leaked key.
const CREDENTIAL_VALUES = [
  /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,})/,
  /(?:AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]+PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/,
  /authorization\s*:\s*bearer\s+[A-Za-z0-9._~+/-]{24,}/i,
  /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{24,}/i,
];

export class SourceIntakeError extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceIntakeError";
    this.code = code;
  }
}

function reject(code) {
  throw new SourceIntakeError(code);
}

function approvedUrl(raw, allowedOrigins) {
  if (typeof raw !== "string" || !(allowedOrigins instanceof Set)) reject("source_not_approved");
  let url;
  try {
    url = new URL(raw);
  } catch {
    reject("source_not_approved");
  }
  if (
    url.href !== raw || url.protocol !== "https:" || url.username || url.password ||
    url.search || url.hash || isIP(url.hostname) || !allowedOrigins.has(url.origin)
  ) reject("source_not_approved");
  return url.href;
}

async function boundedBytes(body, limit) {
  if (body instanceof Uint8Array) {
    if (body.byteLength > limit) reject("source_too_large");
    return Buffer.from(body);
  }
  if (!body || typeof body[Symbol.asyncIterator] !== "function") reject("source_rejected");
  const chunks = [];
  let length = 0;
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) reject("source_rejected");
    length += chunk.byteLength;
    if (length > limit) reject("source_too_large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, length);
}

/**
 * Capture a registered source into an EW02 SourceSnapshot and bounded bytes.
 * `authorize` must consult the real tenant policy; `sources` and
 * `allowedOrigins` must be maintained by the site owner, not by page content.
 * `read` receives only that registered URL and must not follow redirects. Its
 * result must report the final URL, status, media type and byte stream.
 */
export async function captureSourceBytes({
  sourceId,
  tenantScope,
  sources,
  allowedOrigins,
  authorize,
  read,
  capturedAt = () => new Date().toISOString(),
  maxBytes = DEFAULT_SOURCE_BYTES,
} = {}) {
  if (
    typeof sourceId !== "string" || !sourceId ||
    typeof tenantScope !== "string" || !tenantScope ||
    typeof authorize !== "function"
  ) reject("source_access_denied");
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SOURCE_BYTES) {
    reject("invalid_source_limit");
  }

  // No source lookup or reader invocation until the tenant policy grants access.
  let permitted = false;
  try {
    permitted = await authorize({ tenantScope, sourceId });
  } catch {
    reject("source_access_denied");
  }
  if (permitted !== true) reject("source_access_denied");

  const source = sources instanceof Map ? sources.get(sourceId) : undefined;
  if (!source || source.tenantScope !== tenantScope || source.visibility !== "public") {
    reject("source_not_approved");
  }
  const url = approvedUrl(source.url, allowedOrigins);
  if (typeof source.version !== "string" || !source.version ||
      !["api", "ingest", "import"].includes(source.sourceType) ||
      !TEXT_TYPES.has(source.mediaType) ||
      typeof read !== "function") reject("source_not_approved");

  let response;
  try {
    response = await read({ sourceId, tenantScope, url, maxBytes });
  } catch {
    reject("source_unavailable");
  }
  let declaredLength;
  try {
    declaredLength = response?.contentLength;
    if (
      response?.status !== 200 || response.url !== url ||
      typeof response.mediaType !== "string" ||
      response.mediaType.split(";", 1)[0].trim().toLowerCase() !== source.mediaType.toLowerCase() ||
      (declaredLength !== undefined &&
        (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes))
    ) reject("source_rejected");
  } catch {
    reject("source_rejected");
  }

  let bytes;
  try {
    bytes = await boundedBytes(response.body, maxBytes);
  } catch (error) {
    if (error instanceof SourceIntakeError) throw error;
    reject("source_unavailable");
  }
  if (declaredLength !== undefined && declaredLength !== bytes.length) {
    reject("source_rejected");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    reject("source_rejected");
  }
  // This first slice accepts public text only. A private/authenticated connector
  // needs its own grant and content policy; a token in public source is denied.
  if (CREDENTIAL_VALUES.some((pattern) => pattern.test(text))) reject("source_rejected");

  let snapshot;
  try {
    snapshot = sourceSnapshotSchema.parse({
      sourceId,
      sourceType: source.sourceType,
      version: source.version,
      capturedAt: capturedAt(),
      tenantScope,
      contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      metadata: { origin: new URL(url).origin, mediaType: source.mediaType, byteLength: bytes.length },
    });
  } catch {
    reject("source_rejected");
  }
  return { snapshot, bytes };
}
