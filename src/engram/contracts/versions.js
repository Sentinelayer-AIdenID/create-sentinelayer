/**
 * ENGRAM §EW02 — Contract version constants and compatibility fixtures.
 *
 * Every contract schema carries a canonical version. Consumers use these
 * constants to declare which contract version they were built against, and
 * compatibility fixtures verify that old data surfaces parse against the
 * current schemas.
 */

/**
 * Canonical schema versions for EW02 contracts.
 * Bump these when a contract changes in a way that existing fixtures would
 * no longer validate.
 */
export const CONTRACT_VERSIONS = Object.freeze({
  graph: "1.0.0",
  capability: "1.0.0",
  evidence: "1.0.0",
  money: "1.0.0",
  sourceSnapshot: "1.0.0",
  mediaAsset: "1.0.0",
  temporalSegment: "1.0.0",
  taskContextPack: "1.0.0",
  actionReceipt: "1.0.0",
});

/**
 * The supported graph schema version string.
 */
export const GRAPH_SCHEMA_VERSION = "1.0.0";

/**
 * The supported evidence schema version string.
 */
export const EVIDENCE_SCHEMA_VERSION = "1.0.0";

/**
 * Backward-compatibility fixture: a graph from a previous version that must
 * still validate against the current schema (or be explicitly rejected with a
 * clear migration path).
 */
export const COMPAT_FIXTURES = Object.freeze({
  /** Graph v1.0.0 minimal valid fixture. */
  graphV1: Object.freeze({
    version: "1.0.0",
    assertions: [
      {
        id: "assert-v1-001",
        subject: "entity/a",
        predicate: "connected_to",
        object: { target: "entity/b" },
        provenance: "observed",
        schemaValidity: "valid",
        source: {
          sourceId: "src-compat-v1",
          version: "1.0.0",
          capturedAt: "2026-10-23T00:00:00Z",
          tenantScope: "tenant/default",
        },
      },
    ],
    generatedAt: "2026-10-23T00:00:00Z",
  }),
});
