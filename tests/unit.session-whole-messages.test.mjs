import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
import {
  SESSION_MCP_TOOLS,
  createSessionMcpToolHandlers,
  handleMcpJsonRpcMessage,
} from "../src/mcp/session-stdio-server.js";
import {
  ARGV_MESSAGE_WARN_CHARS,
  DEFAULT_READ_PAGE_MAX_CHARS,
  SERVER_MESSAGE_MAX_CHARS,
  argvMessageWarning,
  assertMessageWithinServerLimit,
  boundToServerLimit,
  countMessageChars,
  takeWholeItemsWithinBudget,
} from "../src/session/message-limits.js";
import { dedupeSessionEvents, sessionEventUpgradesExisting } from "../src/session/event-identity.js";
import { redactEventPayload } from "../src/session/redact.js";
import { createSession } from "../src/session/store.js";
import { appendToStream, readStream } from "../src/session/stream.js";
import { pollHumanMessages, resetSessionSyncStateForTests } from "../src/session/sync.js";
import { buildResumeInvocation, wake as claudeWake } from "../src/session/wake/claude.js";
import {
  buildCodexExecResumeInvocation,
  buildCodexWakePrompt,
  wake as codexWake,
} from "../src/session/wake/codex.js";
import { createResolveTarget } from "../src/session/wake/resolve-target.js";

// A long body with a counter every 50 characters and an end mark, so any cut, reorder or
// splice is visible in an equality check.
function longBody(chars, label = "body") {
  let text = "";
  for (let index = 0; text.length < chars; index += 1) {
    text += `${label}:${String(index).padStart(8, "0")}|`.padEnd(50, "-");
  }
  return `${text.slice(0, chars - 5)}<END>`;
}

const MESSAGE_40K = longBody(40_000, "whole");
// Built at runtime so no token-shaped literal appears in source.
const FAKE_GITHUB_TOKEN = ["g", "hp_", "Abcdefghijklmnopqrstuvwxyz0123456789"].join("");
// The marker the CLI used to append when it cut a message, before reads kept messages whole.
const LEGACY_CUT_MARKER = `${String.fromCodePoint(0x2026)}[truncated]`;

function apiEvent(sequenceId, message, extra = {}) {
  return {
    event: "session_message",
    sessionId: "room-1",
    cursor: `1790000000000:${sequenceId.toString(16).padStart(8, "0")}`,
    sequenceId,
    ts: `2026-10-31T12:00:${String(sequenceId % 60).padStart(2, "0")}.000Z`,
    agent: { id: "agent-b", model: "test" },
    payload: { message },
    ...extra,
  };
}

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-whole-messages-fixture", version: "1.0.0" }, null, 2),
    "utf-8",
  );
}

async function runSessionCommand(args = []) {
  const savedExitCode = process.exitCode;
  const program = new Command();
  program
    .name("sl")
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
  registerSessionCommand(program);

  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => logs.push(parts.map((part) => String(part)).join(" "));
  console.error = (...parts) => errors.push(parts.map((part) => String(part)).join(" "));
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = savedExitCode;
  }
  return { stdout: logs.join("\n").trim(), stderr: errors.join("\n").trim() };
}

