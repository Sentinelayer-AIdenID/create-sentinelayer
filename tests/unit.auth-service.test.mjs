import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { Command } from "commander";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";

import {
  getAuthStatus,
  getRuntimeRunStatus,
  listStoredAuthSessions,
  listRuntimeRunEvents,
  loginAndPersistSession,
  logoutSession,
  revokeAuthToken,
  resolveActiveAuthSession,
} from "../src/auth/service.js";
import { readStoredSession, resolveCredentialsFilePath, writeStoredSession } from "../src/auth/session-store.js";
import { __resetRequestCircuitForTests } from "../src/auth/http.js";
import { registerAuthCommand } from "../src/commands/auth.js";
import { bearerOf } from "./credential-probe.mjs";

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
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}

async function startAuthRuntimeMockApi({ pollResponses = null, meStatus = 200, onPoll = () => {} } = {}) {
  const state = {
    pollCalls: 0,
    tokenIssueCalls: 0,
    tokenDeleteIds: [],
    statusCalls: 0,
    requestIds: [],
    flowRequestIds: [],
  };
  const runtimeEvents = [
    {
      event_id: "evt_1",
      run_id: "run-1",
      ts: "2026-04-01T00:00:00.000Z",
      type: "run_started",
      actor: "orchestrator",
      payload: { summary: "runtime started" },
      duration_ms: 0,
      token_usage: 0,
      cost_usd: 0,
    },
    {
      event_id: "evt_2",
      run_id: "run-1",
      ts: "2026-04-01T00:00:01.000Z",
      type: "reasoning_summary",
      actor: "orchestrator",
      payload: { summary: "running checks" },
      duration_ms: 25,
      token_usage: 120,
      cost_usd: 0.0008,
    },
  ];

  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");
      const pathname = parsedUrl.pathname;

      if (req.method === "POST" && pathname === "/api/v1/auth/cli/sessions/start") {
        state.requestIds.push(String(req.headers["x-request-id"] || ""));
        state.flowRequestIds.push(String(req.headers["x-flow-request-id"] || ""));
        await readJsonBody(req);
        return jsonResponse(res, 200, {
          session_id: "sess_1",
          authorize_url: "http://127.0.0.1/cli-auth?session_id=sess_1",
          poll_interval_seconds: 0,
        });
      }

      if (req.method === "POST" && pathname === "/api/v1/auth/cli/sessions/poll") {
        state.requestIds.push(String(req.headers["x-request-id"] || ""));
        state.flowRequestIds.push(String(req.headers["x-flow-request-id"] || ""));
        await readJsonBody(req);
        state.pollCalls += 1;
        onPoll();
        if (Array.isArray(pollResponses) && pollResponses.length > 0) {
          const pollResponse = pollResponses[Math.min(state.pollCalls - 1, pollResponses.length - 1)];
          return jsonResponse(res, Number(pollResponse.httpStatus || 200), pollResponse.payload || {});
        }
        if (state.pollCalls === 1) {
          return jsonResponse(res, 200, { status: "pending" });
        }
        return jsonResponse(res, 200, {
          status: "approved",
          auth_token: "auth_token_web_1",
          aidenid_credentials: {
            provisioned: true,
            org_id: "org_1",
            project_id: "proj_1",
            api_key_prefix: "aid_",
            provisioned_at: "2026-04-01T00:00:00.000Z",
          },
          user: {
            id: "user_1",
            github_username: "demo-user",
            email: "demo@example.com",
          },
        });
      }

      if (req.method === "GET" && pathname === "/api/v1/auth/me") {
        state.requestIds.push(String(req.headers["x-request-id"] || ""));
        state.flowRequestIds.push(String(req.headers["x-flow-request-id"] || ""));
        const authHeader = String(req.headers.authorization || "");
        if (!authHeader.startsWith("Bearer ")) {
          return jsonResponse(res, 401, {
            error: { code: "AUTH_REQUIRED", message: "Missing bearer token" },
          });
        }
        if (meStatus !== 200) {
          return jsonResponse(res, meStatus, { error: { code: "SYNTHETIC_VALIDATION_ERROR", message: "Synthetic validation response" } });
        }
        return jsonResponse(res, 200, {
          id: "user_1",
          github_username: "demo-user",
          email: "demo@example.com",
        });
      }

      if (req.method === "POST" && pathname === "/api/v1/auth/api-tokens") {
        state.requestIds.push(String(req.headers["x-request-id"] || ""));
        state.flowRequestIds.push(String(req.headers["x-flow-request-id"] || ""));
        await readJsonBody(req);
        state.tokenIssueCalls += 1;
        return jsonResponse(res, 200, {
          id: `token_${state.tokenIssueCalls}`,
          token: `api_token_${state.tokenIssueCalls}`,
          token_prefix: "api_token_",
          expires_at: "2027-04-01T00:00:00.000Z",
        });
      }

      if (req.method === "DELETE" && pathname.startsWith("/api/v1/auth/api-tokens/")) {
        state.tokenDeleteIds.push(pathname.split("/").pop() || "");
        return jsonResponse(res, 200, { ok: true });
      }

      if (req.method === "GET" && pathname === "/api/v1/runtime/runs/run-1/events/list") {
        const afterEventId = String(parsedUrl.searchParams.get("after_event_id") || "").trim();
        if (!afterEventId) {
          return jsonResponse(res, 200, { run_id: "run-1", events: runtimeEvents });
        }
        const index = runtimeEvents.findIndex((event) => event.event_id === afterEventId);
        const nextEvents = index >= 0 ? runtimeEvents.slice(index + 1) : runtimeEvents;
        return jsonResponse(res, 200, { run_id: "run-1", events: nextEvents });
      }

      if (req.method === "GET" && pathname === "/api/v1/runtime/runs/run-1/status") {
        state.statusCalls += 1;
        return jsonResponse(res, 200, {
          run_id: "run-1",
          status: state.statusCalls >= 2 ? "completed" : "running",
          mode: "audit_readonly",
          runtime_profile: "container_readonly",
          repo: "acme/demo",
          ref: "main",
          orchestrator_model: "gpt-5.3-codex",
          subagent_model: "gpt-4o-mini",
          created_at: "2026-04-01T00:00:00.000Z",
          updated_at: "2026-04-01T00:00:00.000Z",
          max_iterations: 8,
          current_iteration: 1,
          current_stage: "RUNNING",
          total_events: runtimeEvents.length,
        });
      }

      return jsonResponse(res, 404, {
        error: { code: "NOT_FOUND", message: "Route not found" },
      });
    } catch (error) {
      return jsonResponse(res, 500, {
        error: {
          code: "TEST_SERVER_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to resolve mock API address.");
  }

  return {
    state,
    apiUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

test("Unit auth service: login/status/runtime/list/logout flow remains deterministic", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi();

  try {
    const loginResult = await loginAndPersistSession({
      cwd: tempRoot,
      env: { SENTINELAYER_API_URL: mock.apiUrl }, // the configured API
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      skipBrowserOpen: true,
      timeoutMs: 5000,
      tokenLabel: "unit-test-token",
      tokenTtlDays: 30,
      ide: "unit-test",
      cliVersion: "0.0.0-test",
    });
    assert.equal(loginResult.apiUrl, mock.apiUrl);
    assert.equal(loginResult.storage, "file");
    assert.equal(loginResult.user.githubUsername, "demo-user");
    assert.equal(loginResult.aidenid?.orgId, "org_1");
    const requestIds = mock.state.requestIds.filter(Boolean);
    const flowRequestIds = mock.state.flowRequestIds.filter(Boolean);
    assert.equal(requestIds.length >= 3, true);
    assert.equal(new Set(requestIds).size, requestIds.length);
    assert.equal(flowRequestIds.length >= 3, true);
    assert.equal(new Set(flowRequestIds).size, 1);

    const credentialsPath = resolveCredentialsFilePath({ homeDir: tempRoot });
    assert.match(credentialsPath, /[\\/]\.sentinelayer[\\/]credentials\.json$/);

    const storedSession = await readStoredSession({ homeDir: tempRoot });
    assert.equal(storedSession?.token, "api_token_1");
    assert.equal(storedSession?.tokenId, "token_1");
    assert.equal(storedSession?.storage, "file");
    assert.equal(storedSession?.aidenid?.projectId, "proj_1");

    const activeSession = await resolveActiveAuthSession({
      cwd: tempRoot,
      env: { SENTINELAYER_API_URL: mock.apiUrl }, // the configured API
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      autoRotate: false,
    });
    assert.equal(activeSession?.source, "session");
    assert.equal(await bearerOf(activeSession?.credential), "api_token_1");
    assert.equal(Object.prototype.hasOwnProperty.call(activeSession || {}, "aidenid"), true);

    const authStatus = await getAuthStatus({
      cwd: tempRoot,
      env: { SENTINELAYER_API_URL: mock.apiUrl }, // the configured API
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      checkRemote: true,
      autoRotate: false,
    });
    assert.equal(authStatus.authenticated, true);
    assert.equal(authStatus.remoteUser?.email, "demo@example.com");
    assert.equal(Object.prototype.hasOwnProperty.call(authStatus, "aidenid"), true);

    const eventsResponse = await listRuntimeRunEvents({
      apiUrl: mock.apiUrl,
      credential: activeSession?.credential,
      runId: "run-1",
    });
    assert.equal(Array.isArray(eventsResponse.events), true);
    assert.equal(eventsResponse.events.length, 2);

    const statusResponse = await getRuntimeRunStatus({
      apiUrl: mock.apiUrl,
      credential: activeSession?.credential,
      runId: "run-1",
    });
    assert.equal(statusResponse.status, "running");

    const logoutResult = await logoutSession({
      cwd: tempRoot,
      env: { SENTINELAYER_API_URL: mock.apiUrl }, // the configured API
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      revokeRemote: true,
    });
    assert.equal(logoutResult.hadStoredSession, true);
    assert.equal(logoutResult.clearedLocal, true);
    assert.equal(logoutResult.revokedRemote, true);
    assert.equal(mock.state.tokenDeleteIds.includes("token_1"), true);

    const clearedSession = await readStoredSession({ homeDir: tempRoot });
    assert.equal(clearedSession, null);
  } finally {
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth service: login poll tolerates transient transport failures", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi({
    pollResponses: [
      {
        httpStatus: 503,
        payload: {
          error: {
            code: "TEMPORARY_UNAVAILABLE",
            message: "Retry shortly",
          },
        },
      },
      {
        httpStatus: 200,
        payload: { status: "pending" },
      },
      {
        httpStatus: 200,
        payload: {
          status: "approved",
          auth_token: "auth_token_web_1",
          user: {
            id: "user_1",
            github_username: "demo-user",
            email: "demo@example.com",
          },
        },
      },
    ],
  });

  try {
    const loginResult = await loginAndPersistSession({
      cwd: tempRoot,
      env: { SENTINELAYER_API_URL: mock.apiUrl }, // the configured API
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      skipBrowserOpen: true,
      timeoutMs: 5000,
      tokenLabel: "unit-test-token",
      tokenTtlDays: 30,
      ide: "unit-test",
      cliVersion: "0.0.0-test",
    });
    assert.equal(loginResult.user.githubUsername, "demo-user");
    assert.equal(mock.state.pollCalls, 3);
  } finally {
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth service: login fails fast when poll status is rejected", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi({
    pollResponses: [{ httpStatus: 200, payload: { status: "rejected" } }],
  });

  try {
    await assert.rejects(
      () =>
        loginAndPersistSession({
          cwd: tempRoot,
          env: { SENTINELAYER_API_URL: mock.apiUrl }, // the configured API
          homeDir: tempRoot,
          explicitApiUrl: mock.apiUrl,
          skipBrowserOpen: true,
          timeoutMs: 5000,
          tokenLabel: "unit-test-token",
          tokenTtlDays: 30,
          ide: "unit-test",
          cliVersion: "0.0.0-test",
        }),
      /CLI authentication was not approved/
    );
    assert.equal(mock.state.pollCalls, 1);
  } finally {
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth service: session metadata listing and explicit revoke are deterministic", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi();

  try {
    await loginAndPersistSession({
      cwd: tempRoot,
      env: { SENTINELAYER_API_URL: mock.apiUrl }, // the configured API
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      skipBrowserOpen: true,
      timeoutMs: 5000,
      tokenLabel: "unit-test-token",
      tokenTtlDays: 30,
      ide: "unit-test",
      cliVersion: "0.0.0-test",
    });

    const listed = await listStoredAuthSessions({
      cwd: tempRoot,
      env: { SENTINELAYER_API_URL: mock.apiUrl }, // the configured API
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
    });
    assert.equal(listed.apiUrl, mock.apiUrl);
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].tokenId, "token_1");
    assert.equal(listed.sessions[0].user.email, "demo@example.com");

    const revoked = await revokeAuthToken({
      cwd: tempRoot,
      env: { SENTINELAYER_API_URL: mock.apiUrl }, // the configured API
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
    });
    assert.equal(revoked.revokedRemote, true);
    assert.equal(revoked.tokenId, "token_1");
    assert.equal(revoked.matchedStoredSession, true);
    assert.equal(revoked.clearedLocal, true);
    assert.equal(mock.state.tokenDeleteIds.includes("token_1"), true);

    const clearedSession = await readStoredSession({ homeDir: tempRoot });
    assert.equal(clearedSession, null);
  } finally {
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth service: env, then the global config token; a workspace config token is never used", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  try {
    await writeFile(path.join(tempRoot, ".sentinelayer.yml"), "sentinelayerToken: project_token\n", "utf-8");

    const envSession = await resolveActiveAuthSession({
      cwd: tempRoot,
      env: {
        SENTINELAYER_TOKEN: "env_token",
      },
      explicitApiUrl: "https://api.example.com",
      autoRotate: false,
      homeDir: tempRoot,
    });
    assert.equal(envSession?.source, "env");
    assert.equal(await bearerOf(envSession?.credential), "env_token");

    const workspaceOnly = await resolveActiveAuthSession({
      cwd: tempRoot,
      env: {},
      explicitApiUrl: "https://api.example.com",
      autoRotate: false,
      homeDir: tempRoot,
    });
    assert.equal(workspaceOnly, null, "the workspace .sentinelayer.yml token is not the user's");

    await mkdir(path.join(tempRoot, ".sentinelayer"), { recursive: true });
    await writeFile(path.join(tempRoot, ".sentinelayer", "config.yml"), "sentinelayerToken: global_token\n", "utf-8");
    const globalSession = await resolveActiveAuthSession({
      cwd: tempRoot,
      env: {},
      explicitApiUrl: "https://api.example.com",
      autoRotate: false,
      homeDir: tempRoot,
    });
    assert.equal(globalSession?.source, "config");
    assert.equal(await bearerOf(globalSession?.credential), "global_token");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth service: headless authorization URL is delivered before the first approval poll", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-headless-"));
  const mock = await startAuthRuntimeMockApi({ pollResponses: [{ payload: {
    status: "approved", auth_token: "synthetic_approval", user: { id: "synthetic_user" },
  } }] });
  let delivered = false;
  try {
    await loginAndPersistSession({
      cwd: tempRoot, homeDir: tempRoot, env: { SENTINELAYER_API_URL: mock.apiUrl },
      skipBrowserOpen: true,
      onAuthorize: ({ authorizeUrl, browserOpened }) => {
        assert.equal(mock.state.pollCalls, 0);
        assert.equal(browserOpened, false);
        assert.match(authorizeUrl, /cli-auth\?session_id=sess_1$/);
        delivered = true;
      },
    });
    assert.equal(delivered, true);
    assert.equal(mock.state.pollCalls, 1);
  } finally {
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth service: validation outages are unknown, preserve sign-in, and never erase rejection", async () => {
  for (const status of [429, 503, 401, 403]) {
    __resetRequestCircuitForTests();
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-validation-"));
    const mock = await startAuthRuntimeMockApi({ meStatus: status });
    try {
      await writeStoredSession({
        apiUrl: mock.apiUrl, token: "synthetic_validation", tokenExpiresAt: "2099-01-01T00:00:00Z",
        user: { id: "synthetic_user" },
      }, { homeDir: tempRoot });
      const credentialsPath = resolveCredentialsFilePath({ homeDir: tempRoot });
      const before = await readFile(credentialsPath, "utf8");
      const result = await getAuthStatus({
        cwd: tempRoot, homeDir: tempRoot, env: { SENTINELAYER_API_URL: mock.apiUrl }, autoRotate: false,
      });
      assert.equal(result.authenticated, status >= 429 ? null : false);
      assert.equal(result.validation, status >= 429 ? "unavailable" : "rejected");
      assert.equal(result.remoteError?.status, status);
      assert.equal(result.source, "session");
      assert.equal(await readFile(credentialsPath, "utf8"), before);
      assert.equal((await readStoredSession({ homeDir: tempRoot }))?.token === "synthetic_validation", true);
    } finally {
      await mock.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
});

test("Unit auth service: near-expiry rotation preserves provisioned AIdenID metadata", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-rotation-"));
  const mock = await startAuthRuntimeMockApi();
  const aidenid = { orgId: "synthetic_org", projectId: "synthetic_project", apiKeyPrefix: "aid_", provisionedAt: "2026-01-01T00:00:00Z" };
  try {
    await writeStoredSession({
      apiUrl: mock.apiUrl, token: "synthetic_expiring", tokenId: "synthetic_old",
      tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(), user: { id: "synthetic_user" }, aidenid,
    }, { homeDir: tempRoot });
    const active = await resolveActiveAuthSession({
      cwd: tempRoot, homeDir: tempRoot, env: { SENTINELAYER_API_URL: mock.apiUrl }, autoRotate: true,
    });
    assert.equal(active?.rotated, true);
    assert.deepEqual(active?.aidenid, aidenid);
    assert.deepEqual((await readStoredSession({ homeDir: tempRoot }))?.aidenid, aidenid);
    assert.equal(mock.state.tokenIssueCalls, 1);
    assert.deepEqual(mock.state.tokenDeleteIds, ["synthetic_old"]);
  } finally {
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth command: headless JSON prints URL on stderr before polling and one stdout document", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-command-headless-"));
  const stdout = [];
  const stderr = [];
  let outputBeforePoll;
  const mock = await startAuthRuntimeMockApi({
    pollResponses: [{ payload: { status: "approved", auth_token: "synthetic_command_approval", user: { id: "synthetic_user" } } }],
    onPoll: () => { outputBeforePoll = { stdout: [...stdout], stderr: [...stderr] }; },
  });
  const previousEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SENTINELAYER_API_URL: process.env.SENTINELAYER_API_URL };
  const previousLog = console.log;
  const previousStderrWrite = process.stderr.write;
  try {
    process.env.HOME = tempRoot;
    process.env.USERPROFILE = tempRoot;
    process.env.SENTINELAYER_API_URL = mock.apiUrl;
    console.log = (...values) => stdout.push(values.join(" "));
    process.stderr.write = (chunk, ...args) => {
      stderr.push(String(chunk));
      args.find((arg) => typeof arg === "function")?.();
      return true;
    };
    const program = new Command();
    registerAuthCommand(program);
    await program.parseAsync(["auth", "login", "--skip-browser-open", "--json"], { from: "user" });
    assert.deepEqual(outputBeforePoll?.stdout, []);
    assert.match(outputBeforePoll?.stderr.join(""), /Open this URL to approve sign-in:\nhttp:\/\/127\.0\.0\.1\/cli-auth\?session_id=sess_1/);
    assert.equal(stdout.length, 1);
    assert.equal(JSON.parse(stdout[0]).authenticated, true);
    assert.equal(stderr.filter((line) => line.includes("Open this URL")).length, 1);
  } finally {
    console.log = previousLog;
    process.stderr.write = previousStderrWrite;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth command: transient validation prints retry guidance without login guidance", async () => {
  __resetRequestCircuitForTests();
  const mock = await startAuthRuntimeMockApi({ meStatus: 503 });
  const stdout = [];
  const previousApiUrl = process.env.SENTINELAYER_API_URL;
  const previousToken = process.env.SENTINELAYER_TOKEN;
  const previousLog = console.log;
  try {
    process.env.SENTINELAYER_API_URL = mock.apiUrl;
    process.env.SENTINELAYER_TOKEN = "synthetic_command_validation";
    console.log = (...values) => stdout.push(values.join(" "));
    const program = new Command();
    registerAuthCommand(program);
    await program.parseAsync(["auth", "status", "--no-auto-rotate"], { from: "user" });
    const output = stdout.join("\n");
    assert.match(output, /temporarily unavailable/);
    assert.match(output, /credentials were not cleared/);
    assert.doesNotMatch(output, /auth login|will provision on next login/);
    assert.equal(process.env.SENTINELAYER_TOKEN === "synthetic_command_validation", true);
  } finally {
    console.log = previousLog;
    if (previousApiUrl === undefined) delete process.env.SENTINELAYER_API_URL;
    else process.env.SENTINELAYER_API_URL = previousApiUrl;
    if (previousToken === undefined) delete process.env.SENTINELAYER_TOKEN;
    else process.env.SENTINELAYER_TOKEN = previousToken;
    await mock.close();
  }
});

