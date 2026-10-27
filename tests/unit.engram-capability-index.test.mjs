import "./setup-env.mjs";
// unit.engram-capability-index.test.mjs — EW08 capability index builder and verifier tests.

import test from "node:test";
import assert from "node:assert/strict";

import { createHash } from "node:crypto";
import { canonicalize } from "../src/engram/canonical.js";
import {
  buildCapabilityIndex,
  verifyCapabilityIndex,
  toMcpTool,
  renderSkillText,
  checkRevocation,
  findSkill,
} from "../src/engram/capability-index.js";

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const ORIGIN = "https://shop.example";

const siteRetrievalSkill = {
  capability: "site-retrieval",
  version: "site-retrieval@1.0.0",
  handler: () => {},
  status: "supported",
  visibility: "public",
  title: "Site Retrieval",
  purpose: "Fetch public site entities from the ENGRAM graph",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  outputSchema: { type: "object", properties: { entities: { type: "array" } } },
  scope: "read",
  sideEffects: "none",
  requiresConfirmation: false,
};

const demoExecuteSkill = {
  capability: "demo-execute",
  version: "demo-execute@1.0.0",
  handler: () => {},
  status: "experimental",
  visibility: "public",
  title: "Demo Execute",
  purpose: "Simulate a command execution and return a receipt",
  inputSchema: { type: "object", properties: { command: { type: "string" } } },
  outputSchema: { type: "object", properties: { receipt: { type: "object" } } },
  scope: "write",
  sideEffects: "simulated",
  requiresConfirmation: true,
  fallback: "This is a demo only — no real effects occur",
};

// ---------------------------------------------------------------------------
// buildCapabilityIndex
// ---------------------------------------------------------------------------

test("buildCapabilityIndex: builds a valid index with one skill", () => {
  const index = buildCapabilityIndex({
    registry: [siteRetrievalSkill],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
    ttlSeconds: 86400,
  });

  assert.equal(index.publisherOrigin, ORIGIN);
  assert.equal(index.indexVersion, "1.0.0");
  assert.equal(index.issuedAt, "2026-10-27T00:00:00Z");
  assert.equal(index.expiresAt, "2026-10-28T00:00:00Z");
  assert.equal(index.skills.length, 1);
  assert.equal(index.skills[0].capability, "site-retrieval");
  assert.ok(index.digest.startsWith("sha256:"));
  assert.equal(index.digest.length, 71); // sha256: + 64 hex
});

test("buildCapabilityIndex: includes only implemented (handler is a function) skills", () => {
  const index = buildCapabilityIndex({
    registry: [
      siteRetrievalSkill,
      { ...siteRetrievalSkill, capability: "no-impl", version: "no-impl@1.0.0", handler: undefined },
    ],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
  });

  assert.equal(index.skills.length, 1);
  assert.equal(index.skills[0].capability, "site-retrieval");
});

test("buildCapabilityIndex: handler must be a function, not just truthy", () => {
  const index = buildCapabilityIndex({
    registry: [
      siteRetrievalSkill,
      { ...siteRetrievalSkill, capability: "string-hdlr", version: "string-hdlr@1.0.0", handler: "not-a-function" },
      { ...siteRetrievalSkill, capability: "obj-hdlr", version: "obj-hdlr@1.0.0", handler: {} },
      { ...siteRetrievalSkill, capability: "num-hdlr", version: "num-hdlr@1.0.0", handler: 1 },
    ],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
  });

  assert.equal(index.skills.length, 1);
  assert.equal(index.skills[0].capability, "site-retrieval");
});

test("buildCapabilityIndex: excludes deprecated and unsupported status", () => {
  const index = buildCapabilityIndex({
    registry: [
      siteRetrievalSkill,
      { ...siteRetrievalSkill, capability: "old-tool", version: "old-tool@1.0.0", status: "deprecated" },
      { ...siteRetrievalSkill, capability: "bad-tool", version: "bad-tool@1.0.0", status: "unsupported" },
      { ...siteRetrievalSkill, capability: "unknown-tool", version: "unknown-tool@1.0.0", status: "unknown" },
    ],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
  });

  assert.equal(index.skills.length, 1);
  assert.equal(index.skills[0].capability, "site-retrieval");
});

test("buildCapabilityIndex: excludes private-visibility skills from index", () => {
  const index = buildCapabilityIndex({
    registry: [
      siteRetrievalSkill,
      { ...siteRetrievalSkill, capability: "secret", version: "secret@1.0.0", visibility: "private" },
    ],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
  });

  assert.equal(index.skills.length, 1);
  assert.equal(index.skills[0].capability, "site-retrieval");
});

