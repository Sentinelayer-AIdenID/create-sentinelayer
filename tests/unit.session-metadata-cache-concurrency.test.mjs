import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";

import { executeCliCommand } from "../src/mcp/cli-command-tools.js";
import { createSession } from "../src/session/store.js";
import { resolveSessionMetadataContext } from "../src/session/metadata-cache.js";

test("four concurrent CLI readers complete all 72 reads of one workspace cache", { timeout: 180_000 }, async (t) => {
  const targetPath = await mkdtemp(path.join(os.tmpdir(), "sl-cache-concurrent-"));
  t.after(() => rm(targetPath, { recursive: true, force: true }));
  const sessionId = "concurrent-cache-room";
  await createSession({ targetPath, sessionId, title: "Local old title" });
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      sessions: [{ sessionId, title: `Server title ${requests}`, status: "active" }], has_more: false,
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const env = {
    ...process.env, SENTINELAYER_API_URL: apiUrl, SENTINELAYER_TOKEN: "test-concurrent-cache-credential",
    SENTINELAYER_AGENT_ID: "",
  };
  let successfulRefreshes = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let read = 0; read < 18; read += 1) {
      // Children inherit this test's isolated home, so the real CLI processes
      // contend on the same files. Each child retains the loopback egress guard.
      const result = await executeCliCommand(["session", "list", "--json", "--path", targetPath], {
        targetPath, env, timeoutMs: 30_000,
      });
      assert.equal(result.timedOut, false);
      assert.equal(result.exitCode, 0, result.stderr || result.stdout);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.ok, true);
      assert.equal(payload.source, "remote");
      assert.match(payload.sessions[0].title, /^Server title \d+$/);
      if (!payload.cache.ok) {
        assert.match(result.stderr, /Server read succeeded.*local metadata cache/);
        assert.ok(payload.cache.failed > 0);
      } else {
        successfulRefreshes += payload.cache.refreshed;
      }
    }
  }));
  assert.equal(requests, 72);
  const context = await resolveSessionMetadataContext({ targetPath, resolveAuthSession: async () => ({ apiUrl }) });
  assert.ok(successfulRefreshes > 0, "at least one real process must publish its cache successfully");
  const filenames = await readdir(context.cacheDir);
  assert.equal(filenames.some((name) => name.endsWith(".tmp")), false);
  assert.equal(filenames.includes(".refresh.lock"), false, "an owner must release the scope lock");
  assert.equal(filenames.includes(".refresh-recovery.lock"), false, "an owner must release the recovery guard");
  assert.match(JSON.parse(await readFile(path.join(context.cacheDir, `${sessionId}.json`), "utf8")).session.title, /^Server title \d+$/);
});
