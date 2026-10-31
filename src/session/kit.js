// kit.js -- a room's starter kit: find it in a pinned message, verify it, and unpack it safely.
//
// A kit is a gzip'd tar, base64-encoded between a "KIT-BEGIN" line and a "KIT-END" line of a
// pinned message whose text also states the archive's digest ("sha256 <64 hex digits>").
//
// Trust. Any room contributor can pin a message, so a pin alone proves nothing. A kit is used
// only from a pin set by a HUMAN whose account is the room's owner or an admin on the room's
// member list, matched by account id (a display label is not an identity). The pinned message
// must be exactly the pinned sequence and must not have been edited after it was pinned. The
// most recent such pin wins; kit pins that fail the check are reported and never used.
//
// Integrity and safety. The decoded archive must match the stated sha256 before it is read at
// all. The tar is read in memory by a minimal reader that accepts regular files and directories
// only: no links, devices, absolute paths, "..", backslashes, drive letters or reserved device
// names; at most KIT_MAX_FILES files and KIT_MAX_TOTAL_BYTES of content. Every entry and every
// destination is checked before the first byte is written. An existing file is replaced only
// with force, nothing is written through a symbolic link, and tar modes and owners are ignored.
//
// Sources. Today the archive is inline in the pinned message (readInlineKitArchive). Another
// source, such as a file attached to the pinned message, only has to produce the same
// { kind, expectedSha256, bytes }: unpackKitArchive() verifies and reads every source the same way.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

import { currentAdmittedAgent } from "./admission-auth.js";
import { normalizeSessionId } from "./paths.js";
import { fetchSessionMembers, fetchSessionPinnedMessages } from "./sync.js";

export const KIT_DEFAULT_OUT_DIR = "senti-kit";
export const KIT_MAX_FILES = 64;
export const KIT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const KIT_TRUSTED_PINNER_ROLES = Object.freeze(["owner", "admin"]);

const KIT_BEGIN = "KIT-BEGIN";
const KIT_END = "KIT-END";
// The compressed archive never needs to be larger than the content it unpacks to.
const KIT_MAX_ARCHIVE_BYTES = KIT_MAX_TOTAL_BYTES;
// Headers of every kind, so a hostile archive cannot keep the reader busy with empty entries.
const KIT_MAX_TAR_ENTRIES = 256;
const TAR_BLOCK = 512;
// The tar stream: the content limit plus a header and padding per entry and the end blocks.
const KIT_MAX_TAR_BYTES = KIT_MAX_TOTAL_BYTES + 2 * TAR_BLOCK * KIT_MAX_TAR_ENTRIES + 20 * TAR_BLOCK;
const README_MAX_CHARS = 16_000;
const SHA256_STATEMENT = /\bsha-?256\b[\s:=`]*([0-9a-f]{64})(?![0-9a-z])/gi;
const BASE64_TEXT = /^[A-Za-z0-9+/]+={0,2}$/;
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\..*)?$/i;
const POSIX_USTAR_MAGIC = "ustar\x00";
const TAR_TYPE_DESCRIPTIONS = Object.freeze({
  1: "a hard link",
  2: "a symbolic link",
  3: "a character device",
  4: "a block device",
  6: "a FIFO",
  7: "a contiguous file",
  K: "a long link name",
  M: "a multi-volume continuation",
  S: "a sparse file",
  V: "a volume label",
});
const PIN_TRUST_RULE =
  "Any room contributor can pin a message, so a kit is installed only when a human room owner or admin pinned it.";

/** A refusal with a stable machine-readable reason; installSessionKit turns it into a result. */
export class KitRefusal extends Error {
  constructor(reason, message, details = {}) {
    super(message);
    this.name = "KitRefusal";
    this.reason = reason;
    this.details = details;
  }
}

function refuse(reason, message, details) {
  throw new KitRefusal(reason, message, details);
}

function refuseArchive(problem) {
  refuse("kit_archive_refused", `The kit archive was refused: ${problem}. Nothing was unpacked.`);
}

function text(value) {
  return String(value ?? "").trim();
}

function quoteName(name) {
  const value = String(name ?? "");
  return JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}...` : value);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---- the inline source: a kit block in the pinned message's text

