import "./setup-env.mjs";
// Admission-auth behaviour tests requested by sol-max review:
//   1. resolveAgentAdmissionTarget null ≠ authenticated control access
//   2. No-grant agent join → pending/refused, cannot post, no fallback principal
//   3. Revoked/expired credential rejection paths (no fallback to human)
//   4. Leave is self-only, never reveals another agent
//   5. Identity attribution separate from permission
//   6. MCP runInSessionToolContext: self-provisioning bypass, control refused
// These test the admission-auth module directly plus the stored credential layer.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  AdmissionCredentialRefused,
  assertCanonicalAgentId,
  canonicalAgentId,
  resolveAgentAdmissionTarget,
  SESSION_AGENT_PRINCIPAL,
  withAgentAdmission,
  currentAdmittedAgent,
} from "../src/session/admission-auth.js";
import {
  admissionCredentialPath,
  readAdmissionCredentialState,
  hasStoredAdmissionCredentials,
  storedAdmissionAgentsForSession,
} from "../src/session/admission.js";
import { runInSessionToolContext } from "../src/mcp/session-stdio-server.js";
import { sessionRouteClass, SELF_PROVISIONING_TOOLS } from "../src/session/route-classes.js";

const SID = "ad6b1f8e-3c2a-4d5e-8f90-a1b2c3d4e5f6";

async function fixtureHome() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-admission-auth-"));
  return { dir, env: { ...process.env, HOME: dir, USERPROFILE: dir, APPDATA: path.join(dir, "AppData", "Roaming") } };
}

async function writeLiveCredential(homeDir, sessionId, agentId, overrides = {}) {
  const file = admissionCredentialPath(sessionId, agentId, { homeDir });
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({
    token: "sladm_test_live_token",
    sessionId: String(sessionId).toLowerCase(),
    agentId,
    apiUrl: "https://api.fixture.invalid",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    admissionId: randomUUID(),
    ...overrides,
  }), "utf8");
}

async function writeTombstoneCredential(homeDir, sessionId, agentId, scenario) {
  const file = admissionCredentialPath(sessionId, agentId, { homeDir });
  await fsp.mkdir(path.dirname(file), { recursive: true });
  let payload;
  switch (scenario) {
    case "expired":
      payload = { token: "sladm_test_expired", sessionId: String(sessionId).toLowerCase(), agentId, apiUrl: "https://api.fixture.invalid", expiresAt: Math.floor(Date.now() / 1000) - 3600, admissionId: randomUUID() };
      break;
    case "malformed":
      await fsp.writeFile(file, "{not valid json", "utf8");
      return;
    case "wrong_session":
      payload = { token: "sladm_test_wrong", sessionId: "other-session", agentId, apiUrl: "https://api.fixture.invalid", expiresAt: Math.floor(Date.now() / 1000) + 3600, admissionId: randomUUID() };
      break;
    case "wrong_agent":
      payload = { token: "sladm_test_wrong", sessionId: String(sessionId).toLowerCase(), agentId: "other-agent", apiUrl: "https://api.fixture.invalid", expiresAt: Math.floor(Date.now() / 1000) + 3600, admissionId: randomUUID() };
      break;
    case "no_api_url":
      payload = { token: "sladm_test_nourl", sessionId: String(sessionId).toLowerCase(), agentId, apiUrl: "", expiresAt: Math.floor(Date.now() / 1000) + 3600, admissionId: randomUUID() };
      break;
    default:
      throw new Error(`unknown: ${scenario}`);
  }
  await fsp.writeFile(file, JSON.stringify(payload), "utf8");
}

// ===========================================================================
// 1. resolveAgentAdmissionTarget null ≠ authenticated control access
// ===========================================================================

