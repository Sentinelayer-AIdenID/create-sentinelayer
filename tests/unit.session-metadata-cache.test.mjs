import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fsp, { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { Command } from "commander";
import { admittedAgentScope } from "../src/auth/admission-scope.js";

import { registerSessionCommand } from "../src/commands/session.js";
import { buildCliCommandMcpTools, createCliCommandMcpToolHandlers } from "../src/mcp/cli-command-tools.js";
import {
  cacheRemoteSessionMetadata, listOfflineSessionMetadata,
  readOfflineSessionMetadata, resolveSessionMetadataContext,
} from "../src/session/metadata-cache.js";
import {
  createSession, getSession, recordSessionProvisionedIdentities,
  recordSessionRemoteTitleSync, updateSessionTitle,
} from "../src/session/store.js";
import { resetSessionSyncStateForTests } from "../src/session/sync.js";

const API = "http://127.0.0.1:18091";
const ROOM = "room-title-test";
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});

async function fixture(t, { local = true } = {}) {
  const targetPath = await mkdtemp(path.join(os.tmpdir(), "sl-session-metadata-"));
  const env = { ...process.env };
  const originalFetch = globalThis.fetch;
  const exitCode = process.exitCode;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    process.exitCode = exitCode;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await rm(targetPath, { recursive: true, force: true });
  });
  process.env.SENTINELAYER_API_URL = API;
  process.env.SENTINELAYER_TOKEN = ["test", "metadata", "credential"].join("-");
  delete process.env.SENTINELAYER_AGENT_ID;
  resetSessionSyncStateForTests();
  if (local) await createSession({ targetPath, sessionId: ROOM, title: "Stale title" });
  return targetPath;
}

async function cli(targetPath, args) {
  const program = new Command().name("sl").exitOverride()
    .configureOutput({ writeOut() {}, writeErr() {} });
  registerSessionCommand(program);
  const original = console.log;
  const originalWarn = console.warn;
  const lines = [];
  const warnings = [];
  const exitCode = process.exitCode;
  process.exitCode = 0;
  console.log = (...parts) => lines.push(parts.join(" "));
  console.warn = (...parts) => warnings.push(parts.join(" "));
  try {
    await program.parseAsync(["session", ...args, "--path", targetPath], { from: "user" });
    return { output: lines.join("\n"), stderr: warnings.join("\n"), code: process.exitCode || 0 };
  } finally {
    console.log = original;
    console.warn = originalWarn;
    process.exitCode = exitCode;
  }
}

function contextFor(targetPath, userId = "account-a", apiUrl = API) {
  return resolveSessionMetadataContext({
    targetPath, resolveAuthSession: async () => ({ apiUrl, user: userId ? { id: userId } : null }),
  });
}

test("session list reads all server pages by default, caches renames, and excludes local-only rooms", async (t) => {
  const targetPath = await fixture(t);
  await createSession({ targetPath, sessionId: "local-only", title: "Old account room" });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, method: init.method });
    return parsed.searchParams.has("cursor")
      ? json({ sessions: [{ sessionId: "other-room", title: "Same title", status: "active" }] })
      : json({ sessions: [{ sessionId: ROOM, title: "Same title", status: "active" }], next_cursor: "page-2", has_more: true });
  };
  const result = JSON.parse((await cli(targetPath, ["list", "--json"])).output);
  assert.equal(result.source, "remote");
  assert.equal(result.ok, true);
  assert.deepEqual(result.sessions.map((row) => row.sessionId), [ROOM, "other-room"]);
  assert.deepEqual(result.cache, {
    ok: true, refreshed: 1, skipped: 1, pruned: 0, superseded: 0, failed: 0,
    reason: "stable_account_id_unavailable", errors: [],
  });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.method === "GET" && request.url.searchParams.get("limit") === "200"));
  assert.equal(requests[1].url.searchParams.get("cursor"), "page-2");
  globalThis.fetch = () => assert.fail("offline list must not contact the API");
  const offline = JSON.parse((await cli(targetPath, ["list", "--offline", "--json"])).output);
  assert.equal(offline.source, "local");
  assert.equal(offline.sessions.find((row) => row.sessionId === ROOM).title, "Same title");
  assert.equal(offline.sessions.some((row) => row.sessionId === "other-room"), false);
  assert.match((await cli(targetPath, ["list", "--offline"])).output, /Same title.*\(cached\)/);
});