function installAuthEnv(apiUrl = "https://api.sentinelayer.com") {
  const previous = {
    SENTINELAYER_SKIP_REMOTE_SYNC: process.env.SENTINELAYER_SKIP_REMOTE_SYNC,
    SENTINELAYER_TOKEN: process.env.SENTINELAYER_TOKEN,
    SENTINELAYER_API_URL: process.env.SENTINELAYER_API_URL,
  };
  delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
  process.env.SENTINELAYER_TOKEN = "whole-messages-test-placeholder";
  process.env.SENTINELAYER_API_URL = apiUrl;
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

async function withTempWorkspace(prefix, run) {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `create-sentinelayer-${prefix}-`));
  const restoreEnv = installAuthEnv();
  const originalFetch = globalThis.fetch;
  try {
    await seedWorkspace(tempRoot);
    await run(tempRoot);
  } finally {
    globalThis.fetch = originalFetch;
    resetSessionSyncStateForTests();
    restoreEnv();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

// A fake execFile whose child exposes a stdin that records what the wake wrote to it.
function fakeExecFileWithStdin({ withStdin = true } = {}) {
  const calls = [];
  const impl = (file, args, options, callback) => {
    const call = { file, args, options, stdinText: null };
    calls.push(call);
    let stdin;
    if (withStdin) {
      const chunks = [];
      stdin = new Writable({
        write(chunk, _encoding, done) {
          chunks.push(Buffer.from(chunk));
          done();
        },
      });
      stdin.on("finish", () => {
        call.stdinText = Buffer.concat(chunks).toString("utf8");
      });
    }
    setImmediate(() => callback(null, "", ""));
    return { stdin, kill: () => {} };
  };
  return { impl, calls };
}

function historyHandlers(allEvents, { cursorWrites = [], recentActivity = [] } = {}) {
  return createSessionMcpToolHandlers({
    targetPath: "workspace",
    pollSessionEventsBeforeFn: async (_sessionId, { beforeSequence, limit } = {}) => {
      const older = allEvents.filter((event) => !beforeSequence || event.sequenceId < beforeSequence);
      const page = older.slice(-Math.max(1, limit || 50));
      return {
        ok: true,
        events: page,
        beforeSequence: page[0]?.sequenceId || null,
        cursor: page[page.length - 1]?.cursor || null,
      };
    },
    pollSessionEventsFn: async (_sessionId, { since, limit } = {}) => {
      const start = since ? allEvents.findIndex((event) => event.cursor === since) + 1 : 0;
      const page = allEvents.slice(start, start + Math.max(1, limit || 50));
      return { ok: true, events: page, cursor: page[page.length - 1]?.cursor || since || null };
    },
    listSessionMessageActionsFn: async () => ({ ok: true, actions: [], projection: { recentActivity } }),
    updateSessionReadCursorFn: async (_sessionId, options) => {
      cursorWrites.push(options);
      return { ok: true, updated: true, lastReadSequenceId: options.targetSequenceId };
    },
  });
}

// ---- the shared limits ------------------------------------------------------------------

test("whole messages: text is kept whole up to the server limit, counted in code points", () => {
  assert.equal(SERVER_MESSAGE_MAX_CHARS, 64_000);
  const atLimit = "a".repeat(SERVER_MESSAGE_MAX_CHARS);
  assert.deepEqual(boundToServerLimit(atLimit), { text: atLimit, cut: false, originalChars: 64_000 });
  // 64,000 astral characters are 128,000 UTF-16 units, but 64,000 characters to the server.
  const astral = String.fromCodePoint(0x1f600).repeat(SERVER_MESSAGE_MAX_CHARS);
  assert.equal(astral.length, 128_000);
  assert.equal(countMessageChars(astral), 64_000);
  assert.equal(boundToServerLimit(astral).text, astral);
  assert.equal(assertMessageWithinServerLimit(astral), 64_000);
});

test("whole messages: text beyond the server limit is cut only with an explicit marker", () => {
  const bounded = boundToServerLimit(`${"b".repeat(SERVER_MESSAGE_MAX_CHARS)}tail`);
  assert.equal(bounded.cut, true);
  assert.equal(bounded.originalChars, 64_004);
  assert.ok(bounded.text.startsWith("b".repeat(SERVER_MESSAGE_MAX_CHARS)));
  assert.equal(bounded.text.includes("tail"), false);
  assert.match(bounded.text, /\[cut: this text has 64,004 characters, more than the 64,000-character server limit/);
  // The cut never splits a surrogate pair.
  const emoji = String.fromCodePoint(0x1f600);
  const astral = boundToServerLimit(emoji.repeat(SERVER_MESSAGE_MAX_CHARS + 1));
  assert.ok(astral.text.startsWith(`${emoji.repeat(SERVER_MESSAGE_MAX_CHARS)}\n[cut:`));
});

test("whole messages: a message over the limit is refused with a clear error, never split", () => {
  assert.throws(
    () => assertMessageWithinServerLimit("c".repeat(SERVER_MESSAGE_MAX_CHARS + 1)),
    /64,001 characters; one session message holds at most 64,000\. Attach the full text to the room as a file instead, or shorten it\. The CLI never splits a message into parts\./,
  );
  assert.equal(argvMessageWarning("d".repeat(ARGV_MESSAGE_WARN_CHARS)), "");
  assert.match(argvMessageWarning("d".repeat(ARGV_MESSAGE_WARN_CHARS + 1)), /--message-file <path> or --stdin/);
});

test("whole messages: a page budget keeps whole items, contiguous, and always at least one", () => {
  assert.equal(DEFAULT_READ_PAGE_MAX_CHARS, 256_000);
  const items = ["a", "b", "c", "d"].map((id) => ({ id, body: id.repeat(90) }));
  const size = JSON.stringify(items[0]).length;
  const budget = Math.floor(size * 2.5);

  const forward = takeWholeItemsWithinBudget(items, { maxChars: budget });
  assert.deepEqual(forward.items.map((item) => item.id), ["a", "b"]);
  assert.equal(forward.complete, false);
  assert.equal(forward.omittedCount, 2);
  assert.equal(forward.usedChars, size * 2);

  const tail = takeWholeItemsWithinBudget(items, { maxChars: budget, fromEnd: true });
  assert.deepEqual(tail.items.map((item) => item.id), ["c", "d"]);

  const alone = takeWholeItemsWithinBudget(items, { maxChars: 1 });
  assert.deepEqual(alone.items, [items[0]]);

  // A smaller later item never fills the gap after an item that did not fit.
  const mixed = [{ id: "x" }, { id: "big", body: "y".repeat(500) }, { id: "z" }];
  assert.deepEqual(takeWholeItemsWithinBudget(mixed, { maxChars: 100 }).items.map((item) => item.id), ["x"]);

  const all = takeWholeItemsWithinBudget(items, { maxChars: size * 4 });
  assert.equal(all.complete, true);
  assert.equal(all.items.length, 4);
});

// ---- redaction and the local store --------------------------------------------------------

test("whole messages: redaction keeps a 40,000-character message whole", () => {
  const out = redactEventPayload({ event: "session_message", payload: { message: MESSAGE_40K } });
  assert.equal(out.payload.message, MESSAGE_40K);
});

test("whole messages: secrets are still redacted anywhere inside a long message", () => {
  const message = `${longBody(20_000, "front")} ${FAKE_GITHUB_TOKEN} ${longBody(19_000, "back")} ${FAKE_GITHUB_TOKEN}`;
  const out = redactEventPayload({ event: "session_message", payload: { message } });
  assert.equal(out.payload.message.includes(FAKE_GITHUB_TOKEN), false);
  assert.equal(out.payload.message.split("[REDACTED]").length - 1, 2);
  assert.equal(
    out.payload.message,
    `${longBody(20_000, "front")} [REDACTED] ${longBody(19_000, "back")} [REDACTED]`,
  );
});

test("whole messages: a secret across the server-limit cut is redacted before the cut", () => {
  const head = "e".repeat(SERVER_MESSAGE_MAX_CHARS - 10);
  const out = redactEventPayload({ event: "x", payload: { message: `${head}${FAKE_GITHUB_TOKEN} ${"f".repeat(50)}` } });
  assert.ok(out.payload.message.startsWith(`${head}[REDACTED]\n[cut:`));
  assert.equal(out.payload.message.includes(FAKE_GITHUB_TOKEN.slice(0, 10)), false);
});

test("whole messages: the local store and session read keep a 40,000-character message whole", async () => {
  await withTempWorkspace("whole-local", async (tempRoot) => {
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    await appendToStream(
      session.sessionId,
      { event: "session_message", agent: { id: "agent-b" }, payload: { message: MESSAGE_40K } },
      { targetPath: tempRoot, syncRemote: false },
    );
    const stored = await readStream(session.sessionId, { targetPath: tempRoot, tail: 5 });
    assert.equal(stored[stored.length - 1].payload.message, MESSAGE_40K);

    const { stdout } = await runSessionCommand([
      "session", "read", session.sessionId, "--tail", "5", "--path", tempRoot, "--json",
    ]);
    const payload = JSON.parse(stdout);
    assert.equal(payload.events[payload.events.length - 1].payload.message, MESSAGE_40K);
    assert.equal(payload.pageBudget.complete, true);
    assert.equal(payload.pageBudget.maxChars, DEFAULT_READ_PAGE_MAX_CHARS);
  });
});

function fakeRemoteReadFetch(tailEvents, calls = []) {
  return async (url, options = {}) => {
    const textUrl = String(url);
    calls.push({ url: textUrl, options });
    if (textUrl.includes("/human-messages?")) return jsonResponse({ messages: [], cursor: null });
    if (textUrl.includes("/events/before?")) return jsonResponse({ events: tailEvents });
    if (textUrl.includes("/events?")) return jsonResponse({ events: [], cursor: null });
    return jsonResponse({}, 404);
  };
}

test("whole messages: session read --remote delivers a 40,000-character message whole and stores it whole", async () => {
  await withTempWorkspace("whole-remote", async (tempRoot) => {
    const session = await createSession({ targetPath: tempRoot, sessionId: "whole-remote-read", ttlSeconds: 120 });
    globalThis.fetch = fakeRemoteReadFetch([apiEvent(41, MESSAGE_40K, { sessionId: session.sessionId })]);

    const { stdout } = await runSessionCommand([
      "session", "read", session.sessionId, "--remote", "--tail", "5", "--path", tempRoot, "--json",
    ]);
    const payload = JSON.parse(stdout);
    assert.equal(payload.displaySource, "remote_verified_tail");
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0].payload.message, MESSAGE_40K);
    assert.equal(payload.events[0].payload.truncated, undefined);

    const stored = await readStream(session.sessionId, { targetPath: tempRoot, tail: 5 });
    assert.equal(stored[stored.length - 1].payload.message, MESSAGE_40K);
  });
});

