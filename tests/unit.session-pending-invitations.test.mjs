import "./setup-env.mjs";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
import * as invitations from "../src/session/invitations.js";
import { createSession } from "../src/session/store.js";
import { fetchJsonWithFullTimeout, resetSessionSyncStateForTests, streamSessionEvents } from "../src/session/sync.js";
import { listenSessionEvents } from "../src/session/listener.js";
import { createSessionMcpToolHandlers, handleMcpJsonRpcMessage } from "../src/mcp/session-stdio-server.js";
import { buildCliCommandMcpTools } from "../src/mcp/cli-command-tools.js";

const API = "https://api.fixture.invalid";
const ROOM = "sample-room";
const HINT = "An invitation to this room is waiting. Run `sl session invitations list --json`, then `sl session invitations accept <invitationId>` using its invitationId.";
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});

async function fixture(t) {
  const targetPath = await mkdtemp(path.join(os.tmpdir(), "sl-pending-invitation-"));
  const env = { ...process.env };
  const originalFetch = globalThis.fetch;
  const exitCode = process.exitCode;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    process.exitCode = exitCode;
    for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
    Object.assign(process.env, env);
    await rm(targetPath, { recursive: true, force: true });
  });
  process.env.SENTINELAYER_TOKEN = ["test", "credential"].join("-");
  process.env.SENTINELAYER_API_URL = API;
  process.env.SENTINELAYER_API_ALLOWED_HOSTS = "api.fixture.invalid";
  delete process.env.SENTINELAYER_AGENT_ID;
  resetSessionSyncStateForTests();
  return targetPath;
}

async function command(args) {
  const program = new Command().name("sl").exitOverride()
    .configureOutput({ writeOut() {}, writeErr() {} });
  registerSessionCommand(program);
  const lines = [];
  const originalLog = console.log;
  console.log = (...parts) => lines.push(parts.join(" "));
  try {
    await program.parseAsync(["session", ...args], { from: "user" });
    return { output: lines.join("\n"), error: null };
  } catch (error) {
    return { output: lines.join("\n"), error };
  } finally {
    console.log = originalLog;
  }
}

function refusal(code, status) {
  return json({ error: { code, message: "Access refused.", request_id: "request-example" } }, status);
}

for (const verb of ["read", "say", "join"]) {
  test(`session ${verb}: pending invitation gives one accept hint; generic refusal stays unchanged`, async (t) => {
    const targetPath = await fixture(t);
    await createSession({ sessionId: ROOM, targetPath });
    const args = verb === "read" ? ["read", ROOM, "--remote", "--no-actions", "--no-view"]
      : verb === "say" ? ["say", ROOM, "example message", "--force-cli-user"] : ["join", ROOM];
    for (const status of [403, 404]) {
      resetSessionSyncStateForTests();
      const calls = [];
      globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method || "GET" });
        // Let say reach the POST, rather than failing at its confirmation read.
        if (verb === "say" && (init.method || "GET") === "GET") return json({ events: [] });
        return refusal("INVITATION_PENDING", status);
      };
      const result = await command([...args, "--path", targetPath]);
      assert.equal(result.error?.message, HINT);
      assert.doesNotMatch(result.output, /invitation/i);
      if (verb === "say") assert.ok(calls.some((call) => call.method === "POST" && call.url.endsWith("/events")));
      if (verb === "join") assert.equal(calls.length, 1, "no retry or list fallback for a pending invitation");
    }
    resetSessionSyncStateForTests();
    globalThis.fetch = async () => refusal("SESSION_FORBIDDEN", 403);
    const generic = await command([...args, "--path", targetPath]);
    assert.doesNotMatch(`${generic.output}\n${generic.error?.message || ""}`, /invitations accept|invitation.*waiting/i);
    if (verb === "join") assert.equal(generic.error?.message, `Session '${ROOM}' exists but your account is not a member.`);
    if (verb === "say") assert.match(generic.error?.message || "", /Remote send confirmation anchor failed \(api_403\)/);
    if (verb === "read") assert.match(generic.output, /Remote hydrate skipped \(/);
  });
}

test("session listen: poll and stream refusals carry the accept hint", async (t) => {
  const targetPath = await fixture(t);
  globalThis.fetch = async () => refusal("INVITATION_PENDING", 403);
  await assert.rejects(listenSessionEvents({ sessionId: ROOM, targetPath, fromNow: true, maxPolls: 1 }), { message: HINT });
  await assert.rejects(streamSessionEvents(ROOM, { targetPath }), { message: HINT });
  globalThis.fetch = async () => refusal("SESSION_FORBIDDEN", 403);
  assert.equal((await streamSessionEvents(ROOM, { targetPath })).reason, "api_403");
});

test("session transport recognizes only the pending code on a refusal and tolerates unreadable bodies", async () => {
  const request = (response, options) => fetchJsonWithFullTimeout(`${API}/api/v1/sessions/${ROOM}`, {}, 20,
    async () => response, options);
  await assert.rejects(request(refusal("INVITATION_PENDING", 403)), { message: HINT, status: 403 });
  for (const code of ["SESSION_FORBIDDEN", "NOT_FOUND", "invitation_pending", undefined]) {
    const result = await request(refusal(code, 403));
    assert.equal(result.response.status, 403);
  }
  assert.equal((await request(refusal("INVITATION_PENDING", 500))).response.status, 500);
  assert.equal((await request(json({ error: { code: "INVITATION_PENDING" } }))).response.ok, true);
  assert.equal((await request(new Response("not json", { status: 404 }))).response.status, 404);
  const stalled = { status: 403, ok: false, json: () => new Promise(() => {}) };
  assert.equal((await request(stalled)).response.status, 403);
});

