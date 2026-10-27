/**
 * ENGRAM §2 — Memory-as-a-Service: detachable public entry point.
 *
 * This barrel is the sellable-alone surface: the 3 tools + the store, trust,
 * governance, and namespace seams, over the §1 recall engine. It imports NO
 * SentinelLayer session/mcp/auth runtime — the SL session is just ONE injected
 * store adapter (see the CLI wiring in src/mcp/session-stdio-server.js).
 */

export { createStore, itemId, LegacyStorageError } from "./store.js";
export {
  compileGraph,
  compileCandidate,
  CompileGraphError,
  EW05_PREDICATES,
  EW05_PREDICATE_SET,
  ENTITY_KIND,
  GENERATION_STATUS,
} from "./compile-graph.js";
export {
  parseNamespace,
  authorize,
  createLocalConsent,
  createScopedConsent,
  AccessDeniedError,
  ACTION_SCOPES,
} from "./namespace.js";
export {
  TRUST_LEVELS,
  AUTHORITATIVE_FLOOR,
  classifyWrite,
  classifyObservation,
  isAuthoritative,
  trustRank,
  sealItem,
  visibleUnderScope,
} from "./trust.js";
export { createGovernance } from "./governance.js";
export { createMemoryTools } from "./tools.js";
export { runEngramSla } from "./sla.js";
export * from "./contracts/index.js";
export { ingestDocumentIntoNamespace } from "./ingest-document.js";
export { captureSourceBytes, SourceIntakeError, MAX_SOURCE_BYTES } from "./source-intake.js";
export { createSafeReader, SafeReaderError } from "./safe-reader.js";
export { extractFromHtml } from "./extract-html.js";
export { ingestSite } from "./ingest-site.js";
export {
  createGraphStore,
  GraphValidationError,
  VersionNotFoundError,
  IntegrityError,
} from "./graph-store.js";
export {
  buildSiteRetrievalIndex,
  retrieveSiteEntities,
  retrieveFromGraphStore,
  RETRIEVE_SITE_INDEX_VERSION,
  REQUIRED_EMBEDDER_DIM,
  SITE_RETRIEVAL_DEFAULTS,
} from "./retrieve-site.js";


import { createStore } from "./store.js";
import { createLocalConsent } from "./namespace.js";
import { createGovernance } from "./governance.js";
import { createBuildState } from "./build-state.js";
import { ingestDocumentIntoNamespace } from "./ingest-document.js";
import { createMemoryTools } from "./tools.js";
import { createEmbedder } from "../session/recall/embedder.js";

const DEFAULT_CONSENT = Symbol("default consent");

/**
 * Convenience factory: wire a default CLI-local MaaS instance (permissive-local
 * consent, stub governance, hash-projection embedder) over a store. Callers
 * inject `adapters` (e.g. { session }) to make a kind a first-class namespace.
 *
 * @param {object} options
 * @param {string} options.storeRoot
 * @param {Record<string,Function>} [options.adapters]
 * @param {object} [options.embedder]
 * @param {object} [options.consent]
 * @param {object} [options.governance]
 * @param {object} [options.renderer]
 * @returns {{tools: object, store: object}}
 */
export function createMemoryService(options = {}) {
  const {
    storeRoot,
    adapters = {},
    embedder = createEmbedder(),
    consent: rawConsent = DEFAULT_CONSENT,
    governance = createGovernance(),
    renderer = null,
    isAuthorizedForSealed,
  } = options;

  // Detect whether the caller injected a consent.  When options.consent is
  // undefined the rawConsent is the DEFAULT_CONSENT sentinel; any other
  // value (including createLocalConsent() passed explicitly) means the
  // caller injected one.
  const callerInjectedConsent = rawConsent !== DEFAULT_CONSENT;
  const consent = callerInjectedConsent ? rawConsent : createLocalConsent();

  // Default local consent: use "first-claim" to migrate legacy dirs
  // safely (one user's own namespaces, no cross-tenant risk).
  // Injected (non-default) consent: "refuse" — never trust legacy dirs
  // when a scoped or hosted consent is in play.
  const legacyLossyDirs = callerInjectedConsent ? "refuse" : "first-claim";

  const store = createStore({ storeRoot, adapters, legacyLossyDirs });
  // Wired by DEFAULT, not opt-in: a readiness gate nobody injects is a comment.
  const buildState = createBuildState({ storeRoot, legacyLossyDirs });
  const tools = createMemoryTools({ store, consent, governance, embedder, renderer, isAuthorizedForSealed, buildState });
  // Exposed on the service so the lifecycle cannot be bypassed by a caller who has a
  // store but forgets the buildState -- the deps are bound here, once.
  const ingestDocument = (opts) =>
    ingestDocumentIntoNamespace({ ...opts, deps: { store, buildState } });
  return { tools, store, buildState, ingestDocument };
}
