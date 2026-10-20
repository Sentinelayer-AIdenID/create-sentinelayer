import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { listenSessionEvents } from "../src/session/listener.js";

const id = "10000000-0000-4000-8000-000000000001";
const event = (cursor, extra = {}) => ({ event: "session_message", id, cursor, sequenceId: Number(cursor),
  messageRevision: 2, agent: { id: "peer" }, payload: { message: "hello" }, ...extra });
const options = { sessionId: "test", agentId: "sol-max", replay: true, maxPolls: 1,
  _readCursor: async () => null, _writeCursor: async () => ({ written: true }),
  _updateReadCursor: async () => ({ ok: true }), _sleep: async () => {} };

test("listener awaits views only for delivered messages, excluding other recipients and controls", async () => {
  const steps = [], views = [];
  await listenSessionEvents({ ...options,
    _poll: async () => ({ ok: true, cursor: "3", events: [event("1"), event("2", { payload: { to: "other" } }),
      event("3", { event: "session_checkpoint" })] }),
    onEvent: async item => steps.push(`delivered:${item.cursor}`),
    _recordMessageViews: async (sid, payload) => { await new Promise(resolve => setTimeout(resolve, 10));
      views.push(payload.targets); steps.push("persisted"); return { ok: true, recorded: payload.targets.length }; },
  });
  assert.deepEqual(views, [[{ kind: "message", id, targetRevision: 2 }]]);
  assert.ok(steps.indexOf("persisted") > steps.indexOf("delivered:1"));
});

test("listener reports receipt failure without discarding delivered content", async () => {
  const delivered = [], errors = [];
  await listenSessionEvents({ ...options,
    _poll: async () => ({ ok: true, cursor: "1", events: [event("1")] }),
    onEvent: async item => delivered.push(item.id), onError: async error => errors.push(error),
    _recordMessageViews: async () => ({ ok: false, reason: "api_503" }),
  });
  assert.deepEqual(delivered, [id]);
  assert.ok(errors.some(error => error.operation === "message_views" && error.reason === "api_503"));
});
