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

// A row is { pid, ppid, startedAtMs, name, commandLine }, one for every process the scan
// lists, so a parent chain can be followed through processes that are not this CLI. `ppid`
// (the parent's pid) and `startedAtMs` (when the process was created) are null, and `name`
// (the executable's file name) is "", when the scan did not give them. `commandLine` is ""
// when the scan left it out: the Windows scan keeps only the ones that name a CLI entry.
function normalizeProcessRows(rows = []) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      pid: Number(row?.pid ?? row?.ProcessId ?? row?.processId),
      ppid: optionalPositiveNumber(row?.ppid ?? row?.ParentProcessId),
      startedAtMs: optionalPositiveNumber(row?.startedAtMs ?? row?.CreationMs),
      name: normalizeString(row?.name ?? row?.Name),
      commandLine: normalizeString(row?.commandLine ?? row?.CommandLine ?? row?.command ?? row?.args),
    }))
    .filter((row) => Number.isInteger(row.pid) && row.pid > 0);
}

// Win32_Process.CreationDate as milliseconds since the epoch, for a PowerShell expression.
const WINDOWS_CREATION_MS = "if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";

// Every process, so the parent chain is complete, with its command line only when that names
// a CLI entry point, which keeps the output small: about 600 processes make some 60 KB of
// JSON and take under a second, as the filtered scan did.
async function listWindowsProcesses({ timeoutMs }) {
  const namesCliEntry = `$_.CommandLine -and ($_.CommandLine -match '${cliEntryPattern("win32")}')`;
  const command = [
    "$ErrorActionPreference = 'Stop';",
    "$rows = Get-CimInstance Win32_Process |",
    "Select-Object ProcessId,ParentProcessId,Name,",
    `@{n='CreationMs';e={ ${WINDOWS_CREATION_MS} }},`,
    `@{n='CommandLine';e={ if (${namesCliEntry}) { $_.CommandLine } else { $null } }};`,
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

// ps(1) prints elapsed time as [[dd-]hh:]mm:ss on Linux, macOS and busybox alike.
function parseElapsedSeconds(value) {
  const match = normalizeString(value).match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part || 0));
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

// Start times come from ps's whole seconds of elapsed time, counted from just after
// `scannedAtMs`, so each is good to about a second (startTimeSlackMs).
async function listPosixProcesses({ timeoutMs }) {
  const scannedAtMs = Date.now();
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,etime=,command="], {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
      if (!match) return null;
      const elapsedSeconds = parseElapsedSeconds(match[3]);
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        startedAtMs: elapsedSeconds === null ? null : scannedAtMs - elapsedSeconds * 1000,
        commandLine: normalizeString(match[4]),
      };
    })
    .filter(Boolean);
}

// How far apart two readings of one start time can be. Windows gives creation times to the
// millisecond. A POSIX reading can be up to a second late (whole seconds of elapsed time)
// and slightly early (the time ps takes to start), so 2 s covers it.
const POSIX_START_TIME_SLACK_MS = 2_000;

function startTimeSlackMs(platform = process.platform) {
  return platform === "win32" ? 0 : POSIX_START_TIME_SLACK_MS;
}

// How far up the parent chain the walk goes. Real launch chains are a handful deep.
const MAX_ANCESTOR_DEPTH = 64;

// Whether `parent` (the row at `child`'s recorded parent pid) is still the process that
// started `child`. A parent is always created before its child, so a "parent" created after
// it holds a reused pid. On POSIX a recorded parent is always the live parent, because an
// exiting process's children are re-parented to init or a subreaper; so with no start times
// the link holds there. Windows never re-parents: the parent pid of a child whose parent
// exited can name any process started since, so there a link holds only when both creation
// times are known and in order.
function parentLinkHolds(parent, child, platform) {
  if (Number.isFinite(parent.startedAtMs) && Number.isFinite(child.startedAtMs)) {
    return parent.startedAtMs <= child.startedAtMs + startTimeSlackMs(platform);
  }
  return platform !== "win32";
}

