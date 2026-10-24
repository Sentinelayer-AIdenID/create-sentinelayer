import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { createDelegatedPrincipalVerifier } from "../src/engram/principal.js";

const NOW = Date.parse("2026-10-24T00:00:00Z");
const TOKEN = "test-secret-that-must-never-appear";
const REQUEST = Object.freeze({ tenantId: "tenant/acme", action: "read", resourceId: "article/7" });
const claims = Object.freeze({
  verified: true,
  issuer: "https://id.example.test", audience: "https://site.example.test", subject: "shopper/42",
  clientId: "agent/child", tenantId: "tenant/acme", scopes: ["read"],
  delegationId: "grant-child", issuedAt: "2026-10-23T23:00:00Z", expiresAt: "2026-10-24T01:00:00Z",
});
const parent = Object.freeze({
  id: "grant-parent", subject: "shopper/42", clientId: "agent/parent", tenantId: "tenant/acme",
  actions: ["read", "write"], resources: ["article/7", "article/8"],
  issuedAt: "2026-10-23T22:00:00Z", expiresAt: "2026-10-24T02:00:00Z",
  spend: { currency: "USD", minor: 5000 },
});
const child = Object.freeze({
  id: "grant-child", subject: "shopper/42", clientId: "agent/child", delegatorId: "agent/parent",
  parentId: "grant-parent", tenantId: "tenant/acme", actions: ["read"], resources: ["article/7"],
  issuedAt: "2026-10-23T23:00:00Z", expiresAt: "2026-10-24T01:00:00Z",
  spend: { currency: "USD", minor: 1000 },
});

function harness({ token = claims, grants = { "grant-child": child, "grant-parent": parent }, revoked = [],
  verifyCredential = async () => token, loadGrant = async (id) => grants[id],
  isRevoked = async (id) => revoked.includes(id) } = {}) {
  return createDelegatedPrincipalVerifier({
    issuer: "https://id.example.test", audience: "https://site.example.test", now: () => NOW,
    verifyCredential, loadGrant, isRevoked,
  });
}