test("resolveAgentAdmissionTarget returns null for join and leave (self-provisioning), never giving authenticated control access", async () => {
  const { dir, env } = await fixtureHome();
  try {
    await writeLiveCredential(dir, "other-session", "test-agent");

    const joinResult = await resolveAgentAdmissionTarget(
      ["session", "join", SID, "--agent", "test-agent", "--path", dir],
      { env: { ...env, SENTINELAYER_AGENT_ID: "test-agent" }, homeDir: dir }
    );
    assert.equal(joinResult, null, "join returns null even with admissions stored elsewhere");

    const leaveResult = await resolveAgentAdmissionTarget(
      ["session", "leave", SID, "--agent", "test-agent", "--path", dir],
      { env: { ...env, SENTINELAYER_AGENT_ID: "test-agent" }, homeDir: dir }
    );
    assert.equal(leaveResult, null, "leave returns null even with admissions stored elsewhere");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("resolveAgentAdmissionTarget null for control commands does not equal authenticated", async () => {
  const { dir, env } = await fixtureHome();
  try {
    const lockResult = await resolveAgentAdmissionTarget(
      ["session", "lock", SID, "a.js", "--agent", "test-agent", "--path", dir],
      { env: { ...env, SENTINELAYER_AGENT_ID: "test-agent" }, homeDir: dir }
    );
    assert.equal(lockResult, null, "lock without stored admission → null (not authenticated)");

    // With a stored admission it returns a target (authenticated).
    await writeLiveCredential(dir, SID, "test-agent");
    const lockWithAdmission = await resolveAgentAdmissionTarget(
      ["session", "lock", SID, "a.js", "--agent", "test-agent", "--path", dir],
      { env: { ...env, SENTINELAYER_AGENT_ID: "test-agent" }, homeDir: dir }
    );
    assert.notEqual(lockWithAdmission, null);
    assert.equal(lockWithAdmission.sessionId.toLowerCase(), SID.toLowerCase());
    assert.equal(lockWithAdmission.agentId, "test-agent");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("control and owner commands are never self-provisioning", () => {
  const controlCmds = [
    "cli:session access approve", "cli:session access deny", "cli:session access revoke",
    "cli:session access mode", "cli:session access request", "cli:session access list", "cli:session access status",
    "cli:session lock", "cli:session unlock", "cli:session guard", "cli:session guard-hook",
    "cli:session guard-install", "cli:session guard-uninstall",
    "cli:session ticket claim", "cli:session ticket release", "cli:session ticket renew", "cli:session ticket submit",
    "cli:session stop-listener", "cli:session listeners",
  ];
  for (const route of controlCmds) {
    assert.notEqual(sessionRouteClass(route), "self-provisioning", `${route} must not be self-provisioning`);
  }
});

// ===========================================================================
// 2. No-grant agent: withAgentAdmission with no credential → admitted:false, no fallback
// ===========================================================================

test("withAgentAdmission with no stored credential returns admitted:false, not a fallback principal", async () => {
  const { dir } = await fixtureHome();
  try {
    let captured = null;
    await withAgentAdmission(SID, "no-such-agent", (ctx) => { captured = ctx; }, { homeDir: dir });
    assert.deepEqual(captured, { admitted: false });
    assert.equal(currentAdmittedAgent(), null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("withAgentAdmission with requireStored=true refuses when credential is absent", async () => {
  const { dir } = await fixtureHome();
  try {
    await assert.rejects(
      withAgentAdmission(SID, "missing-agent", () => {}, { homeDir: dir, requireStored: true }),
      (err) => {
        assert.ok(err instanceof AdmissionCredentialRefused);
        assert.match(err.message, /no longer present/);
        assert.equal(err.reason, "admission_removed");
        return true;
      }
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 3. Revoked/expired credential rejection, no fallback to human token
// ===========================================================================

test("expired admission credential is refused, never falls back", async () => {
  const { dir } = await fixtureHome();
  try {
    await writeTombstoneCredential(dir, SID, "expired-agent", "expired");

    const state = await readAdmissionCredentialState(SID, "expired-agent", { homeDir: dir });
    assert.equal(state.state, "refused");
    assert.equal(state.reason, "expired");

    await assert.rejects(
      withAgentAdmission(SID, "expired-agent", () => {}, { homeDir: dir }),
      (err) => {
        assert.ok(err instanceof AdmissionCredentialRefused);
        assert.match(err.message, /expired/);
        assert.equal(err.reason, "expired");
        return true;
      }
    );

    assert.ok(await hasStoredAdmissionCredentials({ homeDir: dir }), "tombstone still stored, not absent");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("malformed admission credential is refused, never silently ignored", async () => {
  const { dir } = await fixtureHome();
  try {
    await writeTombstoneCredential(dir, SID, "malformed-agent", "malformed");

    const state = await readAdmissionCredentialState(SID, "malformed-agent", { homeDir: dir });
    assert.equal(state.state, "refused");
    assert.equal(state.reason, "malformed");

    await assert.rejects(
      withAgentAdmission(SID, "malformed-agent", () => {}, { homeDir: dir }),
      (err) => {
        assert.ok(err instanceof AdmissionCredentialRefused);
        return true;
      }
    );

    // hasStoredAdmissionCredentials sees it — tombstone is not absence
    assert.ok(await hasStoredAdmissionCredentials({ homeDir: dir }));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("credential bound to another session is refused", async () => {
  const { dir } = await fixtureHome();
  try {
    await writeTombstoneCredential(dir, SID, "misbound-agent", "wrong_session");

    const state = await readAdmissionCredentialState(SID, "misbound-agent", { homeDir: dir });
    assert.equal(state.state, "refused");
    assert.equal(state.reason, "bound_to_another_session_or_agent");

    await assert.rejects(
      withAgentAdmission(SID, "misbound-agent", () => {}, { homeDir: dir }),
      (err) => {
        assert.ok(err instanceof AdmissionCredentialRefused);
        return true;
      }
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("credential bound to another agent is refused", async () => {
  const { dir } = await fixtureHome();
  try {
    await writeTombstoneCredential(dir, SID, "wrong-agent-target", "wrong_agent");

    const state = await readAdmissionCredentialState(SID, "wrong-agent-target", { homeDir: dir });
    assert.equal(state.state, "refused");
    assert.equal(state.reason, "bound_to_another_session_or_agent");

    await assert.rejects(
      withAgentAdmission(SID, "wrong-agent-target", () => {}, { homeDir: dir }),
      (err) => {
        assert.ok(err instanceof AdmissionCredentialRefused);
        return true;
      }
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("credential with no issuing authority is refused", async () => {
  const { dir } = await fixtureHome();
  try {
    await writeTombstoneCredential(dir, SID, "no-auth-agent", "no_api_url");

    const state = await readAdmissionCredentialState(SID, "no-auth-agent", { homeDir: dir });
    assert.equal(state.state, "refused");
    assert.equal(state.reason, "no_issuing_authority");

    await assert.rejects(
      withAgentAdmission(SID, "no-auth-agent", () => {}, { homeDir: dir }),
      (err) => {
        assert.ok(err instanceof AdmissionCredentialRefused);
        return true;
      }
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 4. Leave is self-only, never reveals another agent
// ===========================================================================

test("leave is classified as self-provisioning; command behavior is covered separately", () => {
  assert.equal(sessionRouteClass("cli:session leave"), "self-provisioning");
  assert.deepEqual(
    [...SELF_PROVISIONING_TOOLS].sort(),
    ["cli:session join", "cli:session leave"],
  );
});

test("storedAdmissionAgentsForSession returns agents by credential file; leave does not enumerate others", async () => {
  const { dir } = await fixtureHome();
  try {
    await writeLiveCredential(dir, SID, "agent-a");
    const agents = await storedAdmissionAgentsForSession(SID, { homeDir: dir });
    assert.deepEqual(agents, ["agent-a"]);

    await writeLiveCredential(dir, SID, "agent-b");
    const both = await storedAdmissionAgentsForSession(SID, { homeDir: dir });
    assert.deepEqual([...both].sort(), ["agent-a", "agent-b"]);

    // Each agent only accesses its own credential
    const stateA = await readAdmissionCredentialState(SID, "agent-a", { homeDir: dir });
    assert.equal(stateA.state, "live");
    assert.equal(stateA.credential.agentId, "agent-a");

    const stateB = await readAdmissionCredentialState(SID, "agent-b", { homeDir: dir });
    assert.equal(stateB.state, "live");
    assert.equal(stateB.credential.agentId, "agent-b");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 5. Identity attribution separate from permission
// ===========================================================================

test("assertCanonicalAgentId refuses non-canonical spellings that would alias another identity", () => {
  assertCanonicalAgentId("test-agent", "agentId");
  assertCanonicalAgentId("codex", "agentId");
  assertCanonicalAgentId("claude-warden", "agentId");

  assert.throws(() => assertCanonicalAgentId("a:b", "agentId"), AdmissionCredentialRefused);
  assert.throws(() => assertCanonicalAgentId("A B", "agentId"), AdmissionCredentialRefused);
  assert.throws(() => assertCanonicalAgentId("test@agent", "agentId"), AdmissionCredentialRefused);

  assertCanonicalAgentId("", "agentId");
  assertCanonicalAgentId("  ", "agentId");
});

test("canonicalAgentId normalizes consistently — identity attribution is deterministic", () => {
  assert.equal(canonicalAgentId("test-agent"), "test-agent");
  assert.equal(canonicalAgentId("Test-Agent"), "test-agent");
  assert.equal(canonicalAgentId("TEST_AGENT"), "test_agent");
  assert.equal(canonicalAgentId("a:b"), "a-b");
  assert.equal(canonicalAgentId("a@b"), "a-b");
  assert.equal(canonicalAgentId("  spaces  "), "spaces");
  assert.equal(canonicalAgentId("a--b"), "a--b");
});

test("SESSION_AGENT_PRINCIPAL: no command is both actor and self-provisioning", () => {
  for (const [command, principal] of Object.entries(SESSION_AGENT_PRINCIPAL)) {
    const route = `cli:session ${command}`;
    const cls = sessionRouteClass(route);
    if (cls === "self-provisioning") {
      assert.equal(principal, "self-provisioning", `${route}: route class and principal must agree`);
    }
    if (principal === "actor") {
      assert.notEqual(cls, "self-provisioning", `${route}: actor principal must not be self-provisioning`);
    }
  }
});

// ===========================================================================
// 6. MCP runInSessionToolContext: agent context with/without admission
// ===========================================================================

test("runInSessionToolContext refuses control tools in agent context with no stored admission", async () => {
  const { dir, env } = await fixtureHome();
  const saveHome = process.env.HOME;
  try {
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    const agentEnv = { ...env, SENTINELAYER_AGENT_ID: "test-agent", HOME: dir, USERPROFILE: dir };

    // Control tools refused when no admission stored
    for (const tool of ["session_lock", "session_unlock", "session_locks"]) {
      await assert.rejects(
        runInSessionToolContext(tool, { sessionId: SID, agentId: "test-agent" }, () => {}, { env: agentEnv }),
        /stores no admission/,
        `${tool} must be refused without stored admission`
      );
    }


  } finally {
    process.env.HOME = saveHome;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("runInSessionToolContext allows legacy-data-plane tools without admission", async () => {
  const { dir, env } = await fixtureHome();
  const saveHome = process.env.HOME;
  try {
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    const agentEnv = { ...env, SENTINELAYER_AGENT_ID: "test-agent", HOME: dir, USERPROFILE: dir };
    for (const tool of ["send_message", "poll_inbox", "read_history", "session_action", "session_react", "session_reply"]) {
      let called = false;
      await runInSessionToolContext(tool, { sessionId: SID, agentId: "test-agent" },
        () => { called = true; }, { env: agentEnv });
      assert.ok(called, `${tool} must be allowed (legacy-data-plane)`);
    }
  } finally {
    process.env.HOME = saveHome;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("runInSessionToolContext with live admission binds to it for data-plane tools", async () => {
  const { dir, env } = await fixtureHome();
  const saveHome = process.env.HOME;
  try {
    await writeLiveCredential(dir, SID, "live-agent");
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    const agentEnv = { ...env, SENTINELAYER_AGENT_ID: "live-agent", HOME: dir, USERPROFILE: dir };

    let capturedAgent = null;
    await runInSessionToolContext("send_message", { sessionId: SID, agentId: "live-agent" },
      () => { capturedAgent = currentAdmittedAgent(); }, { env: agentEnv });
    assert.notEqual(capturedAgent, null);
    assert.equal(capturedAgent.agentId, "live-agent");
    assert.equal(capturedAgent.sessionId.toLowerCase(), SID.toLowerCase());
  } finally {
    process.env.HOME = saveHome;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("runInSessionToolContext with expired credential refuses data-plane tools", async () => {
  const { dir, env } = await fixtureHome();
  const saveHome = process.env.HOME;
  try {
    await writeTombstoneCredential(dir, SID, "expired-agent", "expired");
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    const agentEnv = { ...env, SENTINELAYER_AGENT_ID: "expired-agent", HOME: dir, USERPROFILE: dir };

    await assert.rejects(
      runInSessionToolContext("send_message", { sessionId: SID, agentId: "expired-agent" },
        () => {}, { env: agentEnv }),
      (err) => {
        assert.ok(err instanceof AdmissionCredentialRefused);
        assert.match(err.message, /expired/);
        return true;
      },
    );
  } finally {
    process.env.HOME = saveHome;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("exempt-local tools bypass admission entirely", async () => {
  const { dir, env } = await fixtureHome();
  const saveHome = process.env.HOME;
  try {
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    const agentEnv = { ...env, SENTINELAYER_AGENT_ID: "test-agent", HOME: dir, USERPROFILE: dir };
    for (const tool of ["memory.write", "memory.recall", "memory.summarize"]) {
      let called = false;
      await runInSessionToolContext(tool, {}, () => { called = true; }, { env: agentEnv });
      assert.ok(called, `${tool} must bypass admission (exempt-local)`);
    }
  } finally {
    process.env.HOME = saveHome;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("live admission scope does not leak to the next call (identity is call-scoped)", async () => {
  const { dir } = await fixtureHome();
  try {
    await writeLiveCredential(dir, SID, "scoped-agent");

    let firstAgent = null;
    await withAgentAdmission(SID, "scoped-agent", () => {
      firstAgent = currentAdmittedAgent();
    }, { homeDir: dir });
    assert.notEqual(firstAgent, null);
    assert.equal(firstAgent.agentId, "scoped-agent");

    assert.equal(currentAdmittedAgent(), null, "scope cleared after callback");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
