import "./setup-env.mjs";
// unit.engram-contracts-capability-index.test.mjs — EW08 capability index contract tests.

import test from "node:test";
import assert from "node:assert/strict";

import {
  skillSchema,
  capabilityIndexSchema,
  CapabilityIndexError,
  digestMismatch,
  indexExpired,
  originMismatch,
  capabilityRevoked,
} from "../src/engram/contracts/capability-index.js";

// ---------------------------------------------------------------------------
// skillSchema
// ---------------------------------------------------------------------------

test("skillSchema: accepts a valid public skill descriptor", () => {
  assert.equal(skillSchema.safeParse({
    capability: "site-retrieval",
    version: "site-retrieval@1.0.0",
    title: "Site Retrieval",
    purpose: "Fetch public site entities from the ENGRAM graph",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    outputSchema: { type: "object", properties: { entities: { type: "array" } } },
    scope: "read",
    sideEffects: "none",
    requiresConfirmation: false,
    visibility: "public",
  }).success, true);
});

test("skillSchema: accepts a write skill with simulated side effects and confirmation", () => {
  assert.equal(skillSchema.safeParse({
    capability: "demo-execute",
    version: "demo-execute@1.0.0",
    title: "Demo Execute",
    purpose: "Simulate a command execution and return a receipt",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
    outputSchema: { type: "object", properties: { receipt: { type: "object" } } },
    scope: "write",
    sideEffects: "simulated",
    requiresConfirmation: true,
    fallback: "This is a demo only — no real effects occur",
    visibility: "public",
  }).success, true);
});

test("skillSchema: REFUSES when version name does not match capability", () => {
  assert.equal(skillSchema.safeParse({
    capability: "site-retrieval",
    version: "wrong-name@1.0.0",
    title: "Site Retrieval",
    purpose: "Fetch",
    inputSchema: {},
    outputSchema: {},
    scope: "read",
    sideEffects: "none",
    requiresConfirmation: false,
    visibility: "public",
  }).success, false);
});

test("skillSchema: REFUSES empty title", () => {
  assert.equal(skillSchema.safeParse({
    capability: "x",
    version: "x@1.0.0",
    title: "",
    purpose: "p",
    inputSchema: {},
    outputSchema: {},
    scope: "read",
    sideEffects: "none",
    requiresConfirmation: false,
    visibility: "public",
  }).success, false);
});

test("skillSchema: REFUSES control characters in purpose", () => {
  assert.equal(skillSchema.safeParse({
    capability: "x",
    version: "x@1.0.0",
    title: "X",
    purpose: "bad\u0000char",
    inputSchema: {},
    outputSchema: {},
    scope: "read",
    sideEffects: "none",
    requiresConfirmation: false,
    visibility: "public",
  }).success, false);
});

test("skillSchema: REFUSES invalid scope", () => {
  assert.equal(skillSchema.safeParse({
    capability: "x",
    version: "x@1.0.0",
    title: "X",
    purpose: "x",
    inputSchema: {},
    outputSchema: {},
    scope: "execute",
    sideEffects: "none",
    requiresConfirmation: false,
    visibility: "public",
  }).success, false);
});

test("skillSchema: REFUSES invalid visibility", () => {
  assert.equal(skillSchema.safeParse({
    capability: "x",
    version: "x@1.0.0",
    title: "X",
    purpose: "x",
    inputSchema: {},
    outputSchema: {},
    scope: "read",
    sideEffects: "none",
    requiresConfirmation: false,
    visibility: "internal",
  }).success, false);
});

test("skillSchema: REFUSES oversized inputSchema", () => {
  const big = { type: "object", properties: {} };
  for (let i = 0; i < 5000; i++) big.properties[`k${i}`] = { type: "string" };
  assert.equal(skillSchema.safeParse({
    capability: "x",
    version: "x@1.0.0",
    title: "X",
    purpose: "x",
    inputSchema: big,
    outputSchema: {},
    scope: "read",
    sideEffects: "none",
    requiresConfirmation: false,
    visibility: "public",
  }).success, false);
});

