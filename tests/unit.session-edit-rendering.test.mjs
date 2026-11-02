import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerSessionCommand } from "../src/commands/session.js";
import { createSession } from "../src/session/store.js";
import { appendToStream } from "../src/session/stream.js";
import { createSessionMcpToolHandlers } from "../src/mcp/session-stdio-server.js";
import { enrichEventWithMentions } from "../src/session/mentions.js";
import { eventMatchesAgent } from "../src/session/listener.js";
import { createResolveTarget } from "../src/session/wake/resolve-target.js";
import { createWakeDispatcher } from "../src/session/wake/dispatcher.js";
import { createWakeRegistry } from "../src/session/wake/registry.js";

const run = promisify(execFile);
const cliPath = fileURLToPath(new URL("../bin/create-sentinelayer.js", import.meta.url));

function edit({ reply = false, direct, text = "updated text" } = {}) {
  const snapshot = {
    stream: "sl_event", id: "message-42", event: "session_message", sessionId: "room-test",
    agent: { id: "writer", model: "test" }, sequenceId: 42, cursor: "c42",
    ts: "2026-11-01T12:00:00.000Z", messageRevision: 2,
    payload: { message: reply ? "parent text" : text, to: ["reader"] },
  };
  return {
    ...snapshot, id: "edit-43", eventId: "edit-43", event: "session_message_edited",
    sequenceId: 43, cursor: "c43", ts: "2026-11-01T12:01:00.000Z",
    payload: {
      schema: "session-message-edit:v1", targetMessageId: snapshot.id, targetSequenceId: 42,
      targetActionId: reply ? "reply-1" : null, messageRevision: 2, event: snapshot,
      reply: reply ? { id: "reply-1", actionType: "reply", actorId: "writer", targetSequenceId: 42,
        messageRevision: 2, note: text, createdAt: snapshot.ts } : null,
      ...(direct !== undefined ? { message: direct } : {}),
    },
  };
}

const cases = [
  [edit(), "[edited #42] updated text"],
  [edit({ reply: true }), "[edited reply under #42] updated text"],
  [edit({ reply: true, direct: "direct text" }), "[edited reply under #42] direct text"],
  [edit({ direct: "direct text" }), "[edited #42] direct text"],
  [edit({ direct: "" }), "[edited #42]"],
  [edit({ reply: true, text: "" }), "[edited reply under #42]"],
  [{ ...edit(), payload: { event: edit().payload.event } }, "[edited #42] updated text"],
];

async function withSession(source, fn) {
  const targetPath = await mkdtemp(path.join(os.tmpdir(), "sl-edit-rendering-"));
  try {
    await createSession({ targetPath, sessionId: source.sessionId });
    await appendToStream(source.sessionId, source, { targetPath, syncRemote: false });
    return await fn(targetPath);
  } finally {
    await rm(targetPath, { recursive: true, force: true });
  }
}

async function cli(args) {
  const program = new Command().exitOverride();
  registerSessionCommand(program);
  const lines = [];
  const original = console.log;
  console.log = (...parts) => lines.push(parts.join(" "));
  try {
    await program.parseAsync(["node", "sl", "session", ...args]);
    return lines.join("\n");
  } finally {
    console.log = original;
  }
}

for (const command of ["read", "history"]) {
  for (const json of [false, true]) {
    test(`Edit rendering: CLI ${command} json=${json} uses edited text and target`, async () => {
      for (const [source, expected] of cases) {
        await withSession(source, async (targetPath) => {
          const args = command === "read" ? [command, source.sessionId] : [command];
          const output = await cli([...args, "--path", targetPath, ...(json ? ["--json"] : [])]);
          if (!json) {
            assert.ok(output.includes(expected), output);
            assert.doesNotMatch(output, /undefined|parent text/);
            return;
          }
          const result = JSON.parse(output);
          const row = command === "read" ? result.events[0] : result.sessions[0].preview;
          assert.equal(row.editSummary, expected);
          const raw = command === "read" ? row : row.event;
          assert.equal(raw.event, source.event);
          assert.equal(raw.sequenceId, 43);
          assert.deepEqual(raw.payload, source.payload);
        });
      }
    });
  }
}

