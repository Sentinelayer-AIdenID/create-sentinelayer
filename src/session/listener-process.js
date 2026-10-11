import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { isProcessAlive } from "./daemon-spawn.js";
import { normalizeSessionId, resolveSessionChildDir, resolveSessionPaths } from "./paths.js";

const LISTENER_DIR_NAME = "listeners";
const GLOBAL_LISTENER_DIR_NAME = "session-listeners";
const execFileAsync = promisify(execFile);

// Time allowed for one scan of the process table. A busy machine can need longer than the
// first limit, so a caller that must not guess (the one-listener check in `session listen`)
// retries once with the longer one before it reports the check as incomplete.
export const LISTENER_PROCESS_SCAN_TIMEOUT_MS = 3_000;
export const LISTENER_PROCESS_SCAN_RETRY_TIMEOUT_MS = 10_000;

function normalizeString(value) {
  return String(value || "").trim();
}

export function normalizeListenerProcessKey(agentId = "") {
  return (
    normalizeString(agentId)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent"
  );
}

function normalizeCommandLine(value) {
  return normalizeString(value).toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The CLI's entry points as package.json "bin" declares them (a test keeps the two in step):
// the scripts node runs, and the command names npm links to them.
const CLI_ENTRY_SCRIPTS = ["create-sentinelayer.js", "sentinelayer-cli.js", "sl.js"];
const CLI_COMMAND_NAMES = ["create-sentinelayer", "sentinel", "sentinelayer-cli", "sl-cli", "slc", "sl"];

/**
 * The one test of "this command line runs this CLI": an argument that is a path ending in an
 * entry point (a path separator, the entry name, then the end of the argument). So
 * `.../bin/create-sentinelayer.js` counts, but `xcreate-sentinelayer.js`,
 * `create-sentinelayer.json` and a directory named after a command do not.
 *
 * On POSIX, npm links each command name to its script and the kernel hands node the link path
 * (`node /usr/local/bin/sl ...`), so the command names count there too. On Windows npm's shims
 * start node on the script itself, and the sh shim Git Bash runs stays alive as node's parent
 * with only the command name on its command line, so there only the scripts count.
 *
 * The pattern is valid in JavaScript and in .NET (the Windows scan runs it in PowerShell), and
 * writes its quotes as \x22 and \x27 so it can sit inside a quoted PowerShell string.
 */
function cliEntryPattern(platform) {
  const entries =
    platform === "win32" ? CLI_ENTRY_SCRIPTS : [...CLI_ENTRY_SCRIPTS, ...CLI_COMMAND_NAMES];
  return `[\\\\/](?:${entries.map(escapeRegExp).join("|")})(?=$|[\\s\\x22\\x27])`;
}

function commandLineFlagValueMatches(commandLine, flagName, expectedValue) {
  const expected = normalizeString(expectedValue).toLowerCase();
  if (!expected) return { found: false, matches: true };
  const pattern = new RegExp(
    `(?:^|\\s)--${escapeRegExp(flagName)}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s]+))`,
    "gi",
  );
  let found = false;
  for (const match of commandLine.matchAll(pattern)) {
    found = true;
    const value = normalizeString(match[1] ?? match[2] ?? match[3]).toLowerCase();
    if (value === expected) {
      return { found: true, matches: true };
    }
  }
  return { found, matches: false };
}

/**
 * Whether a command line is `session listen` for this session and agent, run through any of
 * this CLI's entry points. `platform` is the system the command line was read on.
 */
export function listenerCommandLineMatches(
  commandLine,
  { sessionId = "", agentId = "", platform = process.platform } = {},
) {
  const rawCommandLine = normalizeString(commandLine);
  const normalized = normalizeCommandLine(rawCommandLine);
  if (!normalized) return false;
  const normalizedSessionId = normalizeString(sessionId).toLowerCase();
  const normalizedAgentId = normalizeString(agentId).toLowerCase();
  const hasCliEntry = new RegExp(cliEntryPattern(platform)).test(normalized);
  const sessionFlagMatch = commandLineFlagValueMatches(rawCommandLine, "session", normalizedSessionId);
  const agentFlagMatch = commandLineFlagValueMatches(rawCommandLine, "agent", normalizedAgentId);
  return (
    hasCliEntry &&
    normalized.includes("session") &&
    normalized.includes("listen") &&
    (!normalizedSessionId ||
      (sessionFlagMatch.found
        ? sessionFlagMatch.matches
        : normalized.includes(normalizedSessionId))) &&
    (!normalizedAgentId ||
      (agentFlagMatch.found
        ? agentFlagMatch.matches
        : normalized.includes(normalizedAgentId)))
  );
}

function optionalPositiveNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

// A row is { pid, commandLine, ppid, startedAtMs }. `ppid` (the parent's pid) and
// `startedAtMs` (when the process was created) are null when the scan did not give them.
function normalizeProcessRows(rows = []) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      pid: Number(row?.pid ?? row?.ProcessId ?? row?.processId),
      commandLine: normalizeString(row?.commandLine ?? row?.CommandLine ?? row?.command ?? row?.args),
      ppid: optionalPositiveNumber(row?.ppid ?? row?.ParentProcessId),
      startedAtMs: optionalPositiveNumber(row?.startedAtMs ?? row?.CreationMs),
    }))
    .filter((row) => Number.isInteger(row.pid) && row.pid > 0 && row.commandLine);
}