function kitMarkerLines(lines, marker) {
  const found = [];
  lines.forEach((line, index) => {
    if (line.trim() === marker) found.push(index);
  });
  return found;
}

/** True when a message has KIT-BEGIN and KIT-END lines, so it is meant to carry a kit. */
export function hasKitBlock(message) {
  const lines = String(message ?? "").split(/\r?\n/);
  return kitMarkerLines(lines, KIT_BEGIN).length > 0 && kitMarkerLines(lines, KIT_END).length > 0;
}

/**
 * The archive an inline kit message carries and the sha256 it states. Refuses a message without
 * exactly one KIT-BEGIN line followed by one KIT-END line, one that states no sha256 or several
 * different ones outside the block, and a block that is not strict base64. Whitespace and CRLF
 * line breaks inside the block are ignored.
 */
export function readInlineKitArchive(message) {
  const lines = String(message ?? "").split(/\r?\n/);
  const begins = kitMarkerLines(lines, KIT_BEGIN);
  const ends = kitMarkerLines(lines, KIT_END);
  if (begins.length !== 1 || ends.length !== 1) {
    refuse(
      "kit_malformed",
      `The kit message must hold exactly one ${KIT_BEGIN} line and one ${KIT_END} line (it has ${begins.length} and ${ends.length}).`,
    );
  }
  const [begin] = begins;
  const [end] = ends;
  if (end < begin) refuse("kit_malformed", `The kit message has its ${KIT_END} line before its ${KIT_BEGIN} line.`);
  const outside = [...lines.slice(0, begin), ...lines.slice(end + 1)].join("\n");
  const stated = new Set([...outside.matchAll(SHA256_STATEMENT)].map((match) => match[1].toLowerCase()));
  if (stated.size === 0) {
    refuse("kit_malformed", "The kit message states no sha256 (\"sha256 <64 hex digits>\" outside the kit block).");
  }
  if (stated.size > 1) {
    refuse("kit_malformed", `The kit message states ${stated.size} different sha256 values; refusing to guess which is the kit's.`);
  }
  const encoded = lines.slice(begin + 1, end).join("").replace(/\s+/g, "");
  if (!encoded) refuse("kit_malformed", "The kit block is empty.");
  if (encoded.length % 4 !== 0 || !BASE64_TEXT.test(encoded)) {
    refuse("kit_malformed", "The kit block is not valid base64.");
  }
  return { kind: "inline", expectedSha256: [...stated][0], bytes: Buffer.from(encoded, "base64") };
}

// ---- verification and the tar reader, shared by every source

/**
 * Verify a kit archive against the sha256 its publisher stated, then read it. Nothing in the
 * archive is decompressed or parsed before the digest matches.
 */
export function unpackKitArchive({ expectedSha256, bytes } = {}) {
  const expected = text(expectedSha256).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) refuse("kit_malformed", "The kit's stated sha256 is not 64 hex digits.");
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) refuse("kit_malformed", "The kit archive is empty.");
  if (bytes.length > KIT_MAX_ARCHIVE_BYTES) {
    refuseArchive(`it is ${bytes.length} bytes and the limit is ${KIT_MAX_ARCHIVE_BYTES}`);
  }
  const actual = sha256Hex(bytes);
  if (actual !== expected) {
    refuse(
      "kit_sha256_mismatch",
      `The kit archive's sha256 is ${actual}, but the pinned message states ${expected}. Nothing was unpacked.`,
    );
  }
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) refuseArchive("it is not gzip data");
  let tar;
  try {
    tar = zlib.gunzipSync(bytes, { maxOutputLength: KIT_MAX_TAR_BYTES });
  } catch (error) {
    refuseArchive(
      error?.code === "ERR_BUFFER_TOO_LARGE" ? `it expands past ${KIT_MAX_TAR_BYTES} bytes` : "it is not valid gzip data",
    );
  }
  return { sha256: actual, archiveBytes: bytes.length, entries: readKitTar(tar) };
}

function cString(buffer, start, length) {
  const field = buffer.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}

