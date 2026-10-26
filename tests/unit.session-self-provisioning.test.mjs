import "./setup-env.mjs";

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCliProgram } from "../src/cli.js";
import { AdmissionCredentialRefused, assertDispatchMatchesScope } from "../src/session/admission-auth.js";
import { listAgents, registerAgent } from "../src/session/agent-registry.js";

const SID = "ad6b1f8e-3c2a-4d5e-8f90-a1b2c3d4e5f6";
const bridgeEnv = (agentId) => ({ SENTINELAYER_MCP_BRIDGE: "1", SENTINELAYER_AGENT_ID: agentId });

async function withWorkspace(run) {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-self-provisioning-"));
  assert.equal(path.dirname(path.resolve(workspace)), path.resolve(os.tmpdir()));
  try {
    await run(workspace);
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
}

async function runSession(args, { env, homeDir }) {
  // Exercise the real Commander action with the same preAction guard that runCli installs.
  // Directly building the program avoids the unrelated login gate and all network calls.
  const program = await buildCliProgram({ invokeLegacy: async () => {}, onlyCommand: "session" });
  program.hook("preAction", (_hooked, command) => assertDispatchMatchesScope(command, { env, homeDir }));
  return program.parseAsync(["node", "sl", "session", ...args]);
}

async function activeAgent(workspace, agentId) {
  const agents = await listAgents(SID, { targetPath: workspace });
  return agents.find((agent) => agent.agentId === agentId)?.active;
}

async function register(workspace, agentId) {
  await registerAgent(SID, {
    agentId,
    model: "gpt-6.1-sol",
    targetPath: workspace,
    trackProcessExit: false,
    preserveIdentity: true,
  });
}

test("bridged leave refuses another agent before changing its roster state", async () => {
  await withWorkspace(async (workspace) => {
    await register(workspace, "victim");
    await assert.rejects(
      runSession(["leave", SID, "--agent", "victim", "--path", workspace], {
        env: bridgeEnv("attacker"), homeDir: workspace,
      }),
      (error) => error instanceof AdmissionCredentialRefused && error.reason === "bridged_route_refused",
    );
    assert.equal(await activeAgent(workspace, "victim"), true);
  });
});

test("bridged leave requires an explicit self identity and can leave only itself", async () => {
  await withWorkspace(async (workspace) => {
    await register(workspace, "attacker");
    await register(workspace, "cli-user");
    await assert.rejects(
      runSession(["leave", SID, "--path", workspace], {
        env: bridgeEnv("attacker"), homeDir: workspace,
      }),
      (error) => error instanceof AdmissionCredentialRefused && error.reason === "bridged_route_refused",
    );
    assert.equal(await activeAgent(workspace, "attacker"), true);
    assert.equal(await activeAgent(workspace, "cli-user"), true);
    await runSession(["leave", SID, "--agent", "attacker", "--path", workspace], {
      env: bridgeEnv("attacker"), homeDir: workspace,
    });
    assert.equal(await activeAgent(workspace, "attacker"), false);
    assert.equal(await activeAgent(workspace, "cli-user"), true);
  });
});

test("bridged join refuses another agent's pending cancellation and legacy name alias", async () => {
  await withWorkspace(async (workspace) => {
    for (const identity of [["--agent", "victim"], ["--name", "victim"]]) {
      await assert.rejects(
        runSession(["join", SID, ...identity, "--cancel-admission", "--path", workspace], {
          env: bridgeEnv("attacker"), homeDir: workspace,
        }),
        (error) => error instanceof AdmissionCredentialRefused && error.reason === "bridged_route_refused",
      );
    }
  });
});

test("bridged join accepts its own identity but still requires a real pending request", async () => {
  await withWorkspace(async (workspace) => {
    for (const identity of [["--agent", "attacker"], ["--name", "attacker"]]) {
      await assert.rejects(
        runSession(["join", SID, ...identity, "--cancel-admission", "--path", workspace], {
          env: bridgeEnv("attacker"), homeDir: workspace,
        }),
        /No pending admission request for "attacker"/,
      );
    }
    // When --agent is explicit, --name is a display label rather than a second identity.
    await assert.rejects(
      runSession(["join", SID, "--agent", "attacker", "--name", "Attacker Display", "--cancel-admission", "--path", workspace], {
        env: bridgeEnv("attacker"), homeDir: workspace,
      }),
      /No pending admission request for "attacker"/,
    );
  });
});

test("bridged self-provisioning without a trusted caller or selected agent fails closed", async () => {
  await withWorkspace(async (workspace) => {
    for (const [env, args] of [
      [{ SENTINELAYER_MCP_BRIDGE: "1" }, ["join", SID, "--agent", "victim", "--cancel-admission"]],
      [bridgeEnv("attacker"), ["join", SID, "--cancel-admission"]],
      [bridgeEnv("attacker"), ["leave", SID]],
    ]) {
      await assert.rejects(
        runSession([...args, "--path", workspace], { env, homeDir: workspace }),
        (error) => error instanceof AdmissionCredentialRefused && error.reason === "bridged_route_refused",
      );
    }
  });
});

test("direct human leave may still act on a named agent", async () => {
  await withWorkspace(async (workspace) => {
    await register(workspace, "victim");
    await runSession(["leave", SID, "--agent", "victim", "--path", workspace], {
      env: { SENTINELAYER_MCP_BRIDGE: "0", SENTINELAYER_AGENT_ID: "attacker" },
      homeDir: workspace,
    });
    assert.equal(await activeAgent(workspace, "victim"), false);
  });
});