for (const emit of ["text", "ndjson"]) {
  test(`Edit rendering: CLI listen ${emit} displays both edit kinds and preserves raw JSON`, async () => {
    const sources = cases.map(([source], index) => ({ ...source, id: `edit-${43 + index}`,
      eventId: `edit-${43 + index}`, cursor: `c${43 + index}`, sequenceId: 43 + index }));
    const server = createServer((req, res) => {
      const body = req.method === "GET" && req.url.includes("/events")
        ? { ok: true, events: [...sources, sources[0]], cursor: sources.at(-1).cursor } : { ok: true };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      await withSession(edit(), async (targetPath) => {
        const { stdout } = await run(process.execPath, [cliPath, "session", "listen",
          "--session", "room-test", "--agent", "reader", "--path", targetPath,
          "--emit", emit, "--max-polls", "1", "--replay", "--allow-duplicate", "--no-presence", "--no-coaching"], {
          cwd: targetPath, timeout: 15000,
          env: { ...process.env, SENTINELAYER_CLI_TEST_MODE: "1", SENTINELAYER_CLI_SKIP_AUTH: "1",
            SENTINELAYER_SKIP_REMOTE_SYNC: "0", SENTINELAYER_TOKEN: ["unit", "edit", "fixture"].join("-"),
            SENTINELAYER_API_URL: `http://127.0.0.1:${server.address().port}` },
        });
        if (emit === "text") {
          for (const [, expected] of cases) assert.ok(stdout.includes(expected), stdout);
          assert.doesNotMatch(stdout, /undefined|parent text/);
        } else {
          const events = stdout.trim().split("\n").map(JSON.parse).filter((row) => row.event === "session_message_edited");
          assert.equal(events.length, sources.length);
          for (let index = 0; index < events.length; index += 1) {
            assert.equal(events[index].editSummary, cases[index][1]);
            assert.deepEqual(events[index].payload, sources[index].payload);
          }
        }
      });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

for (const tool of ["read_history", "poll_inbox"]) {
  for (const includeRaw of [false, true]) {
    test(`Edit rendering: MCP ${tool} includeRaw=${includeRaw} adds summary without changing payload`, async () => {
      for (const [source, expected] of cases) {
        const before = structuredClone(source);
        const poll = async () => ({ ok: true, events: [source], cursor: "c43", hasMore: false });
        const handlers = createSessionMcpToolHandlers({
          pollSessionEventsFn: poll, pollSessionEventsBeforeFn: poll,
          updateSessionReadCursorFn: async () => ({ ok: true }),
        });
        const result = await handlers[tool]({ sessionId: "room-test", agentId: "reader", includeRaw, includeActions: false });
        assert.equal(result.ok, true);
        assert.equal(result.events.length, 1);
        assert.equal(result.events[0].editSummary, expected);
        assert.deepEqual(result.events[0].payload, source.payload);
        if (includeRaw) assert.deepEqual(result.events[0], { ...source, editSummary: expected });
        assert.deepEqual(source, before);
      }
    });
  }
}

for (const reply of [false, true]) {
  test(`Edit rendering: ${reply ? "reply" : "message"} edit mentions reach the new recipient once`, async () => {
    const source = edit({ reply, text: "please review @reviewer" });
    const before = structuredClone(source);
    const enriched = enrichEventWithMentions(source);
    assert.deepEqual(enriched.payload.mentions?.handles, ["reviewer"]);
    assert.equal(eventMatchesAgent(source, "reviewer"), true);
    assert.equal(eventMatchesAgent(source, "unrelated"), false);
    const calls = [];
    const dispatcher = createWakeDispatcher({
      registry: createWakeRegistry([{ hostName: "test", wake: async (target) => { calls.push(target); return { ok: true }; } }]),
      resolveTarget: createResolveTarget({ agentId: "reviewer", host: "test", sessionId: "host-test" }),
    });
    assert.equal((await dispatcher.dispatchEvent(source)).ok, true);
    assert.equal((await dispatcher.dispatchEvent(source)).reason, "already_seen");
    assert.equal(calls.length, 1);
    assert.match(calls[0].message, /please review @reviewer/);
    assert.deepEqual(source, before);
  });
}