test("session status reads the server on every call, clears empty titles, and stays fully offline when requested", async (t) => {
  const targetPath = await fixture(t);
  let title = "Renamed on web";
  let reads = 0;
  globalThis.fetch = async (url) => {
    if (new URL(url).pathname === `/api/v1/sessions/${ROOM}`) {
      reads += 1;
      return json({ session: { sessionId: ROOM, title, status: "active" } });
    }
    return json({}, 403);
  };
  for (const nextTitle of ["Renamed on web", null, "", "Renamed again"]) {
    title = nextTitle;
    const result = JSON.parse((await cli(targetPath, ["status", ROOM, "--json"])).output);
    assert.equal(result.source, "remote");
    assert.equal(result.session.title, title);
    assert.equal(result.cache.refreshed, 1);
    const original = globalThis.fetch;
    globalThis.fetch = () => assert.fail("offline status must not read metadata, presence, or file leases");
    const offline = JSON.parse((await cli(targetPath, ["status", ROOM, "--offline", "--json"])).output);
    assert.equal(offline.session.title, title || null);
    assert.equal(offline.listenerPresence.authoritative, false);
    assert.equal(offline.listenerPresence.reason, "offline");
    assert.equal(offline.fileLeaseAuthority.authoritative, false);
    assert.equal(offline.fileLeaseAuthority.error.code, "OFFLINE");
    globalThis.fetch = original;
  }
  assert.equal(reads, 4);
  const text = (await cli(targetPath, ["status", ROOM])).output;
  assert.match(text, /title="Renamed again"/);
});

for (const failure of [401, 403, 404, "transport"]) {
  test(`metadata reads fail explicitly on ${failure} without returning or refreshing stale titles`, async (t) => {
    const targetPath = await fixture(t);
    const context = await resolveSessionMetadataContext({ targetPath });
    await cacheRemoteSessionMetadata([{ sessionId: ROOM, title: "Previously read" }], { targetPath, context });
    const cacheFile = path.join(context.cacheDir, `${ROOM}.json`);
    const before = await readFile(cacheFile, "utf8");
    globalThis.fetch = async () => {
      if (failure === "transport") throw new Error("fixture transport failure");
      return json({}, failure);
    };
    for (const args of [["list"], ["status", ROOM]]) {
      const result = await cli(targetPath, [...args, "--json"]);
      assert.equal(result.code, 1);
      const payload = JSON.parse(result.output);
      assert.equal(payload.ok, false);
      assert.doesNotMatch(result.output, /Stale title|Previously read/);
      assert.equal(await readFile(cacheFile, "utf8"), before);
    }
  });
}

test("missing authentication and malformed successful responses never refresh the cache", async (t) => {
  const targetPath = await fixture(t);
  delete process.env.SENTINELAYER_TOKEN;
  globalThis.fetch = () => assert.fail("missing authentication must not contact the API");
  assert.equal(JSON.parse((await cli(targetPath, ["list", "--json"])).output).ok, false);
  process.env.SENTINELAYER_TOKEN = ["test", "metadata", "credential"].join("-");
  for (const body of [{ sessionId: ROOM }, { sessionId: "wrong-room", title: "Wrong title" }]) {
    globalThis.fetch = async () => json(body);
    await assert.rejects(cli(targetPath, ["status", ROOM, "--json"]), /cache was not refreshed/);
  }
  globalThis.fetch = async () => json({});
  const malformedList = JSON.parse((await cli(targetPath, ["list", "--json"])).output);
  assert.equal(malformedList.ok, false);
  assert.equal(malformedList.reason, "invalid_session_list_response");
  assert.equal((await getSession(ROOM, { targetPath })).title, "Stale title");
  await assert.rejects(cli(targetPath, ["list", "--remote", "--offline"]), /Use only one/);
});