test("whole messages: session read --remote replaces a copy an older CLI stored cut short", async () => {
  await withTempWorkspace("whole-legacy", async (tempRoot) => {
    const session = await createSession({ targetPath: tempRoot, sessionId: "whole-legacy-read", ttlSeconds: 120 });
    const whole = apiEvent(42, MESSAGE_40K, { sessionId: session.sessionId });
    const legacyCut = {
      ...whole,
      payload: { message: `${MESSAGE_40K.slice(0, 16_384)}${LEGACY_CUT_MARKER}` },
    };
    await appendToStream(session.sessionId, legacyCut, { targetPath: tempRoot, syncRemote: false });
    globalThis.fetch = fakeRemoteReadFetch([whole]);

    const { stdout } = await runSessionCommand([
      "session", "read", session.sessionId, "--remote", "--tail", "5", "--path", tempRoot, "--json",
    ]);
    const payload = JSON.parse(stdout);
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0].payload.message, MESSAGE_40K);
  });
});

test("whole messages: a whole copy replaces a cut human relay copy and drops its truncated flag", () => {
  const whole = apiEvent(43, MESSAGE_40K);
  const cut = { ...whole, payload: { message: MESSAGE_40K.slice(0, 2_000), truncated: true, source: "human" } };
  assert.equal(sessionEventUpgradesExisting(cut, whole), true);
  assert.equal(sessionEventUpgradesExisting(whole, cut), false);
  const [merged] = dedupeSessionEvents([cut, whole]);
  assert.equal(merged.payload.message, MESSAGE_40K);
  assert.equal("truncated" in merged.payload, false);
  // A copy the server itself holds cut (an old send) is not a whole copy: nothing to restore.
  const serverCut = { ...whole, payload: { message: "short", truncated: true } };
  assert.equal(sessionEventUpgradesExisting(cut, serverCut), false);
});