/**
 * The pids of a process's ancestors in one scan of the process table: its parent, that
 * process's parent, and so on, while each parent is in the table, still the process that
 * started its child (parentLinkHolds), not seen before (a cycle), and within
 * MAX_ANCESTOR_DEPTH. The walk starts at the parent the table records for `pid`, or at
 * `parentPid` when the table records none. Every row counts, with or without a command line,
 * so the chain runs through processes that are not this CLI (cmd.exe, a service host).
 *
 * The walk ends early under Git Bash (MSYS) on Windows: an MSYS program such as bash, nohup or
 * timeout is started from a forked copy of the shell that exits once the program runs, so its
 * parent pid names no live process. Counting does not rest on the walk (a launcher is never
 * counted, wherever it sits: readListenerScan); the walk marks the listeners --force must not
 * stop, and a listener above such a break is not marked.
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

// The checking process's ancestors in a scan. When the checker is this process and its row
// records no parent, its parent is process.ppid.
function checkerAncestors(rows, selfPid) {
  return listenerAncestorPids(rows, {
    pid: selfPid,
    parentPid: selfPid === process.pid ? process.ppid : null,
  });
}

/**
 * An executable's name as the process kinds below compare it: its file name, without the
 * directory, lower-cased, and without a trailing ".exe". So `C:\Program Files\nodejs\node.exe`,
 * `/usr/bin/node` and `NODE` all read as "node".
 */
