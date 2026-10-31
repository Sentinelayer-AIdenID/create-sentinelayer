import "./setup-env.mjs";
// Unit tests for MCP attachment tools: session.send_attachment and session.get_attachment.
// Verifies get_attachment returns MCP image content blocks for images and text+pageCount for PDFs,
// never base64 in prose.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";

import {
  createSessionMcpToolHandlers,
} from "../src/mcp/session-stdio-server.js";

// ─── Mock API server for attachment operations ──────────────────────────────

function jsonResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
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
  return { pathname, searchParams: new URLSearchParams(search) };
}

async function startAttachmentMockApi({ mimeType = "image/png", fileName = "test.png", content = null } = {}) {
  const downloadContent = content || Buffer.from("mock-image-data-for-mcp-test");

  const server = http.createServer(async (req, res) => {
    try {
      const { pathname, searchParams } = parseUrl(req);

      // POST /api/v1/sessions/:id/attachments/init
      if (pathname.match(/\/attachments\/init$/) && req.method === "POST") {
        const body = await readJsonBody(req);
        return jsonResponse(res, 200, {
          ok: true,
          duplicate: false,
          attachment: { attachmentId: "att_mcp_42" },
          upload: {
            url: `http://127.0.0.1:${server.address().port}/_upload/mcp`,
            method: "PUT",
            expiresIn: 3600,
            headers: {
              "content-type": body.contentType || "application/octet-stream",
              "content-length": String(body.sizeBytes || 0),
              "x-amz-checksum-sha256": body.sha256 || "",
              "x-amz-meta-attachment-id": "att_mcp_42",
              "x-amz-meta-session-ref": "mcp-test",
              "x-amz-meta-sha256": body.sha256 || "",
            },
          },
        });
      }

      // POST /api/v1/sessions/:id/attachments/:aid/complete
      if (pathname.match(/\/attachments\/[^/]+\/complete$/) && req.method === "POST") {
        return jsonResponse(res, 200, { ok: true });
      }

      // GET /api/v1/sessions/:id/attachments/:aid
      if (pathname.match(/\/attachments\/[^/]+$/) && req.method === "GET") {
        const thumbnail = searchParams.get("thumbnail") === "1";
        return jsonResponse(res, 200, {
          status: "ready",
          attachmentId: "att_mcp_42",
          downloadUrl: `http://127.0.0.1:${server.address().port}/_download/mcp`,
          fileName,
          mimeType,
          sha256: createHash("sha256").update(downloadContent).digest("hex"),
          pageCount: thumbnail ? undefined : (mimeType === "application/pdf" ? 3 : undefined),
          extractedText: thumbnail ? undefined : (mimeType === "application/pdf" ? "Page 1 text.\nPage 2 text.\nPage 3 text." : undefined),
        });
      }

      // PUT /_upload/mcp
      if (pathname === "/_upload/mcp" && req.method === "PUT") {
        for await (const chunk of req) { /* consume */ }
        return jsonResponse(res, 200, { ok: true });
      }

      // GET /_download/mcp
      if (pathname === "/_download/mcp" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": mimeType, "Content-Length": String(downloadContent.length) });
        res.end(downloadContent);
        return;
      }

      return jsonResponse(res, 404, { error: { code: "NOT_FOUND" } });
    } catch (error) {
      return jsonResponse(res, 500, { error: { code: "TEST_ERROR", message: String(error) } });
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return { apiUrl: `http://127.0.0.1:${address.port}`, server, async close() { server.close(); await once(server, "close"); } };
}

function setApiEnv(apiUrl) {
  const prev = { api: process.env.SENTINELAYER_API_URL, token: process.env.SENTINELAYER_TOKEN };
  process.env.SENTINELAYER_API_URL = apiUrl;
  process.env.SENTINELAYER_TOKEN = "mcp-test-token";
  return prev;
}

function restoreApiEnv(prev) {
  if (prev.api === undefined) delete process.env.SENTINELAYER_API_URL;
  else process.env.SENTINELAYER_API_URL = prev.api;
  if (prev.token === undefined) delete process.env.SENTINELAYER_TOKEN;
  else process.env.SENTINELAYER_TOKEN = prev.token;
}

// ─── MCP session.send_attachment ────────────────────────────────────────────

test("MCP send_attachment: returns attachment ref after upload", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mcp-att-"));
  const mock = await startAttachmentMockApi();
  const prev = setApiEnv(mock.apiUrl);
  try {
    const filePath = path.join(tmpDir, "mcp-upload.png");
    await writeFile(filePath, Buffer.from("fake-png-for-mcp-upload"));

    const handlers = createSessionMcpToolHandlers({ targetPath: tmpDir });
    const result = await handlers["session.send_attachment"]({
      sessionId: "sess-mcp-1",
      filePath,
    });

    assert.equal(result.ok, true);
    assert.equal(result.attachmentId, "att_mcp_42");
    assert.equal(result.fileName, "mcp-upload.png");
    assert.equal(result.mimeType, "image/png");
    assert.ok(result.sha256, "should return sha256");
  } finally { restoreApiEnv(prev); await mock.close(); await rm(tmpDir, { recursive: true, force: true }); }
});

// ─── MCP session.get_attachment: image content blocks ────────────────────────

test("MCP get_attachment: returns MCP image content block for images", async () => {
  const mock = await startAttachmentMockApi({ mimeType: "image/png", content: Buffer.from("fake-png-bytes") });
  const prev = setApiEnv(mock.apiUrl);
  try {
    const handlers = createSessionMcpToolHandlers();
    const result = await handlers["session.get_attachment"]({
      sessionId: "sess-mcp-1",
      attachmentId: "att_1",
    });

    assert.equal(result.ok, true);
    assert.equal(result.attachmentId, "att_1");
    assert.equal(result.mimeType, "image/png");

    // Must have MCP content array
    assert.ok(Array.isArray(result.content), "content must be an array");
    assert.ok(result.content.length > 0, "must have at least one content block");

    const imageBlock = result.content.find((c) => c.type === "image");
    assert.ok(imageBlock, "must have an image content block");
    assert.ok(imageBlock.data, "must have base64 data");
    assert.ok(imageBlock.data.length > 0, "base64 data must not be empty");
    assert.equal(imageBlock.mimeType, "image/png");

    // Verify the base64 decodes to the original content
    const decoded = Buffer.from(imageBlock.data, "base64");
    assert.equal(decoded.toString(), "fake-png-bytes");

    // Never base64 pasted into prose
    const textBlocks = result.content.filter((c) => c.type === "text");
    for (const tb of textBlocks) {
      assert.ok(!tb.text || !tb.text.includes("base64"), "text blocks must not contain base64");
      assert.ok(!tb.text || tb.text.length < 100, "text blocks should not be dumping raw data");
    }
  } finally { restoreApiEnv(prev); await mock.close(); }
});

test("MCP get_attachment: returns text+pageCount for PDFs", async () => {
  const mock = await startAttachmentMockApi({
    mimeType: "application/pdf",
    fileName: "report.pdf",
    content: Buffer.from("%PDF-1.4 fake pdf"),
  });
  const prev = setApiEnv(mock.apiUrl);
  try {
    const handlers = createSessionMcpToolHandlers();
    const result = await handlers["session.get_attachment"]({
      sessionId: "sess-mcp-1",
      attachmentId: "att_1",
    });

    assert.equal(result.ok, true);
    assert.equal(result.mimeType, "application/pdf");
    assert.equal(result.fileName, "report.pdf");
    assert.equal(result.pageCount, 3);

    // Should have extracted text, not an image block for PDFs
    const imageBlocks = result.content.filter((c) => c.type === "image");
    assert.equal(imageBlocks.length, 0, "PDFs must not return image blocks");

    const textBlocks = result.content.filter((c) => c.type === "text");
    assert.ok(textBlocks.length > 0, "PDFs must have text content blocks");
    assert.ok(textBlocks[0].text.includes("Page 1"), "text must include extracted content");

    // extractedText must also be available at top level
    assert.ok(result.extractedText, "extractedText must be available");
    assert.ok(result.extractedText.includes("Page 1"));
  } finally { restoreApiEnv(prev); await mock.close(); }
});

test("MCP get_attachment: handles non-image non-PDF as text", async () => {
  const mock = await startAttachmentMockApi({
    mimeType: "application/json",
    fileName: "data.json",
    content: Buffer.from('{"hello":"world"}'),
  });
  const prev = setApiEnv(mock.apiUrl);
  try {
    const handlers = createSessionMcpToolHandlers();
    const result = await handlers["session.get_attachment"]({
      sessionId: "sess-mcp-1",
      attachmentId: "att_1",
    });

    assert.equal(result.ok, true);
    assert.equal(result.mimeType, "application/json");

    // No image blocks for non-image types
    const imageBlocks = result.content.filter((c) => c.type === "image");
    assert.equal(imageBlocks.length, 0, "non-image types must not have image blocks");

    // Text block should contain the UTF-8 content
    const textBlocks = result.content.filter((c) => c.type === "text");
    assert.ok(textBlocks.length > 0, "must have text content");
    assert.ok(textBlocks[0].text.includes("hello"));
  } finally { restoreApiEnv(prev); await mock.close(); }
});

test("MCP get_attachment: supports --thumbnail flag", async () => {
  const mock = await startAttachmentMockApi({ mimeType: "image/png", content: Buffer.from("thumb-bytes") });
  const prev = setApiEnv(mock.apiUrl);
  try {
    const handlers = createSessionMcpToolHandlers();
    const result = await handlers["session.get_attachment"]({
      sessionId: "sess-mcp-1",
      attachmentId: "att_1",
      thumbnail: true,
    });

    assert.equal(result.ok, true);
    // Thumbnail still returns image content block
    const imageBlock = result.content.find((c) => c.type === "image");
    assert.ok(imageBlock, "thumbnail of image must still return image block");
  } finally { restoreApiEnv(prev); await mock.close(); }
});