// Win32_Process.CreationDate as milliseconds since the epoch, for a PowerShell expression.
const WINDOWS_CREATION_MS = "if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";

async function listWindowsProcesses({ timeoutMs }) {
  const command = [
    "$ErrorActionPreference = 'Stop';",
    "$rows = Get-CimInstance Win32_Process |",
    `Where-Object { $_.CommandLine -and ($_.CommandLine -match '${cliEntryPattern("win32")}') } |`,
    `Select-Object ProcessId,ParentProcessId,CommandLine,@{n='CreationMs';e={ ${WINDOWS_CREATION_MS} }};`,
    "if ($rows) { $rows | ConvertTo-Json -Compress }",
  ].join(" ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
  );
  const text = normalizeString(stdout);
  if (!text) return [];
  const parsed = JSON.parse(text);
  return normalizeProcessRows(Array.isArray(parsed) ? parsed : [parsed]);
}

// No creation times here: on POSIX a parent link needs none (see listenerAncestorPids).
async function listPosixProcesses({ timeoutMs }) {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,command="], {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      return match
        ? { pid: Number(match[1]), ppid: Number(match[2]), commandLine: normalizeString(match[3]) }
        : null;
    })
    .filter(Boolean);
}

// How far up the parent chain the walk goes. Real launch chains are a handful deep.
const MAX_ANCESTOR_DEPTH = 64;

// Whether `parent` (the row at `child`'s recorded parent pid) is still the process that
// started `child`. A parent is always created before its child, so a "parent" created after
// it holds a reused pid. On POSIX a recorded parent is always the live parent, because an
// exiting process's children are re-parented to init or a subreaper; so with no creation
// times the link holds there. Windows never re-parents: the parent pid of a child whose
// parent exited can name any process started since, so there a link holds only when both
// creation times are known and in order.
function parentLinkHolds(parent, child, platform) {
  if (parent.startedAtMs !== null && child.startedAtMs !== null) {
    return parent.startedAtMs <= child.startedAtMs;
  }
  return platform !== "win32";
}

/**
 * The pids of a process's ancestors in one scan of the process table: its parent, that
 * process's parent, and so on, while each parent is in the table, still the process that
 * started its child (parentLinkHolds), not seen before (a cycle), and within
 * MAX_ANCESTOR_DEPTH. The walk starts at the parent the table records for `pid`, or at
 * `parentPid` when the table records none.
 *
 * A launcher that carries the whole command (`bash -c "node .../bin/sl.js session listen
 * ..."`, nohup, timeout, the nested shells an agent's shell tool runs) matches the listener
 * pattern as the listener itself does. These are the processes the listener checks must not
 * count: the listener being started is their child, not their duplicate.
 *
 * What the walk cannot see on Windows: Git Bash (MSYS) starts an MSYS program such as bash,
 * nohup or timeout from a forked copy of the shell, and that copy exits once the program
 * runs. The program's parent pid then names no live process, so the walk ends there, and a
 * shell above that point whose command line carries the listen command is still counted.
 */
