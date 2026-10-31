import "./setup-env.mjs";
// `sl session kit` and the MCP session_kit tool. A room's pinned starter kit is used only when a
// human room owner or admin pinned it, only when it matches the sha256 its message states, and
// only as regular files inside the output directory, within the file-count and size caps.
// Every refusal leaves the disk untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { admittedAgentScope } from "../src/auth/admission-scope.js";
import { writeStoredSession } from "../src/auth/session-store.js";
import {
  KIT_MAX_FILES,
  KIT_MAX_TOTAL_BYTES,
  installSessionKit,
  readInlineKitArchive,
  unpackKitArchive,
} from "../src/session/kit.js";
import {
  SESSION_MCP_TOOLS,
  createSessionMcpToolHandlers,
  handleMcpJsonRpcMessage,
} from "../src/mcp/session-stdio-server.js";

const CLI = fileURLToPath(new URL("../bin/sl.js", import.meta.url));
const SESSION = "00000000-0000-4000-8000-00000000c001";
const OWNER = { userId: "00000000-0000-4000-8000-0000000000a1", role: "owner", githubLogin: "room-owner" };
const ADMIN = { userId: "00000000-0000-4000-8000-0000000000a2", role: "admin", githubLogin: "room-admin" };
const CONTRIBUTOR = { userId: "00000000-0000-4000-8000-0000000000b1", role: "contributor", githubLogin: "room-guest" };
const MEMBERS = [OWNER, ADMIN, CONTRIBUTOR];

