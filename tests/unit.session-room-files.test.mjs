import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";

import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
import {
  SESSION_MCP_TOOLS,
  createSessionMcpToolHandlers,
  handleMcpJsonRpcMessage,
} from "../src/mcp/session-stdio-server.js";
import {
  RoomFileError,
  downloadRoomFile,
  listRoomFiles,
  requirePlainFileName,
} from "../src/session/room-files.js";
import { resetSessionSyncStateForTests } from "../src/session/sync.js";

// Shapes follow the API's room-file contract: a sent message publishes the files it references
// in payload.attachments; GET .../attachments/{id}?download=true answers with the attachment
// and a short-lived signed link on the file store.
const SESSION_ID = "room-files-test";
const API = "https://api.sentinelayer.com";
const STORE = "https://files.example.test";

function bytesOf(text) {
  return Buffer.from(text, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const REPORT = bytesOf(`# Review notes\n${"A finding per line.\n".repeat(400)}`);
const IMAGE = Buffer.from(Array.from({ length: 2048 }, (_, index) => index % 251));

function pointer(attachmentId, filename, bytes, extra = {}) {
  return {
    attachmentId,
    filename,
    kind: filename.endsWith(".png") ? "image" : "file",
    contentType: filename.endsWith(".png") ? "image/png" : "text/plain",
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
    status: "uploaded",
    summaryStatus: "not_applicable",
    uploadedBy: "human-owner",
    pointer: `/api/v1/sessions/${SESSION_ID}/attachments/${attachmentId}`,
    chunkCount: 0,
    disposition: "attachment",
    uploadedAt: "2026-10-31T14:04:05.123456+00:00",
    ...extra,
  };
}

function messageEvent(sequenceId, attachments, extra = {}) {
  return {
    event: "session_message",
    sessionId: SESSION_ID,
    cursor: `1790000000000:${sequenceId.toString(16).padStart(8, "0")}`,
    sequenceId,
    ts: `2026-10-31T14:05:${String(sequenceId % 60).padStart(2, "0")}.000000+00:00`,
    agent: { id: "human-owner" },
    payload: { message: `files ${sequenceId}`, channel: "session", source: "human", attachments },
    ...extra,
  };
}

const FILES = {
  "att-report-0001": { pointer: pointer("att-report-0001", "review-notes.md", REPORT), bytes: REPORT },
  "att-image-0002": { pointer: pointer("att-image-0002", "screen.png", IMAGE), bytes: IMAGE },
};

function downloadAnswer(attachmentId, { expiresAt = "2099-01-01T00:00:00Z", link = 1 } = {}) {
  return {
    ok: true,
    attachment: FILES[attachmentId].pointer,
    download: {
      url: `${STORE}/session-attachments/${attachmentId}/source?link=${link}&X-Amz-Signature=placeholder`,
      method: "GET",
      expiresIn: 3600,
      expiresAt,
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function headerValue(init = {}, name) {
  const headers = init.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

/**
 * A fake API and file store behind globalThis.fetch. `store` answers each signed-link request
 * (default: the file's bytes); `api` overrides the attachment read.
 */
function installFakeApi({ events = [], store = null, api = null } = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    calls.push({ url: target.toString(), init });
    if (target.origin === STORE) {
      const attachmentId = target.pathname.split("/")[2];
      if (store) return store({ attachmentId, target, init, calls });
      return new Response(FILES[attachmentId].bytes, { status: 200 });
    }
    if (target.pathname.endsWith("/events/before")) {
      const before = Number(target.searchParams.get("beforeSequence") || 0);
      const limit = Number(target.searchParams.get("limit") || 50);
      const older = events.filter((event) => !before || event.sequenceId < before);
      const page = older.slice(-limit);
      return jsonResponse({
        events: [...page].reverse(),
        count: page.length,
        next_before_sequence: page[0]?.sequenceId || null,
        has_more: older.length > page.length,
      });
    }
    const match = target.pathname.match(/\/api\/v1\/sessions\/([^/]+)\/attachments\/([^/]+)$/);
    if (match) {
      const attachmentId = decodeURIComponent(match[2]);
      if (api) return api({ attachmentId, target, init, calls });
      return FILES[attachmentId] ? jsonResponse(downloadAnswer(attachmentId)) : jsonResponse({ error: { code: "SESSION_NOT_FOUND" } }, 404);
    }
    return jsonResponse({}, 404);
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

async function withWorkspace(prefix, run) {
  resetSessionSyncStateForTests();
  const root = await mkdtemp(path.join(os.tmpdir(), `create-sentinelayer-${prefix}-`));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const previous = {
    SENTINELAYER_SKIP_REMOTE_SYNC: process.env.SENTINELAYER_SKIP_REMOTE_SYNC,
    SENTINELAYER_TOKEN: process.env.SENTINELAYER_TOKEN,
    SENTINELAYER_API_URL: process.env.SENTINELAYER_API_URL,
  };
  delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
  process.env.SENTINELAYER_TOKEN = "room-files-test-placeholder";
  process.env.SENTINELAYER_API_URL = API;
  try {
    await run({ root, workspace });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetSessionSyncStateForTests();
    await rm(root, { recursive: true, force: true });
  }
}

async function runSessionCommand(args = []) {
  const savedExitCode = process.exitCode;
  const program = new Command();
  program.name("sl").exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerSessionCommand(program);
  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.map((part) => String(part)).join(" "));
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    console.log = originalLog;
    process.exitCode = savedExitCode;
  }
  return logs.join("\n").trim();
}

async function leftoverTemporaryFiles(directory) {
  return (await readdir(directory)).filter((name) => name.endsWith(".part"));
}

// ---- listing --------------------------------------------------------------------------------

test("room files: listing collects published files newest first from the room history", async () => {
  await withWorkspace("room-files-list", async ({ workspace }) => {
    const events = [
      messageEvent(10, [FILES["att-report-0001"].pointer]),
      messageEvent(11, []),
      { ...messageEvent(12, []), event: "session_reaction" },
      messageEvent(13, [FILES["att-image-0002"].pointer, { attachmentId: "../bad", filename: "x", sizeBytes: 1 }]),
    ];
    const fake = installFakeApi({ events });
    try {
      const result = await listRoomFiles(SESSION_ID, { targetPath: workspace });
      assert.equal(result.ok, true);
      assert.deepEqual(result.files.map((file) => file.attachmentId), ["att-image-0002", "att-report-0001"]);
      assert.equal(result.complete, true);
      assert.equal(result.skippedPointers, 1);
      const image = result.files[0];
      assert.equal(image.filename, "screen.png");
      assert.equal(image.sizeBytes, IMAGE.length);
      assert.equal(image.contentType, "image/png");
      assert.equal(image.uploadedBy, "human-owner");
      assert.equal(image.uploadedAt, "2026-10-31T14:04:05.123456+00:00");
      assert.equal(image.publishedSequenceId, 13);
      assert.equal(image.sha256, sha256(IMAGE));
    } finally {
      fake.restore();
    }
  });
});

test("room files: listing pages back through history and stops at the limit", async () => {
  await withWorkspace("room-files-pages", async ({ workspace }) => {
    const events = [];
    for (let sequenceId = 1; sequenceId <= 450; sequenceId += 1) {
      const id = `att-page-${String(sequenceId).padStart(4, "0")}`;
      FILES[id] = { pointer: pointer(id, `page-${sequenceId}.md`, REPORT), bytes: REPORT };
      events.push(messageEvent(sequenceId, sequenceId % 50 === 0 ? [FILES[id].pointer] : []));
    }
    const fake = installFakeApi({ events });
    try {
      const all = await listRoomFiles(SESSION_ID, { targetPath: workspace });
      assert.equal(all.count, 9);
      assert.equal(all.complete, true);
      assert.equal(all.pages, 3);
      assert.equal(all.files[0].publishedSequenceId, 450);
      assert.equal(all.files[8].publishedSequenceId, 50);

      const few = await listRoomFiles(SESSION_ID, { targetPath: workspace, limit: 2 });
      assert.deepEqual(few.files.map((file) => file.publishedSequenceId), [450, 400]);
      assert.equal(few.complete, false);
    } finally {
      fake.restore();
    }
  });
});

test("room files: sl session files lists name, size, type, uploader, time and attachment id", async () => {
  await withWorkspace("room-files-cli-list", async ({ workspace }) => {
    const fake = installFakeApi({ events: [messageEvent(21, [FILES["att-report-0001"].pointer])] });
    try {
      const json = JSON.parse(await runSessionCommand(["session", "files", SESSION_ID, "--path", workspace, "--json"]));
      assert.equal(json.command, "session files");
      assert.equal(json.count, 1);
      assert.equal(json.files[0].attachmentId, "att-report-0001");

      const text = await runSessionCommand(["session", "files", SESSION_ID, "--path", workspace]);
      assert.match(text, /review-notes\.md {2}\d+(\.\d)? KB {2}text\/plain by human-owner 2026-10-31T14:04:05\.123456\+00:00 in #21/);
      assert.match(text, /attachment id att-report-0001/);
      assert.match(text, /sl session files get room-files-test <attachmentId>/);
    } finally {
      fake.restore();
    }
  });
});

// ---- downloading ------------------------------------------------------------------------------

test("room files: get streams the file to disk, verifies its sha256 and sends no API credential to the store", async () => {
  await withWorkspace("room-files-get", async ({ workspace }) => {
    const fake = installFakeApi();
    try {
      const output = await runSessionCommand([
        "session", "files", "get", SESSION_ID, "att-report-0001", "--path", workspace, "--json",
      ]);
      const payload = JSON.parse(output);
      assert.equal(payload.path, path.join(await realDirectory(workspace), "review-notes.md"));
      assert.equal(payload.bytes, REPORT.length);
      assert.equal(payload.sha256, sha256(REPORT));
      assert.equal(payload.verified, true);
      assert.equal(payload.overwritten, false);
      assert.deepEqual(await readFile(payload.path), REPORT);
      assert.deepEqual(await leftoverTemporaryFiles(workspace), []);

      const apiCall = fake.calls.find((call) => call.url.startsWith(API));
      assert.match(apiCall.url, /\/api\/v1\/sessions\/room-files-test\/attachments\/att-report-0001\?download=true$/);
      assert.ok(headerValue(apiCall.init, "authorization"), "the API read carries the user credential");
      const storeCall = fake.calls.find((call) => call.url.startsWith(STORE));
      assert.equal(headerValue(storeCall.init, "authorization"), null, "the signed link is fetched without credentials");
      assert.equal(storeCall.init.redirect, "error");
      assert.equal(JSON.stringify(payload).includes("X-Amz-Signature"), false, "the signed link is not echoed");
    } finally {
      fake.restore();
    }
  });
});

async function realDirectory(directory) {
  const { realpath } = await import("node:fs/promises");
  return realpath(directory);
}

test("room files: --out may name a file or an existing directory inside the workspace", async () => {
  await withWorkspace("room-files-out", async ({ workspace }) => {
    await mkdir(path.join(workspace, "downloads"));
    const fake = installFakeApi();
    try {
      const named = await downloadRoomFile(SESSION_ID, "att-report-0001", { targetPath: workspace, out: "notes-copy.md" });
      assert.equal(named.path, path.join(await realDirectory(workspace), "notes-copy.md"));
      assert.deepEqual(await readFile(named.path), REPORT);

      const intoDirectory = await downloadRoomFile(SESSION_ID, "att-image-0002", { targetPath: workspace, out: "downloads" });
      assert.equal(intoDirectory.path, path.join(await realDirectory(workspace), "downloads", "screen.png"));
      assert.deepEqual(await readFile(intoDirectory.path), IMAGE);
    } finally {
      fake.restore();
    }
  });
});

test("room files: an existing file is kept unless --force, and --force replaces it whole", async () => {
  await withWorkspace("room-files-force", async ({ workspace }) => {
    const existing = path.join(workspace, "review-notes.md");
    await writeFile(existing, "my local edits", "utf-8");
    const fake = installFakeApi();
    try {
      await assert.rejects(
        () => runSessionCommand(["session", "files", "get", SESSION_ID, "att-report-0001", "--path", workspace]),
        /review-notes\.md already exists; pass --force to overwrite it\./,
      );
      assert.equal(await readFile(existing, "utf-8"), "my local edits");
      assert.equal(fake.calls.some((call) => call.url.startsWith(STORE)), false, "nothing is downloaded before the check");

      const forced = await downloadRoomFile(SESSION_ID, "att-report-0001", { targetPath: workspace, force: true });
      assert.equal(forced.overwritten, true);
      assert.deepEqual(await readFile(existing), REPORT);
      assert.deepEqual(await leftoverTemporaryFiles(workspace), []);
    } finally {
      fake.restore();
    }
  });
});

test("room files: path traversal in --out or in the server's file name is refused", async () => {
  await withWorkspace("room-files-traversal", async ({ root, workspace }) => {
    const fake = installFakeApi({
      api: ({ attachmentId }) => {
        const answer = downloadAnswer("att-report-0001");
        if (attachmentId === "att-evil-name-01") {
          return jsonResponse({ ...answer, attachment: { ...answer.attachment, attachmentId, filename: "../../evil.md" } });
        }
        return jsonResponse(answer);
      },
    });
    try {
      await assert.rejects(
        () => downloadRoomFile(SESSION_ID, "att-report-0001", { targetPath: workspace, out: "../outside.md" }),
        (error) => error instanceof RoomFileError && error.code === "out_outside_workspace",
      );
      await assert.rejects(
        () => downloadRoomFile(SESSION_ID, "att-evil-name-01", { targetPath: workspace }),
        (error) => error instanceof RoomFileError && error.code === "unsafe_file_name",
      );
      await assert.rejects(
        () => downloadRoomFile(SESSION_ID, "att-report-0001", { targetPath: workspace, out: path.join(root, "abs.md"), workspaceOnly: true }),
        (error) => error instanceof RoomFileError && error.code === "out_outside_workspace",
      );
      assert.equal(fake.calls.some((call) => call.url.startsWith(STORE)), false);
      assert.deepEqual((await readdir(root)).sort(), ["workspace"]);
      for (const name of ["..", ".", "a/b", "a\\b", "C:evil", "nul", "COM1.txt", "trailing.", " padded", "x".repeat(256)]) {
        assert.throws(() => requirePlainFileName(name), RoomFileError, name);
      }
      assert.equal(requirePlainFileName("review notes-v2.final.md"), "review notes-v2.final.md");
    } finally {
      fake.restore();
    }
  });
});

test("room files: a link out of the workspace is refused for a relative --out", async (t) => {
  await withWorkspace("room-files-link", async ({ root, workspace }) => {
    const outside = path.join(root, "outside");
    await mkdir(outside);
    try {
      await symlink(outside, path.join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`cannot create a directory link here (${error.code})`);
      return;
    }
    const fake = installFakeApi();
    try {
      await assert.rejects(
        () => downloadRoomFile(SESSION_ID, "att-report-0001", { targetPath: workspace, out: "escape/notes.md" }),
        (error) => error instanceof RoomFileError && error.code === "out_outside_workspace",
      );
      assert.deepEqual(await readdir(outside), []);
    } finally {
      fake.restore();
    }
  });
});

test("room files: a checksum mismatch saves nothing and leaves no partial file", async () => {
  await withWorkspace("room-files-checksum", async ({ workspace }) => {
    const tampered = Buffer.from(REPORT);
    tampered[10] ^= 0xff;
    const fake = installFakeApi({ store: () => new Response(tampered, { status: 200 }) });
    try {
      await assert.rejects(
        () => runSessionCommand(["session", "files", "get", SESSION_ID, "att-report-0001", "--path", workspace]),
        /does not match the server's checksum .*Nothing was saved\./,
      );
      assert.deepEqual(await readdir(workspace), []);
    } finally {
      fake.restore();
    }
  });
});

test("room files: a failed forced download leaves the existing file untouched", async () => {
  await withWorkspace("room-files-atomic", async ({ workspace }) => {
    const existing = path.join(workspace, "review-notes.md");
    await writeFile(existing, "my local edits", "utf-8");
    const tampered = Buffer.from(REPORT);
    tampered[0] ^= 0xff;
    const fake = installFakeApi({ store: () => new Response(tampered, { status: 200 }) });
    try {
      await assert.rejects(
        () => downloadRoomFile(SESSION_ID, "att-report-0001", { targetPath: workspace, force: true }),
        (error) => error instanceof RoomFileError && error.code === "checksum_mismatch",
      );
      assert.equal(await readFile(existing, "utf-8"), "my local edits");
      assert.deepEqual(await readdir(workspace), ["review-notes.md"]);
    } finally {
      fake.restore();
    }
  });
});

test("room files: a download longer than the reported size is stopped and not saved", async () => {
  await withWorkspace("room-files-size", async ({ workspace }) => {
    const fake = installFakeApi({ store: () => new Response(Buffer.concat([REPORT, bytesOf("extra")]), { status: 200 }) });
    try {
      await assert.rejects(
        () => downloadRoomFile(SESSION_ID, "att-report-0001", { targetPath: workspace }),
        (error) => error instanceof RoomFileError && error.code === "size_mismatch",
      );
      assert.deepEqual(await readdir(workspace), []);
    } finally {
      fake.restore();
    }
  });
});

test("room files: an expired link is fetched again once, then the download succeeds", async () => {
  await withWorkspace("room-files-expired", async ({ workspace }) => {
    let reads = 0;
    const fake = installFakeApi({
      api: ({ attachmentId }) => {
        reads += 1;
        return jsonResponse(downloadAnswer(attachmentId, { link: reads }));
      },
      store: ({ attachmentId, target }) =>
        target.searchParams.get("link") === "1"
          ? new Response("<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>", { status: 403 })
          : new Response(FILES[attachmentId].bytes, { status: 200 }),
    });
    try {
      const result = await downloadRoomFile(SESSION_ID, "att-report-0001", { targetPath: workspace });
      assert.equal(result.linkRefetched, true);
      assert.equal(reads, 2);
      assert.deepEqual(await readFile(result.path), REPORT);
    } finally {
      fake.restore();
    }
  });
});

test("room files: a link refused twice gives a clear error", async () => {
  await withWorkspace("room-files-expired-twice", async ({ workspace }) => {
    let reads = 0;
    const fake = installFakeApi({
      api: ({ attachmentId }) => {
        reads += 1;
        return jsonResponse(downloadAnswer(attachmentId, { link: reads }));
      },
      store: () => new Response("expired", { status: 403 }),
    });
    try {
      await assert.rejects(
        () => downloadRoomFile(SESSION_ID, "att-report-0001", { targetPath: workspace }),
        (error) => error instanceof RoomFileError && error.code === "link_expired" && /even after a fresh link/.test(error.message),
      );
      assert.equal(reads, 2, "the link is fetched again exactly once");
      assert.deepEqual(await readdir(workspace), []);
    } finally {
      fake.restore();
    }
  });
});

test("room files: a link already past its expiry is replaced before downloading", async () => {
  await withWorkspace("room-files-stale", async ({ workspace }) => {
    let reads = 0;
    const fake = installFakeApi({
      api: ({ attachmentId }) => {
        reads += 1;
        return jsonResponse(downloadAnswer(attachmentId, { link: reads, expiresAt: reads === 1 ? "2020-01-01T00:00:00Z" : "2099-01-01T00:00:00Z" }));
      },
    });
    try {
      const result = await downloadRoomFile(SESSION_ID, "att-report-0001", { targetPath: workspace });
      assert.equal(result.linkRefetched, true);
      const storeCalls = fake.calls.filter((call) => call.url.startsWith(STORE));
      assert.equal(storeCalls.length, 1);
      assert.match(storeCalls[0].url, /link=2/);
    } finally {
      fake.restore();
    }
  });
});

test("room files: API refusals become clear errors", async () => {
  await withWorkspace("room-files-errors", async ({ workspace }) => {
    const cases = [
      [404, "SESSION_NOT_FOUND", "not_found", /not found in room room-files-test\. A file is visible to the room once a sent message references it/],
      [403, "SESSION_FORBIDDEN", "forbidden", /not a member/],
      [401, "INVALID_TOKEN", "unauthorized", /needs your user login/],
      [409, "ATTACHMENT_NOT_READY", "not_ready", /not complete yet/],
      [503, "ATTACHMENT_STORAGE_UNAVAILABLE", "storage_unavailable", /file store is unavailable/],
    ];
    for (const [status, apiCode, code, message] of cases) {
      const fake = installFakeApi({ api: () => jsonResponse({ error: { code: apiCode, message: "refused" } }, status) });
      try {
        await assert.rejects(
          () => downloadRoomFile(SESSION_ID, "att-report-0001", { targetPath: workspace }),
          (error) => error instanceof RoomFileError && error.code === code && message.test(error.message),
          `HTTP ${status}`,
        );
      } finally {
        fake.restore();
      }
    }
    await assert.rejects(
      () => downloadRoomFile(SESSION_ID, "../../etc", { targetPath: workspace }),
      (error) => error instanceof RoomFileError && error.code === "invalid_attachment_id",
    );
  });
});

// ---- MCP --------------------------------------------------------------------------------------

async function callTool(handlers, name, args) {
  const response = await handleMcpJsonRpcMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    { handlers, tools: SESSION_MCP_TOOLS },
  );
  return { response, text: response.result.content[0].text, result: JSON.parse(response.result.content[0].text) };
}

test("room files: MCP session_files_list and session_file_get save into the workspace and never return bytes", async () => {
  await withWorkspace("room-files-mcp", async ({ workspace }) => {
    const fake = installFakeApi({ events: [messageEvent(31, [FILES["att-report-0001"].pointer])] });
    try {
      const handlers = createSessionMcpToolHandlers({ targetPath: workspace });
      const listed = await callTool(handlers, "session_files_list", { sessionId: SESSION_ID });
      assert.equal(listed.result.ok, true);
      assert.equal(listed.result.files[0].attachmentId, "att-report-0001");

      const got = await callTool(handlers, "session_file_get", { sessionId: SESSION_ID, attachmentId: "att-report-0001" });
      assert.equal(got.result.ok, true);
      assert.equal(got.result.path, path.join(await realDirectory(workspace), "review-notes.md"));
      assert.equal(got.result.sha256, sha256(REPORT));
      assert.equal(got.result.attachment.filename, "review-notes.md");
      assert.deepEqual(await readFile(got.result.path), REPORT);
      assert.equal(got.text.includes("A finding per line."), false, "the file content is not returned inline");

      const again = await callTool(handlers, "session_file_get", { sessionId: SESSION_ID, attachmentId: "att-report-0001" });
      assert.equal(again.result.ok, false);
      assert.equal(again.result.reason, "destination_exists");

      const absolute = await callTool(handlers, "session_file_get", {
        sessionId: SESSION_ID,
        attachmentId: "att-report-0001",
        out: path.join(os.tmpdir(), "elsewhere.md"),
        force: true,
      });
      assert.equal(absolute.result.ok, false);
      assert.equal(absolute.result.reason, "out_outside_workspace");

      const tools = new Set(SESSION_MCP_TOOLS.map((tool) => tool.name));
      assert.equal(tools.has("session_files_list"), true);
      assert.equal(tools.has("session_file_get"), true);
    } finally {
      fake.restore();
    }
  });
});
