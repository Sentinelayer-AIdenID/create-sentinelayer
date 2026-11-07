import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { userCredential } from "../src/auth/credential-destinations.js";
import { createAgentEvent } from "../src/events/schema.js";
import { admissionCredentialPath } from "../src/session/admission.js";
import { startAddedRoomListener } from "../src/session/added-room-listener.js";
import { ownerWatcherAuth } from "../src/session/agent-added-owner-auth.js";
import { listenSessionEvents } from "../src/session/listener.js";
import { writeSyncCursor } from "../src/session/sync-cursor.js";
import { pollSessionEvents, resetSessionSyncStateForTests, updateSessionReadCursor } from "../src/session/sync.js";

const AGENT = "fixture-active-cancel";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, milliseconds = 1500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve) => {
      timer = setTimeout(() => resolve("deadline"), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function reply(sessionId, sequenceId = 3) {
  return createAgentEvent({ event: "session_message", agentId: "human-fixture", agentModel: "fixture",
    sessionId, sequenceId, cursor: `event-${sequenceId}`, payload: { message: "A synthetic reply", to: AGENT } });
}

function respond(res, body) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

for (const stalled of ["poll", "read-cursor", "heartbeat"]) {
  for (const phase of ["headers", "body"]) {
    test(`an added-room stop closes active ${stalled} ${phase} after ready without later work`, { timeout: 10_000 }, async () => {
      resetSessionSyncStateForTests();
      const sessionId = randomUUID(), controller = new AbortController();
      const requests = [], events = [], cursorWrites = [], notices = [], lifecycle = [], serverErrors = [];
      const arrived = deferred(), disconnected = deferred();
      const ownerToken = randomUUID(), roomToken = `sladm_${randomBytes(32).toString("base64url")}`;
      const server = createServer((req, res) => {
        void (async () => {
          for await (const _chunk of req) { /* Drain the synthetic request body. */ }
          const url = new URL(req.url, "http://loopback.invalid");
          const step = url.pathname.endsWith("/admissions/self") ? "receipt"
            : url.pathname.endsWith("/presence") ? (requests.some((request) => request.step === "presence") ? "heartbeat" : "presence")
              : url.pathname.endsWith("/events/before") ? "prime"
                : url.pathname.endsWith("/read-cursor") ? "read-cursor"
                  : req.method === "POST" && url.pathname.endsWith("/events") ? "hello" : "poll";
          requests.push({ step, method: req.method, admissionBound: req.headers.authorization === `Bearer ${roomToken}` });
          if (step === stalled) {
            res.once("close", () => disconnected.resolve(!res.writableEnded));
            if (phase === "body") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.write(step === "poll" ? '{"events":[' : '{"ok":');
            }
            arrived.resolve();
            return;
          }
          respond(res, step === "receipt" ? { agentId: AGENT }
            : step === "prime" ? { events: [reply(sessionId, 1)], has_more: false }
              : step === "poll" ? { events: [reply(sessionId)], nextCursor: "event-3" }
                : { ok: true, recorded: true, updated: true, sequenceId: 2, cursor: "event-2" });
        })().catch((error) => { serverErrors.push(error.name); res.destroy(); });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const apiUrl = `http://127.0.0.1:${server.address().port}`;
      const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-active-cancel-"));
      const admissionFile = admissionCredentialPath(sessionId, AGENT);
      const envNames = ["SENTINELAYER_TOKEN", "SENTINELAYER_API_URL", "SENTINELAYER_SKIP_REMOTE_SYNC"];
      const prior = envNames.map((name) => process.env[name]);
      process.env.SENTINELAYER_TOKEN = ownerToken;
      process.env.SENTINELAYER_API_URL = apiUrl;
      process.env.SENTINELAYER_SKIP_REMOTE_SYNC = "0";
      let handle, terminal;
      try {
        const auth = { source: "env", apiUrl,
          credential: await userCredential(ownerToken, { env: { SENTINELAYER_API_URL: apiUrl }, source: "env" }) };
        const owner = await ownerWatcherAuth(AGENT, { resolveAuth: async () => auth });
        handle = startAddedRoomListener({ sessionId, notificationId: `active-${stalled}-${phase}`, agentId: AGENT,
          ownerBinding: owner.binding, targetPath: workspace, signal: controller.signal,
          _ownerAuth: async () => owner,
          _join: async () => {
            await fsp.mkdir(path.dirname(admissionFile), { recursive: true });
            await fsp.writeFile(admissionFile, JSON.stringify({ version: 2, sessionId, agentId: AGENT, apiUrl,
              token: roomToken, admissionId: randomUUID(), expiresAt: Math.floor(Date.now() / 1000) + 3600 }));
            return { status: "active" };
          },
          _listen: (options) => listenSessionEvents({ ...options, maxPolls: 3, jitterRatio: 0,
            _writeCursor: async (...args) => { cursorWrites.push(args[1]); return writeSyncCursor(...args); },
            onLifecycle: async (state) => { lifecycle.push(state); await options.onLifecycle(state); },
          }),
          onEvent: async (event) => { events.push(event.cursor); },
          onNotice: async (notice) => { notices.push(notice.type); },
        });
        terminal = Promise.allSettled([handle.ready, handle.done]);
        assert.deepEqual(await within(handle.ready, 3000), { joined: true }, "the listener is joined before cancellation");
        assert.notEqual(await within(arrived.promise), "deadline", "the active request reaches the real HTTP server");
        const atAbort = { requests: requests.length, events: events.length, cursorWrites: cursorWrites.length };
        if (stalled === "heartbeat" && phase === "body") handle.stop();
        else controller.abort();
        const stopped = await within(Promise.all([terminal, disconnected.promise]));
        assert.notEqual(stopped, "deadline", "active cancellation must finish before the HTTP timeout");
        assert.equal(stopped[1], true, "the stalled socket closes before a response completes");
        assert.equal(stopped[0][1].status, "fulfilled", "operator cancellation is normal worker cleanup");
        assert.deepEqual({ requests: requests.length, events: events.length, cursorWrites: cursorWrites.length }, atAbort,
          "cancellation cannot start another request, event callback or cursor write");
        assert.deepEqual(notices, [], "operator cancellation is not a room failure");
        assert.equal(lifecycle.filter((state) => state.type === "heartbeat").length, stalled === "heartbeat" ? 1 : 0,
          "only the heartbeat already in flight may have started before cancellation");
        assert.equal(lifecycle.at(-1)?.type, "stopped");
        assert.equal(lifecycle.at(-1)?.consecutivePollFailures, 0);
        assert.equal(lifecycle.at(-1)?.readCursorUpdates, stalled === "heartbeat" ? 1 : 0,
          "only the cursor response completed before cancellation is acknowledged");
        assert.equal(lifecycle.at(-1)?.readCursorReason, "", "operator cancellation adds no cursor failure state");
        assert.equal(requests.filter((request) => request.step === "hello").length, 1);
        if (stalled === "heartbeat") {
          assert.deepEqual(requests.map((request) => request.step),
            ["receipt", "presence", "prime", "hello", "poll", "read-cursor", "heartbeat"],
            "the stalled presence is the active heartbeat after startup and a completed read");
        }
        assert.ok(requests.every((request) => request.admissionBound), "all real room traffic keeps its room admission");
        assert.deepEqual(serverErrors, []);
      } finally {
        controller.abort(); handle?.stop();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        if (terminal) await terminal;
        await fsp.rm(admissionFile, { force: true });
        await fsp.rm(workspace, { recursive: true, force: true });
        for (let i = 0; i < envNames.length; i++) {
          if (prior[i] === undefined) delete process.env[envNames[i]]; else process.env[envNames[i]] = prior[i];
        }
        resetSessionSyncStateForTests();
      }
    });
  }
}

const operations = [
  ["events", (options) => pollSessionEvents("fixture-cancel-chat", { since: "event-1", ...options })],
  ["read cursor", (options) => updateSessionReadCursor("fixture-cancel-chat", { targetSequenceId: 3, agentId: AGENT, ...options })],
];

async function fakeAuth() {
  const apiUrl = "http://127.0.0.1:57239";
  return { source: "env", apiUrl,
    credential: await userCredential(randomUUID(), { env: { SENTINELAYER_API_URL: apiUrl }, source: "env" }) };
}

for (const [name, read] of operations) {
  test(`an already cancelled ${name} read does not resolve credentials or dispatch`, async () => {
    resetSessionSyncStateForTests();
    const controller = new AbortController(); controller.abort();
    let authCalls = 0, requests = 0;
    try {
      const result = await read({ signal: controller.signal,
        resolveAuthSession: async () => { authCalls++; return fakeAuth(); },
        fetchImpl: async () => { requests++; return { ok: true, status: 200, json: async () => ({}) }; },
      });
      assert.equal(result.reason, "aborted");
      assert.equal(result.ok, false);
      assert.equal(authCalls, 0, "cancelled work cannot enter credential resolution");
      assert.equal(requests, 0, "cancelled work cannot send an HTTP request");
    } finally { resetSessionSyncStateForTests(); }
  });

  test(`repeated caller cancellation of ${name} does not open its circuit`, async () => {
    resetSessionSyncStateForTests();
    const auth = await fakeAuth(); let requests = 0;
    try {
      const cancelled = [];
      for (let index = 0; index < 4; index++) {
        const controller = new AbortController();
        cancelled.push(await read({ signal: controller.signal, resolveAuthSession: async () => auth,
          fetchImpl: async () => { requests++; controller.abort(); throw new DOMException("Operator stopped", "AbortError"); },
        }));
      }
      const probe = await read({ resolveAuthSession: async () => auth,
        fetchImpl: async () => { requests++; return { ok: true, status: 200, json: async () => ({}) }; },
      });
      assert.equal(probe.ok, true, "four operator cancellations must leave the circuit available");
      assert.equal(requests, 5);
      assert.deepEqual(cancelled.map((result) => result.reason), ["aborted", "aborted", "aborted", "aborted"]);
    } finally { resetSessionSyncStateForTests(); }
  });

  test(`a late successful ${name} body after cancellation neither advances nor clears prior circuit failures`, async () => {
    resetSessionSyncStateForTests();
    const auth = await fakeAuth(); let requests = 0;
    const fail = () => read({ resolveAuthSession: async () => auth,
      fetchImpl: async () => { requests++; return { ok: false, status: 503, json: async () => ({}) }; },
    });
    try {
      assert.equal((await fail()).reason, "api_503");
      assert.equal((await fail()).reason, "api_503");
      const controller = new AbortController();
      const cancelled = await read({ signal: controller.signal, resolveAuthSession: async () => auth,
        fetchImpl: async () => { requests++; return { ok: true, status: 200, json: async () => {
          controller.abort();
          return { ok: true, updated: true, events: [reply("fixture-cancel-chat")], nextCursor: "event-3" };
        } }; },
      });
      assert.equal(cancelled.reason, "aborted", "a late success cannot acknowledge cancelled work");
      assert.equal(cancelled.ok, false);
      if (name === "events") {
        assert.deepEqual(cancelled.events, []);
        assert.equal(cancelled.cursor, "event-1");
      } else assert.equal(cancelled.updated, false);
      assert.equal((await fail()).reason, "api_503");
      const blocked = await fail();
      assert.equal(blocked.reason, "circuit_breaker_open", "cancellation must preserve the two earlier real failures");
      assert.equal(requests, 4);
    } finally { resetSessionSyncStateForTests(); }
  });

  test(`real ${name} transport timeouts still open the circuit`, async () => {
    resetSessionSyncStateForTests();
    const auth = await fakeAuth(); let requests = 0;
    const options = { timeoutMs: 10, resolveAuthSession: async () => auth,
      fetchImpl: async () => { requests++; return new Promise(() => {}); },
    };
    try {
      for (let index = 0; index < 3; index++) assert.equal((await read(options)).reason, "request_timeout");
      assert.equal((await read(options)).reason, "circuit_breaker_open");
      assert.equal(requests, 3, "real timeouts still count and the fourth request is refused");
    } finally { resetSessionSyncStateForTests(); }
  });
}

for (const successful of [true, false]) {
  test(`a late ${successful ? "successful" : "failed"} poll after stop has no control, event, cursor or failure effect`, async () => {
    const controller = new AbortController(), effects = [];
    const result = await listenSessionEvents({ sessionId: "fixture-cancel-chat", agentId: AGENT,
      signal: controller.signal, since: "event-1", replay: true, maxPolls: 1,
      _poll: async () => {
        controller.abort();
        return { ok: successful, reason: successful ? "" : "aborted", events: [reply("fixture-cancel-chat")], cursor: "event-3",
          listenerControls: [{ controlId: "late-control", type: "listener_stop", issuedAtMs: Date.now(), targetAgentId: AGENT }] };
      },
      _writeCursor: async () => { effects.push("local-cursor"); return { written: true }; },
      _updateReadCursor: async () => { effects.push("remote-cursor"); return { ok: true, updated: true }; },
      onEvent: async () => { effects.push("event"); }, onControl: async () => { effects.push("control"); },
      onError: async () => { effects.push("error"); },
      onLifecycle: async (state) => { if (state.type === "heartbeat") effects.push("heartbeat"); },
    });
    assert.deepEqual(effects, [], "a completed poll cannot act after its owner stopped");
    assert.equal(result.cursor, "event-1");
    assert.equal(result.consecutivePollFailures, 0);
  });
}

test("cancellation from an event callback stops the remaining batch before either cursor write", async () => {
  const controller = new AbortController(), effects = [];
  const result = await listenSessionEvents({ sessionId: "fixture-cancel-chat", agentId: AGENT,
    signal: controller.signal, since: "event-1", replay: true, maxPolls: 1,
    _poll: async () => ({ ok: true, events: [reply("fixture-cancel-chat", 3), reply("fixture-cancel-chat", 4)], cursor: "event-4" }),
    _writeCursor: async () => { effects.push("local-cursor"); return { written: true }; },
    _updateReadCursor: async () => { effects.push("remote-cursor"); return { ok: true, updated: true }; },
    onEvent: async (event) => { effects.push(event.cursor); controller.abort(); },
    onLifecycle: async (state) => { if (state.type === "heartbeat") effects.push("heartbeat"); },
  });
  assert.deepEqual(effects, ["event-3"], "only the callback already in flight may finish");
  assert.equal(result.cursor, "event-1");
});

test("cancellation while the local cursor finishes prevents a new remote cursor write", async () => {
  const controller = new AbortController(), effects = [];
  await listenSessionEvents({ sessionId: "fixture-cancel-chat", agentId: AGENT,
    signal: controller.signal, since: "event-1", replay: true, maxPolls: 1,
    _poll: async () => ({ ok: true, events: [reply("fixture-cancel-chat")], cursor: "event-3" }),
    _writeCursor: async () => { effects.push("local-cursor"); controller.abort(); return { written: true }; },
    _updateReadCursor: async () => { effects.push("remote-cursor"); return { ok: true, updated: true }; },
    onLifecycle: async (state) => { if (state.type === "heartbeat") effects.push("heartbeat"); },
  });
  assert.deepEqual(effects, ["local-cursor"], "an already-started local write may finish, but no new work may begin");
});

test("cancellation from the last event callback leaves the accepted cursor unchanged", async () => {
  const controller = new AbortController(), effects = [];
  const result = await listenSessionEvents({ sessionId: "fixture-cancel-chat", agentId: AGENT,
    signal: controller.signal, since: "event-1", replay: true, maxPolls: 1,
    _poll: async () => ({ ok: true, events: [reply("fixture-cancel-chat")], cursor: "event-3" }),
    _writeCursor: async () => { effects.push("local-cursor"); return { written: true }; },
    _updateReadCursor: async () => { effects.push("remote-cursor"); return { ok: true, updated: true }; },
    onEvent: async (event) => { effects.push(event.cursor); controller.abort(); },
    onLifecycle: async (state) => { if (state.type === "heartbeat") effects.push("heartbeat"); },
  });
  assert.deepEqual(effects, ["event-3"], "the final callback cannot acknowledge a cancelled batch");
  assert.equal(result.cursor, "event-1");
});
