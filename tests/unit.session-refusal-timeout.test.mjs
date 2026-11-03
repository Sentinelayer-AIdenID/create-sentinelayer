import "./setup-env.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { fetchJsonWithFullTimeout, streamSessionEvents } from "../src/session/sync.js";

const API = "https://api.fixture.invalid";

function stalledResponse(status) {
  let bodyController;
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { bodyController = controller; },
    cancel() { cancelled = true; },
  });
  return {
    response: new Response(body, { status }),
    cancelled: () => cancelled,
    close: () => { if (!cancelled) bodyController.close(); },
  };
}

function configureApi(t) {
  for (const [name, value] of Object.entries({
    SENTINELAYER_API_URL: API,
    SENTINELAYER_API_ALLOWED_HOSTS: "api.fixture.invalid",
  })) {
    const original = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
  }
}

for (const status of [403, 404]) {
  test(`session refusal ${status} aborts a locked body when inspection expires`, async () => {
    const stalled = stalledResponse(status);
    let signal;
    try {
      const result = await fetchJsonWithFullTimeout(
        `${API}/api/v1/sessions/sample-room/events`, {}, 40,
        async (_url, options) => {
          signal = options.signal;
          return stalled.response;
        },
      );
      assert.equal(result.response.status, status);
      assert.equal(result.payload, null);
      assert.ok(stalled.cancelled() || signal.aborted,
        "timed-out refusal must cancel the body or abort the request");
    } finally {
      stalled.close();
    }
  });

  test(`session refusal ${status} closes the HTTP connection after inspection expires`, async () => {
    let requestSocket;
    let responseWriter;
    let onClose;
    const closed = new Promise((resolve) => { onClose = resolve; });
    const server = createServer((_request, response) => {
      requestSocket = response.socket;
      responseWriter = response;
      response.on("close", () => onClose(true));
      response.writeHead(status, { "Content-Type": "application/json" });
      response.write('{"error":');
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const result = await fetchJsonWithFullTimeout(
        `http://127.0.0.1:${server.address().port}/api/v1/sessions/sample-room/events`, {}, 150,
      );
      assert.equal(result.response.status, status);
      // The base never closes this socket; allow a slow CI runner (coverage, cold start) time to see the close.
      assert.equal(await Promise.race([closed, delay(2000, false)]), true,
        "refusal body must not retain a live socket after the timeout");
      assert.equal(requestSocket.destroyed, true);
      assert.equal(responseWriter.write(" "), false, "server cannot keep sending the refused body");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test(`stream refusal ${status} shares the connection deadline and aborts inspection`, async (t) => {
    configureApi(t);
    const stalled = stalledResponse(status);
    let signal;
    let started;
    try {
      const result = await streamSessionEvents("sample-room", {
        timeoutMs: 400,
        resolveAuthSession: async () => ({
          token: ["fixture", "credential"].join("-"), apiUrl: API,
        }),
        fetchImpl: async (_url, options) => {
          signal = options.signal;
          started = performance.now();
          await delay(280);
          return stalled.response;
        },
      });
      const elapsed = performance.now() - started;
      assert.equal(result.reason, `api_${status}`);
      assert.equal(result.status, status);
      assert.ok(elapsed < 550,
        `body must use the remaining connection deadline; took ${Math.round(elapsed)}ms`);
      assert.ok(stalled.cancelled() || signal.aborted,
        "expired stream refusal must cancel the body or abort the request");
    } finally {
      stalled.close();
    }
  });
}
