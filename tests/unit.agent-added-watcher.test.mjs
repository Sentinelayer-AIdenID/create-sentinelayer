import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { watchAgentAdditions, readAgentAddedPage, checkedAddition } from "../src/session/agent-added-watcher.js";
import { exactWatcherAgent, ownerWatcherAuth } from "../src/session/agent-added-owner-auth.js";
import { startAddedRoomListener, ADDED_ROOM_HELLO, ADDED_ROOM_GOAL } from "../src/session/added-room-listener.js";
import { admissionCredentialPath } from "../src/session/admission.js";
import { withAgentAdmission, currentAdmittedAgent, resolveAgentAdmissionTarget } from "../src/session/admission-auth.js";
import { listenSessionEvents } from "../src/session/listener.js";
import { userCredential, isCredential } from "../src/auth/credential-destinations.js";
import { createAgentEvent } from "../src/events/schema.js";
import { buildCliProgram } from "../src/cli.js";
import { buildCliCommandMcpTools, createCliCommandMcpToolHandlers } from "../src/mcp/cli-command-tools.js";

const AGENT = "fixture-forge";
const NOW = Date.parse("2026-11-07T01:00:00Z");
const OWNER_TOKEN = ["owner", "watcher", "test", "only"].join("_");
const ROOM_TOKEN = `sladm_${"W".repeat(43)}`;
const API = "http://127.0.0.1:57239";

async function account(apiUrl = API, token = OWNER_TOKEN) {
  const credential = await userCredential(token, { env: { SENTINELAYER_API_URL: apiUrl }, source: "env" });
  return { source: "env", apiUrl, credential };
}
function notification(id = "n1", sessionId = "room-1", overrides = {}) {
  return { id, kind: "agent_added", createdAt: new Date(NOW - 1000).toISOString(),
    payload: { sessionId, agentId: AGENT, title: "Untrusted room name", addedBy: "Fixture person" }, ...overrides };
}
function page(items = [], cursor = "aa1.cursor1") {
  return { ok: true, notifications: items, nextCursor: cursor };
}
function liveHandle(options, starts) {
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const handle = { ready: Promise.resolve({ joined: true }), done, stopped: false,
    stop() { this.stopped = true; finish(); } };
  starts.push({ options, handle });
  return handle;
}
async function watchOptions(overrides = {}) {
  const auth = await account();
  return { agentId: AGENT, maxPolls: 1, _resolveAuth: async () => auth,
    _now: () => NOW, _sleep: async () => {}, ...overrides };
}
async function storeAdmission(sessionId, apiUrl, overrides = {}) {
  const file = admissionCredentialPath(sessionId, AGENT);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ version: 2, sessionId, agentId: AGENT,
    apiUrl, token: ROOM_TOKEN, admissionId: randomUUID(), expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides }));
  return file;
}

test("the owner watcher only reads the exact agent's filtered notification route", async () => {
  const owner = await ownerWatcherAuth(AGENT, { resolveAuth: async () => account() });
  const requests = [];
  await readAgentAddedPage(owner, AGENT, "aa1.position", { requestRead: async (url, options) => {
    requests.push({ url: new URL(url), options }); return page();
  } });
  assert.equal(requests.length, 1);
  const [{ url, options }] = requests;
  assert.equal(url.pathname, "/api/v1/sessions/notifications");
  assert.deepEqual(Object.fromEntries(url.searchParams), { kind: "agent_added", agentId: AGENT, limit: "50", after: "aa1.position" });
  assert.equal(options.method, "GET");
  assert.equal(options.maxRetries, 0);
  assert.ok(isCredential(options.credential));
});

test("one poll starts the added chat once and passes no account credential into its worker", async () => {
  const starts = [], notices = [];
  const result = await watchAgentAdditions(await watchOptions({
    _readPage: async () => page([notification(), notification("n2")]),
    _startListener: (options) => liveHandle(options, starts), onNotice: async (notice) => notices.push(notice),
  }));
  assert.equal(result.polls, 1);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].options.sessionId, "room-1");
  assert.equal(starts[0].options.agentId, AGENT);
  assert.match(starts[0].options.ownerBinding, /^[0-9a-f]{64}$/);
  for (const forbidden of ["credential", "token", "auth", "resolveAuthSession", "requestRead", "title", "goal", "payload"]) {
    assert.equal(starts[0].options[forbidden], undefined, `${forbidden} must not cross the watcher boundary`);
  }
  assert.equal(starts[0].handle.stopped, true, "bounded watcher cleans up listeners");
  assert.equal(notices.filter((n) => n.type === "joined").length, 1);
});