test("whole messages: the session read page budget keeps the newest whole messages and says how to page back", async () => {
  await withTempWorkspace("whole-read-budget", async (tempRoot) => {
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    for (const sequenceId of [1, 2, 3, 4, 5]) {
      await appendToStream(
        session.sessionId,
        apiEvent(sequenceId, longBody(30_000, `m${sequenceId}`), { sessionId: session.sessionId }),
        { targetPath: tempRoot, syncRemote: false },
      );
    }
    const { stdout } = await runSessionCommand([
      "session", "read", session.sessionId, "--tail", "5", "--max-chars", "100000", "--path", tempRoot, "--json",
    ]);
    const payload = JSON.parse(stdout);
    assert.deepEqual(payload.events.map((event) => event.sequenceId), [3, 4, 5]);
    for (const event of payload.events) {
      assert.equal(event.payload.message, longBody(30_000, `m${event.sequenceId}`));
    }
    assert.equal(payload.pageBudget.complete, false);
    assert.equal(payload.pageBudget.omittedEventCount, 2);
    assert.equal(payload.pageBudget.nextBeforeSequence, 3);

    const text = await runSessionCommand([
      "session", "read", session.sessionId, "--tail", "5", "--max-chars", "100000", "--path", tempRoot,
    ]);
    assert.match(text.stdout, /2 older event\(s\) left out .*--before-sequence 3/);
  });
});

// ---- MCP read and inbox tools ---------------------------------------------------------------

