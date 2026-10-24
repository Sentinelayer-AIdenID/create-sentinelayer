import "./setup-env.mjs";

import assert from "node:assert/strict";
import { once } from "node:events";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeStoredSession } from "../src/auth/session-store.js";
import { createSessionMcpRuntime, handleMcpJsonRpcMessage } from "../src/mcp/session-stdio-server.js";
import { listAgents, registerAgent } from "../src/session/agent-registry.js";

const SID = "ad6b1f8e-3c2a-4d5e-8f90-a1b2c3d4e5f6";

async function fixture(caller = "attacker", apiUrl = "http://127.0.0.1:9") {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-mcp-self-provisioning-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(workspace, { recursive: true });
  await writeStoredSession(
    { apiUrl, token: "mcp-test-user-token-0000", tokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() },
    { homeDir: home },
  );
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    SENTINELAYER_AGENT_ID: caller,
    SENTINELAYER_API_URL: apiUrl,
    SENTINELAYER_SKIP_SENTI_AUTOSTART: "1",
  };
  for (const name of ["SENTINELAYER_TOKEN", "SENTINELAYER_API_TOKEN", "SENTINELAYER_MCP_BRIDGE"]) delete env[name];
  const runtime = await createSessionMcpRuntime({ targetPath: workspace, env });
  const call = (name, args = {}) => handleMcpJsonRpcMessage(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
    runtime,
  );
  return {
    workspace,
    runtime,
    call,
    list: () => handleMcpJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, runtime),
    close: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

async function pendingAdmissionApi() {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString("utf8");
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    const admission = req.method === "POST" && req.url === `/api/v1/sessions/${SID}/admissions`;
    const payload = admission
      ? { admissionId: "adm-mcp-self", status: "pending", approveUrl: "https://example.test/approve", pollAfterSeconds: 2 }
      : { error: { code: "NOT_FOUND" } };
    const encoded = JSON.stringify(payload);
    res.writeHead(admission ? 201 : 404, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(encoded) });
    res.end(encoded);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function approvalRefused(response, name) {
  assert.equal(response.result, undefined, `${name} must not reach a handler`);
  assert.equal(response.error?.code, -32001);
  assert.deepEqual(response.error?.data, { reason: "human_approval_required", tool: name });
}

async function active(workspace, agentId) {
  const agents = await listAgents(SID, { targetPath: workspace });
  return agents.find((agent) => agent.agentId === agentId)?.active;
}

test("stock MCP runtime lists only caller-bound join/leave and can leave self", async () => {
  const fx = await fixture();
  try {
    const listed = (await fx.list()).result.tools;
    assert.deepEqual(listed.map((tool) => tool.name).filter((name) => name.startsWith("sl.")), ["sl.session.join", "sl.session.leave"]);
    for (const tool of listed.filter((item) => item.name.startsWith("sl."))) {
      assert.equal(tool.security.requires_human_approval, false);
      assert.equal(tool.security.runtime_blocked, false);
      assert.equal(tool.metadata.approvalPolicy, "caller_bound_self_provisioning");
    }
    const join = listed.find((tool) => tool.name === "sl.session.join");
    for (const withheld of ["inviteToken", "seatKey", "idempotencyKey", "recoverAdmission"]) {
      assert.equal(join.inputSchema.properties[withheld], undefined, `${withheld} is not an MCP self-join input`);
    }
    await registerAgent(SID, { agentId: "attacker", targetPath: fx.workspace, trackProcessExit: false, preserveIdentity: true });
    await registerAgent(SID, { agentId: "victim", targetPath: fx.workspace, trackProcessExit: false, preserveIdentity: true });
    const result = await fx.call("sl.session.leave", { sessionId: SID, agent: "attacker" });
    assert.equal(result.result?.structuredContent?.ok, true, JSON.stringify(result));
    assert.equal(result.result.structuredContent.json?.agentId, "attacker");
    assert.equal(await active(fx.workspace, "attacker"), false);
    assert.equal(await active(fx.workspace, "victim"), true);
  } finally {
    await fx.close();
  }
});

test("stock MCP runtime refuses attacker-to-victim leave and admission cancellation before either handler", async () => {
  const fx = await fixture();
  try {
    await registerAgent(SID, { agentId: "victim", targetPath: fx.workspace, trackProcessExit: false, preserveIdentity: true });
    approvalRefused(await fx.call("sl.session.leave", { sessionId: SID, agent: "victim" }), "sl.session.leave");
    approvalRefused(await fx.call("sl.session.join", { sessionId: SID, agent: "victim", cancelAdmission: true }), "sl.session.join");
    approvalRefused(await fx.call("sl.session.join", { sessionId: SID, name: "victim", cancelAdmission: true }), "sl.session.join");
    assert.equal(
      (await fx.runtime.handlers["sl.session.leave"]({ sessionId: SID, agent: "victim" })).reason,
      "approval_required",
      "the generated handler independently refuses cross-agent leave",
    );
    assert.equal(
      (await fx.runtime.handlers["sl.session.join"]({ sessionId: SID, agent: "victim", cancelAdmission: true })).reason,
      "approval_required",
      "the generated handler independently refuses cross-agent cancellation",
    );
    assert.equal(await active(fx.workspace, "victim"), true);
  } finally {
    await fx.close();
  }
});

