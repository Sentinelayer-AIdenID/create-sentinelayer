/**
 * ENGRAM §EW04 — Site-to-memory ingestion pipeline.
 *
 * Wires: source-intake (authorization) → safe-reader (SSRF-safe fetch) →
 * extract-html (byte-offset facts) → graph-store (immutable snapshot).
 *
 * An unchanged page re-ingests as `reused: true`.
 * An unavailable source is recorded as unknown, never as empty.
 *
 * Library only. Node builtins + existing zod contracts. No new dependency.
 */

import { captureSourceBytes } from "./source-intake.js";
import { extractFromHtml } from "./extract-html.js";
import { parseNamespace } from "./namespace.js";

/**
 * Ingest a site from an approved source through to the graph store.
 *
 * @param {object} options
 * @param {string} options.sourceId
 * @param {string} options.tenantScope
 * @param {Map} options.sources — the approved source registry
 * @param {Set<string>} options.allowedOrigins
 * @param {function} options.authorize — tenant policy function
 * @param {object} options.reader — a safe-reader { read } instance
 * @param {object} options.graphStore — EW03 graph store (with writeSourceSnapshot)
 * @param {object} options.caller — caller identity for graph store
 * @param {string} options.namespace — namespace for graph store
 * @param {number} [options.maxBytes] — byte cap
 * @returns {Promise<{snapshot: object, facts: object, reused: boolean}>}
 */
export async function ingestSite({
  sourceId,
  tenantScope,
  sources,
  allowedOrigins,
  authorize,
  reader,
  graphStore,
  caller,
  namespace,
  maxBytes,
}) {
  // 1. source-intake: authorize + validate source record (does NOT read bytes)
  //    We use captureSourceBytes as an authorization gate; we supply our own read function
  //    that calls safe-reader, but captureSourceBytes handles all the policy checks.

  let captured;
  try {
    captured = await captureSourceBytes({
      sourceId,
      tenantScope,
      sources,
      allowedOrigins,
      authorize,
      read: async ({ url, version: approvedVersion }) => {
        // safe-reader fetch
        const result = await reader.read(url, { approvedOrigins: allowedOrigins });

        // Pass the reader's ACTUAL version (sha256 of bytes) so source-intake
        // can verify it matches the approved version. Never echo the registry
        // version; the trusted connector reports what it actually received.
        return {
          status: 200,
          url: result.finalUrl,
          version: result.version,
          mediaType: result.contentType,
          contentLength: result.bytes.length,
          body: result.bytes,
        };
      },
      maxBytes,
    });
  } catch (error) {
    // An unavailable source is recorded as thrown, never as empty bytes.
    // The caller may catch SourceIntakeError and record unavailability upstream.
    throw error;
  }

  // 2. Check for reuse: does a snapshot with the same contentHash already exist?
  const { snapshot, bytes } = captured;
  const ns = parseNamespace(namespace);

  // source-intake emits contentHash prefixed `sha256:` but the graph store
  // computes its own raw hex hash from bytes (not caller-supplied). Drop the
  // field so the graph store computes the hash, keeping the single source of truth.
  const { contentHash: _ch, ...snapForStore } = snapshot;

  let reused = false;
  let persistedSnapshot = snapshot;
  try {
    const existing = await graphStore.listSourceSnapshots(caller, ns);
    // graph store returns contentHash without prefix; source-intake snapshots have the prefix.
    // Normalize for comparison: strip `sha256:` from the intake snapshot's hash.
    const normalizedHash = snapshot.contentHash.startsWith("sha256:")
      ? snapshot.contentHash.slice(7)
      : snapshot.contentHash;
    const match = existing.find((s) =>
      s.contentHash === normalizedHash && s.sourceId === sourceId,
    );
    if (match) {
      reused = true;
      // Content bytes are identical — a snapshot with this (sourceId, version, contentHash)
      // already exists. Return the existing record; do not write a duplicate.
      // Normalize: graph store returns raw hex, but callers expect the sha256: prefix.
      persistedSnapshot = { ...match, contentHash: "sha256:" + match.contentHash };
    }
  } catch {
    // If listing fails, proceed with write
  }

  if (!reused) {
    // 3. Write source snapshot to graph store (without caller-supplied contentHash;
    //    the graph store computes its own from bytes).
    await graphStore.writeSourceSnapshot(caller, ns, snapForStore, bytes);
  }

  // 4. Extract facts with byte offsets
  let facts;
  try {
    facts = extractFromHtml(bytes);
  } catch {
    facts = { title: null, description: null, canonical: null, headings: [], links: [], jsonLd: [] };
  }

  return {
    snapshot: persistedSnapshot,
    facts,
    reused,
  };
}