test("server-verified credential and bounded parent delegation produce only a redacted principal", async () => {
  const result = await harness().verify({ credential: TOKEN, request: REQUEST });
  assert.equal(result.status, "verified");
  assert.deepEqual(result.principal, {
    kind: "verified_agent", subject: "shopper/42", clientId: "agent/child",
    tenantId: "tenant/acme", resourceId: "article/7", scopes: ["read"],
  });
  assert.equal(result.receipt.reason, "scope_verified");
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("no credential stays anonymous; a declared agent name cannot confer authority", async () => {
  let called = false;
  const verifier = harness({ verifyCredential: async () => { called = true; throw Error("must not run"); } });
  const result = await verifier.verify({ request: { ...REQUEST, agentName: "trusted-operator", purpose: "buy" } });
  assert.equal(result.status, "anonymous");
  assert.equal(result.principal, null);
  assert.equal(called, false);
});

test("credential proof errors fail closed without echoing tokens or provider exceptions", async () => {
  const result = await harness({ verifyCredential: async () => { throw Error(`bad ${TOKEN}`); } })
    .verify({ credential: TOKEN, request: REQUEST });
  assert.equal(result.status, "denied");
  assert.equal(result.receipt.reason, "credential_unverified");
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("issuer, audience, subject, tenant, token scope and expiry are checked after signature verification", async () => {
  const variants = [
    [{ verified: false }, "credential_unverified"],
    [{ issuer: "https://evil.example.test" }, "credential_mismatch"],
    [{ audience: "https://other.example.test" }, "credential_mismatch"],
    [{ subject: "shopper/99" }, "delegation_mismatch"],
    [{ clientId: "agent/stranger" }, "delegation_mismatch"],
    [{ tenantId: "tenant/other" }, "credential_mismatch"],
    [{ scopes: ["write"] }, "insufficient_scope"],
    [{ expiresAt: "2026-10-24T00:00:00Z" }, "credential_expired"],
  ];
  for (const [change, reason] of variants) {
    const result = await harness({ token: { ...claims, ...change } }).verify({ credential: TOKEN, request: REQUEST });
    assert.equal(result.status, "denied", JSON.stringify(change));
    assert.equal(result.receipt.reason, reason, JSON.stringify(change));
  }
});

test("the server reloads grants and revocation on each request", async () => {
  let revoked = false;
  let loads = 0;
  const verifier = harness({
    loadGrant: async (id) => { loads += 1; return { "grant-child": child, "grant-parent": parent }[id]; },
    isRevoked: async (id) => revoked && id === "grant-parent",
  });
  assert.equal((await verifier.verify({ credential: TOKEN, request: REQUEST })).status, "verified");
  revoked = true;
  const second = await verifier.verify({ credential: TOKEN, request: REQUEST });
  assert.equal(second.status, "denied");
  assert.equal(second.receipt.reason, "delegation_revoked");
  assert.equal(loads, 4);
});

test("missing, cyclic, malformed or unconfirmed revocation authority cannot yield a principal", async () => {
  const cases = [
    { grants: { "grant-child": child } },
    { grants: { "grant-child": { ...child, parentId: "grant-child" } } },
    { grants: { "grant-child": { ...child, tenantId: "tenant/other" }, "grant-parent": parent } },
    { isRevoked: async () => undefined },
  ];
  for (const options of cases) {
    const result = await harness(options).verify({ credential: TOKEN, request: REQUEST });
    assert.equal(result.status, "denied", JSON.stringify(options));
    assert.equal(result.principal, null);
  }
});

test("wrong resource and child privilege, TTL or spend expansion are rejected", async () => {
  const wrongResource = await harness().verify({ credential: TOKEN, request: { ...REQUEST, resourceId: "article/8" } });
  assert.equal(wrongResource.receipt.reason, "delegation_out_of_scope");
  for (const change of [
    { actions: ["read", "delete"] },
    { resources: ["article/7", "article/9"] },
    { expiresAt: "2026-10-24T03:00:00Z" },
    { spend: { currency: "USD", minor: 6000 } },
    { spend: { currency: "EUR", minor: 1000 } },
    { delegatorId: "agent/stranger" },
  ]) {
    const result = await harness({ grants: { "grant-child": { ...child, ...change }, "grant-parent": parent } })
      .verify({ credential: TOKEN, request: REQUEST });
    assert.equal(result.status, "denied", JSON.stringify(change));
    assert.equal(result.receipt.reason, "delegation_invalid", JSON.stringify(change));
  }
});

test("revocation and unavailable grant authority fail closed at every generation", async () => {
  for (const revoked of [["grant-child"], ["grant-parent"]]) {
    const result = await harness({ revoked }).verify({ credential: TOKEN, request: REQUEST });
    assert.equal(result.receipt.reason, "delegation_revoked");
  }
  const unavailable = await harness({ loadGrant: async () => { throw Error(TOKEN); } })
    .verify({ credential: TOKEN, request: REQUEST });
  assert.equal(unavailable.status, "denied");
  assert.equal(unavailable.receipt.reason, "delegation_unavailable");
  assert.equal(JSON.stringify(unavailable).includes(TOKEN), false);
});

test("a valid identity does not itself authorize a purchase", async () => {
  const grant = { ...child, actions: ["read", "purchase"] };
  const root = { ...parent, actions: ["read", "write", "purchase"] };
  const result = await harness({
    token: { ...claims, scopes: ["read", "purchase"] },
    grants: { "grant-child": grant, "grant-parent": root },
  }).verify({ credential: TOKEN, request: { ...REQUEST, action: "purchase" } });
  assert.equal(result.status, "denied");
  assert.equal(result.receipt.reason, "transaction_authorization_required");
});
