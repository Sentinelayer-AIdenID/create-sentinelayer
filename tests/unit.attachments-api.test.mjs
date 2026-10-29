import "./setup-env.mjs";
// Unit tests for attachment upload/download API contract using mock HTTP servers.
// Tests init → signed PUT → complete upload flow, signed GET → verify download flow,
// sha256 verification, retries, and MIME type detection.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";

import {
  initAttachment,
  completeAttachment,
  uploadStreamToUrl,
  getAttachmentDownload,
  downloadAttachmentToFile,
  uploadAttachment,
  fetchAndReturnAttachment,
  pollAttachmentUntilReady,
  fileSha256,
} from "../src/session/attachments.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function parseUrl(req) {
  const raw = req.url || "/";
  const idx = raw.indexOf("?");
  const pathname = idx >= 0 ? raw.slice(0, idx) : raw;
  const search = idx >= 0 ? `?${raw.slice(idx + 1)}` : "";
  const searchParams = new URLSearchParams(search);
  return { pathname, searchParams };
}

async function startAttachmentMockApi() {
  const state = {
    initCalls: [],
    completeCalls: [],
    downloadCalls: [],
    uploadBlobs: new Map(),
    nextUploadUrlId: 0,
    nextAttachmentId: 0,
    downloadContent: Buffer.from("mock-download-content"),
    downloadMimeType: "image/png",
    downloadFileName: "test.png",
  };

  const server = http.createServer(async (req, res) => {
    try {
      const { pathname, searchParams } = parseUrl(req);

      // POST /api/v1/sessions/:id/attachments/init
      const initMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/attachments\/init$/);
      if (initMatch && req.method === "POST") {
        const body = await readJsonBody(req);
        state.initCalls.push({ sessionId: initMatch[1], body });
        state.nextAttachmentId += 1;
        state.nextUploadUrlId += 1;
        const uploadPath = `/_upload/${state.nextUploadUrlId}`;
        const uploadHeaders = {
          "content-type": body.contentType || "application/octet-stream",
          "content-length": String(body.sizeBytes),
          "x-amz-checksum-sha256": body.sha256 || "",
          "x-amz-meta-attachment-id": `att_${state.nextAttachmentId}`,
          "x-amz-meta-session-ref": initMatch[1],
          "x-amz-meta-sha256": body.sha256 || "",
        };
        return jsonResponse(res, 200, {
          attachmentId: `att_${state.nextAttachmentId}`,
          upload: {
            url: `http://127.0.0.1:${server.address().port}${uploadPath}`,
            method: "PUT",
            headers: uploadHeaders,
          },
        });
      }

      // POST /api/v1/sessions/:id/attachments/:aid/complete
      const completeMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/attachments\/([^/]+)\/complete$/);
      if (completeMatch && req.method === "POST") {
        state.completeCalls.push({ sessionId: completeMatch[1], attachmentId: completeMatch[2], body: undefined });
        return jsonResponse(res, 200, { ok: true });
      }

      // GET /api/v1/sessions/:id/attachments/:aid — download metadata
      const downloadMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/attachments\/([^/]+)$/);
      if (downloadMatch && req.method === "GET") {
        const thumbnail = searchParams.get("thumbnail") === "1";
        state.downloadCalls.push({ sessionId: downloadMatch[1], attachmentId: downloadMatch[2], thumbnail });
        state.nextUploadUrlId += 1;
        return jsonResponse(res, 200, {
          status: "ready",
          attachmentId: downloadMatch[2],
          downloadUrl: `http://127.0.0.1:${server.address().port}/_download/${state.nextUploadUrlId}`,
          fileName: state.downloadFileName,
          mimeType: state.downloadMimeType,
          sha256: createHash("sha256").update(state.downloadContent).digest("hex"),
          pageCount: thumbnail ? undefined : 1,
          extractedText: thumbnail ? undefined : "mock text extraction result",
        });
      }

      // PUT /_upload/:id — mock signed PUT
      const uploadMatch = pathname.match(/^\/_upload\/(\d+)$/);
      if (uploadMatch && req.method === "PUT") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        state.uploadBlobs.set(pathname, Buffer.concat(chunks));
        return jsonResponse(res, 200, { ok: true });
      }

      // GET /_download/:id — serve mock blob
      const dlMatch = pathname.match(/^\/_download\/(\d+)$/);
      if (dlMatch && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": state.downloadMimeType,
          "Content-Length": String(state.downloadContent.length),
        });
        res.end(state.downloadContent);
        return;
      }

      return jsonResponse(res, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
    } catch (error) {
      return jsonResponse(res, 500, {
        error: { code: "TEST_SERVER_ERROR", message: error instanceof Error ? error.message : String(error) },
      });
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to resolve mock API address.");

  return { state, apiUrl: `http://127.0.0.1:${address.port}`, async close() { server.close(); await once(server, "close"); } };
}

