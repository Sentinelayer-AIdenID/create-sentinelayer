import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
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
  const lines = [];
  const exitCode = process.exitCode;
  process.exitCode = 0;
  console.log = (...parts) => lines.push(parts.join(" "));
  try {
    await program.parseAsync(["session", ...args, "--path", targetPath], { from: "user" });
    return { output: lines.join("\n"), code: process.exitCode || 0 };
  } finally {
    console.log = original;
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
  assert.deepEqual(result.cache, { refreshed: 1, skipped: 1, reason: "stable_account_id_unavailable" });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.method === "GET" && request.url.searchParams.get("limit") === "200"));
  assert.equal(requests[1].url.searchParams.get("cursor"), "page-2");
  globalThis.fetch = () => assert.fail("offline list must not contact the API");
  const offline = JSON.parse((await cli(targetPath, ["list", "--offline", "--json"])).output);
  assert.equal(offline.source, "local");
  assert.equal(offline.sessions.find((row) => row.sessionId === ROOM).title, "Same title");
  assert.equal(offline.sessions.some((row) => row.sessionId === "other-room"), false);
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

test("server-only cache membership is isolated by stable account and normalized API base", async (t) => {
  const targetPath = await fixture(t, { local: false });
  const context = await contextFor(targetPath);
  await cacheRemoteSessionMetadata([{ sessionId: ROOM, title: "Account A room", status: "active" }], { targetPath, context });
  assert.equal((await listOfflineSessionMetadata({ targetPath, context }))[0].title, "Account A room");
  for (const other of [await contextFor(targetPath, "account-b"), await contextFor(targetPath, "account-a", "http://127.0.0.1:18092"), await contextFor(targetPath, "")]) {
    assert.deepEqual(await listOfflineSessionMetadata({ targetPath, context: other }), []);
    assert.equal(await readOfflineSessionMetadata(ROOM, { targetPath, context: other }), null);
  }
  assert.equal((await contextFor(targetPath, "account-a", `${API}/`)).cacheDir, context.cacheDir);
  assert.equal(await getSession(ROOM, { targetPath }), null, "reading membership never creates global local metadata");
});

test("metadata context permits normal online rotation and forbids offline rotation", async (t) => {
  const targetPath = await fixture(t);
  for (const offline of [false, true]) {
    let calls = 0;
    await resolveSessionMetadataContext({ targetPath, offline, resolveAuthSession: async (options) => {
      calls += 1;
      assert.equal(options.autoRotate, !offline);
      return { apiUrl: API, user: { id: "account-a" } };
    } });
    assert.equal(calls, 1);
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