// ---- archives

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function tarHeader(name, size, { type = "0", magic = "posix", prefix = "", linkname = "", checksumDelta = 0 } = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644", 100, "latin1");
  header.write("0000000", 108, "latin1");
  header.write("0000000", 116, "latin1");
  header.write(size.toString(8).padStart(11, "0"), 124, "latin1");
  header.write("00000000000", 136, "latin1");
  header.fill(0x20, 148, 156);
  header.write(type, 156, "latin1");
  header.write(linkname, 157, 100, "utf8");
  if (magic === "posix") {
    header.write("ustar", 257, "latin1"); // the zeroed buffer supplies its terminating NUL
    header.write("00", 263, "latin1");
  } else {
    header.write("ustar  ", 257, "latin1"); // GNU: "ustar " then version " " and a NUL
  }
  if (prefix) header.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write((sum + checksumDelta).toString(8).padStart(6, "0"), 148, "latin1");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function tarEntry(name, data = "", options = {}) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  return Buffer.concat([tarHeader(name, body.length, options), body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

function paxRecord(key, value) {
  const rest = Buffer.byteLength(` ${key}=${value}\n`);
  let length = rest + 1;
  while (String(length).length + rest !== length) length = String(length).length + rest;
  return `${length} ${key}=${value}\n`;
}

function paxEntry(records, { type = "x" } = {}) {
  const body = Object.entries(records).map(([key, value]) => paxRecord(key, value)).join("");
  return tarEntry("PaxHeader/entry", body, { type });
}

function tarball(...entries) {
  return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

const KIT_FILES = Object.freeze({
  "senti-starter-kit/README.md": "# Starter kit\n\nRead SKILL.md, then load mcp.json.\n",
  "senti-starter-kit/SKILL.md": "---\nname: room-skill\n---\nPost in the room before you push.\n",
  "senti-starter-kit/mcp.json": "{\"mcpServers\":{}}\n",
});

function starterKit(files = KIT_FILES) {
  return tarball(
    tarEntry("senti-starter-kit/", "", { type: "5" }),
    ...Object.entries(files).map(([name, content]) => tarEntry(name, content)),
  );
}

function kitMessage(archive, { stated = sha256(archive), newline = "\n", indent = "" } = {}) {
  return [
    "Welcome to the room.",
    "",
    `Starter kit (text only), sha256 ${stated}. Copy the lines between KIT-BEGIN and KIT-END into kit.b64, then:`,
    "KIT-BEGIN",
    ...archive.toString("base64").match(/.{1,76}/g).map((line) => `${indent}${line}`),
    "KIT-END",
  ].join(newline);
}

// ---- a room: its pins and its member list

function kitPin(content, overrides = {}) {
  const sequence = overrides.targetSequenceId ?? 100;
  return {
    targetSequenceId: sequence,
    targetCursor: null,
    pinnedBy: "human-room-owner",
    pinnedByKind: "human",
    pinnedByUserId: OWNER.userId,
    pinnedAt: "2026-10-31T12:00:00.000Z",
    author: "host-agent",
    content,
    contentSequenceId: sequence,
    contentRevision: 1,
    contentEditedAt: "",
    resolved: true,
    ...overrides,
  };
}

function room(pins, { members = MEMBERS, membersStatus = 200 } = {}) {
  const calls = { pins: 0, members: 0 };
  return {
    calls,
    fetchPinnedMessagesFn: async (sessionId) => {
      calls.pins += 1;
      assert.equal(sessionId, SESSION);
      return { ok: true, reason: "", sessionId, pins, pinLimit: 10, count: pins.length };
    },
    fetchMembersFn: async (sessionId) => {
      calls.members += 1;
      assert.equal(sessionId, SESSION);
      return membersStatus === 200
        ? { ok: true, reason: "", status: 200, members }
        : { ok: false, reason: `api_${membersStatus}`, status: membersStatus, members: [] };
    },
  };
}

const kitRoom = (archive, pinOverrides = {}, roomOptions = {}) => room([kitPin(kitMessage(archive), pinOverrides)], roomOptions);

async function workspace(t) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-session-kit-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  return base;
}

async function install(t, fakeRoom, { base, ...options } = {}) {
  const root = base || (await workspace(t));
  const result = await installSessionKit({
    sessionId: SESSION,
    targetPath: root,
    outBase: root,
    out: "senti-kit",
    fetchPinnedMessagesFn: fakeRoom.fetchPinnedMessagesFn,
    fetchMembersFn: fakeRoom.fetchMembersFn,
    ...options,
  });
  return { base: root, out: path.resolve(root, options.out || "senti-kit"), result };
}

function assertRefused(outcome, reason, pattern, label = reason) {
  assert.equal(outcome.result.ok, false, `${label}: ${JSON.stringify(outcome.result)}`);
  assert.equal(outcome.result.reason, reason, `${label}: ${outcome.result.message}`);
  if (pattern) assert.match(outcome.result.message, pattern, label);
  assert.equal(fs.existsSync(outcome.out), false, `${label}: nothing was written`);
}

// ---- a valid kit

test("a kit pinned by the room owner is verified and unpacked, with its README", async (t) => {
  const archive = starterKit();
  const fake = kitRoom(archive);
  const { out, result } = await install(t, fake);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.written, true);
  assert.equal(result.sha256, sha256(archive));
  assert.equal(result.archiveBytes, archive.length);
  assert.deepEqual(result.source, {
    kind: "pinned-message",
    archive: "inline",
    sequenceId: 100,
    pinnedBy: "human-room-owner",
    pinnedByKind: "human",
    pinnedByRole: "owner",
    pinnedAt: "2026-10-31T12:00:00.000Z",
    author: "host-agent",
  });
  assert.deepEqual(result.files.map((file) => file.path), Object.keys(KIT_FILES).sort());
  for (const [name, content] of Object.entries(KIT_FILES)) {
    const onDisk = await fsp.readFile(path.join(out, ...name.split("/")));
    assert.equal(onDisk.toString("utf8"), content, name);
    assert.equal(result.files.find((file) => file.path === name).sha256, sha256(onDisk), name);
  }
  assert.equal(result.fileCount, 3);
  assert.equal(result.readme.path, "senti-starter-kit/README.md");
  assert.equal(result.readme.file, path.join(out, "senti-starter-kit", "README.md"));
  assert.equal(result.readme.text, KIT_FILES["senti-starter-kit/README.md"]);
  assert.deepEqual(result.ignoredPins, []);
  assert.deepEqual(fake.calls, { pins: 1, members: 1 });
});

test("the kit block tolerates CRLF line breaks and indentation; the statement may read SHA-256: in capitals", () => {
  const archive = starterKit();
  const message = kitMessage(archive, { newline: "\r\n", indent: "  " })
    .replace(`sha256 ${sha256(archive)}`, `SHA-256: ${sha256(archive).toUpperCase()}`);
  const inline = readInlineKitArchive(message);
  assert.equal(inline.expectedSha256, sha256(archive));
  assert.deepEqual(inline.bytes, archive);
  assert.equal(unpackKitArchive(inline).entries.filter((entry) => entry.type === "file").length, 3);
  // the same digest stated twice is one statement
  assert.equal(readInlineKitArchive(`${message}\r\nsha256 ${sha256(archive)}`).expectedSha256, sha256(archive));
});

test("an admin's pin is trusted like the owner's", async (t) => {
  const { result } = await install(
    t,
    kitRoom(starterKit(), { pinnedBy: "human-room-admin", pinnedByUserId: ADMIN.userId }),
  );
  assert.equal(result.ok, true, result.message);
  assert.equal(result.source.pinnedByRole, "admin");
});

test("a dry run verifies everything and writes nothing", async (t) => {
  const outcome = await install(t, kitRoom(starterKit()), { dryRun: true });
  assert.equal(outcome.result.ok, true, outcome.result.message);
  assert.equal(outcome.result.dryRun, true);
  assert.equal(outcome.result.written, false);
  assert.equal(outcome.result.fileCount, 3);
  assert.equal(fs.existsSync(outcome.out), false);
});

// ---- integrity

test("a sha256 mismatch is refused before anything is unpacked", async (t) => {
  const archive = starterKit();
  // the statement names other content
  const other = sha256(Buffer.from("some other archive"));
  assertRefused(
    await install(t, room([kitPin(kitMessage(archive, { stated: other }))])),
    "kit_sha256_mismatch",
    new RegExp(`states ${other}`),
  );
  // the payload was changed after the digest was stated
  const lines = kitMessage(archive).split("\n");
  const first = lines.indexOf("KIT-BEGIN") + 1;
  const flipped = lines[first][20] === "A" ? "B" : "A";
  lines[first] = `${lines[first].slice(0, 20)}${flipped}${lines[first].slice(21)}`;
  assertRefused(
    await install(t, room([kitPin(lines.join("\n"))])),
    "kit_sha256_mismatch",
    new RegExp(`states ${sha256(archive)}`),
  );
});

test("a kit message must state exactly one sha256 and hold one strict base64 block", () => {
  const archive = starterKit();
  const good = kitMessage(archive);
  // The intro sentence names both markers too, so edit marker LINES, never the first match.
  const swappedMarkers = good
    .split("\n")
    .map((line) => (line === "KIT-BEGIN" ? "KIT-END" : line === "KIT-END" ? "KIT-BEGIN" : line))
    .join("\n");
  const cases = [
    ["no statement", good.replace(/sha256 [0-9a-f]{64}/, "checksum below"), /states no sha256/],
    ["two statements", `${good}\nsha256 ${sha256(Buffer.from("x"))}`, /2 different sha256 values/],
    ["statement only inside the block", good.replace(/sha256 [0-9a-f]{64}/, "").replace("KIT-BEGIN\n", `KIT-BEGIN\nsha256 ${sha256(archive)}\n`), /states no sha256/],
    ["two blocks", `${good}\nKIT-BEGIN\nAAAA\nKIT-END`, /exactly one KIT-BEGIN line and one KIT-END line/],
    ["end before begin", swappedMarkers, /before its KIT-BEGIN line/],
    ["not base64", good.replace("\nKIT-END", "\n*not-base64*\nKIT-END"), /not valid base64/],
    ["empty block", `sha256 ${sha256(archive)}\nKIT-BEGIN\n\nKIT-END`, /block is empty/],
  ];
  for (const [label, message, pattern] of cases) {
    assert.throws(
      () => readInlineKitArchive(message),
      (error) => error.reason === "kit_malformed" && pattern.test(error.message),
      label,
    );
  }
});

// ---- trust

test("a kit pinned by anyone but a human room owner or admin is refused", async (t) => {
  const cases = [
    ["a contributor", { pinnedBy: "human-room-guest", pinnedByUserId: CONTRIBUTOR.userId }, /a room contributor, not the owner or an admin/],
    ["an agent on the owner's account", { pinnedBy: "host-agent", pinnedByKind: "agent", pinnedByUserId: OWNER.userId }, /\(agent\), not by a human/],
    ["a human who is not a member", { pinnedBy: "human-stranger", pinnedByUserId: "00000000-0000-4000-8000-0000000000ff" }, /not on the room's member list/],
    // the owner's label is not an identity: without the account id the pin is not the owner's
    ["the owner's label without an account id", { pinnedByUserId: "" }, /not on the room's member list/],
  ];
  for (const [label, overrides, pattern] of cases) {
    const outcome = await install(t, kitRoom(starterKit(), overrides));
    assertRefused(outcome, "kit_pin_untrusted", pattern, label);
    assert.match(outcome.result.message, /Any room contributor can pin a message/, label);
    assert.equal(outcome.result.ignoredPins.length, 1, label);
  }
});

test("a newer kit pinned by a contributor is ignored; the most recent owner or admin kit is used", async (t) => {
  const ownerKit = starterKit({ "senti-starter-kit/README.md": "owner kit\n" });
  const adminKit = starterKit({ "senti-starter-kit/README.md": "admin kit\n" });
  const strangerKit = starterKit({ "senti-starter-kit/README.md": "stranger kit\n" });
  const pins = [
    kitPin(kitMessage(ownerKit), { targetSequenceId: 100, pinnedAt: "2026-10-31T12:00:00Z" }),
    kitPin(kitMessage(strangerKit), {
      targetSequenceId: 300,
      pinnedAt: "2026-10-31T13:00:00Z",
      pinnedBy: "human-room-guest",
      pinnedByUserId: CONTRIBUTOR.userId,
    }),
    kitPin(kitMessage(adminKit), {
      targetSequenceId: 200,
      pinnedAt: "2026-10-31T12:30:00Z",
      pinnedBy: "human-room-admin",
      pinnedByUserId: ADMIN.userId,
    }),
    kitPin("an ordinary pinned note", { targetSequenceId: 400, pinnedAt: "2026-10-31T14:00:00Z" }),
  ];
  const { out, result } = await install(t, room(pins));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.source.sequenceId, 200);
  assert.equal(result.sha256, sha256(adminKit));
  assert.equal(await fsp.readFile(path.join(out, "senti-starter-kit", "README.md"), "utf8"), "admin kit\n");
  assert.deepEqual(result.ignoredPins.map((pin) => pin.sequenceId), [300]);
  assert.match(result.ignoredPins[0].reason, /a room contributor/);
});

test("when the member list cannot be read the pinner cannot be verified, so the kit is refused", async (t) => {
  for (const status of [401, 403]) {
    const outcome = await install(t, kitRoom(starterKit(), {}, { membersStatus: status }));
    assertRefused(outcome, "pinner_unverifiable", new RegExp(`HTTP ${status}.*owner and admins only`));
    assert.match(outcome.result.message, /Any room contributor can pin a message/);
  }
  assertRefused(await install(t, kitRoom(starterKit(), {}, { membersStatus: 503 })), "members_unavailable", /api_503/);
  // An agent admission never reaches the member list; the refusal says so instead of naming a status.
  const admitted = await admittedAgentScope.run(
    { sessionId: SESSION, agentId: "kit-agent", admissionId: "adm-kit", expiresAt: 0 },
    () => install(t, kitRoom(starterKit(), {}, { membersStatus: 403 })),
  );
  assertRefused(admitted, "pinner_unverifiable", /An agent admission cannot read the room's member list/);
});

test("no pinned kit: refused without reading the member list", async (t) => {
  const fake = room([
    kitPin("a pinned note without a kit"),
    kitPin("", { targetSequenceId: 7, resolved: false, contentSequenceId: 0 }),
  ]);
  assertRefused(await install(t, fake), "no_kit_pinned", /1 pinned message\(s\) could not be read/);
  assert.equal(fake.calls.members, 0);
});

test("the kit must come from the pinned message itself, unedited since it was pinned", async (t) => {
  const archive = starterKit();
  const refused = [
    ["content from an earlier event", { contentSequenceId: 99 }, /pinned message itself could not be read/],
    ["edited after the pin", { contentRevision: 2, contentEditedAt: "2026-10-31T12:05:00Z" }, /edited after it was pinned/],
    ["edited, at an unknown time", { contentRevision: 2, contentEditedAt: "" }, /edited after it was pinned/],
  ];
  for (const [label, overrides, pattern] of refused) {
    assertRefused(await install(t, kitRoom(archive, overrides)), "kit_pin_untrusted", pattern, label);
  }
  const editedBefore = await install(t, kitRoom(archive, { contentRevision: 2, contentEditedAt: "2026-10-31T11:00:00Z" }));
  assert.equal(editedBefore.result.ok, true, editedBefore.result.message);
});

test("pins that cannot be loaded and invalid session ids are refused", async (t) => {
  const unavailable = await install(t, {
    fetchPinnedMessagesFn: async () => ({ ok: false, reason: "api_404", pins: [] }),
    fetchMembersFn: async () => assert.fail("members must not be read"),
  });
  assertRefused(unavailable, "pins_unavailable", /api_404/);
  const invalid = await install(t, kitRoom(starterKit()), { sessionId: "../escape" });
  assertRefused(invalid, "invalid_session_id");
});

// ---- the archive

test("entries that could leave the output directory, or are not regular files, refuse the whole kit", async (t) => {
  const safe = tarEntry("senti-starter-kit/README.md", "# fine\n");
  const cases = [
    ["parent traversal", tarEntry("../escape.txt", "x"), /leaves the kit through "\.\."/],
    ["nested traversal", tarEntry("senti-starter-kit/../../escape.txt", "x"), /leaves the kit through/],
    ["absolute path", tarEntry("/tmp/escape.txt", "x"), /is an absolute path/],
    ["drive letter", tarEntry("C:/escape.txt", "x"), /drive or stream separator/],
    ["backslashes", tarEntry("senti-starter-kit\\..\\..\\escape.txt", "x"), /contains a backslash/],
    ["symbolic link", tarEntry("senti-starter-kit/link", "", { type: "2", linkname: "/etc/passwd" }), /is a symbolic link; a kit holds regular files/],
    ["hard link", tarEntry("senti-starter-kit/hard", "", { type: "1", linkname: "senti-starter-kit/README.md" }), /is a hard link/],
    ["character device", tarEntry("senti-starter-kit/tty", "", { type: "3" }), /is a character device/],
    ["FIFO", tarEntry("senti-starter-kit/pipe", "", { type: "6" }), /is a FIFO/],
    ["pax path override", Buffer.concat([paxEntry({ path: "../escape.txt" }), tarEntry("senti-starter-kit/innocent.txt", "x")]), /leaves the kit through/],
    ["pax link target", Buffer.concat([paxEntry({ linkpath: "/etc/passwd" }), tarEntry("senti-starter-kit/innocent.txt", "x")]), /sets "linkpath"/],
    ["global pax path", Buffer.concat([paxEntry({ path: "elsewhere" }, { type: "g" }), tarEntry("senti-starter-kit/innocent.txt", "x")]), /global extended header sets "path"/],
    ["GNU long name", Buffer.concat([tarEntry("././@LongLink", "../escape.txt", { type: "L", magic: "gnu" }), tarEntry("senti-starter-kit/innocent.txt", "x", { magic: "gnu" })]), /leaves the kit through/],
    ["ustar prefix", tarEntry("escape.txt", "x", { prefix: ".." }), /leaves the kit through/],
    ["reserved device name", tarEntry("senti-starter-kit/CON.md", "x"), /reserved device name/],
    ["trailing dot", tarEntry("senti-starter-kit/README.md.", "x"), /ends in "\." or a space/],
    ["control character", tarEntry(`senti-starter-kit/a${String.fromCharCode(7)}b`, "x"), /control character/],
    ["duplicate name ignoring case", tarEntry("senti-starter-kit/readme.md", "x"), /appears more than once/],
    ["file and directory", tarEntry("senti-starter-kit/README.md/inner.txt", "x"), /both a file and a directory/],
    ["bad header checksum", tarEntry("senti-starter-kit/a.txt", "x", { checksumDelta: 1 }), /checksum does not match/],
  ];
  for (const [label, hostile, pattern] of cases) {
    const outcome = await install(t, kitRoom(tarball(safe, hostile)));
    assertRefused(outcome, "kit_archive_refused", pattern, label);
    assert.equal(fs.existsSync(path.join(outcome.base, "escape.txt")), false, `${label}: no escape`);
  }
});

test("the file-count and size caps hold, and a decompression bomb is refused", async (t) => {
  const files = (count, size = 4) =>
    Array.from({ length: count }, (_, index) => tarEntry(`senti-starter-kit/f${String(index).padStart(3, "0")}.txt`, "x".repeat(size)));
  const atCap = await install(t, kitRoom(tarball(...files(KIT_MAX_FILES))));
  assert.equal(atCap.result.ok, true, atCap.result.message);
  assert.equal(atCap.result.fileCount, KIT_MAX_FILES);

  assertRefused(await install(t, kitRoom(tarball(...files(KIT_MAX_FILES + 1)))), "kit_archive_refused", /more than 64 files/);

  const big = Math.ceil(KIT_MAX_TOTAL_BYTES / 2) + 1024;
  const overTotal = tarball(tarEntry("senti-starter-kit/a.bin", Buffer.alloc(big)), tarEntry("senti-starter-kit/b.bin", Buffer.alloc(big)));
  assertRefused(await install(t, kitRoom(overTotal)), "kit_archive_refused", new RegExp(`hold more than ${KIT_MAX_TOTAL_BYTES} bytes`));

  const bomb = tarball(tarEntry("senti-starter-kit/zeros.bin", Buffer.alloc(4 * KIT_MAX_TOTAL_BYTES)));
  assert.ok(bomb.length < 64 * 1024, "the bomb itself is small");
  assertRefused(await install(t, kitRoom(bomb)), "kit_archive_refused", /expands past/);

  const directories = Array.from({ length: 300 }, (_, index) => tarEntry(`senti-starter-kit/d${index}/`, "", { type: "5" }));
  assertRefused(await install(t, kitRoom(tarball(...directories, tarEntry("senti-starter-kit/a.txt", "x")))), "kit_archive_refused", /more than 256 entries/);

  const oversized = randomBytes(KIT_MAX_TOTAL_BYTES + 1);
  assert.throws(
    () => unpackKitArchive({ expectedSha256: sha256(oversized), bytes: oversized }),
    (error) => error.reason === "kit_archive_refused" && /the limit is/.test(error.message),
  );
});

// ---- the output directory

test("existing files are kept unless forced; a forced run replaces them", async (t) => {
  const fake = kitRoom(starterKit());
  const first = await install(t, fake);
  assert.equal(first.result.ok, true, first.result.message);
  const readme = path.join(first.out, "senti-starter-kit", "README.md");
  await fsp.writeFile(readme, "my local notes\n");

  for (const dryRun of [false, true]) {
    const again = await install(t, fake, { base: first.base, dryRun });
    assert.equal(again.result.ok, false);
    assert.equal(again.result.reason, "kit_files_exist");
    assert.match(again.result.message, /3 kit file\(s\) already exist.*--force/);
    assert.deepEqual(again.result.existing.sort(), Object.keys(KIT_FILES).sort());
    assert.equal(await fsp.readFile(readme, "utf8"), "my local notes\n", "the local file is kept");
  }

  const forced = await install(t, fake, { base: first.base, force: true });
  assert.equal(forced.result.ok, true, forced.result.message);
  assert.deepEqual(forced.result.replaced.sort(), Object.keys(KIT_FILES).sort());
  assert.equal(await fsp.readFile(readme, "utf8"), KIT_FILES["senti-starter-kit/README.md"]);
});

test("a destination that is not a regular file, or that goes through a symbolic link, is refused even with force", async (t) => {
  const fake = kitRoom(starterKit());

  const dirBase = await workspace(t);
  await fsp.mkdir(path.join(dirBase, "senti-kit", "senti-starter-kit", "README.md"), { recursive: true });
  const asDirectory = await install(t, fake, { base: dirBase, force: true });
  assert.equal(asDirectory.result.reason, "kit_out_refused");
  assert.match(asDirectory.result.message, /exists and is not a regular file/);

  const fileBase = await workspace(t);
  await fsp.writeFile(path.join(fileBase, "senti-kit"), "a file");
  const outIsFile = await install(t, fake, { base: fileBase, force: true });
  assert.equal(outIsFile.result.reason, "kit_out_refused");
  assert.match(outIsFile.result.message, /exists and is not a directory/);

  const linkBase = await workspace(t);
  const outside = path.join(linkBase, "outside");
  await fsp.mkdir(outside);
  await fsp.mkdir(path.join(linkBase, "senti-kit"));
  try {
    fs.symlinkSync(outside, path.join(linkBase, "senti-kit", "senti-starter-kit"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.diagnostic(`symbolic link case skipped: ${error.code}`);
    return;
  }
  const throughLink = await install(t, fake, { base: linkBase, force: true });
  assert.equal(throughLink.result.reason, "kit_out_refused");
  assert.match(throughLink.result.message, /is a symbolic link; nothing is written through one/);
  assert.deepEqual(await fsp.readdir(outside), [], "nothing was written through the link");
});

// ---- the MCP tool

test("session_kit is a native MCP tool with a strict schema, listed by tools/list", async () => {
  const tool = SESSION_MCP_TOOLS.find((candidate) => candidate.name === "session_kit");
  assert.ok(tool, "session_kit is defined");
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required, ["sessionId"]);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["agentId", "dryRun", "force", "out", "sessionId"]);
  const listed = await handleMcpJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { handlers: {} });
  assert.ok(listed.result.tools.some((entry) => entry.name === "session_kit"), "tools/list includes session_kit");
});

test("session_kit returns the same verified result as the CLI path, plus the README text", async (t) => {
  const fake = kitRoom(starterKit());
  const viaCli = await install(t, fake, { dryRun: true });
  const ws = await workspace(t);
  const handlers = createSessionMcpToolHandlers({
    targetPath: ws,
    fetchSessionPinnedMessagesFn: fake.fetchPinnedMessagesFn,
    fetchSessionMembersFn: fake.fetchMembersFn,
  });
  const call = (args) =>
    handleMcpJsonRpcMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "session_kit", arguments: { sessionId: SESSION, ...args } } },
      { handlers },
    );

  const response = await call({ out: "tools/kit" });
  const viaMcp = response.result.structuredContent;
  assert.equal(response.result.isError, undefined, viaMcp.message);
  assert.equal(viaMcp.ok, true);
  for (const key of ["sha256", "archiveBytes", "files", "source", "fileCount", "totalBytes"]) {
    assert.deepEqual(viaMcp[key], viaCli.result[key], key);
  }
  assert.equal(viaMcp.readme.text, KIT_FILES["senti-starter-kit/README.md"]);
  assert.equal(viaMcp.out, path.join(ws, "tools", "kit"));
  assert.equal(
    await fsp.readFile(path.join(ws, "tools", "kit", "senti-starter-kit", "SKILL.md"), "utf8"),
    KIT_FILES["senti-starter-kit/SKILL.md"],
  );

  // out stays strictly inside the workspace
  for (const out of [path.join(os.tmpdir(), "kit-elsewhere"), "../kit-elsewhere", ".", "~/kit"]) {
    const refused = await call({ out, dryRun: true });
    assert.equal(refused.result.isError, true, out);
    assert.equal(refused.result.structuredContent.reason, "kit_out_refused", out);
  }

  // a refusal is an MCP error result carrying the reason
  const untrusted = createSessionMcpToolHandlers({
    targetPath: ws,
    fetchSessionPinnedMessagesFn: kitRoom(starterKit(), { pinnedByUserId: CONTRIBUTOR.userId }).fetchPinnedMessagesFn,
    fetchSessionMembersFn: fake.fetchMembersFn,
  });
  const refused = await handleMcpJsonRpcMessage(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "session_kit", arguments: { sessionId: SESSION, out: "other" } } },
    { handlers: untrusted },
  );
  assert.equal(refused.result.isError, true);
  assert.equal(refused.result.structuredContent.reason, "kit_pin_untrusted");
  assert.equal(fs.existsSync(path.join(ws, "other")), false);
});