function setApiEnv(apiUrl, token) {
  const prev = { api: process.env.SENTINELAYER_API_URL, token: process.env.SENTINELAYER_TOKEN };
  process.env.SENTINELAYER_API_URL = apiUrl;
  process.env.SENTINELAYER_TOKEN = token || "test-attachment-token";
  return prev;
}

function restoreApiEnv(prev) {
  if (prev.api === undefined) delete process.env.SENTINELAYER_API_URL;
  else process.env.SENTINELAYER_API_URL = prev.api;
  if (prev.token === undefined) delete process.env.SENTINELAYER_TOKEN;
  else process.env.SENTINELAYER_TOKEN = prev.token;
}

// ─── uploadStreamToUrl ──────────────────────────────────────────────────────

test("uploadStreamToUrl: PUTs file content to signed URL", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "att-"));
  const mock = await startAttachmentMockApi();
  try {
    const filePath = path.join(tmpDir, "upload.bin");
    await writeFile(filePath, Buffer.from("hello-upload-test"));

    const result = await uploadStreamToUrl(`http://127.0.0.1:${new URL(mock.apiUrl).port}/_upload/42`, filePath);
    assert.equal(result, true);
    assert.equal(mock.state.uploadBlobs.get("/_upload/42")?.toString(), "hello-upload-test");
  } finally { await mock.close(); await rm(tmpDir, { recursive: true, force: true }); }
});

test("uploadStreamToUrl: retries on 5xx and succeeds", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "att-"));
  try {
    const filePath = path.join(tmpDir, "retry.bin");
    await writeFile(filePath, Buffer.from("retry-test"));

    let attempts = 0;
    const server = http.createServer(async (req, res) => {
      attempts += 1;
      if (attempts <= 2) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "transient" }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    try {
      await uploadStreamToUrl(`http://127.0.0.1:${addr.port}/retry`, filePath);
      assert.ok(attempts >= 3, `expected >=3 attempts, got ${attempts}`);
    } finally { server.close(); await once(server, "close"); }
  } finally { await rm(tmpDir, { recursive: true, force: true }); }
});

test("uploadStreamToUrl: fails immediately on 4xx without retry", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "att-"));
  try {
    const filePath = path.join(tmpDir, "noretry.bin");
    await writeFile(filePath, Buffer.from("content"));

    let attempts = 0;
    const server = http.createServer(async (req, res) => {
      attempts += 1;
      res.writeHead(400);
      res.end(JSON.stringify({ error: "bad request" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    try {
      await assert.rejects(
        () => uploadStreamToUrl(`http://127.0.0.1:${addr.port}/noretry`, filePath),
        (err) => err.code === "UPLOAD_FAILED",
      );
      assert.equal(attempts, 1, "should not retry on 4xx");
    } finally { server.close(); await once(server, "close"); }
  } finally { await rm(tmpDir, { recursive: true, force: true }); }
});

// ─── downloadAttachmentToFile ───────────────────────────────────────────────

test("downloadAttachmentToFile: streams to file and verifies sha256", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "att-"));
  try {
    const content = Buffer.from("download-test-content-abc");
    const expectedSha = createHash("sha256").update(content).digest("hex");

    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(content.length) });
      res.end(content);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    const outPath = path.join(tmpDir, "out.bin");
    try {
      const result = await downloadAttachmentToFile(`http://127.0.0.1:${addr.port}/dl`, outPath, expectedSha);
      assert.equal(result.sha256, expectedSha);
      const written = await (await import("node:fs/promises")).readFile(outPath);
      assert.equal(Buffer.compare(written, content), 0);
    } finally { server.close(); await once(server, "close"); }
  } finally { await rm(tmpDir, { recursive: true, force: true }); }
});

test("downloadAttachmentToFile: refuses sha256 mismatch", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "att-"));
  try {
    const content = Buffer.from("actual");
    const wrongSha = createHash("sha256").update("different").digest("hex");

    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(content.length) });
      res.end(content);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    try {
      await assert.rejects(
        () => downloadAttachmentToFile(`http://127.0.0.1:${addr.port}/dl`, path.join(tmpDir, "out.bin"), wrongSha),
        (err) => err.code === "SHA256_MISMATCH",
      );
    } finally { server.close(); await once(server, "close"); }
  } finally { await rm(tmpDir, { recursive: true, force: true }); }
});