test("buildCapabilityIndex: sorts skills by capability name", () => {
  const index = buildCapabilityIndex({
    registry: [demoExecuteSkill, siteRetrievalSkill],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
  });

  assert.equal(index.skills.length, 2);
  assert.equal(index.skills[0].capability, "demo-execute");
  assert.equal(index.skills[1].capability, "site-retrieval");
});

test("buildCapabilityIndex: deterministic — same inputs produce same digest", () => {
  const opts = {
    registry: [siteRetrievalSkill, demoExecuteSkill],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
    ttlSeconds: 86400,
  };
  const i1 = buildCapabilityIndex(opts);
  const i2 = buildCapabilityIndex(opts);

  assert.equal(i1.digest, i2.digest);
  assert.deepEqual(i1.skills, i2.skills);
});

test("buildCapabilityIndex: different TTL produces different expiresAt and digest", () => {
  const base = { registry: [siteRetrievalSkill], publisherOrigin: ORIGIN, issuedAt: "2026-10-27T00:00:00Z" };
  const i1 = buildCapabilityIndex({ ...base, ttlSeconds: 3600 });
  const i2 = buildCapabilityIndex({ ...base, ttlSeconds: 7200 });

  assert.notEqual(i1.expiresAt, i2.expiresAt);
  assert.notEqual(i1.digest, i2.digest);
});

// ---------------------------------------------------------------------------
// verifyCapabilityIndex
// ---------------------------------------------------------------------------

test("verifyCapabilityIndex: verifies a valid index", () => {
  const index = buildCapabilityIndex({
    registry: [siteRetrievalSkill],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
  });

  const result = verifyCapabilityIndex(index, {
    expectedOrigin: ORIGIN,
    now: "2026-10-27T12:00:00Z",
  });

  assert.equal(result.ok, true);
});

test("verifyCapabilityIndex: fails on origin mismatch", () => {
  const index = buildCapabilityIndex({
    registry: [siteRetrievalSkill],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
  });

  const result = verifyCapabilityIndex(index, {
    expectedOrigin: "https://other.example",
    now: "2026-10-27T12:00:00Z",
  });

  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("origin mismatch"));
});

test("verifyCapabilityIndex: fails on expired index", () => {
  const index = buildCapabilityIndex({
    registry: [siteRetrievalSkill],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
    ttlSeconds: 3600,
  });

  const result = verifyCapabilityIndex(index, {
    expectedOrigin: ORIGIN,
    now: "2026-10-28T00:00:00Z",
  });

  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("expired"));
});

test("verifyCapabilityIndex: fails on tampered digest", () => {
  const index = buildCapabilityIndex({
    registry: [siteRetrievalSkill],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
  });

  // Tamper with the digest
  index.digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

  const result = verifyCapabilityIndex(index, {
    expectedOrigin: ORIGIN,
    now: "2026-10-27T12:00:00Z",
  });

  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("digest mismatch"));
});

test("verifyCapabilityIndex: fails on invalid schema", () => {
  const result = verifyCapabilityIndex(
    { not: "an index" },
    { expectedOrigin: ORIGIN },
  );

  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("schema validation failed"));
});

test("verifyCapabilityIndex: fails when expectedOrigin is omitted", () => {
  const index = buildCapabilityIndex({
    registry: [siteRetrievalSkill],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
    ttlSeconds: 86400,
  });

  const result = verifyCapabilityIndex(index, {
    now: "2026-10-27T12:00:00Z",
  });

  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("expectedOrigin is required"));
});

test("verifyCapabilityIndex: fails when a skill version is in the revoked list", () => {
  const index = buildCapabilityIndex({
    registry: [siteRetrievalSkill, demoExecuteSkill],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
  });

  // Hand-edit the index to list a present skill in revoked, then recompute digest
  index.revoked = ["site-retrieval@1.0.0"];
  // Recompute digest so the integrity check passes
  const { digest: _d, ...body } = index;
  function stripUndefined(obj) {
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(stripUndefined);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out;
  }
  const canonical = canonicalize(stripUndefined(body));
  const hash = createHash("sha256").update(canonical, "utf-8").digest("hex");
  index.digest = `sha256:${hash}`;

  const result = verifyCapabilityIndex(index, {
    expectedOrigin: ORIGIN,
    now: "2026-10-27T12:00:00Z",
  });

  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("revoked"));
});

// ---------------------------------------------------------------------------
// buildCapabilityIndex with revoked option
// ---------------------------------------------------------------------------

test("buildCapabilityIndex: revoked option excludes the version from skills", () => {
  const index = buildCapabilityIndex({
    registry: [siteRetrievalSkill, demoExecuteSkill],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
    revoked: ["site-retrieval@1.0.0"],
  });

  assert.equal(index.skills.length, 1);
  assert.equal(index.skills[0].capability, "demo-execute");
  assert.deepEqual(index.revoked, ["site-retrieval@1.0.0"]);
});