function tarNumber(header, start, length, label) {
  const field = header.subarray(start, start + length);
  if (field[0] & 0x80) refuseArchive(`${label} uses the base-256 encoding for very large values`);
  const digits = cString(field, 0, field.length).trim();
  if (digits === "") return 0;
  if (!/^[0-7]+$/.test(digits)) refuseArchive(`${label} is not an octal number`);
  return Number.parseInt(digits, 8);
}

function tarChecksumMatches(header) {
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum === tarNumber(header, 148, 8, "a header checksum");
}

function tarHeaderName(header) {
  const name = cString(header, 0, 100);
  // POSIX ustar splits a long name into a prefix; GNU tar ("ustar " magic) uses that area otherwise.
  if (header.subarray(257, 263).toString("latin1") !== POSIX_USTAR_MAGIC) return name;
  const prefix = cString(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function readPaxRecords(data) {
  const records = new Map();
  let offset = 0;
  while (offset < data.length && data[offset] !== 0) {
    const space = data.indexOf(0x20, offset);
    const lengthText = space > offset ? data.subarray(offset, space).toString("latin1") : "";
    const end = offset + Number(lengthText);
    if (!/^[0-9]+$/.test(lengthText) || !(end > space + 1) || end > data.length || data[end - 1] !== 0x0a) {
      refuseArchive("an extended header is malformed");
    }
    const record = data.subarray(space + 1, end - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) refuseArchive("an extended header is malformed");
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset = end;
  }
  return records;
}

/**
 * The path segments an entry name unpacks to, or a refusal. "." segments and empty segments are
 * dropped ("./a//b" is "a/b"); everything that could leave the output directory, alias another
 * name on Windows or reach a device is refused.
 */
function kitEntrySegments(name, { directory = false } = {}) {
  const shown = quoteName(name);
  if (CONTROL_CHARACTER.test(name)) refuseArchive(`${shown} contains a control character`);
  if (name.includes("\\")) refuseArchive(`${shown} contains a backslash`);
  if (name.startsWith("/")) refuseArchive(`${shown} is an absolute path`);
  if (name.includes(":")) refuseArchive(`${shown} contains ":", a drive or stream separator`);
  const segments = name.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) refuseArchive(`${shown} leaves the kit through ".."`);
  for (const segment of segments) {
    if (WINDOWS_RESERVED_NAME.test(segment)) refuseArchive(`${shown} uses the reserved device name ${quoteName(segment)}`);
    if (/[. ]$/.test(segment)) refuseArchive(`${shown} has a name that ends in "." or a space`);
  }
  if (segments.length === 0 && !directory) refuseArchive("a file entry has an empty name");
  return segments;
}

function assertNoPathCollisions(entries) {
  const files = new Map();
  const directories = new Set();
  for (const entry of entries) {
    const key = entry.path.toLowerCase();
    const parts = key.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) directories.add(parts.slice(0, depth).join("/"));
    if (entry.type === "directory") {
      directories.add(key);
      continue;
    }
    if (files.has(key)) refuseArchive(`${quoteName(entry.path)} appears more than once (names are compared ignoring case)`);
    files.set(key, entry.path);
  }
  for (const [key, original] of files) {
    if (directories.has(key)) refuseArchive(`${quoteName(original)} is both a file and a directory`);
  }
}