test("server-only cache membership is isolated by stable account, API base, and workspace", async (t) => {
  const targetPath = await fixture(t, { local: false });
  const context = await contextFor(targetPath);
  await cacheRemoteSessionMetadata([{ sessionId: ROOM, title: "Account A room", status: "active" }], { targetPath, context });
  assert.equal((await listOfflineSessionMetadata({ targetPath, context }))[0].title, "Account A room");
  for (const other of [await contextFor(targetPath, "account-b"), await contextFor(targetPath, "account-a", "http://127.0.0.1:18092"), await contextFor(targetPath, "")]) {
    assert.deepEqual(await listOfflineSessionMetadata({ targetPath, context: other }), []);
    assert.equal(await readOfflineSessionMetadata(ROOM, { targetPath, context: other }), null);
  }
  assert.equal((await contextFor(targetPath, "account-a", `${API}/`)).cacheDir, context.cacheDir);
  const otherWorkspace = await mkdtemp(path.join(os.tmpdir(), "sl-other-workspace-"));
  t.after(() => rm(otherWorkspace, { recursive: true, force: true }));
  const otherContext = await contextFor(otherWorkspace);
  assert.notEqual(otherContext.cacheDir, context.cacheDir);
  assert.deepEqual(await listOfflineSessionMetadata({ targetPath: otherWorkspace, context: otherContext }), []);
  assert.equal(context.cacheDir.startsWith(path.join(os.homedir(), ".sentinelayer", "session-metadata-cache") + path.sep), true);
  assert.equal(context.cacheDir.startsWith(targetPath + path.sep), false);
  assert.equal(await getSession(ROOM, { targetPath }), null, "reading membership never creates global local metadata");
});

test("metadata reads capture auth once without rotating stored tokens online or offline", async (t) => {
  const targetPath = await fixture(t);
  for (const offline of [false, true]) {
    let calls = 0;
    await resolveSessionMetadataContext({ targetPath, offline, resolveAuthSession: async (options) => {
      calls += 1;
      assert.equal(options.autoRotate, false);
      return { apiUrl: API, user: { id: "account-a" } };
    } });
    assert.equal(calls, 1);
  }
});

test("transient cache rename failures are retried, with private files and no temporary residue", async (t) => {
  const targetPath = await fixture(t);
  const context = await contextFor(targetPath);
  const originalRename = fsp.rename;
  const originalWrite = fsp.writeFile;
  const originalOpen = fsp.open;
  let attempts = 0;
  const modes = [];
  const locks = [];
  t.mock.method(fsp, "open", async (filename, flags, mode) => {
    locks.push({ flags, mode });
    return originalOpen(filename, flags, mode);
  });
  t.mock.method(fsp, "rename", async (...args) => {
    if (attempts++ < 2) throw Object.assign(new Error("fixture transient rename"), { code: "EPERM" });
    return originalRename(...args);
  });
  t.mock.method(fsp, "writeFile", async (filename, data, options) => {
    modes.push({ mode: options.mode, flag: options.flag });
    return originalWrite(filename, data, options);
  });
  const result = await cacheRemoteSessionMetadata([{ sessionId: ROOM, title: "Server title" }], { targetPath, context });
  assert.equal(result.ok, true);
  assert.equal(attempts, 3);
  assert.deepEqual(modes, [{ mode: 0o600, flag: "wx" }]);
  assert.deepEqual(locks, [{ mode: 0o600, flags: "wx" }]);
  const filename = path.join(context.cacheDir, `${ROOM}.json`);
  if (process.platform !== "win32") assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(filename, "utf8")).session.title, "Server title");
  assert.equal((await readdir(context.cacheDir)).some((name) => name.endsWith(".tmp")), false);
});

test("an older response waiting to commit cannot overwrite a newer server title", { timeout: 5_000 }, async (t) => {
  const targetPath = await fixture(t);
  const context = await contextFor(targetPath);
  const originalOpen = fsp.open;
  let releaseOlder;
  let olderReached;
  const blocked = new Promise((resolve) => { releaseOlder = resolve; });
  const reached = new Promise((resolve) => { olderReached = resolve; });
  t.after(() => releaseOlder());
  let first = true;
  t.mock.method(fsp, "open", async (...args) => {
    if (first) {
      first = false;
      olderReached();
      await blocked;
    }
    return originalOpen(...args);
  });
  const older = cacheRemoteSessionMetadata([{ sessionId: ROOM, title: "Older response" }], {
    targetPath, context, requestedAt: "2026-01-01T00:00:00Z",
  });
  await reached;
  await cacheRemoteSessionMetadata([{ sessionId: ROOM, title: "Newer response" }], {
    targetPath, context, requestedAt: "2026-01-02T00:00:00Z",
  });
  releaseOlder();
  const result = await older;
  assert.equal(result.ok, true);
  assert.equal(result.superseded, 1);
  assert.equal((await readOfflineSessionMetadata(ROOM, { targetPath, context })).title, "Newer response");
});

