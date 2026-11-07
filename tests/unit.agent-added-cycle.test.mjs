import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { userCredential } from "../src/auth/credential-destinations.js";
import { ownerWatcherAuth } from "../src/session/agent-added-owner-auth.js";
import { readAgentAddedPage, watchAgentAdditions } from "../src/session/agent-added-watcher.js";
import { startAddedRoomListener } from "../src/session/added-room-listener.js";

const AGENT = "fixture-first-cycle";
const RETRY_MS = 9000;

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

async function loopback(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const token = randomUUID();
  const auth = { source: "env", apiUrl,
    credential: await userCredential(token, { env: { SENTINELAYER_API_URL: apiUrl }, source: "env" }) };
  return { server, apiUrl, token, auth,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function notice(room = "fixture-added-chat") {
  return { id: `notice-${room}`, kind: "agent_added", createdAt: new Date(Date.now() - 1000).toISOString(),
    payload: { agentId: AGENT, sessionId: room } };
}

function page(items = [], cursor = "aa1.position", retryAfterMs) {
  return { ok: true, notifications: items, nextCursor: cursor,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

function respond(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Real watcher/listener orchestration; admission and room operations are injected.
// The separate API suite proves settlement and authorization in real PostgreSQL.
function worker(options, resolveAuth, calls) {
  for (const name of ["credential", "token", "auth", "requestRead", "resolveAuthSession"]) {
    assert.equal(options[name], undefined, `${name} cannot cross into the room worker`);
  }
  const record = (step) => calls.push(`${options.sessionId}:${step}`);
  return startAddedRoomListener({ ...options,
    _ownerAuth: (agentId) => ownerWatcherAuth(agentId, { resolveAuth }),
    _join: async () => { record("join"); return { status: "active" }; },
    _withAdmission: async (_room, _agent, run) => run(),
    _receipt: async () => { record("receipt"); return { agentId: AGENT }; },
    _presence: async () => { record("presence"); return { ok: true, recorded: true }; },
    _latest: async () => { record("cursor"); return { ok: true, cursor: "before-hello" }; },
    _post: async (_room, event) => {
      assert.equal(event.payload.message, "Hello, I'm here.");
      record("hello"); return { synced: true };
    },
    _listen: async ({ signal }) => {
      record("listen");
      if (!signal.aborted) await once(signal, "abort");
    },
  });
}

function watch(site, calls, overrides = {}) {
  const resolveAuth = overrides._resolveAuth ?? (async () => site.auth);
  return watchAgentAdditions({ agentId: AGENT, maxPolls: 1, _resolveAuth: resolveAuth,
    _startListener: (options) => worker(options, resolveAuth, calls), ...overrides });
}

test("one polling cycle makes a real delayed second request and posts one hello", { timeout: 20_000 }, async () => {
  const requests = [], calls = [], sleeps = [], notices = [];
  let settlesAt = 0;
  const site = await loopback((req, res) => {
    requests.push({ url: new URL(req.url, "http://loopback.invalid"), method: req.method,
      correctOwner: req.headers.authorization === `Bearer ${site.token}`, at: Date.now() });
    if (requests.length === 1) {
      settlesAt = Date.now() + RETRY_MS;
      respond(res, page([], "aa1.original", RETRY_MS));
    } else if (Date.now() < settlesAt) {
      respond(res, page([], "aa1.original", Math.max(1, settlesAt - Date.now())));
    } else {
      // Even another valid hint must not produce a third request in this cycle.
      respond(res, page([notice()], "aa1.settled", 1));
    }
  });
  try {
    const result = await watch(site, calls, {
      _sleep: async (...args) => { sleeps.push(args[0]); return delay(...args); },
      onNotice: async (entry) => notices.push(entry),
    });
    assert.equal(result.polls, 1);
    assert.equal(requests.length, 2, "one cycle includes exactly one delayed follow-up HTTP request");
    assert.equal(requests[0].url.searchParams.has("after"), false);
    assert.equal(requests[1].url.searchParams.get("after"), "aa1.original");
    assert.ok(requests[1].at - requests[0].at >= RETRY_MS, "the follow-up waits for the advisory delay");
    assert.ok(requests.every(({ url, method, correctOwner }) => method === "GET" && correctOwner
      && url.pathname === "/api/v1/sessions/notifications" && url.searchParams.get("kind") === "agent_added"
      && url.searchParams.get("agentId") === AGENT));
    assert.deepEqual(calls, ["join", "receipt", "presence", "cursor", "hello", "listen"].map((step) => `fixture-added-chat:${step}`));
    assert.deepEqual(sleeps, [RETRY_MS], "the normal sixty-second cadence starts only after this cycle");
    assert.equal(notices.filter((entry) => entry.type === "joined").length, 1);
    assert.equal(notices.some((entry) => entry.type === "feed_unavailable"), false);
  } finally { await site.close(); }
});

test("settled additions start before the delay and the follow-up uses their confirmed cursor", async () => {
  const requests = [], calls = [], sleeps = [];
  const site = await loopback((req, res) => {
    requests.push(new URL(req.url, "http://loopback.invalid"));
    respond(res, requests.length === 1 ? page([notice("settled-chat")], "aa1.settled_first", 9)
      : page([notice("new-chat")], "aa1.settled_second"));
  });
  try {
    await watch(site, calls, { _sleep: async (ms, _value, options) => {
      sleeps.push(ms);
      assert.ok(calls.includes("settled-chat:hello"), "settled notices are not held behind the advisory wait");
      assert.ok(options?.signal instanceof AbortSignal);
    } });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].searchParams.get("after"), "aa1.settled_first");
    assert.deepEqual(calls.filter((call) => call.endsWith(":hello")), ["settled-chat:hello", "new-chat:hello"]);
    assert.deepEqual(sleeps, [9]);
  } finally { await site.close(); }
});

test("a repeated hint is spent after one follow-up and normal cadence resumes", async () => {
  const site = await loopback((_req, res) => respond(res, page()));
  const cursors = [], sleeps = [];
  try {
    let result, failure;
    try {
      result = await watch(site, [], { maxPolls: 2,
        _readPage: async (_owner, _agent, cursor) => {
          cursors.push(cursor);
          if (cursors.length > 3) throw Object.assign(new Error("Fixture read bound exceeded"), { status: 403 });
          return page([], "aa1.position", cursors.length <= 2 ? 7 : undefined);
        },
        _sleep: async (ms) => { sleeps.push(ms); },
      });
    } catch (error) { failure = error; }
    assert.deepEqual(cursors, [null, "aa1.position", "aa1.position"]);
    assert.equal(failure, undefined, "the finite fixture fuse must remain unused");
    assert.equal(result.polls, 2);
    assert.deepEqual(sleeps, [7, 60_000]);
  } finally { await site.close(); }
});

test("malformed hints never advance a cursor, start a room, or schedule a follow-up", async () => {
  const site = await loopback((_req, res) => respond(res, page()));
  try {
    for (const hint of [0, -1, 10_001, 1.5, "5", true, null, undefined, NaN, Infinity]) {
      const cursors = [], calls = [], sleeps = [], notices = [];
      await watch(site, calls, { maxPolls: 2,
        _readPage: async (_owner, _agent, cursor) => {
          cursors.push(cursor); return { ...page([notice()], "aa1.invalid"), retryAfterMs: hint };
        },
        _sleep: async (ms) => { sleeps.push(ms); }, onNotice: async (entry) => notices.push(entry),
      });
      assert.deepEqual(cursors, [null, null], `invalid hint ${String(hint)} cannot advance or reread inside a cycle`);
      assert.deepEqual(calls, []);
      assert.deepEqual(sleeps, [60_000]);
      assert.equal(notices.filter((entry) => entry.type === "feed_unavailable").length, 2);
    }
  } finally { await site.close(); }
});

test("a hint on a full page is rejected before its settled rows or cursor are accepted", async () => {
  const site = await loopback((_req, res) => respond(res, page()));
  let reads = 0;
  const calls = [], sleeps = [];
  try {
    await watch(site, calls, { _readPage: async () => {
      reads++; return page(Array.from({ length: 50 }, (_, index) => notice(`chat-${index}`)), "aa1.full", 1);
    }, _sleep: async (ms) => { sleeps.push(ms); } });
    assert.equal(reads, 1);
    assert.deepEqual(calls, []);
    assert.deepEqual(sleeps, []);
  } finally { await site.close(); }
});

test("cancelling the advisory delay prevents the follow-up and admission immediately", { timeout: 5000 }, async () => {
  const sleeping = deferred(), controller = new AbortController(), cleanup = new AbortController();
  const requests = [], calls = [];
  const site = await loopback((req, res) => { requests.push(req.url); respond(res, page([], "aa1.position", 10_000)); });
  let running;
  try {
    running = watch(site, calls, { signal: controller.signal, _sleep: async (ms, value, options) => {
      sleeping.resolve();
      // Independent teardown keeps a dropped-caller-signal mutant bounded without
      // hiding it: only the signal the watcher actually passes reacts to owner abort.
      return delay(ms, value, { signal: options?.signal
        ? AbortSignal.any([options.signal, cleanup.signal]) : cleanup.signal });
    } });
    assert.notEqual(await within(sleeping.promise), "deadline", "the first page schedules its bounded advisory wait");
    controller.abort();
    const result = await within(running);
    assert.notEqual(result, "deadline", "cancellation must interrupt the advisory delay");
    assert.equal(result.listening, 0);
    assert.equal(requests.length, 1);
    assert.deepEqual(calls, []);
  } finally {
    controller.abort(); cleanup.abort(); await site.close(); await running?.catch(() => {});
  }
});

test("an aborting sleep hook that resolves still cannot dispatch the follow-up", async () => {
  const controller = new AbortController(), calls = [];
  const site = await loopback((_req, res) => respond(res, page()));
  let reads = 0, sleeps = 0;
  try {
    await watch(site, calls, { signal: controller.signal,
      _readPage: async () => { reads++; return page([], "aa1.position", 1); },
      _sleep: async () => { sleeps++; controller.abort(); },
    });
    assert.equal(sleeps, 1);
    assert.equal(reads, 1);
    assert.deepEqual(calls, []);
  } finally { await site.close(); }
});

test("an account change during the advisory wait stops before the second request", { timeout: 5000 }, async () => {
  const sleeping = deferred(), release = deferred();
  const requests = [], calls = [], notices = [];
  const site = await loopback((req, res) => {
    requests.push(req.url);
    respond(res, requests.length === 1 ? page([], "aa1.position", 1) : page([notice()], "aa1.next"));
  });
  let current = site.auth, running;
  try {
    running = watch(site, calls, { _resolveAuth: async () => current,
      _sleep: async () => { sleeping.resolve(); await release.promise; }, onNotice: async (entry) => notices.push(entry),
    });
    assert.notEqual(await within(sleeping.promise), "deadline");
    current = { ...site.auth, credential: await userCredential(randomUUID(), {
      env: { SENTINELAYER_API_URL: site.apiUrl }, source: "env",
    }) };
    release.resolve();
    await assert.rejects(running, /sign-in changed/);
    assert.equal(requests.length, 1);
    assert.deepEqual(calls, []);
    assert.equal(notices.some((entry) => entry.type === "feed_unavailable"), false);
  } finally {
    release.resolve(); await site.close(); await running?.catch(() => {});
  }
});

test("cancelling the delayed HTTP follow-up closes its socket without admission", { timeout: 5000 }, async () => {
  const arrived = deferred(), disconnected = deferred(), controller = new AbortController();
  const requests = [], calls = [];
  const site = await loopback((req, res) => {
    requests.push(req.url);
    if (requests.length === 1) return respond(res, page([], "aa1.position", 1));
    res.once("close", () => disconnected.resolve(!res.writableEnded));
    arrived.resolve();
  });
  let running;
  try {
    running = watch(site, calls, { signal: controller.signal });
    assert.notEqual(await within(arrived.promise), "deadline", "the actual second request reached the server");
    controller.abort();
    const result = await within(Promise.all([running, disconnected.promise]));
    assert.notEqual(result, "deadline", "cancellation closes the follow-up before its HTTP timeout");
    assert.equal(result[1], true);
    assert.equal(requests.length, 2);
    assert.deepEqual(calls, []);
  } finally {
    controller.abort(); await site.close(); await running?.catch(() => {});
  }
});

test("the five-start budget spans both reads and repeated notices stay deduplicated", async () => {
  const site = await loopback((_req, res) => respond(res, page()));
  const calls = [];
  let reads = 0;
  try {
    const result = await watch(site, calls, {
      _readPage: async () => ++reads === 1
        ? page([notice("one"), notice("two"), notice("three")], "aa1.first", 1)
        : page([notice("one"), notice("four"), notice("five"), notice("six")], "aa1.second"),
      _sleep: async () => {},
    });
    assert.equal(reads, 2);
    assert.equal(result.listening, 5);
    assert.equal(result.pending, 1);
    assert.deepEqual(calls.filter((call) => call.endsWith(":hello")), ["one:hello", "two:hello", "three:hello", "four:hello", "five:hello"]);
  } finally { await site.close(); }
});

test("each filtered HTTP request keeps its original short timeout, signal and zero retries", async () => {
  const credential = await userCredential(randomUUID(), {
    env: { SENTINELAYER_API_URL: "http://127.0.0.1:57239" }, source: "env",
  });
  const controller = new AbortController(), requests = [];
  await readAgentAddedPage({ credential, apiUrl: "http://127.0.0.1:57239" }, AGENT, "aa1.position", {
    signal: controller.signal, requestRead: async (url, options) => { requests.push({ url, options }); return page(); },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.timeoutMs, 10_000);
  assert.equal(requests[0].options.maxRetries, 0);
  assert.equal(requests[0].options.signal, controller.signal);
});

test("an unavailable delayed follow-up is not retried or repeated in the same cycle", async () => {
  const requests = [], calls = [], notices = [];
  const site = await loopback((req, res) => {
    requests.push(req.url);
    if (requests.length === 1) return respond(res, page([], "aa1.position", 1));
    respond(res, { error: { code: "FIXTURE_UNAVAILABLE", message: "Unavailable" } }, 503);
  });
  try {
    await watch(site, calls, { onNotice: async (entry) => notices.push(entry) });
    assert.equal(requests.length, 2);
    assert.deepEqual(calls, []);
    assert.equal(notices.filter((entry) => entry.type === "feed_unavailable").length, 1);
  } finally { await site.close(); }
});

test("five poisoned follow-ups stop the watcher without losing its accepted cursor or active cleanup", { timeout: 5000 }, async () => {
  const requests = [], sleeps = [], starts = [], notices = [];
  const site = await loopback((req, res) => {
    requests.push(new URL(req.url, "http://loopback.invalid"));
    if (requests.length > 10) {
      // A finite guard for the broken implementation: the expected assertion is
      // the five-failure stop, never a hanging watcher or runner timeout.
      return respond(res, { error: { code: "FIXTURE_STOP", message: "Stop" } }, 403);
    }
    if (requests.length % 2 === 1) return respond(res,
      page(requests.length === 1 ? [notice("settled-chat")] : [], "aa1.valid", 1));
    const poison = notice("unwanted-chat");
    poison.payload.agentId = "another-fixture-agent";
    respond(res, page([poison], `aa1.poison${requests.length}`));
  });
  try {
    await assert.rejects(watch(site, [], { maxPolls: null,
      _startListener: (options) => {
        let finish;
        const handle = { ready: Promise.resolve({ joined: true }),
          done: new Promise((resolve) => { finish = resolve; }), stopped: false,
          stop() { this.stopped = true; finish(); } };
        starts.push({ sessionId: options.sessionId, handle }); return handle;
      },
      _sleep: async (ms) => { sleeps.push(ms); }, onNotice: async (entry) => notices.push(entry),
    }), /notification feed is unavailable after five attempts/);
    assert.equal(requests.length, 10, "five cycles have one initial read and one follow-up each");
    assert.deepEqual(requests.map((url) => url.searchParams.get("after")), [null, ...Array(9).fill("aa1.valid")]);
    assert.deepEqual(sleeps, [1, 60_000, 1, 60_000, 1, 60_000, 1, 60_000, 1]);
    assert.equal(notices.filter((entry) => entry.type === "feed_unavailable").length, 5);
    assert.deepEqual(starts.map((entry) => entry.sessionId), ["settled-chat"]);
    assert.equal(starts[0].handle.stopped, true);
  } finally { await site.close(); }
});