export function listenerAncestorPids(
  rows,
  { pid = process.pid, parentPid = null, platform = process.platform } = {},
) {
  const table = new Map(normalizeProcessRows(rows).map((row) => [row.pid, row]));
  const selfPid = Number(pid);
  let child = table.get(selfPid) || { pid: selfPid, ppid: null, startedAtMs: null };
  let next = child.ppid ?? optionalPositiveNumber(parentPid);
  const ancestors = new Set();
  while (next !== null && next !== selfPid && !ancestors.has(next) && ancestors.size < MAX_ANCESTOR_DEPTH) {
    const parent = table.get(next);
    if (!parent || !parentLinkHolds(parent, child, platform)) break;
    ancestors.add(parent.pid);
    child = parent;
    next = parent.ppid;
  }
  return ancestors;
}

// The pids a listener scan never counts: the checking process and its ancestors (above).
// When the checker is this process and its row has no parent, its parent is process.ppid.
function checkerAndAncestorPids(rows, excludePid) {
  const selfPid = Number(excludePid);
  const ancestors = listenerAncestorPids(rows, {
    pid: selfPid,
    parentPid: selfPid === process.pid ? process.ppid : null,
  });
  return new Set([selfPid, ...ancestors]);
}

// Resolves to the process rows, or rejects when the table cannot be read (a timeout, a
// missing tool, unreadable output). It never turns a failed read into an empty table.
async function listProcessTable({ timeoutMs = LISTENER_PROCESS_SCAN_TIMEOUT_MS } = {}) {
  return process.platform === "win32"
    ? listWindowsProcesses({ timeoutMs })
    : listPosixProcesses({ timeoutMs });
}

// The probes `session listen` uses; replaced only through setListenerProcessProbesForTests.
let activeListProcessTable = listProcessTable;
let activeReadProcessCommandLine = readProcessCommandLine;
let activeReadProcessStartTime = readProcessStartTime;

/**
 * Test seam: replace the process-table scan and the per-pid command-line and start-time
 * reads that the listener commands use. Call with no argument to restore the real probes.
 */
export function setListenerProcessProbesForTests({
  listProcesses = null,
  readCommandLine = null,
  readStartTime = null,
} = {}) {
  activeListProcessTable = listProcesses || listProcessTable;
  activeReadProcessCommandLine = readCommandLine || readProcessCommandLine;
  activeReadProcessStartTime = readStartTime || readProcessStartTime;
}

function processScanFailureReason(error) {
  const code = normalizeString(error?.code);
  // execFile kills the scan at its timeout and reports it as killed with no code.
  if (code === "ETIMEDOUT" || (!code && error?.killed)) return "process_scan_timeout";
  if (error instanceof SyntaxError) return "process_scan_unreadable";
  return code ? `process_scan_failed:${code}` : "process_scan_failed";
}

// One scan of the process table: { ok: true, rows } or { ok: false, reason }.
async function scanProcessTable(listProcesses, timeoutMs) {
  let rows;
  try {
    rows = await listProcesses({ timeoutMs });
  } catch (error) {
    return { ok: false, reason: processScanFailureReason(error) };
  }
  if (!Array.isArray(rows)) {
    return { ok: false, reason: "process_scan_unreadable" };
  }
  return { ok: true, rows: normalizeProcessRows(rows) };
}

/**
 * Listener processes for this session and agent: { ok: true, matches } when the process
 * table was read, { ok: false, reason } when it could not be. A failed scan has no
 * `matches`, so it can never be read as "no listener". The checking process (`excludePid`)
 * and its ancestors are never matches (listenerAncestorPids).
 */