test("pruning cannot delete a newer status publication between its timestamp check and unlink", { timeout: 5_000 }, async (t) => {
  const targetPath = await fixture(t);
  const context = await contextFor(targetPath);
  await cacheRemoteSessionMetadata([{ sessionId: ROOM, title: "Old room" }], {
    targetPath, context, requestedAt: "2026-01-01T00:00:00Z",
  });
  const originalRm = fsp.rm;
  const originalOpen = fsp.open;
  let permitDelete;
  let deleteReached;
  let statusAttempted;
  const deleting = new Promise((resolve) => { deleteReached = resolve; });
  const blocked = new Promise((resolve) => { permitDelete = resolve; });
  const attempting = new Promise((resolve) => { statusAttempted = resolve; });
  t.after(() => permitDelete());
  let deletingRoom = false;
  t.mock.method(fsp, "rm", async (filename, options) => {
    if (filename === path.join(context.cacheDir, `${ROOM}.json`)) {
      deletingRoom = true;
      deleteReached();
      await blocked;
    }
    return originalRm(filename, options);
  });
  t.mock.method(fsp, "open", async (...args) => {
    if (deletingRoom) statusAttempted();
    return originalOpen(...args);
  });
  const prune = cacheRemoteSessionMetadata([], {
    targetPath, context, completeList: true, requestedAt: "2026-01-02T00:00:00Z",
  });
  await deleting;
  const status = cacheRemoteSessionMetadata([{ sessionId: ROOM, title: "Restored by newer status" }], {
    targetPath, context, requestedAt: "2026-01-03T00:00:00Z",
  });
  // With the old unlocked implementation status publishes before deletion;
  // with the mutex it reaches the lock and waits until pruning has committed.
  await Promise.race([attempting, status]);
  permitDelete();
  assert.equal((await prune).ok, true);
  assert.equal((await status).ok, true);
  assert.equal((await readOfflineSessionMetadata(ROOM, { targetPath, context })).title, "Restored by newer status");
});

test("equal request stamps preserve the committed title or catalog decision", async (t) => {
  const targetPath = await fixture(t, { local: false });
  const context = await contextFor(targetPath);
  const requestedAt = "2026-01-02T00:00:00.000Z";
  await cacheRemoteSessionMetadata([{ sessionId: ROOM, title: "First publication" }], { targetPath, context, requestedAt });
  const delayed = await cacheRemoteSessionMetadata([{ sessionId: ROOM, title: "Late same-stamp response" }], { targetPath, context, requestedAt });
  assert.equal(delayed.superseded, 1);
  await cacheRemoteSessionMetadata([], { targetPath, context, requestedAt, completeList: true });
  assert.equal((await readOfflineSessionMetadata(ROOM, { targetPath, context })).title, "First publication");
  const absent = await cacheRemoteSessionMetadata([{ sessionId: "missing-room", title: "Late missing membership" }], {
    targetPath, context, requestedAt,
  });
  assert.equal(absent.superseded, 1);
  assert.equal(await readOfflineSessionMetadata("missing-room", { targetPath, context }), null);
});

