import "./setup-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionMcpToolHandlers } from '../src/mcp/session-stdio-server.js';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const event = (n, fields = {}) => ({ event: 'session_message', id: id(n), sequenceId: n, cursor: `c${n}`,
  ts: '2026-10-20T20:00:00Z', sessionId: 'room-a', messageRevision: 2,
  agent: { id: 'human-mrrcarter' }, payload: { message: 'returned body' }, ...fields });
const deps = (events, overrides = {}) => ({ targetPath: 'workspace',
  pollSessionEventsFn: async () => ({ ok: true, events, cursor: 'c999' }),
  pollSessionEventsBeforeFn: async () => ({ ok: true, events, cursor: 'c999' }),
  listSessionMessageActionsFn: async () => ({ ok: true, actions: [] }),
  updateSessionReadCursorFn: async () => ({ ok: true, updated: true, lastReadSequenceId: 999 }),
  ...overrides });

test('MCP inbox receipts count returned bodies, never recipient-filtered/self/control rows or high cursor', async () => {
  const calls = [];
  let persisted = false;
  const handlers = createSessionMcpToolHandlers(deps([event(1), event(2, { payload: { message: 'other agent', to: 'claude' } }),
    event(3, { agent: { id: 'sol-max' } }), event(999, { event: 'session_listener_heartbeat' })], {
    recordSessionMessageViewsFn: async (room, request) => { calls.push({ room, request });
      await new Promise(resolve => setTimeout(resolve, 10)); persisted = true; return { ok: true, recorded: request.targets.length }; },
  }));
  const result = await handlers.poll_inbox({ sessionId: 'room-a', agentId: 'sol-max', includeActions: false });
  assert.equal(persisted, true);
  assert.equal(result.inboxCount, 1);
  assert.equal(result.events[0].id, id(1));
  assert.equal(result.events[0].messageRevision, 2);
  assert.deepEqual(calls[0].request.targets, [{ kind: 'message', id: id(1), targetRevision: 2 }]);
  assert.equal(result.viewReceipts.recorded, 1);
  assert.equal(result.viewReceipts.complete, true);
  assert.equal(result.readCursor.lastReadSequenceId, 999);
});

test('MCP returns human reply revisions and records only matching current bodies', async () => {
  const writes = [];
  const reply = { id: id(12), actionType: 'reply', actorKind: 'human', actorId: 'human-mrrcarter',
    note: 'current reply', messageRevision: 4, createdAt: '2026-10-20T20:00:00Z' };
  const projected = { ...reply }; delete projected.messageRevision;
  const handlers = createSessionMcpToolHandlers(deps([], {
    listSessionMessageActionsFn: async () => ({ ok: true, actions: [reply], projection: { recentActivity: [projected] } }),
    recordSessionMessageViewsFn: async (_room, request) => { writes.push(request.targets); return { ok: true, recorded: request.targets.length }; },
  }));
  const result = await handlers.read_history({ sessionId: 'room-a', agentId: 'sol-max' });
  assert.equal(result.recentHumanActivity[0].messageRevision, 4);
  assert.deepEqual(writes, [[{ kind: 'reply', id: id(12), targetRevision: 4 }]]);
  assert.equal(result.viewReceipts.complete, true);

  const stale = createSessionMcpToolHandlers(deps([], {
    listSessionMessageActionsFn: async () => ({ ok: true, actions: [reply], projection: { recentActivity: [{ ...projected, note: 'old projected reply' }] } }),
    recordSessionMessageViewsFn: async () => assert.fail('unknown reply revision must not be guessed'),
  }));
  const unresolved = await stale.read_history({ sessionId: 'room-a', agentId: 'sol-max' });
  assert.equal(unresolved.viewReceipts.unresolved, 1);
  assert.equal(unresolved.viewReceipts.complete, false);
});

test('MCP history receipts use exact newest returned revisions and bounded batches; partial failure stays visible', async () => {
  const events = Array.from({ length: 101 }, (_, i) => event(i + 1));
  const batches = [];
  const handlers = createSessionMcpToolHandlers(deps([...events, event(1, { messageRevision: 3 })], {
    recordSessionMessageViewsFn: async (_room, request) => { batches.push(request.targets);
      return batches.length === 1 ? { ok: true, recorded: request.targets.length } : { ok: false, reason: 'api_unavailable' }; },
  }));
  const result = await handlers.read_history({ sessionId: 'room-a', agentId: 'sol-max', limit: 200, includeActions: false });
  assert.equal(result.ok, true);
  assert.deepEqual(batches.map(batch => batch.length), [100, 1]);
  assert.equal(batches[0].find(target => target.id === id(1)).targetRevision, 3);
  assert.equal(result.viewReceipts.recorded, 100);
  assert.equal(result.viewReceipts.failed, 1);
  assert.equal(result.viewReceipts.reason, 'api_unavailable');
  assert.equal(result.viewReceipts.complete, false);
  assert.equal(result.viewReceipts.background, false);
});

test('MCP missing identity does not attribute a view to the owner; stuck writes are bounded', async () => {
  const unbound = createSessionMcpToolHandlers(deps([event(1)], {
    recordSessionMessageViewsFn: async () => assert.fail('cannot guess agent identity'),
  }));
  const result = await unbound.read_history({ sessionId: 'room-a', includeActions: false });
  assert.equal(result.viewReceipts.enabled, false);
  assert.equal(result.viewReceipts.reason, 'agent_identity_required');
  const stuck = createSessionMcpToolHandlers(deps([event(1)], { viewReceiptTimeoutMs: 50,
    recordSessionMessageViewsFn: async () => new Promise(() => {}),
  }));
  const start = performance.now();
  const timed = await stuck.read_history({ sessionId: 'room-a', agentId: 'sol-max', includeActions: false });
  assert(performance.now() - start < 1000);
  assert.equal(timed.ok, true);
  assert.equal(timed.viewReceipts.reason, 'view_receipts_timeout');
  assert.equal(timed.viewReceipts.complete, false);
  assert.equal(timed.events[0].payload.message, 'returned body');
});