export async function listMatchingListenerProcesses(
  sessionId,
  agentId,
  {
    excludePid = process.pid,
    timeoutMs = LISTENER_PROCESS_SCAN_TIMEOUT_MS,
    _listProcesses = activeListProcessTable,
  } = {},
) {
  const scan = await scanProcessTable(_listProcesses, timeoutMs);
  if (!scan.ok) return scan;
  const excluded = checkerAndAncestorPids(scan.rows, excludePid);
  return {
    ok: true,
    matches: scan.rows.filter((row) =>
      !excluded.has(row.pid) &&
      listenerCommandLineMatches(row.commandLine, { sessionId, agentId })
    ),
  };
}

export async function summarizeLocalListenerProcesses(
  sessionId,
  agentIds = [],
  {
    excludePid = process.pid,
    timeoutMs = LISTENER_PROCESS_SCAN_TIMEOUT_MS,
    _listProcesses = activeListProcessTable,
  } = {},
) {
  const normalizedSessionId = normalizeString(sessionId);
  const uniqueAgentIds = [...new Set((Array.isArray(agentIds) ? agentIds : [])
    .map((agentId) => normalizeString(agentId))
    .filter(Boolean))];
  const scan = await scanProcessTable(_listProcesses, timeoutMs);
  if (!scan.ok) {
    return { ok: false, reason: scan.reason, sessionId: normalizedSessionId };
  }
  const excluded = checkerAndAncestorPids(scan.rows, excludePid);
  const candidates = scan.rows.filter((row) => !excluded.has(row.pid));
  const agents = uniqueAgentIds.map((agentId) => {
    const matches = candidates
      .filter((row) => listenerCommandLineMatches(row.commandLine, {
        sessionId: normalizedSessionId,
        agentId,
      }))
      .sort((a, b) => a.pid - b.pid);
    const pids = matches.map((match) => match.pid);
    return {
      agentId,
      processCount: pids.length,
      duplicateProcessCount: Math.max(0, pids.length - 1),
      pids,
    };
  });
  return {
    ok: true,
    sessionId: normalizedSessionId,
    processCount: agents.reduce((sum, agent) => sum + agent.processCount, 0),
    duplicateProcessCount: agents.reduce((sum, agent) => sum + agent.duplicateProcessCount, 0),
    agents,
  };
}

async function readWindowsCommandLine(pid) {
  const command = [
    "$ErrorActionPreference = 'Stop';",
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}";`,
    "if ($p) { $p.CommandLine }",
  ].join(" ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: 2000 },
  );
  return normalizeString(stdout);
}

async function readPosixCommandLine(pid) {
  if (process.platform === "linux") {
    try {
      const raw = await fsp.readFile(`/proc/${Number(pid)}/cmdline`);
      return normalizeString(raw.toString("utf8").replace(/\0/g, " "));
    } catch {
      // Fall through to ps(1), which also covers restricted /proc mounts.
    }
  }
  const { stdout } = await execFileAsync("ps", ["-p", String(Number(pid)), "-o", "command="], {
    timeout: 2000,
  });
  return normalizeString(stdout);
}

export async function readProcessCommandLine(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return "";
  try {
    return process.platform === "win32"
      ? await readWindowsCommandLine(numericPid)
      : await readPosixCommandLine(numericPid);
  } catch {
    return "";
  }
}

async function readWindowsStartTime(pid) {
  const command = [
    "$ErrorActionPreference = 'Stop';",
    `Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}" |`,
    `ForEach-Object { ${WINDOWS_CREATION_MS} }`,
  ].join(" ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: 2000 },
  );
  return optionalPositiveNumber(normalizeString(stdout));
}