for (const previouslyCached of [false, true]) {
  test(`a newer complete catalog fences a delayed old status after ${previouslyCached ? "tombstone cleanup" : "an empty first list"}`, { timeout: 5_000 }, async (t) => {
    const targetPath = await fixture(t, { local: false });
    const context = await contextFor(targetPath);
    if (previouslyCached) {
      await cacheRemoteSessionMetadata([{ sessionId: ROOM, title: "Previous membership" }], {
        targetPath, context, requestedAt: "2026-01-01T00:00:00Z",
      });
      await cacheRemoteSessionMetadata([], {
        targetPath, context, completeList: true, requestedAt: "2026-01-02T00:00:00Z",
      });
    }
    const originalOpen = fsp.open;
    let releaseStatus;
    let statusReached;
    const held = new Promise((resolve) => { releaseStatus = resolve; });
    const reached = new Promise((resolve) => { statusReached = resolve; });
    t.after(() => releaseStatus());
    let first = true;
    t.mock.method(fsp, "open", async (...args) => {
      if (first) {
        first = false;
        statusReached();
        await held;
      }
      return originalOpen(...args);
    });
    const oldStatus = cacheRemoteSessionMetadata([{ sessionId: ROOM, title: "Stale membership" }], {
      targetPath, context, requestedAt: "2026-01-01T12:00:00Z",
    });
    await reached;
    await cacheRemoteSessionMetadata([], {
      targetPath, context, completeList: true, requestedAt: "2026-01-03T00:00:00Z",
    });
    assert.deepEqual(JSON.parse(await readFile(path.join(context.cacheDir, ".list-exclusions.json"), "utf8")).sessionIds, []);
    releaseStatus();
    assert.equal((await oldStatus).superseded, 1);
    assert.equal(await readOfflineSessionMetadata(ROOM, { targetPath, context }), null);
    assert.deepEqual(await listOfflineSessionMetadata({ targetPath, context }), []);
  });
}

test("a held cache lock times out without stealing ownership or failing the server read", { timeout: 5_000 }, async (t) => {
  const targetPath = await fixture(t);
  const context = await resolveSessionMetadataContext({ targetPath });
  await fsp.mkdir(context.cacheDir, { recursive: true });
  const lockPath = path.join(context.cacheDir, ".refresh.lock");
  const holder = await fsp.open(lockPath, "wx", 0o600);
  await holder.writeFile("fixture owner");
  t.after(async () => { await holder.close(); await rm(lockPath, { force: true }); });
  globalThis.fetch = async () => json({ sessions: [{ sessionId: ROOM, title: "Fresh while locked" }], has_more: false });
  const started = performance.now();
  const result = await cli(targetPath, ["list", "--json"]);
  assert.ok(performance.now() - started < 3_500, "cache contention must remain bounded");
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.output);
  assert.equal(payload.ok, true);
  assert.equal(payload.sessions[0].title, "Fresh while locked");
  assert.equal(payload.cache.ok, false);
  assert.deepEqual(payload.cache.errors, [{ sessionId: null, code: "CACHE_LOCK_TIMEOUT" }]);
  assert.match(result.stderr, /Server read succeeded.*CACHE_LOCK_TIMEOUT/);
  assert.equal(await readFile(lockPath, "utf8"), "fixture owner");
});

for (const code of ["EPERM", "EACCES"]) {
  test(`successful server reads survive ${code} cache failures and warn only on stderr`, async (t) => {
    const targetPath = await fixture(t);
    const context = await resolveSessionMetadataContext({ targetPath });
    await cacheRemoteSessionMetadata([{ sessionId: ROOM, title: "Old cached title" }], { targetPath, context });
    const cacheFile = path.join(context.cacheDir, `${ROOM}.json`);
    const before = await readFile(cacheFile, "utf8");
    const originalRename = fsp.rename;
    t.mock.method(fsp, "rename", async (source, destination) => {
      if (destination.startsWith(context.cacheDir + path.sep)) {
        throw Object.assign(new Error("fixture secret path must not appear"), { code });
      }
      return originalRename(source, destination);
    });
    globalThis.fetch = async (url) => {
      const row = { sessionId: ROOM, title: "Fresh server title", status: "active" };
      return new URL(url).pathname === "/api/v1/sessions"
        ? json({ sessions: [row], has_more: false }) : json({ session: row });
    };
    for (const args of [["list"], ["status", ROOM]]) {
      for (const format of [[], ["--json"]]) {
        const result = await cli(targetPath, [...args, ...format]);
        assert.equal(result.code, 0);
        assert.match(result.output, /Fresh server title/);
        assert.doesNotMatch(result.output, /Old cached title|secret path|could not be fully refreshed/);
        assert.match(result.stderr, new RegExp(`Server read succeeded.*${code}.*Offline results may be stale`));
        if (format.length) {
          const payload = JSON.parse(result.output);
          assert.equal(payload.ok, true);
          assert.equal(payload.cache.ok, false);
          assert.ok(payload.cache.failed > 0);
          assert.ok(payload.cache.errors.every((error) => error.code === code));
        }
        assert.equal(await readFile(cacheFile, "utf8"), before);
      }
    }
    assert.equal((await readdir(context.cacheDir)).some((name) => name.endsWith(".tmp")), false);
  });
}