test("whole messages: MCP read_history returns a 40,000-character message whole over JSON-RPC", async () => {
  const handlers = historyHandlers([apiEvent(7, MESSAGE_40K)]);
  const response = await handleMcpJsonRpcMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read_history", arguments: { sessionId: "room-1", agentId: "agent-a", limit: 5 } },
    },
    { handlers, tools: SESSION_MCP_TOOLS },
  );
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.ok, true);
  assert.equal(result.events[0].payload.message, MESSAGE_40K);
  assert.equal("truncated" in result.events[0].payload, false);
  assert.equal(result.pageBudget.complete, true);
});

test("whole messages: MCP read_history tail pages end between whole messages and page back", async () => {
  const all = [1, 2, 3, 4, 5].map((sequenceId) => apiEvent(sequenceId, longBody(30_000, `m${sequenceId}`)));
  const cursorWrites = [];
  const handlers = historyHandlers(all, { cursorWrites });

  const first = await handlers.read_history({ sessionId: "room-1", agentId: "agent-a", maxChars: 100_000 });
  assert.deepEqual(first.events.map((event) => event.sequenceId), [3, 4, 5]);
  assert.equal(first.pageBudget.complete, false);
  assert.equal(first.pageBudget.omittedEventCount, 2);
  assert.deepEqual(first.pageBudget.resume, { beforeSequence: 3 });
  assert.equal(first.beforeSequence, 3);
  assert.equal(cursorWrites[0].targetSequenceId, 5);

  const second = await handlers.read_history({
    sessionId: "room-1",
    agentId: "agent-a",
    beforeSequence: first.pageBudget.resume.beforeSequence,
    maxChars: 100_000,
  });
  assert.deepEqual(second.events.map((event) => event.sequenceId), [1, 2]);
  assert.equal(second.pageBudget.complete, true);
  for (const event of [...second.events, ...first.events]) {
    assert.equal(event.payload.message, longBody(30_000, `m${event.sequenceId}`));
  }
});

test("whole messages: MCP read_history cursor pages resume with the first message left out", async () => {
  const all = [1, 2, 3, 4, 5].map((sequenceId) => apiEvent(sequenceId, longBody(30_000, `m${sequenceId}`)));
  const cursorWrites = [];
  const handlers = historyHandlers(all, { cursorWrites });

  const first = await handlers.read_history({
    sessionId: "room-1",
    agentId: "agent-a",
    cursor: "start",
    maxChars: 100_000,
  });
  assert.deepEqual(first.events.map((event) => event.sequenceId), [1, 2, 3]);
  assert.equal(first.cursor, all[2].cursor);
  assert.deepEqual(first.pageBudget.resume, { cursor: all[2].cursor });
  // The read cursor never moves past what was delivered.
  assert.equal(cursorWrites[0].targetSequenceId, 3);

  const second = await handlers.read_history({
    sessionId: "room-1",
    agentId: "agent-a",
    cursor: first.pageBudget.resume.cursor,
    maxChars: 100_000,
  });
  assert.deepEqual(second.events.map((event) => event.sequenceId), [4, 5]);
  assert.equal(second.pageBudget.complete, true);
});

test("whole messages: a message larger than the page budget still arrives whole, alone", async () => {
  const all = [apiEvent(1, MESSAGE_40K), apiEvent(2, longBody(39_000, "next"))];
  const handlers = historyHandlers(all);
  const page = await handlers.read_history({ sessionId: "room-1", agentId: "agent-a", cursor: "start", maxChars: 1_000 });
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].payload.message, MESSAGE_40K);
  assert.equal("truncated" in page.events[0].payload, false);
  assert.deepEqual(page.pageBudget.resume, { cursor: all[0].cursor });
});

test("whole messages: MCP poll_inbox delivers whole messages and stops its cursor at the budget", async () => {
  const all = [
    apiEvent(1, longBody(30_000, "m1"), { payload: { message: longBody(30_000, "m1"), to: "agent-a" } }),
    apiEvent(2, "for someone else", { payload: { message: "for someone else", to: "agent-c" } }),
    apiEvent(3, longBody(30_000, "m3"), { payload: { message: longBody(30_000, "m3"), to: "agent-a" } }),
    apiEvent(4, longBody(30_000, "m4")),
    apiEvent(5, MESSAGE_40K, { payload: { message: MESSAGE_40K, to: "agent-a" } }),
  ];
  const cursorWrites = [];
  const handlers = historyHandlers(all, { cursorWrites });

  const first = await handlers.poll_inbox({ sessionId: "room-1", agentId: "agent-a", maxChars: 75_000 });
  assert.deepEqual(first.events.map((event) => event.sequenceId), [1, 3]);
  assert.equal(first.events[1].payload.message, longBody(30_000, "m3"));
  assert.equal(first.cursor, all[2].cursor);
  assert.equal(first.pageBudget.complete, false);
  assert.deepEqual(first.pageBudget.resume, { cursor: all[2].cursor });
  assert.equal(cursorWrites[0].targetSequenceId, 3);

  const second = await handlers.poll_inbox({ sessionId: "room-1", agentId: "agent-a", cursor: first.cursor, maxChars: 75_000 });
  assert.deepEqual(second.events.map((event) => event.sequenceId), [4, 5]);
  assert.equal(second.events[1].payload.message, MESSAGE_40K);
  assert.equal(second.pageBudget.complete, true);
});