/** Regular files and directories from an uncompressed tar, every name and limit checked. */
function readKitTar(tar) {
  const entries = [];
  let offset = 0;
  let headers = 0;
  let files = 0;
  let totalBytes = 0;
  let longName = null;
  let ended = false;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) {
      ended = true;
      break;
    }
    headers += 1;
    if (headers > KIT_MAX_TAR_ENTRIES) refuseArchive(`it has more than ${KIT_MAX_TAR_ENTRIES} entries`);
    if (!tarChecksumMatches(header)) refuseArchive("a tar header checksum does not match");
    const size = tarNumber(header, 124, 12, "an entry size");
    const typeflag = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const dataStart = offset + TAR_BLOCK;
    if (dataStart + size > tar.length) refuseArchive("it is truncated");
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    // Extended headers name the next entry; anything that would change a size or a link is refused.
    if (typeflag === "x" || typeflag === "g") {
      const records = readPaxRecords(data);
      for (const key of ["linkpath", "size"]) {
        if (records.has(key)) refuseArchive(`an extended header sets "${key}"`);
      }
      if (typeflag === "g") {
        if (records.has("path")) refuseArchive('a global extended header sets "path"');
        continue;
      }
      if (records.has("path")) longName = records.get("path");
      continue;
    }
    if (typeflag === "L") {
      longName = cString(data, 0, data.length);
      continue;
    }

    const name = longName ?? tarHeaderName(header);
    longName = null;
    if (typeflag !== "0" && typeflag !== "5") {
      const kind = TAR_TYPE_DESCRIPTIONS[typeflag] || `an unsupported entry (type ${JSON.stringify(typeflag)})`;
      refuseArchive(`${quoteName(name)} is ${kind}; a kit holds regular files and directories only`);
    }
    // Old tar writers mark a directory with a trailing "/" instead of its own type.
    const directory = typeflag === "5" || (name.endsWith("/") && size === 0);
    const segments = kitEntrySegments(name, { directory });
    if (directory) {
      if (segments.length > 0) entries.push({ type: "directory", path: segments.join("/") });
      continue;
    }
    files += 1;
    if (files > KIT_MAX_FILES) refuseArchive(`it has more than ${KIT_MAX_FILES} files`);
    totalBytes += size;
    if (totalBytes > KIT_MAX_TOTAL_BYTES) refuseArchive(`its files hold more than ${KIT_MAX_TOTAL_BYTES} bytes`);
    entries.push({ type: "file", path: segments.join("/"), data: Buffer.from(data) });
  }
  if (longName !== null) refuseArchive("an extended header is not followed by an entry");
  if (!ended && offset < tar.length) refuseArchive("it ends inside a header block");
  if (files === 0) refuseArchive("it contains no files");
  assertNoPathCollisions(entries);
  return entries;
}

// ---- which pinned kit to trust

function pinTimeMs(pin) {
  const time = Date.parse(text(pin.pinnedAt));
  return Number.isFinite(time) ? time : 0;
}

function editedAfterPinning(pin) {
  const editedAt = Date.parse(text(pin.contentEditedAt));
  if (!Number.isFinite(editedAt)) return (Number(pin.contentRevision) || 1) > 1;
  const pinnedAt = Date.parse(text(pin.pinnedAt));
  return !Number.isFinite(pinnedAt) || editedAt > pinnedAt;
}

/** Why a kit pin is not trusted, or "" when it is. */
function kitPinProblem(pin, members) {
  const who = text(pin.pinnedBy) || "an unknown account";
  const kind = text(pin.pinnedByKind).toLowerCase();
  if (kind !== "human") return `it was pinned by ${who} (${kind || "unknown kind"}), not by a human`;
  const userId = text(pin.pinnedByUserId);
  const member = userId ? members.get(userId) : null;
  if (!member) return `it was pinned by ${who}, whose account is not on the room's member list`;
  if (!KIT_TRUSTED_PINNER_ROLES.includes(member.role)) {
    return `it was pinned by ${who}, a room ${member.role || "member"}, not the owner or an admin`;
  }
  if (Number(pin.contentSequenceId) !== Number(pin.targetSequenceId)) return "the pinned message itself could not be read";
  if (editedAfterPinning(pin)) return "the message was edited after it was pinned";
  return "";
}

function membersUnreadableMessage(status) {
  const who = currentAdmittedAgent()
    ? "An agent admission cannot read the room's member list"
    : `This account cannot read the room's member list (HTTP ${status}); the API shows it to the room owner and admins only`;
  return `Cannot check who pinned the kit. ${who}. ${PIN_TRUST_RULE} Run sl session kit from the room owner's or an admin's own account.`;
}