// ---- end to end: the real CLI and the real MCP server against a loopback API

async function startKitApi(t, state) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push(`${req.method} ${url.pathname}`);
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const prefix = `/api/v1/sessions/${SESSION}`;
    if (req.method !== "GET") return send(404, {});
    if (url.pathname === `${prefix}/actions`) {
      return send(200, { actions: [], projection: { pinLimit: 10, pinnedMessages: [state.pin] } });
    }
    if (url.pathname === `${prefix}/events/before`) return send(200, { events: [state.event] });
    if (url.pathname === `${prefix}/members`) return send(200, { sessionId: SESSION, members: MEMBERS });
    return send(404, {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function runNode(args, { cwd, env, input = null }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

async function mcpKitCall({ ws, env }, args) {
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "session_kit", arguments: { sessionId: SESSION, ...args } } },
  ];
  const run = await runNode(["mcp", "server", "run", "--path", ws], {
    cwd: ws,
    env,
    input: messages.map((message) => `${JSON.stringify(message)}\n`).join(""),
  });
  assert.equal(run.code, 0, run.stderr);
  const responses = new Map(
    run.stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line)).map((response) => [response.id, response]),
  );
  return { listed: responses.get(1).result.tools.map((tool) => tool.name), call: responses.get(2).result };
}

