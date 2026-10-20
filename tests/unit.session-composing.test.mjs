import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { updateSessionComposing } from "../src/session/sync.js";
import { startSessionComposing, withSessionComposing } from "../src/session/composing.js";
import { createSessionMutationCsrfToken } from "../src/session/invitations.js";

const targetId = "10000000-0000-4000-8000-000000000001";
const fixtureToken = ["unit", "composing", "token"].join("-");
process.env.SENTINELAYER_API_URL = "http://127.0.0.1:3000";
const auth = async () => ({ token: fixtureToken, apiUrl: "http://127.0.0.1:3000" });
const options = { agentId: "sol-max", runId: "run-a", targetId, targetKind: "message" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

test("composing transport is guarded, bounded and never falls back to event ingest", async () => {
  const old = process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
  process.env.SENTINELAYER_SKIP_REMOTE_SYNC = "0";
  try {
    const calls = [];
    const result = await updateSessionComposing("room-a", { ...options, operation: "start", resolveAuthSession: auth,
      fetchImpl: async (url, init) => { calls.push({ url, ...init }); return json({ status: "ok", active: [] }); } });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/sessions\/room-a\/composing$/);
    assert.equal(calls[0].method, "PUT");
    assert.deepEqual(JSON.parse(calls[0].body), { operation: "start", ...options });
    assert.equal(calls[0].headers["X-CSRF-Token"], createSessionMutationCsrfToken({ bearerToken: fixtureToken,
      sessionId: "room-a", routeId: "PUT /api/v1/sessions/{session_id}/composing", idempotencyKey: calls[0].headers["Idempotency-Key"] }));
    for (const [response, reason] of [[json({ status: "degraded", active: [] }), "composing_unavailable"],
      [json({ detail: { error: { code: "COMPOSING_CONFLICT" } } }, 409), "COMPOSING_CONFLICT"]]) {
      let count = 0;
      const refused = await updateSessionComposing("room-a", { ...options, operation: "heartbeat", resolveAuthSession: auth,
        fetchImpl: async () => { count++; return response; } });
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, reason);
      assert.equal(count, 1);
    }
  } finally { process.env.SENTINELAYER_SKIP_REMOTE_SYNC = old; }
});

test("invalid operation, UUID, identity and run are rejected before credential lookup", async () => {
  for (const change of [{ operation: "thinking" }, { targetId: "../other" }, { runId: "bad run" }, { agentId: "human/name" }]) {
    const result = await updateSessionComposing("room-a", { ...options, operation: "start", ...change,
      resolveAuthSession: async () => { throw new Error("must not resolve auth"); } });
    assert.deepEqual(result, { ok: false, reason: "invalid_input" });
  }
});

function runtime(update = async () => ({ ok: true })) {
  const calls = [];
  let scheduled;
  return { calls, next: async () => { const next = scheduled; scheduled = null; next?.(); await new Promise(setImmediate); },
    options: { ...options, update: async (_room, request) => { calls.push(request.operation); return update(request); },
      setTimer: (callback, delay) => { assert.equal(delay, 15_000); scheduled = callback; return {}; },
      clearTimer: () => { scheduled = null; } } };
}

test("runtime explicitly starts, renews and stops once; no heartbeat after cleanup", async () => {
  const fixture = runtime();
  const handle = await startSessionComposing("room-a", fixture.options);
  await fixture.next();
  await handle.stop();
  await handle.stop();
  await fixture.next();
  assert.deepEqual(fixture.calls, ["start", "heartbeat", "stop"]);
});

test("lost heartbeat stops renewing and never resurrects a stale run", async () => {
  const fixture = runtime(async (request) => ({ ok: request.operation !== "heartbeat", reason: "stale" }));
  const handle = await startSessionComposing("room-a", fixture.options);
  await fixture.next();
  await fixture.next();
  await handle.stop();
  assert.deepEqual(fixture.calls, ["start", "heartbeat", "stop"]);
});

test("completion and thrown work both clear composing in finally", async () => {
  for (const failed of [false, true]) {
    const fixture = runtime();
    const run = withSessionComposing("room-a", fixture.options, async () => {
      if (failed) throw new Error("work failed");
      return "reply sent";
    });
    if (failed) await assert.rejects(run, /work failed/);
    else assert.equal(await run, "reply sent");
    assert.deepEqual(fixture.calls, ["start", "stop"]);
  }
});

test("abort clears a run; abort during start prevents work; rejected start never invokes work", async () => {
  const abort = new AbortController();
  const fixture = runtime();
  const handle = await startSessionComposing("room-a", { ...fixture.options, signal: abort.signal });
  abort.abort();
  await handle.stop();
  assert.deepEqual(fixture.calls, ["start", "stop"]);
  const during = new AbortController();
  const starting = runtime(async (request) => { if (request.operation === "start") during.abort(); return { ok: true }; });
  await assert.rejects(withSessionComposing("room-a", { ...starting.options, signal: during.signal }, () => assert.fail("cancelled work")), /cancelled/);
  assert.deepEqual(starting.calls, ["start", "stop"]);
  const refused = runtime(async () => ({ ok: false, reason: "conflict" }));
  await assert.rejects(withSessionComposing("room-a", refused.options, () => assert.fail("refused work")), /conflict/);
  assert.deepEqual(refused.calls, ["start"]);
});