test("later notifications join without restarting the owner watcher", async () => {
  const starts = [], cursors = [];
  await watchAgentAdditions(await watchOptions({ maxPolls: 3,
    _readPage: async (_owner, _agent, cursor) => {
      cursors.push(cursor);
      return page(cursors.length === 1 ? [] : [notification(`n${cursors.length}`, `room-${cursors.length}`)], `aa1.cursor${cursors.length}`);
    }, _startListener: (options) => liveHandle(options, starts),
  }));
  assert.deepEqual(cursors, [null, "aa1.cursor1", "aa1.cursor2"]);
  assert.deepEqual(starts.map((s) => s.options.sessionId), ["room-2", "room-3"]);
  assert.ok(starts.every((s) => s.handle.stopped));
});

test("malformed or another agent's addition never starts a worker or advances its cursor", async () => {
  const starts = [], cursors = [];
  const bad = notification("n2", "room-2", { payload: { sessionId: "room-2", agentId: "another-agent" } });
  await watchAgentAdditions(await watchOptions({ maxPolls: 2,
    _readPage: async (_owner, _agent, cursor) => { cursors.push(cursor); return page([notification(), bad]); },
    _startListener: (options) => liveHandle(options, starts),
  }));
  assert.deepEqual(starts, []);
  assert.deepEqual(cursors, [null, null]);
  assert.throws(() => checkedAddition(notification("n", "../outside"), AGENT, NOW), /invalid/);
  assert.equal(checkedAddition(notification("old", "room", { createdAt: new Date(NOW - 86400001).toISOString() }), AGENT, NOW), null);
});

test("account change stops the watcher and every active room before another feed read", async () => {
  const first = await account(), second = await account(API, "different_fixture_account");
  let resolves = 0, reads = 0;
  const starts = [];
  await assert.rejects(watchAgentAdditions(await watchOptions({ maxPolls: 3,
    _resolveAuth: async () => ++resolves <= 2 ? first : second,
    _readPage: async () => { reads++; return page([notification()]); },
    _startListener: (options) => liveHandle(options, starts),
  })), /sign-in changed/);
  assert.equal(reads, 1);
  assert.equal(starts[0].handle.stopped, true);
});

test("an exhausted pending join frees capacity and reports failure after five attempts", async () => {
  let now = NOW, attempts = 0, reads = 0;
  const notices = [];
  const result = await watchAgentAdditions(await watchOptions({ maxPolls: 7, _now: () => now,
    _sleep: async () => { now += 360000; },
    _readPage: async () => { reads++; return page(reads === 1 ? [notification()] : [], `aa1.cursor${reads}`); },
    _startListener: () => { attempts++; return { ready: Promise.resolve({ joined: false }), done: Promise.resolve(), stop() {} }; },
    onNotice: async (notice) => notices.push(notice),
  }));
  assert.equal(attempts, 5);
  assert.equal(result.pending, 0, "failed entries must not permanently block new notification pages");
  assert.equal(notices.filter((n) => n.type === "join_failed").length, 1);
});

test("feed authorization failures stop immediately and never start a room", async () => {
  for (const status of [400, 401, 403]) {
    let starts = 0, reads = 0;
    await assert.rejects(watchAgentAdditions(await watchOptions({ maxPolls: 8,
      _readPage: async () => { reads++; throw Object.assign(new Error("private response body"), { status }); },
      _startListener: () => { starts++; },
    })), /notification feed refused/);
    assert.equal(reads, 1); assert.equal(starts, 0);
  }
});

test("the owner watcher refuses admitted context, even with an account resolver available", async () => {
  const sid = randomUUID();
  await storeAdmission(sid, API);
  let resolves = 0;
  await withAgentAdmission(sid, AGENT, async () => {
    await assert.rejects(watchAgentAdditions(await watchOptions({
      _resolveAuth: async () => { resolves++; return account(); },
    })), /cannot run inside a room admission/);
  }, { requireStored: true });
  assert.equal(resolves, 0);
});

test("the owner watcher validates exact identity, account source and bounds before reading", async () => {
  for (const value of ["Forge", " forge", "human-fixture", "unknown", "agent/other", "x".repeat(65)]) assert.throws(() => exactWatcherAgent(value));
  for (const options of [{ intervalSeconds: 9 }, { maxRooms: 501 }, { maxPolls: 0 }]) {
    await assert.rejects(watchAgentAdditions(await watchOptions(options)));
  }
  const auth = await account();
  await assert.rejects(ownerWatcherAuth(AGENT, { resolveAuth: async () => ({ ...auth, source: "session_admission" }) }), /account sign-in/);
});