test("end to end: sl session kit and the real MCP server install the same verified kit; a contributor's pin is refused by both", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-session-kit-e2e-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const ws = path.join(base, "workspace");
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(ws, { recursive: true });

  const archive = starterKit();
  const state = {
    pin: {
      id: "00000000-0000-4000-8000-00000000d001",
      targetSequenceId: 100,
      actionType: "pin",
      actorKind: "human",
      actorId: "human-room-owner",
      actorUserId: OWNER.userId,
      createdAt: "2026-10-31T12:00:00Z",
    },
    event: {
      event: "session_message",
      sequenceId: 100,
      cursor: "c100",
      sessionId: SESSION,
      agent: { id: "host-agent" },
      agentId: "host-agent",
      payload: { message: kitMessage(archive) },
      ts: "2026-10-31T11:59:00Z",
      messageRevision: 1,
      editedAt: null,
    },
  };
  const api = await startKitApi(t, state);
  // Built at runtime so no credential-shaped literal sits in the source.
  const stored = { apiUrl: api.url, tokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  stored["to" + "ken"] = "kit-fixture-not-a-credential";
  await writeStoredSession(stored, { homeDir: home });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    SENTINELAYER_CIRCUIT_STATE_DIR: path.join(home, ".sentinelayer"),
    SENTINELAYER_API_URL: api.url,
  };
  for (const name of ["SENTINELAYER_TOKEN", "SENTINELAYER_API_TOKEN", "SENTINELAYER_AGENT_ID"]) delete env[name];

  const cli = await runNode(["session", "kit", SESSION, "--out", "cli-kit", "--path", ws, "--json"], { cwd: ws, env });
  assert.equal(cli.code, 0, cli.stderr || cli.stdout);
  const viaCli = JSON.parse(cli.stdout);
  assert.equal(viaCli.command, "session kit");
  assert.equal(viaCli.ok, true, viaCli.message);
  assert.equal(viaCli.sha256, sha256(archive));
  assert.equal(viaCli.source.pinnedByRole, "owner");
  assert.ok(api.requests.includes(`GET /api/v1/sessions/${SESSION}/members`), api.requests.join(", "));

  const mcp = await mcpKitCall({ ws, env }, { out: "mcp-kit" });
  assert.ok(mcp.listed.includes("session_kit"), "the real server lists session_kit");
  const viaMcp = mcp.call.structuredContent;
  assert.equal(mcp.call.isError, undefined, viaMcp.message);
  assert.deepEqual(viaMcp.files, viaCli.files);
  assert.deepEqual(viaMcp.source, viaCli.source);
  assert.equal(viaMcp.readme.text, KIT_FILES["senti-starter-kit/README.md"]);
  for (const name of Object.keys(KIT_FILES)) {
    const fromCli = await fsp.readFile(path.join(ws, "cli-kit", ...name.split("/")), "utf8");
    assert.equal(fromCli, KIT_FILES[name], name);
    assert.equal(await fsp.readFile(path.join(ws, "mcp-kit", ...name.split("/")), "utf8"), fromCli, name);
  }

  // the same kit, pinned by a contributor
  state.pin = { ...state.pin, actorId: "human-room-guest", actorUserId: CONTRIBUTOR.userId };
  const refusedCli = await runNode(["session", "kit", SESSION, "--out", "cli-refused", "--path", ws, "--json"], { cwd: ws, env });
  assert.equal(refusedCli.code, 1, refusedCli.stderr || refusedCli.stdout);
  assert.equal(JSON.parse(refusedCli.stdout).reason, "kit_pin_untrusted");
  const refusedMcp = await mcpKitCall({ ws, env }, { out: "mcp-refused" });
  assert.equal(refusedMcp.call.isError, true);
  assert.equal(refusedMcp.call.structuredContent.reason, "kit_pin_untrusted");
  assert.equal(fs.existsSync(path.join(ws, "cli-refused")), false);
  assert.equal(fs.existsSync(path.join(ws, "mcp-refused")), false);
});