test("MCP session tools return the invitation hint as an error", async (t) => {
  const targetPath = await fixture(t);
  globalThis.fetch = async () => refusal("INVITATION_PENDING", 404);
  const result = await handleMcpJsonRpcMessage({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "poll_inbox", arguments: { sessionId: ROOM, agentId: "sample-agent", includeActions: false } },
  }, { targetPath, handlers: createSessionMcpToolHandlers({ targetPath }) });
  assert.equal(result.result.isError, true);
  assert.match(JSON.stringify(result.result), /sl session invitations accept <invitationId>/);
});

test("invitation CLI bridge inputs remain strict and require human approval", async () => {
  const tools = await buildCliCommandMcpTools();
  for (const name of ["sl.session.invitations.list", "sl.session.invitations.accept"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool);
    assert.equal(tool.security.requires_human_approval, true);
    assert.equal(tool.security.runtime_block_reason, "approval_required");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.apiUrl, undefined);
    assert.equal(tool.inputSchema.properties.origin, undefined);
  }
});

test("session invitations list uses authenticated pending route and preserves raw JSON", async (t) => {
  const targetPath = await fixture(t);
  const payload = { invitations: [{ invitationId: "sample-invitation" }] };
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return json(payload);
  };
  const result = await command(["invitations", "list", "--json", "--path", targetPath]);
  assert.equal(result.error, null);
  assert.deepEqual(JSON.parse(result.output), payload);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API}/api/v1/sessions/invitations/pending`);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(new Headers(calls[0].init.headers).get("Authorization"), `Bearer ${process.env.SENTINELAYER_TOKEN}`);
  assert.equal(new Headers(calls[0].init.headers).get("Idempotency-Key"), null);
  assert.equal((await command(["invitations", "list", "--path", targetPath])).output, "Invitation: sample-invitation");
  globalThis.fetch = async () => json([]);
  assert.equal((await command(["invitations", "list", "--path", targetPath])).output, "No pending invitations.");
  const unknownPayload = { futureEnvelope: [{ invitationId: "sample-invitation" }] };
  globalThis.fetch = async () => json(unknownPayload);
  assert.deepEqual(JSON.parse((await command(["invitations", "list", "--json", "--path", targetPath])).output), unknownPayload);
  assert.match((await command(["invitations", "list", "--path", targetPath])).output, /Use `sl session invitations list --json`/);
  globalThis.fetch = async () => refusal("SESSION_FORBIDDEN", 403);
  const rejected = await command(["invitations", "list", "--path", targetPath]);
  assert.equal(rejected.error?.code, "SESSION_FORBIDDEN");
  assert.equal(rejected.output, "");
});

test("session invitations accept uses invitation id, mutation headers and raw JSON", async (t) => {
  const targetPath = await fixture(t);
  const payload = { example: "raw response" };
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return json(payload);
  };
  const result = await command(["invitations", "accept", "sample-invitation", "--json", "--path", targetPath]);
  assert.equal(result.error, null);
  assert.deepEqual(JSON.parse(result.output), payload);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API}/api/v1/sessions/invitations/sample-invitation/accept`);
  assert.equal(calls[0].init.method, "POST");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("Authorization"), `Bearer ${process.env.SENTINELAYER_TOKEN}`);
  assert.equal(headers.get("Origin"), "https://sentinelayer.com");
  assert.equal(headers.get("Sec-Fetch-Site"), "same-site");
  assert.equal(headers.get("X-Sentinelayer-Session-Mutation"), "session-mutation");
  assert.ok(headers.get("Idempotency-Key"));
  const proof = ["session-mutation-csrf:v1", "unavailable",
    "POST /api/v1/sessions/invitations/{invitation_id}/accept", headers.get("Idempotency-Key")].join("\0");
  assert.equal(headers.get("X-CSRF-Token"), createHmac("sha256", process.env.SENTINELAYER_TOKEN).update(proof).digest("hex"));
  assert.deepEqual(JSON.parse(calls[0].init.body), {});
  assert.equal((await command(["invitations", "accept", "sample-invitation", "--path", targetPath])).output, "Invitation accepted.");
  globalThis.fetch = async () => refusal("INVITATION_EXPIRED", 403);
  const rejected = await command(["invitations", "accept", "sample-invitation", "--path", targetPath]);
  assert.equal(rejected.error?.code, "INVITATION_EXPIRED");
  assert.equal(rejected.output, "");
});

test("accept rejects an empty invitation id before auth or transport", async () => {
  assert.equal(typeof invitations.acceptPendingSessionInvitation, "function");
  for (const id of ["", "   ", undefined, {}, []]) {
    await assert.rejects(invitations.acceptPendingSessionInvitation(id, {
      resolveAuthSession: async () => assert.fail("must validate before authentication"),
      requestMutation: async () => assert.fail("must not send a request"),
    }), /invitation id is required/);
  }
  for (const id of ["..", "sample/other", "sample\\other"]) {
    await assert.rejects(invitations.acceptPendingSessionInvitation(id, {
      resolveAuthSession: async () => assert.fail("must validate before authentication"),
    }), /single URL path segment/);
  }
});
