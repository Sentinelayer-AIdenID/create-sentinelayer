/**
 * EW11 preparation: turn a provider-verified credential and server-owned
 * delegation chain into a read-scoped, resource-bound principal for this one
 * request. This is not a token parser,
 * signature verifier, consent store, purchase authorizer, or endpoint policy.
 * AIdenID/OAuth verification and live revocation must be supplied by the
 * server; user text, task packs and behavioral labels never enter this seam.
 */

const MAX_DELEGATION_DEPTH = 8;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim() === value && value.trim().length > 0;
}

function instant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    return NaN;
  }
  return Date.parse(value);
}

function names(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every(nonempty);
}

function audienceMatches(value, audience) {
  return value === audience || (Array.isArray(value) && value.includes(audience));
}

function validSpend(spend) {
  return spend === undefined || (record(spend) && /^[A-Z]{3}$/.test(spend.currency) &&
    Number.isSafeInteger(spend.minor) && spend.minor >= 0);
}

function validGrant(grant) {
  return record(grant) && ["id", "subject", "clientId", "tenantId"].every((key) => nonempty(grant[key])) &&
    names(grant.actions) && names(grant.resources) && Number.isFinite(instant(grant.issuedAt)) &&
    Number.isFinite(instant(grant.expiresAt)) && instant(grant.issuedAt) < instant(grant.expiresAt) &&
    (grant.parentId === undefined || grant.parentId === null || nonempty(grant.parentId)) &&
    (grant.delegatorId === undefined || grant.delegatorId === null || nonempty(grant.delegatorId)) &&
    validSpend(grant.spend);
}

function covers(values, requested) {
  return values.includes("*") || values.includes(requested);
}

function childWithinParent(child, parent) {
  if (child.subject !== parent.subject || child.tenantId !== parent.tenantId ||
      child.delegatorId !== parent.clientId ||
      instant(child.issuedAt) < instant(parent.issuedAt) || instant(child.expiresAt) > instant(parent.expiresAt)) {
    return false;
  }
  if (!child.actions.every((action) => covers(parent.actions, action)) ||
      !child.resources.every((resource) => covers(parent.resources, resource))) {
    return false;
  }
  if (child.spend && (!parent.spend || child.spend.currency !== parent.spend.currency ||
      child.spend.minor > parent.spend.minor)) {
    return false;
  }
  return true;
}

function result(status, reason, principal = null) {
  // A receipt is safe to log: never interpolate credentials, provider errors,
  // arbitrary claims, or raw grant records into it.
  return Object.freeze({ status, principal, receipt: Object.freeze({ status, reason }) });
}

/**
 * Bind trusted server adapters once, outside untrusted request handling.
 * `verifyCredential` MUST verify signature/introspection, token revocation and
 * issuer before returning `{verified:true,...}`; this function rechecks the
 * resource audience and request bindings. `loadGrant` and `isRevoked` MUST read
 * server-owned, current records and fail if unavailable. No credentials are
 * persisted or returned here. Unknown or unavailable authority fails closed.
 */
export function createDelegatedPrincipalVerifier({
  issuer, audience, verifyCredential, loadGrant, isRevoked, now = Date.now,
} = {}) {
  if (!nonempty(issuer) || !nonempty(audience) || typeof verifyCredential !== "function" ||
      typeof loadGrant !== "function" || typeof isRevoked !== "function" || typeof now !== "function") {
    throw new TypeError("trusted issuer, audience, credential verifier, grant loader, revocation check and clock are required");
  }

  return Object.freeze({
    async verify({ credential, request } = {}) {
      let current;
      try {
        current = now();
      } catch {
        return result("denied", "authority_unavailable");
      }
      if (!record(request) || !["tenantId", "action", "resourceId"].every((key) => nonempty(request[key])) ||
          !Number.isFinite(current)) {
        return result("denied", "invalid_request");
      }
      if (credential === undefined || credential === null || credential === "") {
        // Public endpoints may choose to serve anonymous content. This result
        // grants no protected scope, even if a caller supplies an agent name.
        return result("anonymous", "missing_credential");
      }
      if (typeof credential !== "string") return result("denied", "credential_unverified");

      let claims;
      try {
        claims = await verifyCredential(credential, { issuer, audience });
      } catch {
        return result("denied", "credential_unverified");
      }
      if (!record(claims) || claims.verified !== true ||
          !["subject", "clientId", "tenantId", "delegationId"].every((key) => nonempty(claims[key])) ||
          !names(claims.scopes) || !Number.isFinite(instant(claims.issuedAt)) ||
          !Number.isFinite(instant(claims.expiresAt)) || instant(claims.issuedAt) >= instant(claims.expiresAt)) {
        return result("denied", "credential_unverified");
      }
      if (claims.issuer !== issuer || !audienceMatches(claims.audience, audience) ||
          claims.tenantId !== request.tenantId) {
        return result("denied", "credential_mismatch");
      }
      if (instant(claims.issuedAt) > current || instant(claims.expiresAt) <= current) {
        return result("denied", "credential_expired");
      }
      if (!claims.scopes.includes(request.action)) return result("denied", "insufficient_scope");

      const seen = new Set();
      let id = claims.delegationId;
      let child = null;
      let leaf = null;
      for (let depth = 0; id; depth += 1) {
        if (depth >= MAX_DELEGATION_DEPTH || seen.has(id)) return result("denied", "delegation_invalid");
        seen.add(id);
        let grant;
        let revoked;
        try {
          grant = await loadGrant(id);
          revoked = await isRevoked(id);
        } catch {
          return result("denied", "delegation_unavailable");
        }
        if (!validGrant(grant) || grant.id !== id || typeof revoked !== "boolean") {
          return result("denied", "delegation_invalid");
        }
        if (grant.parentId == null && grant.delegatorId != null) {
          return result("denied", "delegation_invalid");
        }
        if (revoked) return result("denied", "delegation_revoked");
        if (instant(grant.issuedAt) > current || instant(grant.expiresAt) <= current) {
          return result("denied", "delegation_expired");
        }
        if (grant.subject !== claims.subject || grant.tenantId !== claims.tenantId) {
          return result("denied", "delegation_mismatch");
        }
        if (!covers(grant.actions, request.action) || !covers(grant.resources, request.resourceId)) {
          return result("denied", "delegation_out_of_scope");
        }
        if (child && !childWithinParent(child, grant)) return result("denied", "delegation_invalid");
        if (!leaf) leaf = grant;
        child = grant;
        id = grant.parentId;
      }
      if (!leaf || leaf.clientId !== claims.clientId ||
          instant(claims.issuedAt) < instant(leaf.issuedAt) ||
          instant(claims.expiresAt) > instant(leaf.expiresAt)) {
        return result("denied", "delegation_mismatch");
      }
      // Transaction/confirmation/budget state is not implemented in this prep.
      // A scoped identity is never enough to execute a mutation or purchase.
      if (request.action !== "read") return result("denied", "transaction_authorization_required");

      return result("verified", "scope_verified", Object.freeze({
        kind: "verified_agent", subject: claims.subject, clientId: claims.clientId,
        tenantId: claims.tenantId, resourceId: request.resourceId,
        scopes: Object.freeze([request.action]),
      }));
    },
  });
}
