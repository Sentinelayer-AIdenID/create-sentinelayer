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
  // The key may be quoted, as in JSON ("api_key": "...") or YAML ('token': ...).
  /(?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{24,}/i,
];

export class SourceIntakeError extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceIntakeError";
    this.code = code;
  }
}

const OWN_ERRORS = new WeakSet();
const CODES = new Set([
  "invalid_source_limit", "source_access_denied", "source_not_approved",
  "source_rejected", "source_too_large", "source_unavailable",
]);

function reject(code) {
  // Frozen: a caller that kept an error from an earlier call cannot rewrite its message or code and replay it.
  const error = Object.freeze(new SourceIntakeError(code));
  OWN_ERRORS.add(error);
  throw error;
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
    url.search || url.hash || isIP(url.hostname.replace(/^\[|\]$/g, "")) || !allowedOrigins.has(url.origin)
  ) reject("source_not_approved");
  return url.href;
}

function unchangedApprovedSource(current, approved, allowedOrigins) {
  try {
    return current?.tenantScope === approved.tenantScope &&
      current.visibility === approved.visibility &&
      current.version === approved.version &&
      current.sourceType === approved.sourceType &&
      current.mediaType === approved.mediaType &&
      approvedUrl(current.url, allowedOrigins) === approved.url;
  } catch {
    return false;
  }
}

// The TypedArray intrinsic getters: a reader-supplied view can shadow .byteLength/.byteOffset/.buffer with
// own properties, so the cap and the copy read the real values through these, never through the object.
const TYPED_ARRAY = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsic = (name) => Object.getOwnPropertyDescriptor(TYPED_ARRAY, name).get;
const VIEW_LENGTH = intrinsic("byteLength");
const VIEW_OFFSET = intrinsic("byteOffset");
const VIEW_BUFFER = intrinsic("buffer");
// A stream may only yield this many chunks in total, so endless empty chunks cannot hold a capture open.
export const MAX_SOURCE_CHUNKS = 4096;

function copyView(view) {
  const length = Reflect.apply(VIEW_LENGTH, view, []);
  return { length, copy: () => Buffer.from(new Uint8Array(Reflect.apply(VIEW_BUFFER, view, []), Reflect.apply(VIEW_OFFSET, view, []), length)) };
}

async function boundedBytes(body, limit) {
  if (body instanceof Uint8Array) {
    const view = copyView(body);
    if (view.length > limit) reject("source_too_large");
    return view.copy();
  }
  if (!body || typeof body[Symbol.asyncIterator] !== "function") reject("source_rejected");
  const chunks = [];
  let length = 0;
  let count = 0;
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) reject("source_rejected");
    count += 1;
    if (count > MAX_SOURCE_CHUNKS) reject("source_too_large");
    const view = copyView(chunk);
    if (view.length === 0) continue; // never retain empty chunks
    length += view.length;
    if (length > limit) reject("source_too_large");
    chunks.push(view.copy());
  }
  return Buffer.concat(chunks, length);
}

/**
 * Capture a registered source into an EW02 SourceSnapshot and bounded bytes.
 * `authorize` must consult the real tenant policy and is called again before
 * returning captured bytes; `sources` and
 * `allowedOrigins` must be maintained by the site owner, not by page content.
 * `read` receives the approved URL and immutable source version, and must not
 * follow redirects. It must report the actual version of the returned bytes,
 * not echo the requested version; only the trusted connector can make that
 * assertion. Its result must also report the final URL, status and media type.
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

  let approved;
  try {
    const source = sources instanceof Map ? sources.get(sourceId) : undefined;
    approved = source && Object.freeze({
      tenantScope: source.tenantScope,
      visibility: source.visibility,
      url: source.url,
      version: source.version,
      sourceType: source.sourceType,
      mediaType: source.mediaType,
    });
  } catch {
    reject("source_not_approved");
  }
  if (!approved || approved.tenantScope !== tenantScope || approved.visibility !== "public") {
    reject("source_not_approved");
  }
  const url = approvedUrl(approved.url, allowedOrigins);
  if (typeof approved.version !== "string" || !approved.version ||
      (approved.sourceType !== "api" && approved.sourceType !== "ingest" && approved.sourceType !== "import") ||
      !TEXT_TYPES.has(approved.mediaType) ||
      typeof read !== "function") reject("source_not_approved");

  let response;
  try {
    response = await read({ sourceId, tenantScope, url, version: approved.version, maxBytes });
  } catch {
    reject("source_unavailable");
  }
  let declaredLength;
  try {
    declaredLength = response?.contentLength;
    if (
      response?.status !== 200 || response.url !== url || response.version !== approved.version ||
      typeof response.mediaType !== "string" ||
      response.mediaType.split(";", 1)[0].trim().toLowerCase() !== approved.mediaType.toLowerCase() ||
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
    // Never rethrow the caught object: a body stream can throw anything, including one of our own earlier errors.
    // Re-raise only a fresh error carrying an allow-listed code.
    if (OWN_ERRORS.has(error) && CODES.has(error.code)) reject(error.code);
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
      sourceType: approved.sourceType,
      version: approved.version,
      capturedAt: capturedAt(),
      tenantScope,
      contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      metadata: { origin: new URL(url).origin, mediaType: approved.mediaType, byteLength: bytes.length },
    });
  } catch {
    reject("source_rejected");
  }

  // A read may outlive owner policy or source-version changes. Never return
  // bytes with a snapshot from a different approved record or revoked grant.
  let stillPermitted = false;
  try {
    stillPermitted = await authorize({ tenantScope, sourceId });
  } catch {
    reject("source_access_denied");
  }
  if (stillPermitted !== true) reject("source_access_denied");
  let current;
  try {
    current = sources.get(sourceId);
  } catch {
    reject("source_not_approved");
  }
  if (!unchangedApprovedSource(current, approved, allowedOrigins)) reject("source_not_approved");
  return { snapshot, bytes };
}