test("skillSchema: REFUSES extra fields (strict)", () => {
  assert.equal(skillSchema.safeParse({
    capability: "x",
    version: "x@1.0.0",
    title: "X",
    purpose: "x",
    inputSchema: {},
    outputSchema: {},
    scope: "read",
    sideEffects: "none",
    requiresConfirmation: false,
    visibility: "public",
    bogusField: 42,
  }).success, false);
});

// ---------------------------------------------------------------------------
// capabilityIndexSchema
// ---------------------------------------------------------------------------

const validSkill = {
  capability: "site-retrieval",
  version: "site-retrieval@1.0.0",
  title: "Site Retrieval",
  purpose: "Fetch public site entities",
  inputSchema: {},
  outputSchema: {},
  scope: "read",
  sideEffects: "none",
  requiresConfirmation: false,
  visibility: "public",
};

const validIndex = {
  publisherOrigin: "https://shop.example",
  indexVersion: "1.0.0",
  issuedAt: "2026-10-27T00:00:00Z",
  expiresAt: "2026-10-28T00:00:00Z",
  revoked: [],
  skills: [validSkill],
  digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
};

test("capabilityIndexSchema: accepts a valid index", () => {
  assert.equal(capabilityIndexSchema.safeParse(validIndex).success, true);
});

test("capabilityIndexSchema: REFUSES non-https origin", () => {
  assert.equal(capabilityIndexSchema.safeParse({
    ...validIndex,
    publisherOrigin: "http://shop.example",
  }).success, false);
});

test("capabilityIndexSchema: REFUSES origin with path", () => {
  assert.equal(capabilityIndexSchema.safeParse({
    ...validIndex,
    publisherOrigin: "https://shop.example/path",
  }).success, false);
});

test("capabilityIndexSchema: REFUSES expiresAt before issuedAt", () => {
  assert.equal(capabilityIndexSchema.safeParse({
    ...validIndex,
    expiresAt: "2026-10-26T00:00:00Z",
  }).success, false);
});

test("capabilityIndexSchema: REFUSES private skills in index", () => {
  assert.equal(capabilityIndexSchema.safeParse({
    ...validIndex,
    skills: [{ ...validSkill, visibility: "private" }],
  }).success, false);
});

test("capabilityIndexSchema: REFUSES unsorted skills", () => {
  const skillB = { ...validSkill, capability: "b-tool", version: "b-tool@1.0.0" };
  const skillA = { ...validSkill, capability: "a-tool", version: "a-tool@1.0.0" };
  assert.equal(capabilityIndexSchema.safeParse({
    ...validIndex,
    skills: [skillB, skillA],
  }).success, false);
});

test("capabilityIndexSchema: REFUSES invalid revoked entry", () => {
  assert.equal(capabilityIndexSchema.safeParse({
    ...validIndex,
    revoked: ["not-a-valid-version"],
  }).success, false);
});

test("capabilityIndexSchema: REFUSES missing digest", () => {
  const { digest, ...noDigest } = validIndex;
  assert.equal(capabilityIndexSchema.safeParse(noDigest).success, false);
});

// ---------------------------------------------------------------------------
// Error constructors
// ---------------------------------------------------------------------------

test("digestMismatch: produces CapabilityIndexError with evidence", () => {
  const err = digestMismatch("sha256:aaaa", "sha256:bbbb", "evidence-addr");
  assert.ok(err instanceof CapabilityIndexError);
  assert.equal(err.evidence, "evidence-addr");
  assert.ok(err.message.includes("digest mismatch"));
});

test("indexExpired: produces CapabilityIndexError", () => {
  const err = indexExpired("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z");
  assert.ok(err instanceof CapabilityIndexError);
  assert.ok(err.message.includes("expired"));
});

test("originMismatch: produces CapabilityIndexError", () => {
  const err = originMismatch("https://a.example", "https://b.example");
  assert.ok(err instanceof CapabilityIndexError);
  assert.ok(err.message.includes("origin mismatch"));
});

test("capabilityRevoked: produces CapabilityIndexError", () => {
  const err = capabilityRevoked("site-retrieval", "site-retrieval@1.0.0");
  assert.ok(err instanceof CapabilityIndexError);
  assert.ok(err.message.includes("revoked"));
});