async function locateTrustedKitPin(sessionId, { targetPath, fetchPinnedMessagesFn, fetchMembersFn }) {
  const pinned = await fetchPinnedMessagesFn(sessionId, { targetPath });
  if (!pinned?.ok) {
    refuse("pins_unavailable", `Could not load the pinned messages of session ${sessionId} (${text(pinned?.reason) || "unknown"}).`);
  }
  const pins = (Array.isArray(pinned.pins) ? pinned.pins : []).filter((pin) => pin && typeof pin === "object");
  const kitPins = pins
    .filter((pin) => pin.resolved === true && hasKitBlock(pin.content))
    .sort((a, b) => pinTimeMs(b) - pinTimeMs(a) || (Number(b.targetSequenceId) || 0) - (Number(a.targetSequenceId) || 0));
  if (kitPins.length === 0) {
    const unread = pins.filter((pin) => pin.resolved !== true).length;
    refuse(
      "no_kit_pinned",
      `No pinned message in session ${sessionId} carries a starter kit (a ${KIT_BEGIN} ... ${KIT_END} block)` +
        `${unread ? `; ${unread} pinned message(s) could not be read` : ""}.`,
    );
  }

  const roster = await fetchMembersFn(sessionId, { targetPath });
  if (!roster?.ok) {
    const status = Number(roster?.status) || 0;
    if (status === 401 || status === 403) refuse("pinner_unverifiable", membersUnreadableMessage(status));
    refuse(
      "members_unavailable",
      `Could not load the room's member list to check who pinned the kit (${text(roster?.reason) || "unknown"}).`,
    );
  }
  const members = new Map();
  for (const member of Array.isArray(roster.members) ? roster.members : []) {
    const userId = text(member?.userId);
    if (userId) members.set(userId, { role: text(member.role).toLowerCase() });
  }

  const assessed = kitPins.map((pin) => ({ pin, problem: kitPinProblem(pin, members) }));
  const ignoredPins = assessed
    .filter((item) => item.problem)
    .map(({ pin, problem }) => ({
      sequenceId: Number(pin.targetSequenceId) || 0,
      pinnedBy: text(pin.pinnedBy),
      pinnedAt: text(pin.pinnedAt),
      reason: problem,
    }));
  const chosen = assessed.find((item) => !item.problem);
  if (!chosen) {
    const problems = ignoredPins.map((item) => `#${item.sequenceId}: ${item.reason}`).join("; ");
    refuse("kit_pin_untrusted", `Refusing the pinned kit (${problems}). ${PIN_TRUST_RULE}`, { ignoredPins });
  }
  return { pin: chosen.pin, role: members.get(text(chosen.pin.pinnedByUserId)).role, ignoredPins };
}

// ---- where the kit goes

