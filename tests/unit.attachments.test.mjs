import "./setup-env.mjs";
// Unit tests for src/session/attachments.js — upload/download streaming, sha256 verification, MIME detection, retries.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  guessMimeType,
  isImageMimeType,
  isPdfMimeType,
  fileSha256,
} from "../src/session/attachments.js";

// ─── MIME type detection ────────────────────────────────────────────────────

test("guessMimeType: maps known extensions to correct MIME types", () => {
  assert.equal(guessMimeType("photo.png"), "image/png");
  assert.equal(guessMimeType("photo.jpg"), "image/jpeg");
  assert.equal(guessMimeType("photo.jpeg"), "image/jpeg");
  assert.equal(guessMimeType("anim.gif"), "image/gif");
  assert.equal(guessMimeType("icon.webp"), "image/webp");
  assert.equal(guessMimeType("doc.pdf"), "application/pdf");
  assert.equal(guessMimeType("data.json"), "application/json");
  assert.equal(guessMimeType("readme.md"), "text/markdown");
  assert.equal(guessMimeType("video.mp4"), "video/mp4");
});

test("guessMimeType: is case-insensitive on extension", () => {
  assert.equal(guessMimeType("PHOTO.PNG"), "image/png");
  assert.equal(guessMimeType("Doc.PDF"), "application/pdf");
  assert.equal(guessMimeType("Data.JSON"), "application/json");
});

test("guessMimeType: unknown extension returns octet-stream", () => {
  assert.equal(guessMimeType("file.xyz"), "application/octet-stream");
  assert.equal(guessMimeType("noextension"), "application/octet-stream");
});

test("guessMimeType: empty string returns octet-stream", () => {
  assert.equal(guessMimeType(""), "application/octet-stream");
});

// ─── isImageMimeType / isPdfMimeType ──────────────────────────────────────────

test("isImageMimeType: detects image MIME types", () => {
  assert.equal(isImageMimeType("image/png"), true);
  assert.equal(isImageMimeType("image/jpeg"), true);
  assert.equal(isImageMimeType("image/gif"), true);
  assert.equal(isImageMimeType("image/webp"), true);
  assert.equal(isImageMimeType("image/svg+xml"), true);
  assert.equal(isImageMimeType("application/pdf"), false);
  assert.equal(isImageMimeType("text/plain"), false);
  assert.equal(isImageMimeType(""), false);
  assert.equal(isImageMimeType(null), false);
});

test("isPdfMimeType: detects PDF MIME type exactly", () => {
  assert.equal(isPdfMimeType("application/pdf"), true);
  assert.equal(isPdfMimeType("image/png"), false);
  assert.equal(isPdfMimeType(""), false);
  assert.equal(isPdfMimeType(null), false);
});

// ─── fileSha256 ──────────────────────────────────────────────────────────────

test("fileSha256: computes correct sha256 for known content", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "attachments-test-"));
  const filePath = path.join(tmpDir, "hello.txt");
  try {
    const content = "hello world\n";
    await writeFile(filePath, content, "utf-8");
    const expected = createHash("sha256").update(content).digest("hex");
    const actual = await fileSha256(filePath);
    assert.equal(actual, expected);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("fileSha256: returns consistent hash for binary content", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "attachments-test-"));
  const filePath = path.join(tmpDir, "binary.bin");
  try {
    const size = 256 * 1024; // 256 KB — exercise streaming
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) buf[i] = (i * 7 + 13) & 0xff;
    await writeFile(filePath, buf);
    const expected = createHash("sha256").update(buf).digest("hex");
    const actual = await fileSha256(filePath);
    assert.equal(actual, expected);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("fileSha256: empty file returns hash of empty input", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "attachments-test-"));
  const filePath = path.join(tmpDir, "empty.bin");
  try {
    await writeFile(filePath, "", "utf-8");
    const expected = createHash("sha256").update("").digest("hex");
    const actual = await fileSha256(filePath);
    assert.equal(actual, expected);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