test("server reads cache outside a read-only repository and do not import its old sidecars", async (t) => {
  const targetPath = await fixture(t);
  const oldScope = createHash("sha256").update(JSON.stringify([API, ""])).digest("hex");
  const oldCacheDir = path.join(targetPath, ".sentinelayer", "session-metadata-cache", oldScope);
  await fsp.mkdir(oldCacheDir, { recursive: true });
  await writeFile(path.join(oldCacheDir, `${ROOM}.json`), JSON.stringify({
    session: { sessionId: ROOM, title: "Old repository sidecar" },
    fetchedAt: new Date().toISOString(), localTitleAtRead: "Stale title",
  }));
  const context = await resolveSessionMetadataContext({ targetPath });
  assert.equal((await readOfflineSessionMetadata(ROOM, { targetPath, context })).title, "Stale title");
  const originalWrite = fsp.writeFile;
  const workspaceWrites = [];
  t.mock.method(fsp, "writeFile", async (filename, ...args) => {
    if (String(filename).startsWith(targetPath + path.sep)) {
      workspaceWrites.push(filename);
      throw Object.assign(new Error("read-only repository"), { code: "EACCES" });
    }
    return originalWrite(filename, ...args);
  });
  globalThis.fetch = async () => json({ sessions: [{ sessionId: ROOM, title: "Home cache title" }], has_more: false });
  const result = await cli(targetPath, ["list", "--json"]);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.output).cache.ok, true);
  assert.deepEqual(workspaceWrites, []);
  assert.equal((await readOfflineSessionMetadata(ROOM, { targetPath, context })).title, "Home cache title");
});

test("only complete lists prune missing cached rooms and preserve unrelated local metadata", async (t) => {
  const targetPath = await fixture(t);
  const context = await contextFor(targetPath);
  await createSession({ targetPath, sessionId: "local-only", title: "Local work" });
  const local = await getSession(ROOM, { targetPath });
  const before = await readFile(local.metadataPath, "utf8");
  const rooms = [{ sessionId: ROOM, title: "Former room" }, { sessionId: "server-only", title: "Remote room" }];
  await cacheRemoteSessionMetadata(rooms, { targetPath, context, requestedAt: "2026-01-01T00:00:00Z" });
  await cacheRemoteSessionMetadata([], { targetPath, context, completeList: false });
  assert.equal((await listOfflineSessionMetadata({ targetPath, context })).length, 3);
  const result = await cacheRemoteSessionMetadata([], {
    targetPath, context, completeList: true, requestedAt: "2026-01-02T00:00:00Z",
  });
  assert.equal(result.ok, true);
  assert.equal(result.pruned, 2);
  assert.deepEqual((await listOfflineSessionMetadata({ targetPath, context })).map((row) => row.sessionId), ["local-only"]);
  assert.equal(await readOfflineSessionMetadata(ROOM, { targetPath, context }), null);
  assert.equal(await readFile(local.metadataPath, "utf8"), before);
  await assert.rejects(readFile(path.join(context.cacheDir, "server-only.json")), { code: "ENOENT" });
  await cacheRemoteSessionMetadata([{ sessionId: ROOM, title: "Restored by status" }], {
    targetPath, context, requestedAt: "2026-01-03T00:00:00Z",
  });
  assert.equal((await readOfflineSessionMetadata(ROOM, { targetPath, context })).title, "Restored by status");
  await cacheRemoteSessionMetadata([], {
    targetPath, context, completeList: true, requestedAt: "2026-01-01T12:00:00Z",
  });
  assert.equal((await readOfflineSessionMetadata(ROOM, { targetPath, context })).title, "Restored by status");
});