test("stock MCP runtime permits same-agent admission cancellation to reach domain validation", async () => {
  const fx = await fixture();
  try {
    const result = await fx.call("sl.session.join", { sessionId: SID, agent: "attacker", cancelAdmission: true });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.result?.structuredContent?.reason, "cli_command_failed");
    assert.match(result.result.structuredContent.stderr, /No pending admission request for "attacker"/);
    const legacyName = await fx.call("sl.session.join", { sessionId: SID, name: "attacker", cancelAdmission: true });
    assert.equal(legacyName.error, undefined, JSON.stringify(legacyName));
    assert.match(legacyName.result.structuredContent.stderr, /No pending admission request for "attacker"/);
    approvalRefused(await fx.call("sl.session.join", { sessionId: SID, agent: "attacker" }), "sl.session.join");
    approvalRefused(await fx.call("sl.session.say", { sessionId: SID, agent: "attacker", message: ["hello"] }), "sl.session.say");
  } finally {
    await fx.close();
  }
});

test("stock MCP runtime refuses unbound or wider join/leave arguments and retains owner gate", async () => {
  const fx = await fixture();
  try {
    for (const args of [
      { sessionId: SID, agent: "attacker" },
      { sessionId: SID, goal: "Review" },
      { sessionId: SID, agent: "attacker", goal: "Review", inviteToken: "invite-capability" },
      { sessionId: SID, agent: "attacker", goal: "Review", unsupported: true },
      { sessionId: SID, agent: "attacker", cancelAdmission: "true" },
      { sessionId: SID, agent: "attacker:victim", cancelAdmission: true },
    ]) approvalRefused(await fx.call("sl.session.join", args), "sl.session.join");
    for (const args of [
      { sessionId: SID },
      { sessionId: SID, agent: "victim" },
      { sessionId: SID, agent: "attacker", unsupported: true },
      { agent: "attacker" },
    ]) approvalRefused(await fx.call("sl.session.leave", args), "sl.session.leave");
    approvalRefused(await fx.call("sl.session.access.approve", { sessionId: SID, agent: "attacker" }), "sl.session.access.approve");
  } finally {
    await fx.close();
  }
});

test("stock MCP runtime hides self-provisioning when the bridge kill switch is enabled", async () => {
  const fx = await fixture();
  try {
    fx.runtime.env.SENTINELAYER_MCP_CLI_BRIDGE_DISABLED = "1";
    const listed = (await fx.list()).result.tools.map((tool) => tool.name);
    assert.equal(listed.includes("sl.session.join"), false);
    assert.equal(listed.includes("sl.session.leave"), false);
    approvalRefused(await fx.call("sl.session.leave", { sessionId: SID, agent: "attacker" }), "sl.session.leave");
  } finally {
    await fx.close();
  }
});

test("stock MCP runtime files a caller-bound pending admission request for human approval", async () => {
  const api = await pendingAdmissionApi();
  const fx = await fixture("attacker", api.url);
  try {
    const result = await fx.call("sl.session.join", {
      sessionId: SID, agent: "attacker", model: "gpt-6.1-sol", goal: "Review the room", wait: false,
    });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.result?.structuredContent?.json?.admission?.status, "pending", JSON.stringify(result));
    assert.equal(result.result.structuredContent.json?.joined, false);
    assert.equal(JSON.stringify(result).includes("mcp-test-user-token-0000"), false);
    assert.equal(await active(fx.workspace, "attacker"), undefined, "pending approval is not a joined agent");
    assert.deepEqual(api.calls.map((call) => [call.method, call.url]), [
      ["POST", `/api/v1/sessions/${SID}/admissions`],
    ]);
    assert.equal(api.calls[0].authorization, "Bearer mcp-test-user-token-0000");
    assert.equal(JSON.parse(api.calls[0].body).agentId, "attacker");
  } finally {
    await fx.close();
    await api.close();
  }
});

test("stock MCP runtime keeps self-provisioning hidden without a trusted caller", async () => {
  const fx = await fixture("");
  try {
    const listed = (await fx.list()).result.tools.map((tool) => tool.name);
    assert.equal(listed.includes("sl.session.join"), false);
    assert.equal(listed.includes("sl.session.leave"), false);
    approvalRefused(await fx.call("sl.session.leave", { sessionId: SID, agent: "victim" }), "sl.session.leave");
    approvalRefused(await fx.call("sl.session.join", { sessionId: SID, agent: "victim", goal: "Review" }), "sl.session.join");
  } finally {
    await fx.close();
  }
});

test("stock MCP runtime rejects a noncanonical host caller before publishing tools", async () => {
  const fx = await fixture("attacker:victim");
  try {
    const listed = (await fx.list()).result.tools.map((tool) => tool.name);
    assert.equal(listed.includes("sl.session.join"), false);
    assert.equal(listed.includes("sl.session.leave"), false);
    approvalRefused(await fx.call("sl.session.leave", { sessionId: SID, agent: "attacker-victim" }), "sl.session.leave");
  } finally {
    await fx.close();
  }
});
