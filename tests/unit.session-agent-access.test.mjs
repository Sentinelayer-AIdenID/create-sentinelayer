import "./setup-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { Command } from "commander";

import { userCredential } from "../src/auth/credential-destinations.js";
import { SentinelayerApiError } from "../src/auth/http.js";
import { registerSessionCommand } from "../src/commands/session.js";
import { verifyLegacyAgentJoin } from "../src/session/agent-access.js";
import { resetSessionSyncStateForTests } from "../src/session/sync.js";
import { resolveSessionPaths } from "../src/session/paths.js";

const API = "https://legacy.fixture.invalid";
const AGENT = "sol-max";
const SID = "legacy-room";
const activeGrant = () => ({ id: "synthetic-grant", agentId: AGENT, role: "reviewer", exists: true, revoked: false, revokedAt: null });

async function fixture(overrides = {}) {
  const calls = [];
  const credential = await userCredential("synthetic_legacy", { env: { SENTINELAYER_API_URL: API } });
  const options = {
    agentId: AGENT, role: "reviewer", remoteSession: { agentAdmissionMode: "legacy" },
    readAdmissionState: async () => ({ state: "none" }),
    resolveAuthSession: async () => ({ credential, source: "env", apiUrl: API }),
    requestRead: async (url, init) => {
      calls.push({ url, method: init.method });
      return { grants: [activeGrant()], nextAfter: null };
    },
    requestMutation: async (url, init) => {
      calls.push({ url, method: init.method });
      assert.equal(init.method, "PUT");
      assert.equal(init.body.agentId, AGENT);
      return { status: "ok", recorded: true, agentId: AGENT, ttlSeconds: 90 };
    },
    ...overrides,
  };
  return { calls, options };
}

test("legacy join verifies the existing grant and exact presence, without grant/event POSTs", async () => {
  const f = await fixture();
  const result = await verifyLegacyAgentJoin(SID, f.options);
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.map((call) => call.method), ["GET", "PUT"]);
  assert.match(f.calls[0].url, /\/agent-grants\?limit=100$/);
  assert.match(f.calls[1].url, /\/legacy-room\/presence$/);
  assert.equal(result.grant.agentId, AGENT);
  assert.equal(result.presence.recorded, true);
  assert.equal(result.identity, undefined, "legacy compatibility does not mint an email or key identity");
});

test("missing and revoked legacy grants are refused, never recreated", async () => {
  for (const grants of [[], [{ ...activeGrant(), revoked: true, revokedAt: "2026-01-01T00:00:00Z" }]]) {
    let writes = 0;
    const f = await fixture({
      requestRead: async () => ({ grants, nextAfter: null }),
      requestMutation: async () => { writes += 1; throw new Error("Unexpected write"); },
    });
    const result = await verifyLegacyAgentJoin(SID, f.options);
    assert.equal(result.ok, false);
    assert.equal(result.code, "LEGACY_GRANT_NOT_ACTIVE");
    assert.equal(writes, 0);
  }
});

test("legacy join refuses role elevation and unsupported roles before presence", async () => {
  for (const role of ["coder", "tester"]) {
    const f = await fixture({ role });
    const result = await verifyLegacyAgentJoin(SID, f.options);
    assert.equal(result.code, "LEGACY_GRANT_ROLE_MISMATCH");
    assert.equal(f.calls.some((call) => call.method !== "GET"), false);
  }
});

test("legacy grant pagination follows a bounded server cursor and rejects ambiguous pages", async () => {
  const calls = [];
  const f = await fixture({ requestRead: async (url) => {
    calls.push(url);
    return calls.length === 1
      ? { grants: [{ ...activeGrant(), agentId: "alpha" }], nextAfter: "alpha" }
      : { grants: [activeGrant()], nextAfter: null };
  } });
  assert.equal((await verifyLegacyAgentJoin(SID, f.options)).ok, true);
  assert.match(calls[1], /after=alpha/);
  for (const page of [
    { grants: [activeGrant(), activeGrant()], nextAfter: null },
    { grants: [], nextAfter: "missing-cursor" },
    { grants: [], nextAfter: undefined },
    { grants: [{ agentId: AGENT, role: "reviewer" }], nextAfter: null },
  ]) {
    const bad = await fixture({ requestRead: async () => page });
    assert.equal((await verifyLegacyAgentJoin(SID, bad.options)).code, "LEGACY_GRANT_CONTRACT_MISMATCH");
    assert.equal(bad.calls.length, 0);
  }
});

test("generic 403 and admission-required refusals never trigger an automatic grant", async () => {
  for (const code of ["IDENTITY_FORGERY", "FORBIDDEN", "ADMISSION_REQUIRED", "ADMISSION_SCOPE_DENIED"]) {
    let writes = 0;
    const f = await fixture({ requestMutation: async (_url, init) => {
      writes += 1;
      assert.equal(init.method, "PUT");
      throw new SentinelayerApiError("Synthetic refusal", { code, status: 403 });
    } });
    const result = await verifyLegacyAgentJoin(SID, f.options);
    assert.equal(result.ok, false);
    assert.equal(writes, 1);
    assert.equal(result.code, code.startsWith("ADMISSION_") ? code : "LEGACY_AGENT_ACCESS_DENIED");
  }
});

