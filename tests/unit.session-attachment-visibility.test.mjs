import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { registerSessionCommand } from "../src/commands/session.js";
import { createSession } from "../src/session/store.js";
import { appendToStream } from "../src/session/stream.js";
import { pickLatestPreview } from "../src/session/preview.js";
import { buildTranscriptMarkdown } from "../src/session/transcript.js";
import { buildSessionRecap } from "../src/session/recap.js";
import { createListenerHostWake } from "../src/session/wake/listen-wake.js";
import { createSessionMcpToolHandlers } from "../src/mcp/session-stdio-server.js";
import { fetchSessionPinnedMessages } from "../src/session/sync.js";

const attachments = [
  {
    attachmentId: "att-image-0001", kind: "image", filename: "photo-0001.png",
    contentType: "image/png", sizeBytes: 1677722, sha256: "1a2b3c4d" + "a".repeat(56),
    status: "uploaded", pointer: "/api/v1/sessions/room-test/attachments/att-image-0001",
  },
  {
    attachmentId: "att-file-0002", kind: "file", filename: "notes.txt",
    contentType: "text/plain", sizeBytes: 0, sha256: "b".repeat(64), status: "pending",
    pointer: { url: "https://store.invalid/private-file", opaque: "do-not-display" },
  },
];

function event(sessionId = "room-test", message = "See the files") {
  return {
    stream: "sl_event", event: "session_message", sessionId,
    sequenceId: 2, cursor: "c2", ts: "2026-11-02T12:00:00.000Z",
    agent: { id: "human-owner", model: "human" },
    payload: { message, attachments: structuredClone(attachments), to: "reader" },
  };
}

