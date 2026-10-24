import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { captureSourceBytes, SourceIntakeError } from "../src/engram/index.js";
import { sourceSnapshotSchema } from "../src/engram/contracts/source-snapshot.js";

const url = "https://aidenid.com/llms.txt";
const tenantScope = "tenant:aidenid";
const sourceId = "aidenid:llms";
const source = Object.freeze({
  url,
  tenantScope,
  sourceType: "ingest",
  version: "git:approved-public-page-v1",
  mediaType: "text/plain",
  visibility: "public",
});
const body = Buffer.from("# AIdenID\nPublic agent guide.\n", "utf8");

function fixture(overrides = {}) {
  return {
    sourceId,
    tenantScope,
    sources: new Map([[sourceId, source]]),
    allowedOrigins: new Set(["https://aidenid.com"]),
    authorize: async () => true,
    read: async () => ({ status: 200, url, mediaType: "text/plain; charset=utf-8", contentLength: body.length, body }),
    capturedAt: () => "2026-10-24T00:00:00.000Z",
    ...overrides,
  };
}

async function rejectsCode(options, code) {
  await assert.rejects(captureSourceBytes(options), (error) =>
    error instanceof SourceIntakeError && error.code === code && error.message === code);
}

test("public owner source yields bounded bytes and exact EW02 SourceSnapshot", async () => {
  let requested;
  const result = await captureSourceBytes(fixture({ read: async (request) => {
    requested = request;
    return { status: 200, url, mediaType: "text/plain; charset=utf-8", contentLength: body.length, body };
  } }));
  assert.equal(sourceSnapshotSchema.safeParse(result.snapshot).success, true);
  assert.deepEqual(result.bytes, body);
  assert.equal(result.snapshot.contentHash, `sha256:${createHash("sha256").update(body).digest("hex")}`);
  assert.equal(result.snapshot.version, source.version);
  assert.equal(result.snapshot.tenantScope, tenantScope);
  assert.deepEqual(requested, { sourceId, tenantScope, url, maxBytes: 256 * 1024 });
  assert.deepEqual(result.snapshot.metadata, {
    origin: "https://aidenid.com", mediaType: "text/plain", byteLength: body.length,
  });
  assert.equal((await captureSourceBytes(fixture())).snapshot.contentHash, result.snapshot.contentHash);
});

test("tenant denial happens before source lookup or retrieval", async () => {
  let lookedUp = 0;
  let reads = 0;
  const sources = new Map([[sourceId, source]]);
  sources.get = () => { lookedUp += 1; throw Error("private source name"); };
  await rejectsCode(fixture({ sources, authorize: async () => false,
    read: async () => { reads += 1; throw Error("private bytes"); } }), "source_access_denied");
  assert.equal(lookedUp, 0);
  assert.equal(reads, 0);
  await rejectsCode(fixture({ authorize: async () => { throw Error("secret auth token"); } }), "source_access_denied");
});

test("unregistered, cross-tenant and private sources never reach the reader", async () => {
  let reads = 0;
  const read = async () => { reads += 1; throw Error("must not read"); };
  await rejectsCode(fixture({ sources: new Map(), read }), "source_not_approved");
  await rejectsCode(fixture({ tenantScope: "tenant:other", read }), "source_not_approved");
  await rejectsCode(fixture({ sources: new Map([[sourceId, { ...source, visibility: "private" }]]), read }), "source_not_approved");
  await rejectsCode(fixture({ sources: new Map([[sourceId, { ...source, sourceType: "derived" }]]), read }), "source_not_approved");
  assert.equal(reads, 0);
});

test("source registry rejects URL credentials, private hosts, query strings and unlisted origins", async () => {
  const badUrls = [
    "http://aidenid.com/llms.txt",
    "https://user:password@aidenid.com/llms.txt",
    "https://aidenid.com/llms.txt?token=abc",
    "https://127.0.0.1/llms.txt",
    "https://169.254.169.254/latest/meta-data",
    "https://other.example/llms.txt",
    " https://aidenid.com/llms.txt",
  ];
  for (const badUrl of badUrls) {
    let reads = 0;
    await rejectsCode(fixture({
      sources: new Map([[sourceId, { ...source, url: badUrl }]]),
      read: async () => { reads += 1; throw Error("must not read"); },
    }), "source_not_approved");
    assert.equal(reads, 0, badUrl);
  }
});

test("redirect, changed URL, unexpected media type and bad declared length are denied", async () => {
  for (const change of [
    { status: 302 },
    { url: "https://aidenid.com/private" },
    { url: "http://127.0.0.1/" },
    { mediaType: "text/html" },
    { contentLength: body.length + 1 },
    { contentLength: 999999 },
  ]) {
    await rejectsCode(fixture({ read: async () => ({
      status: 200, url, mediaType: "text/plain", contentLength: body.length, body, ...change,
    }) }), "source_rejected");
  }
});

test("streaming over the byte cap stops the reader and stores no snapshot", async () => {
  let closed = false;
  async function* stream() {
    try {
      yield Buffer.from("12345678");
      yield Buffer.from("9");
      yield Buffer.from("never reached");
    } finally {
      closed = true;
    }
  }
  await rejectsCode(fixture({ maxBytes: 8, read: async () => ({
    status: 200, url, mediaType: "text/plain", body: stream(),
  }) }), "source_too_large");
  assert.equal(closed, true);
});

test("reader exceptions, malformed UTF-8 and credential-like content never leak into errors", async () => {
  const secret = "ghp_" + "abcdefghijklmnopqrstuvwxyz1234567890";
  await rejectsCode(fixture({ read: async () => { throw Error(`reader failed: ${secret}`); } }), "source_unavailable");
  await rejectsCode(fixture({ read: async () => ({
    status: 200, url, mediaType: "text/plain", body: Buffer.from([0xff]),
  }) }), "source_rejected");
  await rejectsCode(fixture({ read: async () => ({
    status: 200, url, mediaType: "text/plain", body: Buffer.from(secret),
  }) }), "source_rejected");
  await rejectsCode(fixture({ read: async () => ({
    status: 200, url, mediaType: "text/plain", body: Buffer.from("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"),
  }) }), "source_rejected");
  await rejectsCode(fixture({ read: async () => ({
    status: 200, url, mediaType: "text/plain", body: Buffer.from("api_key: abcdefghijklmnopqrstuvwxyz123456"),
  }) }), "source_rejected");
  const namedOnly = Buffer.from("Set AIDENID_API_KEY in the server environment.");
  const named = await captureSourceBytes(fixture({ read: async () => ({
    status: 200, url, mediaType: "text/plain", body: namedOnly,
  }) }));
  assert.deepEqual(named.bytes, namedOnly);
  const throwingMetadata = { status: 200, url, mediaType: "text/plain", body };
  Object.defineProperty(throwingMetadata, "contentLength", { get() { throw Error(`private: ${secret}`); } });
  await rejectsCode(fixture({ read: async () => throwingMetadata }), "source_rejected");
});