function mockedWorker(overrides = {}) {
  const calls = [];
  const auth = { source: "env" };
  const options = {
    sessionId: "worker-room", notificationId: "n1", agentId: AGENT, ownerBinding: "binding",
    _ownerAuth: async () => ({ binding: "binding", auth }),
    _join: async (_room, opts) => { calls.push(["join", opts]); assert.equal(await opts.resolveAuthSession(), auth); return { status: "active" }; },
    _withAdmission: async (_room, _agent, fn, opts) => { assert.equal(opts.requireStored, true); calls.push(["scope"]); return fn(); },
    _receipt: async () => { calls.push(["receipt"]); return { agentId: AGENT }; },
    _presence: async () => { calls.push(["presence"]); return { ok: true, recorded: true }; },
    _latest: async () => { calls.push(["latest"]); return { ok: true, cursor: "before-hello" }; },
    _post: async (_room, event, opts) => { calls.push(["hello", event, opts]); return { synced: true }; },
    _listen: async (opts) => { calls.push(["listen", opts]); },
    ...overrides,
  };
  return { calls, options };
}

test("room startup claims normally then reads its receipt and primes before one plain hello", async () => {
  const { calls, options } = mockedWorker();
  const handle = startAddedRoomListener(options);
  assert.deepEqual(await handle.ready, { joined: true });
  await handle.done;
  assert.deepEqual(calls.map((c) => c[0]), ["join", "scope", "receipt", "presence", "latest", "hello", "listen"]);
  assert.deepEqual(calls[0][1].actions, ["session.read", "session.post"]);
  assert.equal(calls[0][1].goal, ADDED_ROOM_GOAL);
  assert.equal(calls[0][1].noAutoGrant, true);
  assert.equal(calls[0][1].requireAccountCheck, true);
  assert.ok(calls[0][1].signal instanceof AbortSignal);
  assert.equal(calls[5][1].payload.message, ADDED_ROOM_HELLO);
  assert.equal(calls[5][1].idempotencyToken, `agent-added:n1:${AGENT}`);
  assert.equal(calls[5][2].noAutoGrant, true);
  assert.equal(calls[6][1].since, "before-hello");
  assert.equal(calls[6][1].replay, true);
});

test("pending, denied and revoked requests cannot post a hello", async () => {
  for (const status of ["pending", "denied", "revoked"]) {
    const { calls, options } = mockedWorker({ _join: async () => ({ status }) });
    const handle = startAddedRoomListener(options);
    assert.deepEqual(await handle.ready, { joined: false }); await handle.done;
    assert.deepEqual(calls, []);
  }
});

test("a missing stored admission cannot fall back after bootstrap reports success", async () => {
  const { calls, options } = mockedWorker({ sessionId: randomUUID(), _withAdmission: withAgentAdmission });
  const handle = startAddedRoomListener(options);
  await assert.rejects(handle.ready, /will not fall back/);
  await assert.rejects(handle.done, /will not fall back/);
  assert.deepEqual(calls.map((c) => c[0]), ["join"]);
});

test("a wrong-agent receipt and a failed initial read prevent the hello", async () => {
  for (const override of [{ _receipt: async () => ({ agentId: "outsider" }) }, { _latest: async () => ({ ok: false }) }]) {
    const { calls, options } = mockedWorker(override);
    const handle = startAddedRoomListener(options);
    await assert.rejects(handle.ready); await assert.rejects(handle.done);
    assert.equal(calls.some((c) => c[0] === "hello"), false);
  }
});

test("cancellation during admission setup prevents presence, hello and listener startup", async () => {
  const controller = new AbortController();
  const { calls, options } = mockedWorker({ signal: controller.signal,
    _join: async () => { controller.abort(); return { status: "active" }; } });
  const handle = startAddedRoomListener(options);
  assert.deepEqual(await handle.ready, { joined: false }); await handle.done;
  assert.deepEqual(calls, []);
});

test("room revocation stops polling without trying the account credential", async () => {
  let seenSignal;
  const { options } = mockedWorker({ _listen: async (opts) => { seenSignal = opts.signal; await opts.onError({ reason: "api_403", status: 403 }); } });
  const handle = startAddedRoomListener(options);
  await handle.ready; await handle.done;
  assert.equal(seenSignal.aborted, true);
});