test("default complete list prunes but limited and malformed pagination do not", async (t) => {
  const targetPath = await fixture(t);
  const context = await resolveSessionMetadataContext({ targetPath });
  await cacheRemoteSessionMetadata([{ sessionId: ROOM, title: "Previously visible" }], { targetPath, context });
  for (const body of [
    { sessions: [{ sessionId: "other", title: "Other" }], has_more: true, next_cursor: "next" },
    { sessions: [], has_more: true },
  ]) {
    globalThis.fetch = async () => json(body);
    const result = await cli(targetPath, ["list"]);
    assert.equal(result.code, 0);
    assert.equal((await readOfflineSessionMetadata(ROOM, { targetPath, context })).title, "Previously visible");
  }
  globalThis.fetch = async () => json({ sessions: [], has_more: false });
  const result = JSON.parse((await cli(targetPath, ["list", "--json"])).output);
  assert.equal(result.cache.pruned, 1);
  assert.equal(await readOfflineSessionMetadata(ROOM, { targetPath, context }), null);
});

test("list and status preserve admission-only credentials and never retry with the human token", async (t) => {
  const targetPath = await fixture(t);
  const token = `sladm_${"a".repeat(43)}`;
  const admission = { sessionId: ROOM, agentId: "worker", admissionId: "metadata-admission", apiUrl: API,
    token, expiresAt: Date.now() / 1000 + 60 };
  const humanContext = await resolveSessionMetadataContext({ targetPath });
  const admissionContext = await admittedAgentScope.run(admission, () => resolveSessionMetadataContext({ targetPath }));
  assert.notEqual(admissionContext.cacheDir, humanContext.cacheDir);
  let requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, authorization: new Headers(init.headers).get("authorization") });
    const row = { sessionId: ROOM, title: "Admitted title", status: "active" };
    return new URL(url).pathname === "/api/v1/sessions"
      ? json({ sessions: [row], has_more: false }) : json({ session: row });
  };
  for (const args of [["list"], ["status", ROOM]]) {
    const result = await admittedAgentScope.run(admission, () => cli(targetPath, [...args, "--json"]));
    assert.equal(result.code, 0);
    assert.match(result.output, /Admitted title/);
  }
  assert.ok(requests.length >= 2);
  assert.ok(requests.every((request) => request.authorization === `Bearer ${token}`));
  assert.equal((await readOfflineSessionMetadata(ROOM, { targetPath, context: humanContext })).title, "Stale title");
  requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(new Headers(init.headers).get("authorization"));
    return json({}, 403);
  };
  for (const args of [["list"], ["status", ROOM]]) {
    const result = await admittedAgentScope.run(admission, () => cli(targetPath, [...args, "--json"]));
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.output).ok, false);
  }
  assert.deepEqual(requests, [`Bearer ${token}`, `Bearer ${token}`]);
  globalThis.fetch = () => assert.fail("expired admission must not send any request or use the human credential");
  for (const args of [["list"], ["status", ROOM]]) {
    const result = await admittedAgentScope.run({ ...admission, expiresAt: 0 }, () => cli(targetPath, [...args, "--json"]));
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.output).ok, false);
  }
});

test("cached server lifecycle controls the offline view without rewriting local TTL", async (t) => {
  const targetPath = await fixture(t);
  const context = await contextFor(targetPath);
  const local = await getSession(ROOM, { targetPath });
  const before = await readFile(local.metadataPath, "utf8");
  await cacheRemoteSessionMetadata([{
    sessionId: ROOM, title: "Archived room", status: "archived", archiveStatus: "archived",
    expiresAt: "2026-01-01T00:00:00.000Z",
  }], { targetPath, context });
  assert.deepEqual(await listOfflineSessionMetadata({ targetPath, context }), []);
  const offline = await readOfflineSessionMetadata(ROOM, { targetPath, context });
  assert.equal(offline.status, "archived");
  assert.equal(offline.expiresAt, "2026-01-01T00:00:00.000Z");
  assert.equal((await listOfflineSessionMetadata({ targetPath, context, includeArchived: true })).length, 1);
  assert.equal(await readFile(local.metadataPath, "utf8"), before);
});