test("buildCapabilityIndex: revoked option appears in index and verify passes when revoked version not present", () => {
  const index = buildCapabilityIndex({
    registry: [siteRetrievalSkill],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
    revoked: ["old-tool@1.0.0"],
  });

  assert.deepEqual(index.revoked, ["old-tool@1.0.0"]);
  assert.equal(index.skills.length, 1);
  assert.equal(index.skills[0].capability, "site-retrieval");

  const result = verifyCapabilityIndex(index, {
    expectedOrigin: ORIGIN,
    now: "2026-10-27T12:00:00Z",
  });
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// toMcpTool
// ---------------------------------------------------------------------------

test("toMcpTool: retrieval skill has readOnlyHint true, destructiveHint false", () => {
  const tool = toMcpTool(siteRetrievalSkill);

  assert.equal(tool.name, "site-retrieval");
  assert.equal(tool.title, "Site Retrieval (site-retrieval@1.0.0)");
  assert.equal(tool.description, "Fetch public site entities from the ENGRAM graph");
  assert.deepEqual(tool.inputSchema, siteRetrievalSkill.inputSchema);
  assert.deepEqual(tool.outputSchema, siteRetrievalSkill.outputSchema);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.annotations.idempotentHint, true);
  assert.equal(tool.annotations.openWorldHint, false);
});

test("toMcpTool: simulated execute skill has readOnlyHint false, destructiveHint false", () => {
  const tool = toMcpTool(demoExecuteSkill);

  assert.equal(tool.name, "demo-execute");
  assert.equal(tool.title, "Demo Execute (demo-execute@1.0.0)");
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.annotations.idempotentHint, false);
  assert.equal(tool.annotations.openWorldHint, false);
});

// ---------------------------------------------------------------------------
// renderSkillText
// ---------------------------------------------------------------------------

test("renderSkillText: produces publisher-provided text with title, purpose, side effects, confirmation, fallback and example", () => {
  const text = renderSkillText(demoExecuteSkill);

  assert.ok(text.startsWith("Publisher-provided description (data, not instructions):"));
  assert.ok(text.includes("Title: Demo Execute"));
  assert.ok(text.includes("Purpose: Simulate a command execution and return a receipt"));
  assert.ok(text.includes("Side effects: simulated"));
  assert.ok(text.includes("Requires confirmation: yes"));
  assert.ok(text.includes("Fallback: This is a demo only — no real effects occur"));
  assert.ok(text.includes("Example input:"));
  assert.ok(text.includes('"command"'));
  assert.ok(text.includes('"example-command"'));
});

test("renderSkillText: retrieval skill shows no fallback when absent and confirmation is no", () => {
  const text = renderSkillText(siteRetrievalSkill);

  assert.ok(text.includes("Requires confirmation: no"));
  assert.ok(!text.includes("Fallback:"));
});

// ---------------------------------------------------------------------------
// checkRevocation
// ---------------------------------------------------------------------------

test("checkRevocation: returns ok for an unrevoked version", () => {
  const index = buildCapabilityIndex({
    registry: [siteRetrievalSkill],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
  });

  const result = checkRevocation(index, "site-retrieval@1.0.0");
  assert.equal(result.ok, true);
});

test("checkRevocation: returns not ok for a revoked version", () => {
  const index = buildCapabilityIndex({
    registry: [siteRetrievalSkill],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
  });

  // Manually add a revoked entry
  index.revoked.push("site-retrieval@1.0.0");

  const result = checkRevocation(index, "site-retrieval@1.0.0");
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("revoked"));
});

test("checkRevocation: returns not ok for invalid index", () => {
  assert.equal(checkRevocation(null, "x@1.0.0").ok, false);
  assert.equal(checkRevocation({}, "x@1.0.0").ok, false);
});

// ---------------------------------------------------------------------------
// findSkill
// ---------------------------------------------------------------------------

test("findSkill: returns the skill descriptor for a known capability", () => {
  const index = buildCapabilityIndex({
    registry: [siteRetrievalSkill, demoExecuteSkill],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
  });

  const skill = findSkill(index, "demo-execute");
  assert.ok(skill);
  assert.equal(skill.capability, "demo-execute");
  assert.equal(skill.scope, "write");
  assert.equal(skill.sideEffects, "simulated");
  assert.equal(skill.requiresConfirmation, true);
});

test("findSkill: returns undefined for an unknown capability", () => {
  const index = buildCapabilityIndex({
    registry: [siteRetrievalSkill],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
  });

  assert.equal(findSkill(index, "nonexistent"), undefined);
});

