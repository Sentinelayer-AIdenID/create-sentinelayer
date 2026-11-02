import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { enrichEventWithMentions } from "../src/session/mentions.js";
import { listenSessionEvents } from "../src/session/listener.js";
import { createResolveTarget } from "../src/session/wake/resolve-target.js";
import { createWakeDispatcher } from "../src/session/wake/dispatcher.js";
import { createWakeRegistry } from "../src/session/wake/registry.js";

const agents = ["author", "reviewer", "observer"];
const cases = [
  ...["all", "everyone", "here", "channel"].map((mention) => ({
    name: `targeted @${mention}`,
    payload: { message: `updated @${mention}`, to: ["reviewer"] },
    recipients: ["reviewer"],
  })),
  { name: "added direct mention", payload: { message: "updated @reviewer" }, recipients: ["reviewer"] },
  { name: "plain edit", payload: { message: "updated", to: ["reviewer"] }, recipients: ["reviewer"] },
  { name: "self mention", payload: { message: "updated @author" }, recipients: ["author"] },
  { name: "duplicate delivery", payload: { message: "updated @reviewer" }, recipients: ["reviewer"], duplicate: true },
  { name: "explicit audience wins", payload: { message: "updated @observer", to: ["reviewer"] }, recipients: ["reviewer"] },
  ...["recipients", "recipient", "targetAgent", "targetAgentId"].map((field) => ({
    name: `explicit ${field} wins`,
    payload: { message: "updated @observer", [field]: field === "recipients" ? ["reviewer"] : "reviewer" },
    recipients: ["reviewer"],
  })),
  { name: "server broadcast", payload: { message: "updated", to: ["reviewer"], broadcast: true }, recipients: agents },
  { name: "server non-broadcast", payload: { message: "updated @all", to: ["reviewer"], broadcast: false }, recipients: ["reviewer"] },
];

function pairedEvents(payload) {
  const original = {
    id: "message-1", event: "session_message", agent: { id: "author" },
    sessionId: "sample-session", sequenceId: 1, cursor: "seq:1",
    ts: "2026-01-01T00:00:00.000Z", messageRevision: 1,
    payload: { ...payload, message: "original" },
  };
  const snapshot = { ...original, messageRevision: 2, payload: { ...payload } };
  const edited = {
    ...original, id: "edit-2", event: "session_message_edited", sequenceId: 2, cursor: "seq:2",
    payload: {
      schema: "session-message-edit:v1", targetMessageId: original.id,
      targetSequenceId: 1, messageRevision: 2, event: snapshot,
    },
  };
  const fresh = enrichEventWithMentions({
    ...original, id: "message-2", sequenceId: 2, cursor: "seq:2", payload: { ...payload },
  });
  return { original: enrichEventWithMentions(original), fresh, edited };
}

test("paired new/edit listener deliveries preserve targeted audiences and deduplicate notifications", async () => {
  const actual = [];
  const expected = [];
  for (const scenario of cases) {
    const { original, fresh, edited } = pairedEvents(scenario.payload);
    for (const [kind, event] of [["new", fresh], ["edit", edited], ["local edit", enrichEventWithMentions(edited)]]) {
      for (const agentId of agents) {
        const delivered = [];
        const events = [original, event, ...(scenario.duplicate ? [structuredClone(event)] : [])];
        const result = await listenSessionEvents({
          sessionId: "sample-session", agentId, replay: true, maxPolls: 1,
          _readCursor: async () => null,
          _writeCursor: async () => ({ written: true }),
          _updateReadCursor: async () => ({ ok: true }),
          _poll: async () => ({ ok: true, events, cursor: "seq:2" }),
          onEvent: async (value) => delivered.push(value),
        });
        assert.equal(result.emitted, delivered.length);
        actual.push([scenario.name, kind, agentId, delivered.filter((value) => value.sequenceId === 2).length]);
        expected.push([scenario.name, kind, agentId, Number(scenario.recipients.includes(agentId))]);
      }
    }
  }
  assert.deepEqual(actual, expected);
});

test("paired new/edit wake resolution preserves audiences, excludes the author and wakes once per notification", async () => {
  const actual = [];
  const expected = [];
  for (const scenario of cases) {
    const { original, fresh, edited } = pairedEvents(scenario.payload);
    for (const [kind, event] of [["new", fresh], ["edit", edited], ["local edit", enrichEventWithMentions(edited)]]) {
      for (const agentId of agents) {
        const wakes = [];
        const resolveTarget = createResolveTarget({ agentId, host: "sample-host", sessionId: "sample-session" });
        const dispatcher = createWakeDispatcher({
          resolveTarget,
          registry: createWakeRegistry([{
            hostName: "sample-host",
            wake: async (target) => { wakes.push(target); return { ok: true }; },
          }]),
        });
        await dispatcher.dispatchEvent(original);
        wakes.length = 0;
        await dispatcher.dispatchEvent(event);
        if (scenario.duplicate) {
          const duplicate = await dispatcher.dispatchEvent(structuredClone(event));
          assert.equal(duplicate.reason, "already_seen");
        }
        assert.equal(dispatcher.getCursor(), 2);
        actual.push([scenario.name, kind, agentId, resolveTarget(event) !== null, wakes.length]);
        const shouldWake = scenario.recipients.includes(agentId) && agentId !== "author";
        expected.push([scenario.name, kind, agentId, shouldWake, Number(shouldWake)]);
        for (const wake of wakes) assert.ok(wake.message.includes(scenario.payload.message));
      }
    }
  }
  assert.deepEqual(actual, expected);
});