test("presence must confirm exact identity, actual recording and a positive TTL", async () => {
  for (const presence of [
    { status: "ok", recorded: true, agentId: "other-agent", ttlSeconds: 90 },
    { status: "degraded", recorded: false, agentId: AGENT, ttlSeconds: 90 },
    { status: "ok", recorded: true, agentId: AGENT, ttlSeconds: 0 },
  ]) {
    const f = await fixture({ requestMutation: async () => presence });
    assert.equal((await verifyLegacyAgentJoin(SID, f.options)).ok, false);
  }
});

test("stored live/tombstoned admissions and required rooms never reach human credentials", async () => {
  for (const held of [{ state: "live" }, { state: "refused", reason: "expired" }, { state: "refused", reason: "malformed" }]) {
    let authCalls = 0;
    const f = await fixture({
      readAdmissionState: async () => held,
      resolveAuthSession: async () => { authCalls += 1; throw new Error("Unexpected human auth"); },
    });
    const result = await verifyLegacyAgentJoin(SID, f.options);
    assert.equal(result.ok, false);
    assert.equal(authCalls, 0);
    assert.equal(f.calls.length, 0);
  }
  const f = await fixture({ remoteSession: { agentAdmissionMode: "required" } });
  assert.equal((await verifyLegacyAgentJoin(SID, f.options)).code, "ADMISSION_REQUIRED");
  assert.equal(f.calls.length, 0);
});

test("a newly appearing admission is refused before human presence dispatch", async () => {
  let reads = 0;
  const f = await fixture({ readAdmissionState: async () => ++reads < 3 ? { state: "none" } : { state: "refused", reason: "expired" } });
  assert.equal((await verifyLegacyAgentJoin(SID, f.options)).code, "ADMISSION_CREDENTIAL_REFUSED");
  assert.deepEqual(f.calls.map((call) => call.method), ["GET"]);
});

test("legacy join retains credential destination isolation for injected transports", async () => {
  const f = await fixture();
  f.options.resolveAuthSession = async () => ({
    credential: await userCredential("synthetic_bound", { env: { SENTINELAYER_API_URL: API } }),
    source: "env", apiUrl: "https://other.fixture.invalid",
  });
  assert.equal((await verifyLegacyAgentJoin(SID, f.options)).ok, false);
  assert.equal(f.calls.length, 0);
});

test("unauthenticated, reserved identity and verification timeout paths never publish presence", async () => {
  for (const overrides of [
    { resolveAuthSession: async () => null },
    { agentId: "cli-user" },
    { agentId: "human-owner" },
    { agentId: "unknown" },
    { agentId: "x".repeat(65) },
    { now: (() => { let clock = 0; return () => clock += 20_000; })(), timeoutMs: 1 },
  ]) {
    const f = await fixture(overrides);
    assert.equal((await verifyLegacyAgentJoin(SID, f.options)).ok, false);
    assert.equal(f.calls.length, 0);
  }
});

async function runJoin(args) {
  const program = new Command().exitOverride();
  registerSessionCommand(program);
  const output = [];
  const previousLog = console.log;
  const previousExitCode = process.exitCode;
  console.log = (...values) => output.push(values.join(" "));
  try {
    await program.parseAsync(["session", "join", SID, ...args], { from: "user" });
    return JSON.parse(output.join("\n"));
  } finally {
    console.log = previousLog;
    process.exitCode = previousExitCode;
  }
}

test("actual named join returns typed false before local materialization when no active grant exists", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "sl-legacy-join-"));
  const previousFetch = globalThis.fetch;
  const previousEnv = { SENTINELAYER_API_URL: process.env.SENTINELAYER_API_URL, SENTINELAYER_TOKEN: process.env.SENTINELAYER_TOKEN, SENTINELAYER_SKIP_REMOTE_SYNC: process.env.SENTINELAYER_SKIP_REMOTE_SYNC };
  const methods = [];
  try {
    resetSessionSyncStateForTests();
    process.env.SENTINELAYER_API_URL = API;
    process.env.SENTINELAYER_TOKEN = "synthetic_command_join";
    delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
    globalThis.fetch = async (url, init = {}) => {
      methods.push(init.method || "GET");
      const payload = String(url).includes("/agent-grants?")
        ? { grants: [], nextAfter: null }
        : { session: { sessionId: SID, agentAdmissionMode: "legacy", title: "Synthetic room" } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const result = await runJoin(["--agent", AGENT, "--role", "reviewer", "--path", workspace, "--json"]);
    assert.equal(result.joined, false);
    assert.equal(result.remoteAgentVerification.code, "LEGACY_GRANT_NOT_ACTIVE");
    assert.deepEqual(methods, ["GET", "GET"]);
    await assert.rejects(stat(resolveSessionPaths(SID, { targetPath: workspace }).sessionDir), { code: "ENOENT" });
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetSessionSyncStateForTests();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("explicit admission recovery requires the agent's goal before any remote action", async () => {
  await assert.rejects(runJoin(["--agent", AGENT, "--recover-admission", "--json"]), /requires --goal/);
});