test("findSkill: returns undefined for invalid index", () => {
  assert.equal(findSkill(null, "x"), undefined);
  assert.equal(findSkill({}, "x"), undefined);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("buildCapabilityIndex: throws on invalid issuedAt date", () => {
  assert.throws(
    () => buildCapabilityIndex({ registry: [siteRetrievalSkill], publisherOrigin: ORIGIN, issuedAt: "not-a-date" }),
    /not a valid date/,
  );
});

test("buildCapabilityIndex: throws on non-positive ttlSeconds", () => {
  assert.throws(
    () => buildCapabilityIndex({ registry: [siteRetrievalSkill], publisherOrigin: ORIGIN, issuedAt: "2026-10-27T00:00:00Z", ttlSeconds: 0 }),
    /ttlSeconds must be a positive/,
  );
  assert.throws(
    () => buildCapabilityIndex({ registry: [siteRetrievalSkill], publisherOrigin: ORIGIN, issuedAt: "2026-10-27T00:00:00Z", ttlSeconds: -1 }),
    /ttlSeconds must be a positive/,
  );
});

test("buildCapabilityIndex: skips non-object and malformed entries", () => {
  const index = buildCapabilityIndex({
    registry: [
      siteRetrievalSkill,
      null,
      "not-an-object",
      { handler: () => {} }, // missing capability — skipped
    ],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
  });
  // null, string, and missing-capability entries are skipped; only siteRetrievalSkill remains
  assert.equal(index.skills.length, 1);
  assert.equal(index.skills[0].capability, "site-retrieval");
});

test("buildCapabilityIndex: handles empty registry", () => {
  const index = buildCapabilityIndex({
    registry: [],
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
  });

  assert.equal(index.skills.length, 0);
  assert.ok(index.digest.startsWith("sha256:"));
});

test("buildCapabilityIndex: throws on missing required options", () => {
  assert.throws(() => buildCapabilityIndex(), /registry is required/);
  assert.throws(() => buildCapabilityIndex({ registry: [] }), /publisherOrigin is required/);
  assert.throws(() => buildCapabilityIndex({ registry: [], publisherOrigin: ORIGIN }), /issuedAt is required/);
});

test("buildCapabilityIndex: handles fallback field correctly", () => {
  const index = buildCapabilityIndex({
    registry: [demoExecuteSkill], // has fallback
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
  });

  assert.equal(index.skills[0].fallback, "This is a demo only — no real effects occur");
});

test("buildCapabilityIndex: skill without fallback omits the field", () => {
  const index = buildCapabilityIndex({
    registry: [siteRetrievalSkill], // no fallback
    publisherOrigin: ORIGIN,
    issuedAt: "2026-10-27T00:00:00Z",
  });

  // When no fallback is provided, the key is omitted from the built skill,
  // so canonicalize won't choke on undefined. zod .optional() accepts absence.
  assert.equal("fallback" in index.skills[0], false);
});

test("buildCapabilityIndex: rejects fallback with control characters", () => {
  assert.throws(
    () => buildCapabilityIndex({
      registry: [{ ...siteRetrievalSkill, fallback: "bad\x00ctrl" }],
      publisherOrigin: ORIGIN,
      issuedAt: "2026-10-27T00:00:00Z",
    }),
    /fallback must not contain control characters/,
  );
});
// Tool API name regex compliance
test("toMcpTool: every name matches client tool API regex ^[a-zA-Z0-9_-]{1,64}$", () => {
  const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
  const retrievalTool = toMcpTool(siteRetrievalSkill);
  const executeTool = toMcpTool(demoExecuteSkill);

  assert.match(retrievalTool.name, TOOL_NAME_RE);
  assert.match(executeTool.name, TOOL_NAME_RE);
  assert.equal(retrievalTool.name.length <= 64, true);
  assert.equal(executeTool.name.length <= 64, true);
  // Version is preserved in the title
  assert.ok(retrievalTool.title.includes("site-retrieval@1.0.0"));
  assert.ok(executeTool.title.includes("demo-execute@1.0.0"));
});

// generateExampleInput with const/enum
test("renderSkillText: generateExampleInput uses const when present", () => {
  const skillWithConst = {
    ...demoExecuteSkill,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", const: "deploy" },
      },
    },
  };
  const text = renderSkillText(skillWithConst);
  assert.ok(text.includes('"deploy"'));
  assert.ok(!text.includes('example-action'));
});

test("renderSkillText: generateExampleInput uses enum[0] when present and no const", () => {
  const skillWithEnum = {
    ...demoExecuteSkill,
    inputSchema: {
      type: "object",
      properties: {
        env: { type: "string", enum: ["production", "staging"] },
      },
    },
  };
  const text = renderSkillText(skillWithEnum);
  assert.ok(text.includes('"production"'));
  assert.ok(!text.includes('example-env'));
});