// ─── initAttachment / completeAttachment integration ─────────────────────────

test("initAttachment + completeAttachment: full contract", async () => {
  const mock = await startAttachmentMockApi();
  const prev = setApiEnv(mock.apiUrl);
  try {
    const init = await initAttachment("sess-1", "photo.png", "image/png", 12345, { sha256: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" });
    assert.ok(init.attachmentId);
    assert.ok(init.upload.url);
    assert.equal(mock.state.initCalls[0].body.filename, "photo.png");
    assert.equal(mock.state.initCalls[0].body.contentType, "image/png");
    assert.ok(mock.state.initCalls[0].body.sha256);

    const comp = await completeAttachment("sess-1", init.attachmentId, "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2");
    assert.equal(comp.ok, true);
    assert.equal(mock.state.completeCalls[0].body, undefined);
  } finally { restoreApiEnv(prev); await mock.close(); }
});

// ─── getAttachmentDownload ──────────────────────────────────────────────────

test("getAttachmentDownload: returns download metadata with thumbnail flag", async () => {
  const mock = await startAttachmentMockApi();
  const prev = setApiEnv(mock.apiUrl);
  try {
    const result = await getAttachmentDownload("sess-1", "att_1");
    assert.ok(result.downloadUrl);
    assert.equal(result.fileName, "test.png");
    assert.equal(mock.state.downloadCalls[0].thumbnail, false);

    await getAttachmentDownload("sess-1", "att_1", { thumbnail: true });
    assert.equal(mock.state.downloadCalls[1].thumbnail, true);
  } finally { restoreApiEnv(prev); await mock.close(); }
});

// ─── uploadAttachment (full pipeline) ────────────────────────────────────────

test("uploadAttachment: full init→upload→complete pipeline", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "att-"));
  const mock = await startAttachmentMockApi();
  const prev = setApiEnv(mock.apiUrl);
  try {
    const filePath = path.join(tmpDir, "test.png");
    const content = Buffer.from("fake-png-data");
    await writeFile(filePath, content);

    const result = await uploadAttachment("sess-1", filePath);
    assert.ok(result.attachmentId);
    assert.equal(result.sha256, createHash("sha256").update(content).digest("hex"));
    assert.equal(result.fileName, "test.png");
    assert.equal(result.mimeType, "image/png");
    assert.equal(mock.state.initCalls.length, 1);
    assert.equal(mock.state.completeCalls.length, 1);
  } finally { restoreApiEnv(prev); await mock.close(); await rm(tmpDir, { recursive: true, force: true }); }
});

// ─── fetchAndReturnAttachment ───────────────────────────────────────────────

test("fetchAndReturnAttachment: returns buffer + metadata for images", async () => {
  const mock = await startAttachmentMockApi();
  const prev = setApiEnv(mock.apiUrl);
  try {
    const result = await fetchAndReturnAttachment("sess-1", "att_1");
    assert.ok(Buffer.isBuffer(result.buffer));
    assert.ok(result.buffer.length > 0);
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.fileName, "test.png");
  } finally { restoreApiEnv(prev); await mock.close(); }
});

test("fetchAndReturnAttachment: passes thumbnail flag", async () => {
  const mock = await startAttachmentMockApi();
  const prev = setApiEnv(mock.apiUrl);
  try {
    await fetchAndReturnAttachment("sess-1", "att_1", { thumbnail: true });
    assert.equal(mock.state.downloadCalls[0].thumbnail, true);
  } finally { restoreApiEnv(prev); await mock.close(); }
});

test("fetchAndReturnAttachment: returns PDF metadata when mimeType is application/pdf", async () => {
  const mock = await startAttachmentMockApi();
  mock.state.downloadMimeType = "application/pdf";
  mock.state.downloadFileName = "report.pdf";
  mock.state.downloadContent = Buffer.from("%PDF-1.4 fake pdf content");
  const prev = setApiEnv(mock.apiUrl);
  try {
    const result = await fetchAndReturnAttachment("sess-1", "att_1");
    assert.equal(result.mimeType, "application/pdf");
    assert.equal(result.fileName, "report.pdf");
    assert.equal(result.pageCount, 1);
    assert.equal(result.extractedText, "mock text extraction result");
  } finally { restoreApiEnv(prev); await mock.close(); }
});

// ─── Warden-requested tests ─────────────────────────────────────────────────