test("whole messages: MCP recent human activity carries a long human reply whole", async () => {
  const handlers = historyHandlers([], {
    recentActivity: [
      {
        id: "reply-1",
        targetSequenceId: 4,
        actionType: "reply",
        actorKind: "human",
        actorId: "human-owner",
        note: MESSAGE_40K,
        createdAt: "2026-10-31T12:00:00.000Z",
      },
    ],
  });
  const result = await handlers.poll_inbox({ sessionId: "room-1", agentId: "agent-a" });
  assert.equal(result.recentHumanActivity[0].note, MESSAGE_40K);
});

// ---- MCP send tools -------------------------------------------------------------------------

function sendHandlers({ synced = [], actions = [] } = {}) {
  return createSessionMcpToolHandlers({
    targetPath: "workspace",
    pollSessionEventsBeforeFn: async () => ({ ok: true, events: [apiEvent(1, "anchor")], cursor: apiEvent(1, "anchor").cursor }),
    syncSessionEventToApiFn: async (_sessionId, event) => {
      synced.push(event);
      return { synced: true, status: 202 };
    },
    pollSessionEventsFn: async () => ({
      ok: true,
      events: synced.map((event, index) => ({ ...event, cursor: `posted-${index}`, sequenceId: 100 + index })),
      cursor: `posted-${synced.length}`,
    }),
    createSessionMessageActionFn: async (_sessionId, options) => {
      actions.push(options);
      return { ok: true, action: { id: `action-${actions.length}`, actionType: options.actionType } };
    },
    appendToStreamFn: async (_sessionId, event) => event,
    sleepFn: async () => {},
  });
}

test("whole messages: MCP send_message sends a 40,000-character message as one whole message", async () => {
  const synced = [];
  const handlers = sendHandlers({ synced });
  const result = await handlers.send_message({ sessionId: "room-1", agentId: "agent-a", message: MESSAGE_40K });
  assert.equal(result.ok, true);
  assert.equal(synced.length, 1);
  assert.equal(synced[0].payload.message, MESSAGE_40K);
  assert.equal("truncated" in synced[0].payload, false);
  const schema = SESSION_MCP_TOOLS.find((tool) => tool.name === "send_message").inputSchema;
  assert.equal(schema.properties.message.maxLength, SERVER_MESSAGE_MAX_CHARS);
});

test("whole messages: MCP send_message refuses a message over the server limit, never splitting it", async () => {
  const synced = [];
  const handlers = sendHandlers({ synced });
  const response = await handleMcpJsonRpcMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: { sessionId: "room-1", agentId: "agent-a", message: "g".repeat(SERVER_MESSAGE_MAX_CHARS + 1) },
      },
    },
    { handlers, tools: SESSION_MCP_TOOLS },
  );
  assert.equal(response.result.isError, true);
  assert.match(response.result.structuredContent.reason, /64,001 characters.*file instead.*never splits/);
  assert.equal(synced.length, 0);
});

test("whole messages: MCP session_reply sends a long reply whole and refuses one over the limit", async () => {
  const actions = [];
  const handlers = sendHandlers({ actions });
  const result = await handlers.session_reply({
    sessionId: "room-1",
    agentId: "agent-a",
    targetSequenceId: 5,
    message: MESSAGE_40K,
  });
  assert.equal(result.ok, true);
  assert.equal(actions[0].note, MESSAGE_40K);
  await assert.rejects(
    () => handlers.session_reply({
      sessionId: "room-1",
      agentId: "agent-a",
      targetSequenceId: 5,
      message: "h".repeat(SERVER_MESSAGE_MAX_CHARS + 1),
    }),
    /The reply has 64,001 characters/,
  );
  assert.equal(actions.length, 1);
});

// ---- the human-message relay ----------------------------------------------------------------

