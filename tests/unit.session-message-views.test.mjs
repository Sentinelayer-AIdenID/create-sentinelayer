import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { recordSessionMessageViews, resetSessionSyncStateForTests } from "../src/session/sync.js";
import { displayedMessageViewTargets } from "../src/session/message-views.js";
import { createSessionMutationCsrfToken } from "../src/session/invitations.js";

const messageId = "10000000-0000-4000-8000-000000000001";
const replyId = "20000000-0000-4000-8000-000000000002";
const token = "unit-local-view-token";
const target = { kind: "message", id: messageId, targetRevision: 2 };
const auth = async () => ({ token, apiUrl: "http://127.0.0.1:3000" });

test("view targets are exact displayed message/reply revisions; cursors, edits and client ids cannot masquerade as views", () => {
  assert.deepEqual(displayedMessageViewTargets([
    { event: "session_message", id: messageId, messageRevision: 1 },
    { event: "session_message", id: messageId, messageRevision: 2 },
    { event: "session_reply", payload: { actionId: replyId }, messageRevision: 3 },
    { event: "session_message", sequenceId: 40, cursor: "40:unknown", payload: { messageId: messageId } },
    { event: "session_message_edited", id: messageId, messageRevision: 3 },
  ]), [target, { kind: "reply", id: replyId, targetRevision: 3 }]);
});

test("view batch is awaited and authenticated with route-bound mutation headers", async () => {
  resetSessionSyncStateForTests();
  process.env.SENTINELAYER_API_URL = "http://127.0.0.1:3000";
  let writeFinished = false;
  let request;
  const result = await recordSessionMessageViews("view-room", { targets: [target], agentId: "sol-max", resolveAuthSession: auth,
    fetchImpl: async (url, options) => {
      request = { url, options };
      await new Promise(resolve => setTimeout(resolve, 15));
      writeFinished = true;
      return Response.json({ ok: true, recorded: 1 });
    } });
  assert.equal(writeFinished, true);
  assert.equal(request.url, "http://127.0.0.1:3000/api/v1/sessions/view-room/view-receipts");
  assert.deepEqual(JSON.parse(request.options.body), { targets: [target], agentId: "sol-max" });
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["X-CSRF-Token"], createSessionMutationCsrfToken({ bearerToken: token, sessionId: "view-room", routeId: "POST /api/v1/sessions/{session_id}/view-receipts", idempotencyKey: request.options.headers["Idempotency-Key"] }));
  assert.deepEqual(result, { ok: true, reason: "", recorded: 1 });
});

test("invalid view batches are refused before any network or credential lookup", async () => {
  let calls = 0;
  for (const targets of [[], [{ ...target, id: "../not-a-message" }], [{ ...target, targetRevision: 0 }], Array(101).fill(target)]) {
    const result = await recordSessionMessageViews("view-room", { targets, resolveAuthSession: async () => { calls++; return auth(); } });
    assert.equal(result.ok, false);
  }
  assert.equal(calls, 0);
});

test("backend refusal is reported as failure rather than a queued/successful view", async () => {
  resetSessionSyncStateForTests();
  const result = await recordSessionMessageViews("view-room", { targets: [target], resolveAuthSession: auth,
    fetchImpl: async () => Response.json({ error: "unsupported" }, { status: 503 }) });
  assert.equal(result.ok, false);
  assert.equal(result.recorded, 0);
  assert.equal(result.reason, "view_receipts_api_503");
});