// ps(1) gives the elapsed time as [[dd-]hh:]mm:ss on Linux, macOS and busybox alike.
async function readPosixStartTime(pid) {
  const { stdout } = await execFileAsync("ps", ["-p", String(Number(pid)), "-o", "etime="], {
    timeout: 2000,
  });
  const match = normalizeString(stdout).match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part || 0));
  return Date.now() - (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/**
 * When the process with this pid was created, in milliseconds since the epoch, or null when
 * it cannot be read. On POSIX it is only good to the second (see PROCESS_START_SLACK_MS).
 */
export async function readProcessStartTime(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  try {
    return process.platform === "win32"
      ? await readWindowsStartTime(numericPid)
      : await readPosixStartTime(numericPid);
  } catch {
    return null;
  }
}

export function resolveListenerPidPath(
  sessionId,
  agentId,
  { targetPath = process.cwd() } = {},
) {
  const paths = resolveSessionPaths(sessionId, { targetPath });
  return path.join(
    paths.sessionDir,
    LISTENER_DIR_NAME,
    `${normalizeListenerProcessKey(agentId)}.json`,
  );
}

export function resolveGlobalListenerPidPath(
  sessionId,
  agentId,
  { homeDir = os.homedir() } = {},
) {
  // The id is held to the session-id rule as given; its directory is the lower-cased key.
  const sessionDir = resolveSessionChildDir(
    path.join(path.resolve(String(homeDir || os.homedir())), ".sentinelayer", GLOBAL_LISTENER_DIR_NAME),
    normalizeListenerProcessKey(normalizeSessionId(sessionId)),
  );
  return path.join(sessionDir, `${normalizeListenerProcessKey(agentId)}.json`);
}

async function readPidRecordAtPath(pidPath) {
  try {
    const raw = await fsp.readFile(pidPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writePidRecordAtPath(pidPath, record) {
  await fsp.mkdir(path.dirname(pidPath), { recursive: true });
  await fsp.writeFile(pidPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
}

async function removePidRecordAtPath(pidPath, { onlyForPid = null } = {}) {
  if (onlyForPid != null) {
    const existing = await readPidRecordAtPath(pidPath);
    if (existing && Number(existing.pid) !== Number(onlyForPid)) {
      return false;
    }
  }
  try {
    await fsp.unlink(pidPath);
    return true;
  } catch {
    return false;
  }
}

export async function readListenerPidRecord(
  sessionId,
  agentId,
  { targetPath = process.cwd() } = {},
) {
  const pidPath = resolveListenerPidPath(sessionId, agentId, { targetPath });
  return readPidRecordAtPath(pidPath);
}

export async function readGlobalListenerPidRecord(
  sessionId,
  agentId,
  { homeDir = os.homedir() } = {},
) {
  const pidPath = resolveGlobalListenerPidPath(sessionId, agentId, { homeDir });
  return readPidRecordAtPath(pidPath);
}

export async function writeListenerPidRecord(
  sessionId,
  agentId,
  {
    targetPath = process.cwd(),
    pid = process.pid,
    listenerId = "",
    transport = "",
    intervalSeconds = null,
    activeIntervalSeconds = null,
    presenceIntervalSeconds = null,
    logFile = "",
    homeDir = os.homedir(),
  } = {},
) {
  const pidPath = resolveListenerPidPath(sessionId, agentId, { targetPath });
  const globalPidPath = resolveGlobalListenerPidPath(sessionId, agentId, { homeDir });
  const record = {
    pid: Number(pid),
    sessionId: normalizeString(sessionId),
    agentId: normalizeString(agentId),
    listenerKey: normalizeListenerProcessKey(agentId),
    listenerId: normalizeString(listenerId),
    targetPath: path.resolve(String(targetPath || ".")),
    transport: normalizeString(transport) || undefined,
    intervalSeconds: Number(intervalSeconds) || undefined,
    activeIntervalSeconds: Number(activeIntervalSeconds) || undefined,
    presenceIntervalSeconds: Number(presenceIntervalSeconds) || undefined,
    logFile: normalizeString(logFile) || undefined,
    startedAt: new Date().toISOString(),
  };
  const globalRecord = {
    ...record,
    recordScope: "global",
    localPidPath: pidPath,
  };
  await writePidRecordAtPath(globalPidPath, globalRecord);
  try {
    await writePidRecordAtPath(pidPath, record);
  } catch (error) {
    await removePidRecordAtPath(globalPidPath, { onlyForPid: pid }).catch(() => {});
    throw error;
  }
  return record;
}

export async function removeListenerPidRecord(
  sessionId,
  agentId,
  { targetPath = process.cwd(), onlyForPid = null, homeDir = os.homedir() } = {},
) {
  const pidPath = resolveListenerPidPath(sessionId, agentId, { targetPath });
  const globalPidPath = resolveGlobalListenerPidPath(sessionId, agentId, { homeDir });
  const localRemoved = await removePidRecordAtPath(pidPath, { onlyForPid });
  const globalRemoved = await removePidRecordAtPath(globalPidPath, { onlyForPid });
  return Boolean(localRemoved || globalRemoved);
}

// How much later than a pid record's `startedAt` its process may appear to have started: ps
// reports elapsed time in whole seconds, so a POSIX start time can read up to a second late.
const PROCESS_START_SLACK_MS = 2_000;

// Whether the process now at a record's pid was created after the record was written. The
// listener writes its record after it starts, so such a process is not that listener: its pid
// was reused. This is what keeps the record check from counting the checker's own launchers
// (whose command lines match like a listener's): a launcher holding a recorded pid holds a
// pid whose listener had already exited, so it was created after the record. When either time
// is unknown the record is judged by its command line alone, as before.
async function recordPidWasReused(record, readStartTime) {
  const recordedAtMs = Date.parse(normalizeString(record.startedAt));
  if (!Number.isFinite(recordedAtMs)) return false;
  const startedAtMs = await readStartTime(record.pid);
  return Number.isFinite(startedAtMs) && startedAtMs > recordedAtMs + PROCESS_START_SLACK_MS;
}

async function listenerStatusFromRecord(
  record,
  {
    sessionId,
    agentId,
    recordScope,
    _readProcessCommandLine = activeReadProcessCommandLine,
    _readProcessStartTime = activeReadProcessStartTime,
  } = {},
) {
  const alive = isProcessAlive(record.pid);
  if (!alive) {
    return {
      state: "not_running",
      running: false,
      pid: null,
      stale: true,
      record,
      recordScope,
      listenerKey: normalizeListenerProcessKey(agentId),
    };
  }
  const commandLine = await _readProcessCommandLine(record.pid);
  const matches = listenerCommandLineMatches(commandLine, { sessionId, agentId });
  if (!matches || (await recordPidWasReused(record, _readProcessStartTime))) {
    return {
      state: "not_running",
      running: false,
      pid: null,
      stale: true,
      reused: Boolean(commandLine),
      unverified: !commandLine,
      record,
      recordScope,
      listenerKey: normalizeListenerProcessKey(agentId),
      commandLine,
    };
  }
  return {
    state: "running",
    running: true,
    pid: Number(record.pid),
    stale: false,
    record,
    recordScope,
    listenerKey: normalizeListenerProcessKey(agentId),
    commandLine,
  };
}

/**
 * Whether a listener for this session and agent is running on this machine. `state` is
 * "running", "not_running" or "unknown". A live pid record whose command line matches, and
 * whose process is not newer than the record (recordPidWasReused), is "running" without a
 * scan. Otherwise the process table decides, and when it cannot be read the answer is
 * "unknown" (`running: null`, with `reason`), never "not_running".
 */
export async function getListenerProcessStatus(
  sessionId,
  agentId,
  {
    targetPath = process.cwd(),
    homeDir = os.homedir(),
    scanTimeoutMs = LISTENER_PROCESS_SCAN_TIMEOUT_MS,
    _readProcessCommandLine = activeReadProcessCommandLine,
    _readProcessStartTime = activeReadProcessStartTime,
    _listProcesses = activeListProcessTable,
  } = {},
) {
  const records = [
    {
      record: await readGlobalListenerPidRecord(sessionId, agentId, { homeDir }),
      recordScope: "global",
    },
    {
      record: await readListenerPidRecord(sessionId, agentId, { targetPath }),
      recordScope: "local",
    },
  ];
  const staleStatuses = [];
  for (const entry of records) {
    if (!entry.record) continue;
    const status = await listenerStatusFromRecord(entry.record, {
      sessionId,
      agentId,
      recordScope: entry.recordScope,
      _readProcessCommandLine,
      _readProcessStartTime,
    });
    if (status.running) {
      return status;
    }
    staleStatuses.push(status);
  }
  const scan = await listMatchingListenerProcesses(sessionId, agentId, {
    timeoutMs: scanTimeoutMs,
    _listProcesses,
  });
  if (!scan.ok) {
    return {
      state: "unknown",
      running: null,
      pid: null,
      reason: scan.reason,
      record: staleStatuses[0]?.record || null,
      listenerKey: normalizeListenerProcessKey(agentId),
    };
  }
  const matchingProcesses = scan.matches;
  if (matchingProcesses.length > 0) {
    return {
      state: "running",
      running: true,
      pid: matchingProcesses[0].pid,
      stale: false,
      record: null,
      recordScope: "process_scan",
      untracked: true,
      listenerKey: normalizeListenerProcessKey(agentId),
      commandLine: matchingProcesses[0].commandLine,
      matchingProcesses,
    };
  }
  if (staleStatuses.length === 0) {
    return {
      state: "not_running",
      running: false,
      pid: null,
      stale: false,
      record: null,
      listenerKey: normalizeListenerProcessKey(agentId),
    };
  }
  return staleStatuses[0];
}

/**
 * Stops every listener process the scan finds for this session and agent. When the process
 * table cannot be read it stops nothing and returns { ok: false, reason }.
 */
export async function stopMatchingListenerProcesses(
  sessionId,
  agentId,
  {
    excludePid = process.pid,
    timeoutMs = 3000,
    pollIntervalMs = 100,
    scanTimeoutMs = LISTENER_PROCESS_SCAN_TIMEOUT_MS,
    _listProcesses = activeListProcessTable,
  } = {},
) {
  const scan = await listMatchingListenerProcesses(sessionId, agentId, {
    excludePid,
    timeoutMs: scanTimeoutMs,
    _listProcesses,
  });
  if (!scan.ok) return scan;
  const matches = scan.matches;
  const results = [];
  for (const match of matches) {
    const result = await requestListenerProcessStop(match.pid, {
      timeoutMs,
      pollIntervalMs,
    });
    results.push({
      pid: match.pid,
      commandLine: match.commandLine,
      ...result,
    });
  }
  const failed = results.filter((result) => !result.stopped);
  return {
    ok: true,
    matches,
    results,
    stoppedCount: results.filter((result) => result.stopped).length,
    failedCount: failed.length,
    failed,
  };
}

export async function requestListenerProcessStop(
  pid,
  { signal = "SIGTERM", timeoutMs = 3000, pollIntervalMs = 100 } = {},
) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return { requested: false, stopped: true, reason: "invalid_pid" };
  }
  if (numericPid === process.pid) {
    return { requested: false, stopped: false, reason: "self" };
  }
  if (!isProcessAlive(numericPid)) {
    return { requested: false, stopped: true, reason: "not_running" };
  }

  try {
    process.kill(numericPid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { requested: false, stopped: true, reason: "not_running" };
    }
    return {
      requested: false,
      stopped: false,
      reason: normalizeString(error?.code) || "signal_failed",
    };
  }

  const deadlineMs = Date.now() + Math.max(1, Number(timeoutMs) || 3000);
  const sleepMs = Math.max(10, Number(pollIntervalMs) || 100);
  while (Date.now() < deadlineMs) {
    if (!isProcessAlive(numericPid)) {
      return { requested: true, stopped: true, reason: "stopped" };
    }
    await sleep(sleepMs);
  }
  return { requested: true, stopped: false, reason: "timeout" };
}