test("whole messages: the human-message relay keeps a message longer than 2,000 characters whole", async () => {
  resetSessionSyncStateForTests();
  const authSession = { apiUrl: "https://api.sentinelayer.com" };
  authSession["to" + "ken"] = "whole-messages-test-placeholder";
  const polled = await pollHumanMessages("room-1", {
    resolveAuthSession: async () => authSession,
    fetchImpl: async () => jsonResponse({
      cursor: "human-1",
      messages: [{ id: "hm-1", ts: "2026-10-31T12:00:00.000Z", senderId: "human-owner", message: MESSAGE_40K }],
    }),
  });
  resetSessionSyncStateForTests();
  assert.equal(polled.ok, true);
  assert.equal(polled.events.length, 1);
  assert.equal(polled.events[0].payload.message, MESSAGE_40K);
  assert.equal(polled.events[0].payload.truncated, false);
});

// ---- wake prompts ---------------------------------------------------------------------------

test("whole messages: a claude wake carries a long message whole over stdin", async () => {
  const resolveTarget = createResolveTarget({ agentId: "agent-a", host: "claude", sessionId: "resume-1" });
  const target = resolveTarget(apiEvent(12, MESSAGE_40K, { payload: { message: MESSAGE_40K, to: "agent-a" } }));
  assert.ok(target.message.endsWith(`\n\n${MESSAGE_40K}`));

  const invocation = buildResumeInvocation(target);
  assert.deepEqual(invocation.args, ["--resume", "resume-1", "-p"]);
  assert.equal(invocation.stdin, target.message);

  const { impl, calls } = fakeExecFileWithStdin();
  const result = await claudeWake(target, { execFileImpl: impl });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].args, ["--resume", "resume-1", "-p"]);
  assert.equal(calls[0].stdinText, target.message);
});

test("whole messages: a short claude wake still passes its prompt as an argument", async () => {
  const { impl, calls } = fakeExecFileWithStdin();
  const result = await claudeWake({ sessionId: "resume-1", message: "short wake" }, { execFileImpl: impl });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].args, ["--resume", "resume-1", "-p", "short wake"]);
  assert.equal(calls[0].stdinText, null);
});

test("whole messages: a long wake fails loudly when the prompt cannot be written to stdin", async () => {
  const { impl } = fakeExecFileWithStdin({ withStdin: false });
  const result = await claudeWake({ sessionId: "resume-1", message: MESSAGE_40K }, { execFileImpl: impl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "wake_prompt_stdin_unavailable");
});

test("whole messages: a codex wake carries a long message whole over stdin", async () => {
  const prompt = buildCodexWakePrompt({ sentiSessionId: "room-1", message: MESSAGE_40K });
  const payload = JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)?.[1] || "{}");
  assert.equal(payload.message, MESSAGE_40K);

  const codexSessionId = "11111111-1111-4111-8111-111111111111";
  const invocation = buildCodexExecResumeInvocation({ codexSessionId, prompt });
  assert.equal(invocation.args[invocation.args.length - 1], "-");
  assert.equal(invocation.stdin, prompt);

  const { impl, calls } = fakeExecFileWithStdin();
  const result = await codexWake({ sessionId: codexSessionId, message: prompt }, { execFileImpl: impl });
  assert.equal(result.ok, true);
  assert.equal(calls[0].args[calls[0].args.length - 1], "-");
  assert.equal(calls[0].stdinText, prompt);
});

// ---- CLI posting ----------------------------------------------------------------------------

test("whole messages: session say refuses a message file over the server limit before any request", async () => {
  await withTempWorkspace("whole-say-refuse", async (tempRoot) => {
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    const messageFile = path.join(tempRoot, "too-long.md");
    await writeFile(messageFile, "i".repeat(70_000), "utf-8");
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return jsonResponse({}, 500);
    };
    await assert.rejects(
      () => runSessionCommand([
        "session", "say", session.sessionId, "--message-file", messageFile, "--agent", "agent-a", "--path", tempRoot,
      ]),
      /70,000 characters; one session message holds at most 64,000\. Attach the full text to the room as a file instead/,
    );
    assert.equal(requests, 0);
  });
});

