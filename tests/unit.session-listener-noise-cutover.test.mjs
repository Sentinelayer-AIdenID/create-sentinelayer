import "./setup-env.mjs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "bin", "create-sentinelayer.js");
const TEST_TOKEN = ["api", "token", "unit", "presence", "cutover"].join("_");

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim() ? JSON.parse(raw) : {};
}

async function startMockApi({ renew, roster } = {}) {
  const state = {
    presenceWrites: [],
    durableEventWrites: [],
    actionWrites: [],
    readCursorWrites: [],
    eventReads: 0,
    listenerAgentIds: [],
    presenceReads: 0,
    present: [],
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (
      req.method === "GET" &&
      url.pathname === "/api/v1/sessions/sess-noise/events"
    ) {
      state.eventReads += 1;
      state.listenerAgentIds.push(url.searchParams.get("listenerAgentId"));
      return jsonResponse(res, 200, {
        sessionId: "sess-noise",
        listenerControls: [],
        events: [],
        cursor: null,
      });
    }
    if (
      req.method === "PUT" &&
      url.pathname === "/api/v1/sessions/sess-noise/presence"
    ) {
      const body = await readJsonBody(req);
      state.presenceWrites.push(body);
      const refusal = renew?.(body, state);
      if (refusal?.disconnect) return res.destroy();
      if (refusal) return jsonResponse(res, refusal.status, refusal.body);
      state.present = [{ agentId: body.agentId, model: body.model }];
      return jsonResponse(res, 200, {
        status: "ok",
        recorded: true,
        ttlSeconds: 90,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/sessions/sess-noise/presence") {
      state.presenceReads += 1;
      const response = roster || { status: 200, body: { status: "ok", present: state.present } };
      return jsonResponse(res, response.status, response.body);
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/v1/sessions/sess-noise/events"
    ) {
      state.durableEventWrites.push(await readJsonBody(req));
      return jsonResponse(res, 200, { ok: true });
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/v1/sessions/sess-noise/actions"
    ) {
      state.actionWrites.push(await readJsonBody(req));
      return jsonResponse(res, 200, { ok: true });
    }
    if (
      req.method === "PUT" &&
      url.pathname === "/api/v1/sessions/sess-noise/read-cursor"
    ) {
      state.readCursorWrites.push(await readJsonBody(req));
      return jsonResponse(res, 200, {
        ok: true,
        updated: true,
        lastReadSequenceId: 1,
      });
    }
    return jsonResponse(res, 404, { error: "not_found", path: url.pathname });
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    apiUrl: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

function runCli(args, { cwd, apiUrl }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: cwd,
        USERPROFILE: cwd,
        XDG_CONFIG_HOME: path.join(cwd, ".config"),
        NODE_ENV: "test",
        SENTINELAYER_CLI_TEST_MODE: "1",
        SENTINELAYER_CLI_SKIP_AUTH: "1",
        SENTINELAYER_SKIP_SENTI_AUTOSTART: "1",
        SENTINELAYER_SKIP_REMOTE_SYNC: "0",
        SENTINELAYER_TOKEN: TEST_TOKEN,
        SENTINELAYER_API_URL: apiUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => child.kill(), 15_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

test("Unit session listener cutover: one poll writes presence only, never durable noise", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sl-listener-noise-cutover-"));
  const mock = await startMockApi();
  try {
    const result = await runCli(
      [
        "session",
        "listen",
        "--session",
        "sess-noise",
        "--agent",
        "codex",
        "--transport",
        "poll",
        "--max-polls",
        "1",
        "--emit",
        "text",
        "--path",
        tmp,
      ],
      { cwd: tmp, apiUrl: mock.apiUrl },
    );

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(mock.state.eventReads, 1);
    assert.deepEqual(mock.state.listenerAgentIds, ["codex"]);
    assert.ok(mock.state.presenceWrites.length >= 1);
    assert.equal(mock.state.durableEventWrites.length, 0);
    assert.equal(mock.state.actionWrites.length, 0);
    assert.equal(mock.state.readCursorWrites.length, 0);
    assert.ok(
      mock.state.presenceWrites.every((payload) => payload.agentId === "codex"),
    );
  } finally {
    await mock.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

async function presenceScenario(options, extraArgs = []) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sl-presence-check-"));
  const mock = await startMockApi(options);
  try {
    const result = await runCli([
      "session", "listen", "--session", "sess-noise", "--agent", "test-agent",
      "--model", "test-model", "--transport", "poll", "--max-polls", "1",
      "--interval", "1", "--presence-interval", "1", "--no-coaching",
      "--emit", "ndjson", "--path", tmp, ...extraArgs,
    ], { cwd: tmp, apiUrl: mock.apiUrl });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const events = extraArgs.includes("text") ? [] : result.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
    return { ...result, state: mock.state, events };
  } finally {
    await mock.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

test("Unit session listener presence: retries identity refusal once and remembers minimal presence", async () => {
  const result = await presenceScenario({
    renew: (body) => Object.keys(body).some((key) => !["agentId", "model"].includes(key))
      ? { status: 403, body: { detail: { code: "AGENT_IDENTITY_REQUIRED" } } }
      : null,
  }, ["--presence-check", "--max-polls", "2"]);
  assert.ok(result.state.presenceWrites.length >= 3);
  assert.ok(result.state.presenceWrites[0].listenerId);
  for (const body of result.state.presenceWrites.slice(1)) {
    assert.deepEqual(body, { agentId: "test-agent", model: "test-model" });
  }
  assert.equal((result.stderr.match(/runtime\/working/g) || []).length, 1);
  assert.equal(result.state.presenceReads, 1);
  assert.equal(result.events.find((event) => event.event === "session_presence_check")?.payload.present, true);
  assert.equal(result.state.durableEventWrites.length, 0);
});

test("Unit session listener presence: a failed fallback is reported without another downgrade", async () => {
  const result = await presenceScenario({
    renew: () => ({ status: 403, body: { error: { code: "AGENT_IDENTITY_REQUIRED" } } }),
  });
  assert.equal(result.state.presenceWrites.length, 3); // initial, retry, stopped
  assert.ok(result.state.presenceWrites[0].listenerId);
  assert.ok(result.state.presenceWrites.slice(1).every((body) => !body.listenerId));
  assert.equal((result.stderr.match(/runtime\/working/g) || []).length, 1);
  assert.match(result.stderr, /Presence renewal failed.*api_403/);
});

test("Unit session listener presence: other refusals are visible and never downgrade", async () => {
  for (const status of [401, 403, 404, 429, 503]) {
    const result = await presenceScenario({ renew: () => ({ status, body: { code: "OTHER_ERROR" } }) });
    assert.equal(result.state.presenceWrites.length, 2, `status ${status}: no immediate retry`);
    assert.ok(result.state.presenceWrites.every((body) => body.listenerId));
    assert.match(result.stderr, /Presence renewal failed/);
    assert.doesNotMatch(result.stderr, /runtime\/working/);
    assert.equal(result.state.presenceReads, 0);
  }
});

test("Unit session listener presence: check reports absent and unknown separately", async () => {
  for (const [roster, present] of [
    [{ status: 200, body: { status: "ok", present: [{ agentId: "another-agent" }] } }, false],
    [{ status: 503, body: {} }, null],
  ]) {
    const result = await presenceScenario({ roster }, ["--presence-check"]);
    assert.equal(result.state.presenceReads, 1);
    assert.equal(result.events.find((event) => event.event === "session_presence_check")?.payload.present, present);
    if (present === null) assert.match(result.stderr, /Presence check.*unknown/);
  }
});

test("Unit session listener presence: transport and unrecorded renewals are reported", async () => {
  for (const response of [
    { disconnect: true },
    { status: 200, body: { status: "degraded", recorded: false } },
    { status: 200, body: { status: "ok", recorded: false } },
  ]) {
    const result = await presenceScenario({ renew: () => response });
    assert.match(result.stderr, /Presence renewal failed/);
    assert.doesNotMatch(result.stderr, /runtime\/working/);
    assert.equal(result.state.presenceWrites.length, 2);
  }
});

test("Unit session listener presence: explicit check still reads when renewal is disabled", async () => {
  const result = await presenceScenario({}, ["--presence-check", "--no-presence", "--emit", "text"]);
  assert.equal(result.state.presenceWrites.length, 0);
  assert.equal(result.state.presenceReads, 1);
  assert.match(result.stdout, /Presence check: test-agent is not listed/);
});