function assertVisible(text, sessionId = "room-test") {
  assert.match(text, /\[attachment: image photo-0001\.png, 1\.6 MB, sha256 1a2b3c4d…/);
  assert.match(text, /\[attachment: file notes\.txt, 0 B, sha256 bbbbbbbb…/);
  assert.match(text, /status pending/);
  assert.ok(text.includes(`sl session files get ${sessionId} att-image-0001`));
  assert.ok(text.includes(`sl session files get ${sessionId} att-file-0002`));
  assert.doesNotMatch(text, /https:\/\/store\.invalid|private-file|do-not-display/);
}

async function withSession(fn, message = "See the files") {
  const targetPath = await mkdtemp(path.join(os.tmpdir(), "sl-attachment-visibility-"));
  try {
    const session = await createSession({ targetPath });
    await appendToStream(session.sessionId, event(session.sessionId, message), { targetPath });
    return await fn(session.sessionId, targetPath);
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

for (const command of ["read", "status", "history"]) {
  test(`Attachment visibility: CLI ${command} preserves file metadata and fetch hints`, async () => {
    await withSession(async (sessionId, targetPath) => {
      const args = command === "history" ? [command] : [command, sessionId];
      const output = await cli([...args, "--path", targetPath]);
      assertVisible(output, sessionId);
      if (command === "read") {
        const json = JSON.parse(await cli([...args, "--path", targetPath, "--json"]));
        assert.deepEqual(json.events.find((item) => item.sequenceId === 2).payload.attachments, attachments);
      }
    });
  });
}

test("Attachment visibility: history preview retains attachment-only messages and untruncated markers", () => {
  for (const message of ["", "A long message ".repeat(80)]) {
    const preview = pickLatestPreview([event("room-test", message)]);
    assertVisible(preview.message);
    assert.equal((preview.message.match(/\[attachment:/g) || []).length, 2);
    assert.deepEqual(preview.attachments, attachments);
  }
});

test("Attachment visibility: CLI read JSON adds summary and preserves the original message", async () => {
  await withSession(async (sessionId, targetPath) => {
    const result = JSON.parse(await cli(["read", sessionId, "--path", targetPath, "--json"]));
    const message = result.events.find((item) => item.sequenceId === 2);
    assertVisible(message.attachmentSummary, sessionId);
    assert.equal(message.payload.message, "See the files");
    assert.deepEqual(message.payload.attachments, attachments);
  });
});

test("Attachment visibility: Markdown download includes attachment-only messages", () => {
  const { markdown } = buildTranscriptMarkdown({ sessionMeta: { sessionId: "room-test" }, events: [event("room-test", "")] });
  assertVisible(markdown);
});

test("Attachment visibility: pinned messages preserve attachment metadata and fetch hints", async () => {
  const result = await fetchSessionPinnedMessages("room-test", {
    listActions: async () => ({ ok: true, projection: { pinnedMessages: [{ targetSequenceId: 2 }] } }),
    fetchEventsBefore: async () => ({ ok: true, events: [event("room-test", "")] }),
  });
  assertVisible(result.pins[0].content);
  assert.deepEqual(result.pins[0].attachments, attachments);
});

test("Attachment visibility: recap activity includes attachments after body truncation", async () => {
  for (const message of ["", "A long message ".repeat(80)]) {
    await withSession(async (sessionId, targetPath) => {
      const result = await buildSessionRecap(sessionId, { targetPath, forAgentId: "reader" });
      assertVisible(result.text, sessionId);
    }, message);
  }
});

test("Attachment visibility: listen host wake retains markers after long message truncation", async () => {
  const messages = [];
  const wake = createListenerHostWake({
    host: "claude", resumeSessionId: "host-test", agentId: "reader", sessionId: "room-test",
    adapters: { claude: { wake: async (target) => { messages.push(target.message); return { ok: true }; } } },
  });
  await wake.trigger(event("room-test", "Long message ".repeat(500)));
  assert.equal(messages.length, 1);
  assertVisible(messages[0]);
});

for (const tool of ["read_history", "poll_inbox"]) {
  for (const includeRaw of [false, true]) {
    test(`Attachment visibility: MCP ${tool} includeRaw=${includeRaw} adds summary without changing payload`, async () => {
      const source = event();
      const before = structuredClone(source);
      const poll = async () => ({ ok: true, events: [source], cursor: "c2", hasMore: false });
      const handlers = createSessionMcpToolHandlers({
        pollSessionEventsFn: poll, pollSessionEventsBeforeFn: poll,
        updateSessionReadCursorFn: async () => ({ ok: true }),
      });
      const result = await handlers[tool]({
        sessionId: "room-test", agentId: "reader", includeRaw, includeActions: false,
      });
      assert.equal(result.ok, true);
      assert.equal(result.events.length, 1);
      assertVisible(result.events[0].attachmentSummary);
      assert.deepEqual(result.events[0].payload, source.payload);
      assert.deepEqual(source, before);
    });
  }
}

test("Attachment visibility: malformed optional metadata stays safe and keeps a discoverable marker", () => {
  const source = event();
  source.payload.attachments = [null, { filename: "https://store.invalid/private-file", pointer: "do-not-display" }];
  const preview = pickLatestPreview([source]);
  assert.match(preview.message, /\[attachment:/);
  assert.match(preview.message, /sl session files room-test/);
  assert.doesNotMatch(preview.message, /https:|private-file|do-not-display|NaN|undefined/);
});

test("Attachment visibility: edited message snapshots retain attachment summaries", async () => {
  const snapshot = { ...event(), id: "message-2", messageRevision: 2 };
  const edited = {
    ...event(), event: "session_message_edited", payload: {
      schema: "session-message-edit:v1", targetMessageId: snapshot.id, messageRevision: 2, event: snapshot,
    },
  };
  const handlers = createSessionMcpToolHandlers({
    pollSessionEventsBeforeFn: async () => ({ ok: true, events: [edited], hasMore: false }),
    updateSessionReadCursorFn: async () => ({ ok: true }),
  });
  const result = await handlers.read_history({ sessionId: "room-test", includeActions: false });
  assertVisible(result.events[0].attachmentSummary);
  assert.deepEqual(result.events[0].payload.event.payload.attachments, attachments);
});

test("Attachment visibility: unsafe metadata cannot supply secrets or executable fetch arguments", () => {
  const source = event();
  const syntheticSecret = "sk-" + "x".repeat(24);
  source.sessionId = "room; echo unsafe";
  source.payload.attachments = [{
    kind: syntheticSecret, filename: "\u001b[31mfile\nname.txt", status: syntheticSecret,
    attachmentId: syntheticSecret, pointer: "https://store.invalid/private-file",
  }];
  const preview = pickLatestPreview([source]);
  assert.match(preview.message, /\[attachment:/);
  assert.match(preview.message, /sl session files <sessionId>/);
  assert.ok(!preview.message.includes(syntheticSecret));
  assert.doesNotMatch(preview.message, /\u001b|\n|https:|echo unsafe/);
});

test("Attachment visibility: short attachment ids use file discovery instead of an invalid get command", () => {
  const source = event();
  source.payload.attachments = [{ filename: "pending.txt", attachmentId: "x" }];
  const preview = pickLatestPreview([source]);
  assert.match(preview.message, /\[attachment: file pending\.txt\]/);
  assert.match(preview.message, /sl session files room-test/);
  assert.doesNotMatch(preview.message, /files get/);
});