test("Unit auth service: a refused credential destination is not mislabeled as a validation outage", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-status-destination-"));
  const configured = await startAuthRuntimeMockApi();
  const other = await startAuthRuntimeMockApi();
  try {
    const status = await getAuthStatus({
      cwd: tempRoot, homeDir: tempRoot, autoRotate: false, explicitApiUrl: other.apiUrl,
      env: { SENTINELAYER_API_URL: configured.apiUrl, SENTINELAYER_TOKEN: "synthetic_wrong_destination" },
    });
    assert.equal(status.authenticated, false);
    assert.equal(status.validation, "rejected");
    assert.equal(status.remoteError?.code, "CREDENTIAL_DESTINATION_REFUSED");
    assert.equal(configured.state.requestIds.length, 0);
    assert.equal(other.state.requestIds.length, 0);
  } finally {
    await configured.close();
    await other.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth service: missing/corrupt keys report unknown storage, preserve metadata, and do not validate remotely", async () => {
  for (const fault of ["missing", "corrupt"]) {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-status-storage-"));
    const mock = await startAuthRuntimeMockApi();
    try {
      await writeStoredSession({
        apiUrl: mock.apiUrl, token: "synthetic_storage_status", tokenId: "synthetic-stored-id",
        tokenExpiresAt: "2099-01-01T00:00:00Z", user: { id: "synthetic-user" },
      }, { homeDir: tempRoot });
      const keyPath = path.join(tempRoot, ".sentinelayer", "keys", "credentials.key");
      const metadataPath = resolveCredentialsFilePath({ homeDir: tempRoot });
      const metadata = await readFile(metadataPath, "utf8");
      await rename(keyPath, `${keyPath}.retained`);
      if (fault === "corrupt") await writeFile(keyPath, "synthetic-invalid-key", "utf8");
      const status = await getAuthStatus({ cwd: tempRoot, homeDir: tempRoot,
        env: { SENTINELAYER_API_URL: mock.apiUrl }, autoRotate: false,
      });
      assert.equal(status.authenticated, null);
      assert.equal(status.validation, "storage_unavailable");
      assert.equal(status.source, "storage_unknown");
      assert.equal(status.tokenId, "synthetic-stored-id");
      assert.equal(status.filePath, metadataPath);
      assert.equal(status.remoteError, null);
      assert.equal(mock.state.requestIds.length, 0);
      assert.equal(await readFile(metadataPath, "utf8"), metadata);
      assert.equal(JSON.stringify(status).includes("synthetic_storage_status"), false);
      assert.equal(status.tokenEncrypted, undefined);
      if (fault === "missing") await assert.rejects(readFile(keyPath), { code: "ENOENT" });
      else assert.equal(await readFile(keyPath, "utf8"), "synthetic-invalid-key");
      if (fault === "corrupt") await rm(keyPath);
      await rename(`${keyPath}.retained`, keyPath);
      assert.equal((await getAuthStatus({ cwd: tempRoot, homeDir: tempRoot,
        env: { SENTINELAYER_API_URL: mock.apiUrl }, autoRotate: false, checkRemote: false,
      })).authenticated, true, "repairing storage restores the existing sign-in without another login");
    } finally {
      await mock.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
});

test("Unit auth command: unavailable storage has repair guidance and honest single-document JSON", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-command-storage-"));
  const previousEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SENTINELAYER_API_URL: process.env.SENTINELAYER_API_URL };
  const previousLog = console.log;
  const stdout = [];
  try {
    process.env.HOME = tempRoot;
    process.env.USERPROFILE = tempRoot;
    process.env.SENTINELAYER_API_URL = "https://synthetic.invalid";
    await writeStoredSession({ apiUrl: "https://synthetic.invalid", token: "synthetic_command_storage",
      tokenExpiresAt: "2099-01-01T00:00:00Z",
    }, { homeDir: tempRoot });
    const keyPath = path.join(tempRoot, ".sentinelayer", "keys", "credentials.key");
    await rename(keyPath, `${keyPath}.retained`);
    console.log = (...values) => stdout.push(values.join(" "));
    const program = new Command();
    registerAuthCommand(program);
    await program.parseAsync(["auth", "status", "--offline", "--no-auto-rotate"], { from: "user" });
    const output = stdout.join("\n");
    assert.match(output, /Authentication is unknown/);
    assert.match(output, /current user\/home, keyring availability, encryption key and file permissions/);
    assert.doesNotMatch(output, /auth login|auth logout|No active session token|Authenticated as/);
    stdout.length = 0;
    const jsonProgram = new Command();
    registerAuthCommand(jsonProgram);
    await jsonProgram.parseAsync(["auth", "status", "--offline", "--no-auto-rotate", "--json"], { from: "user" });
    assert.equal(stdout.length, 1);
    const status = JSON.parse(stdout[0]);
    assert.equal(status.authenticated, null);
    assert.equal(status.source, "storage_unknown");
    assert.equal(status.validation, "storage_unavailable");
    assert.equal(stdout[0].includes("synthetic_command_storage"), false);
    await assert.rejects(readFile(keyPath), { code: "ENOENT" });
  } finally {
    console.log = previousLog;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth service: genuinely absent credentials still report no sign-in", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-status-absent-"));
  try {
    const status = await getAuthStatus({ cwd: tempRoot, homeDir: tempRoot,
      env: { SENTINELAYER_API_URL: "https://synthetic.invalid" }, checkRemote: false, autoRotate: false,
    });
    assert.equal(status.authenticated, false);
    assert.equal(status.validation, "none");
    assert.equal(status.source, null);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