for (const localStatus of ["active", "expired", "archived"]) {
  test(`server status without archiveStatus replaces the local ${localStatus} classification`, async (t) => {
    const targetPath = await fixture(t);
    const context = await contextFor(targetPath);
    const local = await getSession(ROOM, { targetPath });
    const raw = JSON.parse(await readFile(local.metadataPath, "utf8"));
    await writeFile(local.metadataPath, JSON.stringify({ ...raw, status: localStatus }));
    const remoteStatus = localStatus === "active" ? "archived" : "active";
    await cacheRemoteSessionMetadata([{
      sessionId: ROOM, title: "Current lifecycle", status: remoteStatus,
      ...(remoteStatus === "active" ? { expiresAt: "2999-01-01T00:00:00.000Z" } : {}),
    }], { targetPath, context });
    const visible = await listOfflineSessionMetadata({ targetPath, context });
    assert.equal(visible.length, remoteStatus === "active" ? 1 : 0);
    const all = await listOfflineSessionMetadata({ targetPath, context, includeArchived: true });
    assert.equal(all[0].archiveStatus, remoteStatus);
    assert.equal((await getSession(ROOM, { targetPath })).status, localStatus);
  });
}

test("cache refresh preserves concurrent local metadata and a newer local rename", async (t) => {
  const targetPath = await fixture(t);
  const context = await contextFor(targetPath);
  const requestedAt = "2026-01-01T00:00:00.000Z";
  await recordSessionRemoteTitleSync(ROOM, {
    targetPath, title: "Local rename", pending: true, lastAttemptAt: "2026-01-02T00:00:00.000Z",
  });
  await updateSessionTitle(ROOM, { targetPath, title: "Local rename" });
  await Promise.all([
    recordSessionProvisionedIdentities(ROOM, { targetPath, identityIds: ["local-identity"] }),
    cacheRemoteSessionMetadata([{ sessionId: ROOM, title: "Older response" }], { targetPath, context, requestedAt }),
  ]);
  const local = await getSession(ROOM, { targetPath });
  assert.deepEqual(local.sharedResources.provisionedIdentityIds, ["local-identity"]);
  assert.equal(local.remoteTitleSync.pending, true);
  assert.equal(local.title, "Local rename");
  assert.equal((await readOfflineSessionMetadata(ROOM, { targetPath, context })).title, "Local rename");
  await cacheRemoteSessionMetadata([{ sessionId: ROOM, title: "Latest response" }], { targetPath, context });
  assert.equal((await readOfflineSessionMetadata(ROOM, { targetPath, context })).title, "Latest response");
  await updateSessionTitle(ROOM, { targetPath, title: "New local intent" });
  assert.equal((await readOfflineSessionMetadata(ROOM, { targetPath, context })).title, "New local intent");
  assert.equal((await readdir(context.cacheDir)).some((name) => name.endsWith(".tmp")), false);
});

test("registered MCP list/status paths read live titles and retain the approval boundary", async (t) => {
  const targetPath = await fixture(t);
  let title = "First server title";
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const session = { sessionId: ROOM, title, status: "active" };
    const body = pathname === "/api/v1/sessions" ? { sessions: [session] }
      : pathname === `/api/v1/sessions/${ROOM}` ? session : {};
    response.writeHead(Object.keys(body).length ? 200 : 403, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const env = { ...process.env, SENTINELAYER_API_URL: `http://127.0.0.1:${server.address().port}` };
  const tools = (await buildCliCommandMcpTools()).filter((tool) => ["sl.session.list", "sl.session.status"].includes(tool.name));
  assert.equal(tools.length, 2);
  assert.ok(tools.every((tool) => tool.inputSchema.additionalProperties === false && tool.inputSchema.properties.offline.type === "boolean"));
  const refused = createCliCommandMcpToolHandlers(tools, { targetPath, env });
  assert.equal((await refused["sl.session.list"]({})).reason, "approval_required");
  assert.equal(requests, 0);
  // A test validator exercises execution after approval; production approval is unchanged.
  const handlers = createCliCommandMcpToolHandlers(tools, { targetPath, env, approve: () => true });
  const listed = await handlers["sl.session.list"]({});
  assert.equal(listed.ok, true, listed.stderr);
  assert.equal(listed.json.source, "remote");
  assert.equal(listed.json.sessions[0].title, title);
  title = "Latest server title";
  const status = await handlers["sl.session.status"]({ sessionId: ROOM });
  assert.equal(status.ok, true, status.stderr);
  assert.equal(status.json.session.title, title);
  const requestCount = requests;
  const offline = await handlers["sl.session.status"]({ sessionId: ROOM, offline: true });
  assert.equal(offline.ok, true, offline.stderr);
  assert.equal(offline.json.session.title, title);
  assert.equal(requests, requestCount);
});