function realpathOfNearestExisting(target) {
  let current = target;
  for (;;) {
    try {
      return fs.realpathSync.native(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * The output directory. A confined one (the MCP tool's) must be a relative directory strictly
 * inside the workspace that does not leave it through a symbolic link.
 */
function resolveKitOutDir(out, { base, confine }) {
  const raw = text(out) || KIT_DEFAULT_OUT_DIR;
  const root = path.resolve(base);
  if (!confine) return path.resolve(root, raw);
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith("~")) {
    refuse("kit_out_refused", "out must be a relative directory inside the workspace.");
  }
  const outDir = path.resolve(root, raw);
  if (
    path.relative(root, outDir) === "" ||
    !isInside(root, outDir) ||
    !isInside(realpathOfNearestExisting(root), realpathOfNearestExisting(outDir))
  ) {
    refuse("kit_out_refused", "out must name a directory inside the workspace, not the workspace itself, and must not leave it.");
  }
  return outDir;
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

/** Check every destination before anything is written; returns the kit files that already exist. */
function planKitWrite(entries, outDir, { force }) {
  let outStat = null;
  try {
    outStat = fs.statSync(outDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (outStat && !outStat.isDirectory()) refuse("kit_out_refused", `${outDir} exists and is not a directory.`);
  const existing = [];
  for (const entry of entries) {
    const segments = entry.path.split("/");
    const destination = path.join(outDir, ...segments);
    if (path.relative(outDir, destination) === "" || !isInside(outDir, destination)) {
      refuse("kit_out_refused", `${quoteName(entry.path)} does not stay inside ${outDir}.`);
    }
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const current = path.join(outDir, ...segments.slice(0, depth));
      const stat = lstatOrNull(current);
      if (!stat) break;
      if (stat.isSymbolicLink()) refuse("kit_out_refused", `${current} is a symbolic link; nothing is written through one.`);
      if (depth < segments.length || entry.type === "directory") {
        if (!stat.isDirectory()) refuse("kit_out_refused", `${current} exists and is not a directory.`);
        continue;
      }
      if (!stat.isFile()) refuse("kit_out_refused", `${current} exists and is not a regular file.`);
      existing.push(entry.path);
    }
  }
  if (existing.length > 0 && !force) {
    const sample = `${existing.slice(0, 3).join(", ")}${existing.length > 3 ? ", ..." : ""}`;
    refuse(
      "kit_files_exist",
      `${existing.length} kit file(s) already exist in ${outDir} (${sample}). Nothing was written. ` +
        "Use --force (force: true over MCP) to replace them, or choose another output directory.",
      { existing },
    );
  }
  return { existing };
}

function writeKitFiles(entries, outDir, { replace }) {
  const replacing = new Set(replace);
  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of entries) {
    const destination = path.join(outDir, ...entry.path.split("/"));
    if (entry.type === "directory") {
      fs.mkdirSync(destination, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    // Only a file planned for replacement (checked above to be a regular file) is removed first;
    // every file is then created exclusively, so nothing that appeared since is overwritten.
    if (replacing.has(entry.path)) fs.rmSync(destination);
    fs.writeFileSync(destination, entry.data, { flag: "wx" });
  }
}

function kitReadme(entries, outDir) {
  const [readme] = entries
    .filter((entry) => entry.type === "file" && path.posix.basename(entry.path).toLowerCase() === "readme.md")
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length || compareStrings(a.path, b.path));
  if (!readme) return null;
  const content = readme.data.toString("utf8");
  return {
    path: readme.path,
    file: path.join(outDir, ...readme.path.split("/")),
    text: content.slice(0, README_MAX_CHARS),
    truncated: content.length > README_MAX_CHARS,
  };
}

/**
 * Fetch the room's pinned starter kit, verify it and unpack it into `out` (relative to
 * `outBase`). Returns { ok: true, files, readme, ... } or { ok: false, reason, message }; only
 * unexpected I/O errors throw. With dryRun everything is checked and nothing is written.
 */
export async function installSessionKit({
  sessionId,
  targetPath = process.cwd(),
  out = KIT_DEFAULT_OUT_DIR,
  outBase = process.cwd(),
  confineOut = false,
  force = false,
  dryRun = false,
  fetchPinnedMessagesFn = fetchSessionPinnedMessages,
  fetchMembersFn = fetchSessionMembers,
} = {}) {
  const summary = { sessionId: text(sessionId), dryRun: Boolean(dryRun) };
  let id;
  try {
    id = normalizeSessionId(sessionId);
  } catch (error) {
    return { ok: false, ...summary, reason: "invalid_session_id", message: text(error?.message) || "sessionId is invalid." };
  }
  try {
    const outDir = resolveKitOutDir(out, { base: outBase, confine: confineOut });
    const { pin, role, ignoredPins } = await locateTrustedKitPin(id, { targetPath, fetchPinnedMessagesFn, fetchMembersFn });
    const archive = readInlineKitArchive(pin.content);
    const { sha256, archiveBytes, entries } = unpackKitArchive(archive);
    const { existing } = planKitWrite(entries, outDir, { force: Boolean(force) });
    if (!dryRun) writeKitFiles(entries, outDir, { replace: existing });
    const files = entries
      .filter((entry) => entry.type === "file")
      .map((entry) => ({ path: entry.path, bytes: entry.data.length, sha256: sha256Hex(entry.data) }))
      .sort((a, b) => compareStrings(a.path, b.path));
    return {
      ok: true,
      reason: "",
      ...summary,
      sessionId: id,
      written: !dryRun,
      out: outDir,
      source: {
        kind: "pinned-message",
        archive: archive.kind,
        sequenceId: Number(pin.targetSequenceId) || 0,
        pinnedBy: text(pin.pinnedBy),
        pinnedByKind: text(pin.pinnedByKind),
        pinnedByRole: role,
        pinnedAt: text(pin.pinnedAt),
        author: text(pin.author),
      },
      sha256,
      archiveBytes,
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      files,
      replaced: existing,
      readme: kitReadme(entries, outDir),
      ignoredPins,
    };
  } catch (error) {
    if (error instanceof KitRefusal) {
      return { ok: false, ...summary, sessionId: id, reason: error.reason, message: error.message, ...error.details };
    }
    throw error;
  }
}