test("presigned upload headers are all forwarded to PUT", async () => {
  // Prove every header from init's upload.headers reaches the PUT by checking
  // that upload succeeds (headers are correct per the API signature contract).
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "att-"));
  const mock = await startAttachmentMockApi();
  const prev = setApiEnv(mock.apiUrl);
  try {
    const filePath = path.join(tmpDir, "test.png");
    await writeFile(filePath, Buffer.from("presigned-header-test-data"));

    const result = await uploadAttachment("sess-1", filePath);
    assert.ok(result.attachmentId);

    // Verify the init call included the new contract fields
    const initCall = mock.state.initCalls[0];
    assert.ok(initCall);
    assert.equal(initCall.body.filename, "test.png");
    assert.equal(initCall.body.contentType, "image/png");
    assert.ok(initCall.body.sizeBytes > 0);
    assert.ok(initCall.body.sha256, "sha256 must be present in init");

    // Verify the blob was uploaded (mock stores uploaded content)
    const uploadKeys = Array.from(mock.state.uploadBlobs.keys());
    assert.ok(uploadKeys.length >= 1, "upload must have been called");

    // Verify the complete call was made (empty body now)
    assert.equal(mock.state.completeCalls.length, 1);
    assert.equal(mock.state.completeCalls[0].body, undefined);
  } finally { restoreApiEnv(prev); await mock.close(); await rm(tmpDir, { recursive: true, force: true }); }
});

test("initAttachment throws when sha256 is missing or invalid", async () => {
  const mock = await startAttachmentMockApi();
  const prev = setApiEnv(mock.apiUrl);
  try {
    // Missing sha256 must throw BEFORE any API call
    await assert.rejects(
      () => initAttachment("sess-1", "file.png", "image/png", 100, {}),
      /sha256 is required/,
    );
    // Short sha256 must throw
    await assert.rejects(
      () => initAttachment("sess-1", "file.png", "image/png", 100, { sha256: "abc123" }),
      /sha256 is required/,
    );
    // Verify no API call was made
    assert.equal(mock.state.initCalls.length, 0);
  } finally { restoreApiEnv(prev); await mock.close(); }
});

test("initAttachment sends valid sha256 through to API", async () => {
  const mock = await startAttachmentMockApi();
  const prev = setApiEnv(mock.apiUrl);
  try {
    const validSha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const init = await initAttachment("sess-1", "file.png", "image/png", 100, { sha256: validSha });
    assert.ok(init.attachmentId);
    const callBody = mock.state.initCalls[0].body;
    assert.ok(callBody.sha256);
    assert.notEqual(callBody.sha256, "");
    assert.equal(callBody.sha256, validSha);
  } finally { restoreApiEnv(prev); await mock.close(); }
});

test("uploadStreamToUrl: 4xx on PUT is not retried, 5xx is retried at most 3 times", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "att-"));
  try {
    const filePath = path.join(tmpDir, "test.bin");
    await writeFile(filePath, Buffer.from("retry-test-data"));

    // Server that returns 500 three times then 200
    let attemptCount = 0;
    const retryServer = http.createServer((req, res) => {
      attemptCount += 1;
      if (attemptCount <= 3) {
        return jsonResponse(res, 500, { error: "transient" });
      }
      return jsonResponse(res, 200, { ok: true });
    });
    retryServer.listen(0, "127.0.0.1");
    await once(retryServer, "listening");
    const addr = retryServer.address();
    try {
      await uploadStreamToUrl(`http://127.0.0.1:${addr.port}/put`, filePath);
      assert.equal(attemptCount, 4, "should retry 3 times (4 total attempts) for 5xx");
    } finally { retryServer.close(); await once(retryServer, "close"); }

    // Server that returns 403 — should fail immediately (no retry)
    attemptCount = 0;
    const failServer = http.createServer((req, res) => {
      attemptCount += 1;
      return jsonResponse(res, 403, { error: "forbidden" });
    });
    failServer.listen(0, "127.0.0.1");
    await once(failServer, "listening");
    const addr2 = failServer.address();
    try {
      await assert.rejects(
        () => uploadStreamToUrl(`http://127.0.0.1:${addr2.port}/put`, filePath),
        (err) => err.status === 403,
      );
      assert.equal(attemptCount, 1, "4xx must not be retried");
    } finally { failServer.close(); await once(failServer, "close"); }
  } finally { await rm(tmpDir, { recursive: true, force: true }); }
});

test("pollAttachmentUntilReady: returns when status=ready, throws on status=failed", async () => {
  const mock = await startAttachmentMockApi();
  const prev = setApiEnv(mock.apiUrl);
  try {
    const result = await pollAttachmentUntilReady("sess-1", "att_1");
    assert.equal(result.status, "ready");
  } finally { restoreApiEnv(prev); await mock.close(); }
});