test("every real room request uses its admission and a reply arriving after hello remains visible", async () => {
  const sid = randomUUID(), requests = [], delivered = [];
  let posted = false;
  const before = createAgentEvent({ event: "session_message", agentId: "human-fixture", sessionId: sid,
    agentModel: "fixture", sequenceId: 1, cursor: "before-hello", payload: { message: "Welcome" } });
  const reply = createAgentEvent({ event: "session_message", agentId: "human-fixture", sessionId: sid,
    agentModel: "fixture", sequenceId: 3, cursor: "after-hello", payload: { message: "A response during startup" } });
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, path: req.url, bearer: String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""), body: raw ? JSON.parse(raw) : null });
    let body = { ok: true, recorded: true };
    if (req.url.includes("/admissions/self")) body = { agentId: AGENT };
    else if (req.url.includes("/events/before")) body = { events: [before], has_more: false };
    else if (req.method === "POST" && req.url.endsWith("/events")) { posted = true; body = { ok: true, sequenceId: 2, cursor: "hello" }; }
    else if (req.method === "GET" && req.url.includes("/events")) body = { events: posted ? [reply] : [], nextCursor: posted ? "after-hello" : "before-hello" };
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-added-room-"));
  const prior = { token: process.env.SENTINELAYER_TOKEN, url: process.env.SENTINELAYER_API_URL, skip: process.env.SENTINELAYER_SKIP_REMOTE_SYNC };
  process.env.SENTINELAYER_TOKEN = OWNER_TOKEN;
  process.env.SENTINELAYER_API_URL = apiUrl;
  process.env.SENTINELAYER_SKIP_REMOTE_SYNC = "0";
  try {
    const auth = await account(apiUrl);
    const owner = await ownerWatcherAuth(AGENT, { resolveAuth: async () => auth });
    const handle = startAddedRoomListener({ sessionId: sid, notificationId: "network-notice", agentId: AGENT,
      ownerBinding: owner.binding, targetPath: workspace, _ownerAuth: async () => owner,
      _join: async (_sid, options) => { assert.equal(await options.resolveAuthSession(), auth); await storeAdmission(sid, apiUrl); return { status: "active" }; },
      _listen: (options) => listenSessionEvents({ ...options, maxPolls: 1 }),
      onEvent: async (event) => { assert.equal(currentAdmittedAgent()?.agentId, AGENT); delivered.push(event); },
    });
    assert.deepEqual(await handle.ready, { joined: true });
    await handle.done;
    assert.ok(requests.length >= 5, "receipt, presence, prime, hello and poll reached the API");
    assert.deepEqual(requests.filter((r) => r.bearer !== ROOM_TOKEN), [], "no room request may carry the configured owner token");
    assert.equal(requests.filter((r) => r.method === "POST" && r.path.endsWith("/events")).length, 1);
    assert.ok(requests.find((r) => r.method === "GET" && new URL(r.path, apiUrl).searchParams.get("after") === "before-hello"), "listener retains the cursor from before the hello");
    assert.ok(delivered.some((event) => event.payload?.message === "A response during startup"));
  } finally {
    for (const [key, value] of [["SENTINELAYER_TOKEN", prior.token], ["SENTINELAYER_API_URL", prior.url], ["SENTINELAYER_SKIP_REMOTE_SYNC", prior.skip]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});

test("the generated MCP bridge blocks the owner watcher before executing it", async () => {
  const tools = await buildCliCommandMcpTools({ buildProgramFn: async () => buildCliProgram({ invokeLegacy: async () => {} }) });
  const tool = tools.find((entry) => entry.name === "sl.agent.watch-added");
  assert.ok(tool, "the CLI command is registered");
  assert.equal(tool.security.runtime_blocked, true);
  const handlers = createCliCommandMcpToolHandlers(tools, { approve: () => true });
  const response = await handlers[tool.name]({ agent: AGENT, maxPolls: 1 });
  assert.equal(response.ok, false);
  assert.match(String(response.reason), /sensitive|blocked/);
});

test("owner watcher dispatch rejects duplicate identity and workspace options", async () => {
  for (const args of [
    ["--agent", AGENT, "--agent=outsider"],
    ["--agent", AGENT, "--path", ".", "--path=elsewhere"],
  ]) {
    await assert.rejects(resolveAgentAdmissionTarget(["agent", "watch-added", ...args]), /given 2 times/);
  }
});