test("whole messages: session say warns about a long command-line message", async () => {
  await withTempWorkspace("whole-say-argv", async (tempRoot) => {
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    globalThis.fetch = async () => jsonResponse({}, 500);
    let stderr = "";
    const originalError = console.error;
    console.error = (...parts) => {
      stderr += parts.join(" ");
    };
    try {
      await assert.rejects(() => runSessionCommandKeepingStderr([
        "session", "say", session.sessionId, "j".repeat(70_000), "--agent", "agent-a", "--path", tempRoot,
      ]));
    } finally {
      console.error = originalError;
    }
    assert.match(stderr, /came from command-line arguments.*--message-file <path> or --stdin/);
  });
});

// Like runSessionCommand, but leaves console.error to the caller.
async function runSessionCommandKeepingStderr(args = []) {
  const savedExitCode = process.exitCode;
  const program = new Command();
  program.name("sl").exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerSessionCommand(program);
  const originalLog = console.log;
  console.log = () => {};
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    console.log = originalLog;
    process.exitCode = savedExitCode;
  }
}

test("whole messages: session say posts a 40,000-character message file as one whole message", async () => {
  await withTempWorkspace("whole-say-post", async (tempRoot) => {
    const session = await createSession({ targetPath: tempRoot, sessionId: "whole-say-post", ttlSeconds: 120 });
    const messageFile = path.join(tempRoot, "long.md");
    await writeFile(messageFile, MESSAGE_40K, "utf-8");
    const posts = [];
    globalThis.fetch = async (url, options = {}) => {
      const textUrl = String(url);
      if (options.method === "POST" && textUrl.endsWith(`/api/v1/sessions/${session.sessionId}/events`)) {
        posts.push(JSON.parse(options.body).event);
        return jsonResponse({}, 202);
      }
      if (textUrl.includes("/events/before?")) {
        return jsonResponse({ events: [{ event: "session_message", cursor: "cursor-anchor", payload: { message: "anchor" } }] });
      }
      if (textUrl.includes("/events?after=cursor-anchor")) {
        const projected = posts.map((event) => {
          const copy = JSON.parse(JSON.stringify(event));
          delete copy.eventId;
          delete copy.idempotencyToken;
          return { ...copy, cursor: "cursor-posted" };
        });
        return jsonResponse({ events: projected });
      }
      return jsonResponse({}, 404);
    };

    const { stdout } = await runSessionCommand([
      "session", "say", session.sessionId, "--message-file", messageFile, "--agent", "agent-a", "--path", tempRoot, "--json",
    ]);
    const payload = JSON.parse(stdout);
    assert.equal(payload.remoteConfirmation.confirmed, true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].payload.message, MESSAGE_40K);
    assert.equal(payload.event.payload.message, MESSAGE_40K);
  });
});

test("whole messages: session reply posts a long reply file whole and refuses one over the limit", async () => {
  await withTempWorkspace("whole-reply", async (tempRoot) => {
    const session = await createSession({ targetPath: tempRoot, sessionId: "whole-reply", ttlSeconds: 120 });
    const replyFile = path.join(tempRoot, "reply.md");
    await writeFile(replyFile, MESSAGE_40K, "utf-8");
    const actionBodies = [];
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === "POST" && String(url).endsWith(`/api/v1/sessions/${session.sessionId}/actions`)) {
        const body = JSON.parse(options.body);
        actionBodies.push(body);
        return jsonResponse({
          ok: true,
          action: {
            id: "00000000-0000-4000-8000-000000000001",
            sessionId: session.sessionId,
            actionType: "reply",
            targetSequenceId: body.targetSequenceId,
            actorId: "agent-a",
            note: body.note,
            createdAt: "2026-10-31T12:00:00.000Z",
          },
        }, 201);
      }
      return jsonResponse({}, 404);
    };

    const { stdout } = await runSessionCommand([
      "session", "reply", session.sessionId, "5", "--message-file", replyFile, "--agent", "agent-a", "--path", tempRoot, "--json",
    ]);
    const payload = JSON.parse(stdout);
    assert.equal(actionBodies.length, 1);
    assert.equal(actionBodies[0].note, MESSAGE_40K);
    assert.equal(payload.action.note, MESSAGE_40K);

    const tooLong = path.join(tempRoot, "reply-too-long.md");
    await writeFile(tooLong, "k".repeat(SERVER_MESSAGE_MAX_CHARS + 1), "utf-8");
    await assert.rejects(
      () => runSessionCommand([
        "session", "reply", session.sessionId, "5", "--message-file", tooLong, "--agent", "agent-a", "--path", tempRoot,
      ]),
      /The reply has 64,001 characters/,
    );
    assert.equal(actionBodies.length, 1);
  });
});
