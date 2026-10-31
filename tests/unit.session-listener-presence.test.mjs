import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { admissionCredential, userCredential } from "../src/auth/credential-destinations.js";
import { renewSessionPresence, resetSessionSyncStateForTests } from "../src/session/sync.js";

import {
  listenerLifecycleIdempotencyStep,
  shouldPublishListenerPresenceHeartbeat,
} from "../src/commands/session.js";

function heartbeat(overrides = {}) {
  return {
    type: "heartbeat",
    active: false,
    state: "idle",
    transport: "poll",
    idleIntervalSeconds: 60,
    activeIntervalSeconds: 10,
    activeWindowSeconds: 300,
    lastHumanActivityAt: null,
    ...overrides,
  };
}

test("Unit session listener presence: minimal renewal preserves account and scoped credentials and model", async () => {
  for (const kind of ["account", "scoped"]) {
    resetSessionSyncStateForTests();
    const token = ["synthetic", "presence", kind].join(" ");
    const apiUrl = "https://api.sentinelayer.com";
    const credential = kind === "account"
      ? await userCredential(token)
      : admissionCredential({ token, apiUrl });
    const bodies = [];
    for (const minimalPresence of [false, true]) {
      const result = await renewSessionPresence("test-session", {
        agentId: "test-agent", model: "test-model", listenerId: "test-listener", minimalPresence,
        resolveAuthSession: async () => ({ credential, apiUrl }),
        fetchImpl: async (_url, options) => {
          assert.equal(new Headers(options.headers).get("authorization"), `Bearer ${token}`);
          bodies.push(JSON.parse(options.body));
          return { ok: true, status: 200, json: async () => ({ recorded: true, ttlSeconds: 90 }) };
        },
      });
      assert.equal(result.recorded, true);
      assert.equal(result.ttlSeconds, 90);
    }
    assert.equal(bodies[0].listenerId, "test-listener");
    assert.ok(bodies.every((body) => !("runtime" in body) && !("working" in body)));
    assert.deepEqual(bodies[1], { agentId: "test-agent", model: "test-model" });
  }
});

test("Unit session listener presence: renewal retains structured identity refusal codes", async () => {
  for (const payload of [
    { code: "AGENT_IDENTITY_REQUIRED" },
    { error: { code: "AGENT_IDENTITY_REQUIRED" } },
    { detail: { code: "AGENT_IDENTITY_REQUIRED" } },
  ]) {
    resetSessionSyncStateForTests();
    const result = await renewSessionPresence("test-session", {
      agentId: "test-agent",
      resolveAuthSession: async () => ({ token: ["synthetic", "presence"].join(" ") }),
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => payload }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "api_403");
    assert.equal(result.code, "AGENT_IDENTITY_REQUIRED");
  }
});

test("Unit session listener presence: publishes first, interval, and keepalive heartbeats", () => {
  const first = shouldPublishListenerPresenceHeartbeat({
    lifecycle: heartbeat(),
    nowMs: 1_000,
    presenceIntervalMs: 30_000,
    presenceKeepaliveMs: 180_000,
  });
  assert.equal(first.publish, true);
  assert.equal(first.reason, "first");

  const duplicate = shouldPublishListenerPresenceHeartbeat({
    lifecycle: heartbeat(),
    nowMs: 16_000,
    lastHeartbeatMs: 1_000,
    lastFingerprint: first.fingerprint,
    presenceIntervalMs: 30_000,
    presenceKeepaliveMs: 180_000,
  });
  assert.equal(duplicate.publish, false);
  assert.equal(duplicate.reason, "interval");

  const interval = shouldPublishListenerPresenceHeartbeat({
    lifecycle: heartbeat(),
    nowMs: 31_000,
    lastHeartbeatMs: 1_000,
    lastFingerprint: first.fingerprint,
    presenceIntervalMs: 30_000,
    presenceKeepaliveMs: 180_000,
  });
  assert.equal(interval.publish, true);
  assert.equal(interval.reason, "interval");

  const keepalive = shouldPublishListenerPresenceHeartbeat({
    lifecycle: heartbeat(),
    nowMs: 181_000,
    lastHeartbeatMs: 1_000,
    lastFingerprint: first.fingerprint,
    presenceIntervalMs: 30_000,
    presenceKeepaliveMs: 180_000,
  });
  assert.equal(keepalive.publish, true);
  assert.equal(keepalive.reason, "keepalive");
});

test("Unit session listener presence: publishes state changes and stopping heartbeats immediately", () => {
  const first = shouldPublishListenerPresenceHeartbeat({
    lifecycle: heartbeat(),
    nowMs: 10_000,
  });

  const changed = shouldPublishListenerPresenceHeartbeat({
    lifecycle: heartbeat({
      active: true,
      state: "active",
      lastHumanActivityAt: "2026-06-23T22:00:00.000Z",
    }),
    nowMs: 11_000,
    lastHeartbeatMs: 10_000,
    lastFingerprint: first.fingerprint,
    presenceIntervalMs: 60_000,
    presenceKeepaliveMs: 180_000,
  });
  assert.equal(changed.publish, true);
  assert.equal(changed.reason, "changed");

  const stopping = shouldPublishListenerPresenceHeartbeat({
    lifecycle: heartbeat({ stopping: true }),
    nowMs: 12_000,
    lastHeartbeatMs: 10_000,
    lastFingerprint: first.fingerprint,
    presenceIntervalMs: 60_000,
    presenceKeepaliveMs: 180_000,
  });
  assert.equal(stopping.publish, true);
  assert.equal(stopping.reason, "stopping");
});

test("Unit session listener presence: always publishes non-heartbeat lifecycle events", () => {
  const started = shouldPublishListenerPresenceHeartbeat({
    lifecycle: { type: "started", state: "started" },
    nowMs: 1_000,
    lastHeartbeatMs: 1_000,
    lastFingerprint: "same",
  });
  assert.equal(started.publish, true);
  assert.equal(started.reason, "lifecycle");
});

test("Unit session listener presence: heartbeat idempotency uses heartbeat count", () => {
  assert.equal(
    listenerLifecycleIdempotencyStep({
      type: "heartbeat",
      pollCount: 0,
      heartbeatCount: 1,
    }),
    1,
  );
  assert.equal(
    listenerLifecycleIdempotencyStep({
      type: "heartbeat",
      pollCount: 0,
      heartbeatCount: 2,
    }),
    2,
  );
  assert.equal(
    listenerLifecycleIdempotencyStep({
      type: "started",
      pollCount: 0,
      heartbeatCount: 2,
    }),
    0,
  );
});