export function normalizeImageName(value) {
  const base = normalizeString(value).split(/[\\/]/).pop().toLowerCase();
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

// Executables that run this CLI as node. Also the checker's own node, whatever it is named.
const NODE_IMAGE_NAMES = ["node", "nodejs"];
// Executables that only start other programs: a command line naming the CLI there is the
// command they run, not this CLI running.
const LAUNCHER_IMAGE_NAMES = new Set([
  "bash", "sh", "dash", "zsh", "cmd", "powershell", "pwsh", "nohup", "timeout", "env",
  "screen", "tmux", "script", "setsid", "nice",
]);
// Node options known to take no value, so the next argument is not theirs.
const NODE_FLAGS = new Set([
  "--inspect", "--inspect-brk", "--inspect-wait", "--no-warnings", "--no-deprecation",
  "--trace-warnings", "--trace-deprecation", "--trace-uncaught", "--throw-deprecation",
  "--pending-deprecation", "--enable-source-maps", "--expose-gc", "--preserve-symlinks",
  "--preserve-symlinks-main", "--abort-on-uncaught-exception", "--experimental-vm-modules",
]);
// Of those, the ones that may also be given a value after "=" (--inspect=127.0.0.1:9229).
const NODE_FLAGS_WITH_OPTIONAL_VALUE = new Set(["--inspect", "--inspect-brk", "--inspect-wait"]);
// Node options known to take a value, as the next argument or after "=".
const NODE_OPTIONS_WITH_VALUE = new Set([
  "--inspect-port", "--title", "-C", "--conditions", "--input-type", "--env-file",
  "--disable-warning", "--redirect-warnings", "--max-old-space-size", "--stack-size",
]);
// Node options that load a module before the script; that module may be this CLI.
const NODE_PRELOAD_OPTIONS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"]);
// Node options that run code given on the command line instead of a script.
const NODE_INLINE_CODE_OPTIONS = new Set(["-e", "--eval", "-p", "--print", "-pe", "-ep"]);

// A command line's arguments, in order, and whether they were read with certainty.
// - Windows quotes an argument with spaces, or an empty one, in double quotes. An empty
//   argument ("") stays an argument, so a value option never takes the next one in its
//   place. A quote left open, or one escaped with a backslash, is not read with certainty.
// - ps(1) prints POSIX arguments joined by single spaces with no quoting. An argument with a
//   space reads as two (listenerProcessKind allows for that), and a run of spaces may hide an
//   empty argument or an argument made of spaces, so it is not read with certainty. A quote
//   character there is part of an argument, not quoting: it is kept as it is, and a command line
//   that has one is not read with certainty, so no file name is recognised by removing it.
function commandLineArguments(commandLine, platform) {
  const text = normalizeString(commandLine);
  if (platform === "win32") {
    const certain = (text.match(/"/g) || []).length % 2 === 0 && !/\\"/.test(text);
    const parts = text.match(/(?:"[^"]*"?|[^\s"]+)+/g) || [];
    return { args: parts.map((part) => part.replace(/"/g, "")), certain };
  }
  const parts = text.split(/\s+/);
  return { args: parts.filter(Boolean), certain: !/\s{2,}/.test(text) && !/["']/.test(text) };
}

/**
 * What a process whose command line matches a listen command is. Both kinds are allow-listed;
 * anything else is "unknown", which the listener checks treat as possibly a listener, so
 * starting and --force refuse.
 * - "listener": this CLI running it. The executable is node (node, nodejs, or the name of the
 *   checker's own node) and node's first argument that is not a node option is a CLI entry
 *   point, read with certainty.
 * - "wrapper": a launcher, which carries the command for the process it starts: an executable
 *   in LAUNCHER_IMAGE_NAMES (bash, sh, dash, zsh, cmd, powershell, pwsh, nohup, timeout, env,
 *   screen, tmux, script, setsid, nice); or node whose first non-option argument is certainly
 *   another script, or node running inline code (-e, -p) with no CLI entry among its arguments.
 * - "unknown": anything else, including node whose arguments cannot be read with certainty: a
 *   preload option (-r, --require, --import, --loader), inline code next to a CLI entry, an
 *   option this does not know (it may take the next argument), a quote left open, or, on
 *   POSIX, a first argument that is not an entry (it may be the first piece of an entry path
 *   with a space, which ps prints unquoted).
 * The executable is Win32_Process.Name on Windows and the first argument on POSIX, compared
 * as normalizeImageName gives it.
 */
export function listenerProcessKind(
  row,
  { platform = process.platform, nodeExecutable = process.execPath } = {},
) {
  const { args, certain } = commandLineArguments(row?.commandLine, platform);
  const image = normalizeImageName(normalizeString(row?.name) || args[0]);
  if (LAUNCHER_IMAGE_NAMES.has(image)) return "wrapper";
  const nodeImages = new Set([...NODE_IMAGE_NAMES, normalizeImageName(nodeExecutable)].filter(Boolean));
  if (!nodeImages.has(image)) return "unknown";
  if (!certain) return "unknown";
  const entries =
    platform === "win32" ? CLI_ENTRY_SCRIPTS : [...CLI_ENTRY_SCRIPTS, ...CLI_COMMAND_NAMES];
  const entryPath = new RegExp(`[\\\\/](?:${entries.map(escapeRegExp).join("|")})$`);
  const isEntry = (arg) => entryPath.test(normalizeString(arg).toLowerCase());
  let index = 1;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      index += 1;
      break;
    }
    if (!arg.startsWith("-") || arg === "-") break;
    // Every spelling is judged by the option's name: --name, --name value, --name=value.
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const valueAttached = equals !== -1;
    if (NODE_INLINE_CODE_OPTIONS.has(name)) {
      return args.slice(1).some(isEntry) ? "unknown" : "wrapper";
    }
    if (NODE_PRELOAD_OPTIONS.has(name)) return "unknown";
    if (NODE_OPTIONS_WITH_VALUE.has(name)) {
      if (!valueAttached) index += 1;
      continue;
    }
    if (NODE_FLAGS.has(name) && (!valueAttached || NODE_FLAGS_WITH_OPTIONAL_VALUE.has(name))) continue;
    return "unknown";
  }
  const script = args[index];
  if (!script) return "unknown";
  if (isEntry(script)) return "listener";
  return platform === "win32" ? "wrapper" : "unknown";
}

/**
 * One scan read for one session and agent from the checking process's side. Every process
 * whose command line matches, other than the checker, is judged by listenerProcessKind:
 * `listeners` are the listeners, `unconfirmed` the processes that may be one, and launchers
 * are in neither, wherever they sit. Ancestry is the second layer: a listener or possible
 * listener that is an ancestor of the checker is marked `ancestor: true`, and the takeover
 * never stops one.
 */
function readListenerScan(rows, { sessionId, agentId, selfPid, ancestors }) {
  const listeners = [];
  const unconfirmed = [];
  for (const row of rows) {
    if (row.pid === selfPid || !listenerCommandLineMatches(row.commandLine, { sessionId, agentId })) {
      continue;
    }
    const kind = listenerProcessKind(row);
    if (kind === "wrapper") continue;
    const marked = ancestors.has(row.pid) ? { ...row, ancestor: true } : row;
    (kind === "listener" ? listeners : unconfirmed).push(marked);
  }
  return { listeners, unconfirmed };
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

/**
 * Test seam: replace the process-table scan and the per-pid command-line read that the
 * listener commands use. Call with no argument to restore the real probes.
 */
export function setListenerProcessProbesForTests({ listProcesses = null, readCommandLine = null } = {}) {
  activeListProcessTable = listProcesses || listProcessTable;
  activeReadProcessCommandLine = readCommandLine || readProcessCommandLine;
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
 * `matches`, so it can never be read as "no listener". The matches are the listeners and the
 * processes that may be one (readListenerScan); the checking process (`excludePid`) and
 * launchers never are, and a match that is an ancestor of the checker is marked
 * `ancestor: true`.
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
  const selfPid = Number(excludePid);
  const ancestors = checkerAncestors(scan.rows, selfPid);
  const { listeners, unconfirmed } = readListenerScan(scan.rows, { sessionId, agentId, selfPid, ancestors });
  return { ok: true, matches: [...listeners, ...unconfirmed] };
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
  const selfPid = Number(excludePid);
  const ancestors = checkerAncestors(scan.rows, selfPid);
  const agents = uniqueAgentIds.map((agentId) => {
    const { listeners, unconfirmed } = readListenerScan(scan.rows, {
      sessionId: normalizedSessionId,
      agentId,
      selfPid,
      ancestors,
    });
    const pids = [...listeners, ...unconfirmed].map((match) => match.pid).sort((a, b) => a - b);
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

async function listenerStatusFromRecord(
  record,
  {
    sessionId,
    agentId,
    recordScope,
    _readProcessCommandLine = activeReadProcessCommandLine,
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
  if (!listenerCommandLineMatches(commandLine, { sessionId, agentId })) {
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
 * What the process at a pid record's pid is, judged on one scan (`row` is its row there, or
 * null; `commandLine` is the one read for the record, used when the row has none). A
 * listener writes its record after it starts, so the process that wrote it started no later
 * than the record's `startedAt`, within the platform's precision (startTimeSlackMs).
 * - "confirmed": a listener (listenerProcessKind) that started by then: the one that wrote it.
 * - "ancestor": one of the checking process's ancestors (`ancestors`). The scan judges those
 *   (readListenerScan), so the record adds nothing.
 * - "wrapper": a launcher, which never wrote a listener's record.
 * - "reused": a listener started after the record was written, so not the one that wrote it.
 * - "gone": no longer in the process table.
 * - "unconfirmed": a process that may be a listener, or a start time that is unknown, so the
 *   record proves nothing either way.
 */
export function pidRecordHolder(
  record,
  row,
  { ancestors = new Set(), commandLine = "", platform = process.platform } = {},
) {
  if (!row) return "gone";
  if (ancestors.has(row.pid)) return "ancestor";
  const kind = listenerProcessKind(
    { name: row.name, commandLine: row.commandLine || commandLine },
    { platform },
  );
  if (kind === "wrapper") return "wrapper";
  if (kind === "unknown") return "unconfirmed";
  const recordedAtMs = Date.parse(normalizeString(record?.startedAt));
  if (!Number.isFinite(row.startedAtMs) || !Number.isFinite(recordedAtMs)) return "unconfirmed";
  return row.startedAtMs > recordedAtMs + startTimeSlackMs(platform) ? "reused" : "confirmed";
}

/**
 * Whether a listener for this session and agent is running on this machine. `state` is
 * "running", "not_running" or "unknown".
 *
 * A pid record counts when its pid is alive with a matching command line and one scan of the
 * process table confirms it (pidRecordHolder). The same scan finds untracked listeners
 * (readListenerScan). A running answer carries the process's `startedAtMs`, and `ancestor:
 * true` when the listener is an ancestor of this process, which --force must never stop.
 *
 * Anything uncertain makes the answer "unknown" (`running: null`, with `reason`), never
 * "not_running": a scan that could not be read, a record whose process cannot be confirmed
 * ("pid_record_unconfirmed"), or a process that may be a listener ("listener_unconfirmed").
 */
export async function getListenerProcessStatus(
  sessionId,
  agentId,
  {
    targetPath = process.cwd(),
    homeDir = os.homedir(),
    scanTimeoutMs = LISTENER_PROCESS_SCAN_TIMEOUT_MS,
    _readProcessCommandLine = activeReadProcessCommandLine,
    _listProcesses = activeListProcessTable,
  } = {},
) {
  const listenerKey = normalizeListenerProcessKey(agentId);
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
  const tracked = [];
  const staleStatuses = [];
  for (const entry of records) {
    if (!entry.record) continue;
    const status = await listenerStatusFromRecord(entry.record, {
      sessionId,
      agentId,
      recordScope: entry.recordScope,
      _readProcessCommandLine,
    });
    (status.running ? tracked : staleStatuses).push(status);
  }
  const unknown = (reason, record) => ({
    state: "unknown",
    running: null,
    pid: null,
    reason,
    record: record || tracked[0]?.record || staleStatuses[0]?.record || null,
    listenerKey,
  });
  const scan = await scanProcessTable(_listProcesses, scanTimeoutMs);
  if (!scan.ok) return unknown(scan.reason);

  const ancestors = checkerAncestors(scan.rows, process.pid);
  const table = new Map(scan.rows.map((row) => [row.pid, row]));
  const confirmed = [];
  const unconfirmedRecords = [];
  for (const status of tracked) {
    const row = table.get(Number(status.pid)) || null;
    const holder = pidRecordHolder(status.record, row, { ancestors, commandLine: status.commandLine });
    if (holder === "confirmed") {
      confirmed.push({ ...status, startedAtMs: row.startedAtMs, ancestor: false });
    } else if (holder === "unconfirmed") {
      unconfirmedRecords.push(status);
    } else {
      staleStatuses.push({
        state: "not_running",
        running: false,
        pid: null,
        stale: true,
        reused: holder !== "gone",
        holder,
        record: status.record,
        recordScope: status.recordScope,
        listenerKey,
        commandLine: status.commandLine,
      });
    }
  }
  const { listeners, unconfirmed } = readListenerScan(scan.rows, {
    sessionId,
    agentId,
    selfPid: process.pid,
    ancestors,
  });
  if (unconfirmedRecords.length > 0) {
    return unknown("pid_record_unconfirmed", unconfirmedRecords[0].record);
  }
  if (unconfirmed.length > 0) return unknown("listener_unconfirmed");
  // A listener that is an ancestor of this process is the one reported, so that --force
  // refuses rather than stop it.
  const ancestorListener = listeners.find((row) => row.ancestor);
  if (confirmed.length > 0 && !ancestorListener) return confirmed[0];
  const reported = ancestorListener || listeners[0];
  if (reported) {
    return {
      state: "running",
      running: true,
      pid: reported.pid,
      startedAtMs: reported.startedAtMs,
      ancestor: Boolean(reported.ancestor),
      stale: false,
      record: null,
      recordScope: "process_scan",
      untracked: true,
      listenerKey,
      commandLine: reported.commandLine,
      matchingProcesses: listeners,
    };
  }
  if (staleStatuses.length === 0) {
    return {
      state: "not_running",
      running: false,
      pid: null,
      stale: false,
      record: null,
      listenerKey,
    };
  }
  return staleStatuses[0];
}

// Why the takeover's own scan does not bear out `listener`, the status check's answer, or
// null when it does. `row` is the scan's row for that pid (null when it is gone, which
// leaves nothing to stop for it), and `isListener` says whether the scan counts that row as
// a current listener for this session and agent (readListenerScan). The pid must name the
// same process the status check saw, by start time (exact on Windows, within 2 s on POSIX:
// startTimeSlackMs): otherwise it changed hands ("reused"), even when the new holder is a
// listener too. And it must still be a current listener; a start time that cannot be
// compared, or the same process no longer counted as a listener, is "unconfirmed".
function takeoverTargetRefusal(listener, row, { isListener, platform = process.platform }) {
  if (!row) return null;
  if (!Number.isFinite(listener?.startedAtMs) || !Number.isFinite(row.startedAtMs)) return "unconfirmed";
  if (Math.abs(row.startedAtMs - listener.startedAtMs) > startTimeSlackMs(platform)) return "reused";
  return isListener ? null : "unconfirmed";
}

/**
 * The --force takeover. --force stops only current listeners for this session and agent, and
 * refuses with no stops if the listener the status check saw has changed hands or can no
 * longer be confirmed. One scan is taken, and the stop set is exactly that scan's listeners
 * for this session and agent (readListenerScan): never the checker, never a launcher, and
 * never the pid the status check found unless this scan counts it as a listener. Every
 * refusal is decided before the first stop: a listener that is an ancestor of the checker
 * ("ancestor_listener"), a process that may be a listener ("listener_unconfirmed"), or the
 * status check's listener changed hands or unconfirmed (takeoverTargetRefusal). It returns
 * { ok: true, refused: { pid, reason } } then. When the process table cannot be read it stops
 * nothing and returns { ok: false, reason }; the caller then stops nothing either, since what
 * it found earlier may no longer hold.
 */
export async function stopMatchingListenerProcesses(
  sessionId,
  agentId,
  {
    excludePid = process.pid,
    listener = null,
    timeoutMs = 3000,
    pollIntervalMs = 100,
    scanTimeoutMs = LISTENER_PROCESS_SCAN_TIMEOUT_MS,
    _listProcesses = activeListProcessTable,
  } = {},
) {
  const scan = await scanProcessTable(_listProcesses, scanTimeoutMs);
  if (!scan.ok) return scan;
  const selfPid = Number(excludePid);
  const ancestors = checkerAncestors(scan.rows, selfPid);
  const { listeners, unconfirmed } = readListenerScan(scan.rows, { sessionId, agentId, selfPid, ancestors });
  const refuse = (pid, reason) => ({
    ok: true,
    refused: { pid, reason },
    matches: listeners,
    results: [],
    stoppedCount: 0,
    failedCount: 0,
    failed: [],
  });
  const ancestorListener = listeners.find((row) => row.ancestor);
  if (ancestorListener) return refuse(ancestorListener.pid, "ancestor_listener");
  if (unconfirmed.length > 0) return refuse(unconfirmed[0].pid, "listener_unconfirmed");
  // Decide everything, then act: every refusal above and here comes before the first stop.
  const matches = [...listeners];
  const listenerPid = Number(listener?.pid);
  if (Number.isInteger(listenerPid) && listenerPid > 0) {
    const row = scan.rows.find((entry) => entry.pid === listenerPid) || null;
    const isListener = matches.some((match) => match.pid === listenerPid);
    const refusal = takeoverTargetRefusal(listener, row, { isListener });
    if (refusal) return refuse(listenerPid, refusal);
  }
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
