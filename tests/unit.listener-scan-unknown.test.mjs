import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
import {
  LISTENER_PROCESS_SCAN_RETRY_TIMEOUT_MS,
  LISTENER_PROCESS_SCAN_TIMEOUT_MS,
  getListenerProcessStatus,
  listMatchingListenerProcesses,
  listenerAncestorPids,
  listenerCommandLineMatches,
  listenerProcessKind,
  normalizeImageName,
  pidRecordHolder,
  readGlobalListenerPidRecord,
  readListenerPidRecord,
  setListenerProcessProbesForTests,
  stopMatchingListenerProcesses,
  summarizeLocalListenerProcesses,
  writeListenerPidRecord,
} from "../src/session/listener-process.js";
import { isProcessAlive } from "../src/session/daemon-spawn.js";
import { createSession } from "../src/session/store.js";
import { resetSessionSyncStateForTests } from "../src/session/sync.js";

// node as a real command line shows it: Windows quotes a path with a space; ps(1) prints POSIX
// arguments unquoted (a quote there would be part of the argument).
const NODE_ON_COMMAND_LINE = process.platform === "win32" ? `"${process.execPath}"` : process.execPath;

// Every test that runs `session listen` gets this bound: the fake API stops the listener on
// its first poll, and the timeout fails a test that still does not finish.
const LISTEN_TEST = { timeout: 60_000 };

async function seedWorkspace(rootPath) {
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "listener-scan-unknown-fixture", version: "1.0.0" }, null, 2),
    "utf-8",
  );
}

function listenerCommandLine({ sessionId, agentId = "Codex" }) {
  // Quoted, as a real command line quotes a path with a space.
  return [
    NODE_ON_COMMAND_LINE,
    path.join("node_modules", "sentinelayer-cli", "bin", "sl.js"),
    "session",
    "listen",
    "--session",
    sessionId,
    "--agent",
    agentId,
  ].join(" ");
}

function scanTimeoutError() {
  // The shape execFile gives a command it killed at its timeout.
  return Object.assign(new Error("Command failed: powershell.exe"), {
    killed: true,
    signal: "SIGTERM",
    code: null,
  });
}

function scanSpawnError() {
  return Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" });
}

// A process-table probe that answers from a script, one entry per call, and records the time
// limit each call was given. A thrown entry is a failed scan.
function scriptedScan(script) {
  const timeouts = [];
  const listProcesses = async ({ timeoutMs } = {}) => {
    timeouts.push(timeoutMs);
    const step = script[Math.min(timeouts.length, script.length) - 1];
    if (step instanceof Error) throw step;
    return step;
  };
  return { timeouts, listProcesses };
}

async function runSessionCommand(args = []) {
  const program = new Command();
  program
    .name("sl")
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
  registerSessionCommand(program);

  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => logs.push(parts.map((part) => String(part)).join(" "));
  console.error = (...parts) => errors.push(parts.map((part) => String(part)).join(" "));
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { stdout: logs.join("\n").trim(), stderr: errors.join("\n").trim() };
}

function installAuthEnv() {
  const previous = {
    SENTINELAYER_SKIP_REMOTE_SYNC: process.env.SENTINELAYER_SKIP_REMOTE_SYNC,
    SENTINELAYER_TOKEN: process.env.SENTINELAYER_TOKEN,
    SENTINELAYER_API_URL: process.env.SENTINELAYER_API_URL,
  };
  delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
  process.env.SENTINELAYER_TOKEN = "tok_listener_scan_unknown_test";
  process.env.SENTINELAYER_API_URL = "https://api.sentinelayer.com";
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

// A fake API that tells the agent's listener to stop on its first poll and answers the
// presence roster with `present`. Every request is recorded.
function installFakeApi({ agentId = "codex", present = [] } = {}) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET" });
    if (options.method === "PUT") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", recorded: true, ttlSeconds: 90 }),
      };
    }
    if (String(url).endsWith("/presence")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ enabled: true, status: "ok", present }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        listenerControls: [
          {
            controlId: "control-stop-scan-test",
            type: "stop",
            issuedAt: new Date(Date.now() + 30_000).toISOString(),
            targetAgentId: agentId,
            reason: "test_bound",
          },
        ],
        events: [],
        cursor: null,
      }),
    };
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

// Temp workspace, auth env, fake API and process probes for one command test, all undone after.
async function withListenHarness({ probes = {}, present = [] } = {}, run) {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-listener-scan-unknown-"));
  const restoreEnv = installAuthEnv();
  const api = installFakeApi({ present });
  setListenerProcessProbesForTests(probes);
  try {
    await seedWorkspace(tempRoot);
    return await run({ tempRoot, api });
  } finally {
    setListenerProcessProbesForTests();
    api.restore();
    resetSessionSyncStateForTests();
    restoreEnv();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function listenArgs(sessionId, tempRoot, extra = []) {
  return [
    "session",
    "listen",
    "--session",
    sessionId,
    "--agent",
    "Codex",
    "--path",
    tempRoot,
    "--no-coaching",
    ...extra,
  ];
}

async function assertNoPidRecords(sessionId, tempRoot) {
  assert.equal(await readListenerPidRecord(sessionId, "Codex", { targetPath: tempRoot }), null);
  assert.equal(await readGlobalListenerPidRecord(sessionId, "Codex"), null);
}

const FAILED_SCANS = [
  { kind: "timeout", error: scanTimeoutError, reason: "process_scan_timeout" },
  { kind: "error", error: scanSpawnError, reason: "process_scan_failed:ENOENT" },
];

for (const failure of FAILED_SCANS) {
  for (const force of [false, true]) {
    const label = `${failure.kind}${force ? " with --force" : ""}`;
    test(`Listener scan unknown: a scan ${label} refuses after exactly one retry, with no listener and no API call`, LISTEN_TEST, async () => {
      const scan = scriptedScan([failure.error(), failure.error(), failure.error()]);
      await withListenHarness({ probes: { listProcesses: scan.listProcesses } }, async ({ tempRoot, api }) => {
        const sessionId = `scan-unknown-${failure.kind}-${force ? "force" : "plain"}`;
        await assert.rejects(
          runSessionCommand(listenArgs(sessionId, tempRoot, force ? ["--force"] : [])),
          (error) => {
            assert.match(error.message, /^Could not confirm whether a session listener is already running/);
            assert.ok(
              error.message.includes(`the local process check did not complete (${failure.reason})`),
              error.message,
            );
            assert.match(error.message, /No listener was started\./);
            assert.match(error.message, /use --allow-duplicate to start without this check/);
            assert.match(error.message, /--force does not skip the check/);
            return true;
          },
        );
        assert.deepEqual(scan.timeouts, [
          LISTENER_PROCESS_SCAN_TIMEOUT_MS,
          LISTENER_PROCESS_SCAN_RETRY_TIMEOUT_MS,
        ]);
        assert.deepEqual(api.calls, []);
        await assertNoPidRecords(sessionId, tempRoot);
      });
    });
  }
}

test("Listener scan unknown: a scan that fails once and then finds no listener lets the listener start", LISTEN_TEST, async () => {
  const sessionId = "scan-unknown-then-clear";
  const scan = scriptedScan([
    scanTimeoutError(),
    [{ pid: process.pid + 200_000, commandLine: `${process.execPath} unrelated-worker.js` }],
  ]);
  await withListenHarness({ probes: { listProcesses: scan.listProcesses } }, async ({ tempRoot, api }) => {
    await runSessionCommand(listenArgs(sessionId, tempRoot));

    assert.deepEqual(scan.timeouts, [
      LISTENER_PROCESS_SCAN_TIMEOUT_MS,
      LISTENER_PROCESS_SCAN_RETRY_TIMEOUT_MS,
    ]);
    const polls = api.calls.filter((call) => call.method === "GET");
    assert.equal(polls.length, 1);
    assert.match(polls[0].url, /listenerAgentId=codex/);
    // The listener wrote its pid record on start and removed it when the stop control ended it.
    await assertNoPidRecords(sessionId, tempRoot);
  });
});

test("Listener scan unknown: a completed scan that finds a duplicate refuses as before, without a retry", LISTEN_TEST, async () => {
  const sessionId = "scan-finds-duplicate";
  const duplicatePid = process.pid + 200_001;
  const scan = scriptedScan([[{ pid: duplicatePid, commandLine: listenerCommandLine({ sessionId }) }]]);
  await withListenHarness({ probes: { listProcesses: scan.listProcesses } }, async ({ tempRoot, api }) => {
    await assert.rejects(
      runSessionCommand(listenArgs(sessionId, tempRoot)),
      new RegExp(`already running for session ${sessionId} as codex \\(pid ${duplicatePid}\\)`),
    );
    assert.deepEqual(scan.timeouts, [LISTENER_PROCESS_SCAN_TIMEOUT_MS]);
    assert.deepEqual(api.calls, []);
    await assertNoPidRecords(sessionId, tempRoot);
  });
});

test("Listener bins: a duplicate started through create-sentinelayer.js from a checkout is refused", LISTEN_TEST, async () => {
  const sessionId = "scan-finds-create-sentinelayer";
  const duplicatePid = process.pid + 200_002;
  // As this platform's process table shows a checkout's listener: no "sentinelayer-cli"
  // anywhere in it. Windows quotes the path with a space; ps prints POSIX arguments unquoted.
  const listen = `session listen --session ${sessionId} --agent Codex`;
  const commandLine =
    process.platform === "win32"
      ? `"C:\\Program Files\\nodejs\\node.exe" H:/create-sentinelayer/bin/create-sentinelayer.js ${listen}`
      : `/usr/bin/node /home/u/create-sentinelayer/bin/create-sentinelayer.js ${listen}`;
  const scan = scriptedScan([[{ pid: duplicatePid, commandLine }]]);
  await withListenHarness({ probes: { listProcesses: scan.listProcesses } }, async ({ tempRoot, api }) => {
    await assert.rejects(
      runSessionCommand(listenArgs(sessionId, tempRoot)),
      new RegExp(`already running for session ${sessionId} as codex \\(pid ${duplicatePid}\\)`),
    );
    assert.deepEqual(api.calls, []);
    await assertNoPidRecords(sessionId, tempRoot);
  });
});

test("Listener bins: the wrappers a launch leaves around a listener (npm exec, sh -c, cmd /c) are not one", LISTEN_TEST, async () => {
  const sessionId = "scan-skips-launch-wrappers";
  const listen = `session listen --session ${sessionId} --agent Codex`;
  const wrappers = [
    `npm exec sentinelayer-cli ${listen}`,
    `sh -c sentinelayer-cli ${listen}`,
    `"C:\\Windows\\system32\\cmd.exe" /d /s /c "sentinelayer-cli ${listen}"`,
    `"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js" sentinelayer-cli ${listen}`,
  ].map((commandLine, index) => ({ pid: process.pid + 200_010 + index, commandLine }));
  const scan = scriptedScan([wrappers]);
  await withListenHarness({ probes: { listProcesses: scan.listProcesses } }, async ({ tempRoot, api }) => {
    await runSessionCommand(listenArgs(sessionId, tempRoot));

    assert.deepEqual(scan.timeouts, [LISTENER_PROCESS_SCAN_TIMEOUT_MS]);
    assert.equal(api.calls.filter((call) => call.method === "GET").length, 1);
    await assertNoPidRecords(sessionId, tempRoot);
  });
});

test("Listener scan unknown: --force stops nothing when the takeover scan fails, even after the status check confirmed the record", LISTEN_TEST, async () => {
  const sessionId = "scan-unknown-force-tracked";
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = once(child, "exit", { signal: AbortSignal.timeout(30_000) });
  // The status check's scan confirms the record (its process started before the record was
  // written); the takeover's scan then fails.
  const confirming = [
    { pid: child.pid, ppid: OUTSIDE_PID, startedAtMs: Date.now() - 60_000, commandLine: listenerCommandLine({ sessionId }) },
  ];
  const scan = scriptedScan([confirming, scanTimeoutError()]);
  const probes = {
    listProcesses: scan.listProcesses,
    readCommandLine: async () => listenerCommandLine({ sessionId }),
  };
  try {
    await withListenHarness({ probes }, async ({ tempRoot, api }) => {
      await writeListenerPidRecord(sessionId, "Codex", {
        targetPath: tempRoot,
        pid: child.pid,
        listenerId: "listener-codex-tracked",
      });

      // A record confirmed a moment ago is no evidence of what holds its pid now, nor of
      // which processes this command runs under: an unread takeover scan stops nothing.
      await assert.rejects(
        runSessionCommand(listenArgs(sessionId, tempRoot, ["--force"])),
        new RegExp(
          `Could not confirm that pid ${child.pid} is a session listener --force can replace .*\\(process_scan_timeout\\)\\. No listener was stopped or started\\.`,
        ),
      );
      // One scan confirmed the record for the status check; the takeover scan failed.
      assert.deepEqual(scan.timeouts, [LISTENER_PROCESS_SCAN_TIMEOUT_MS, LISTENER_PROCESS_SCAN_TIMEOUT_MS]);
      assert.deepEqual(api.calls, []);
    });
    assert.equal(child.exitCode, null, "the recorded listener was stopped");
    assert.equal(isProcessAlive(child.pid), true, "the recorded listener was stopped");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited.catch(() => {});
  }
});

test("Listener scan unknown: status is unknown, never not-running, when the scan fails", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-listener-scan-status-"));
  try {
    await seedWorkspace(tempRoot);
    const sessionId = "scan-unknown-status";
    const failing = scriptedScan([scanTimeoutError()]);

    const noRecord = await getListenerProcessStatus(sessionId, "Codex", {
      targetPath: tempRoot,
      homeDir: tempRoot,
      _listProcesses: failing.listProcesses,
    });
    assert.equal(noRecord.state, "unknown");
    assert.equal(noRecord.running, null);
    assert.equal(noRecord.reason, "process_scan_timeout");
    assert.deepEqual(failing.timeouts, [LISTENER_PROCESS_SCAN_TIMEOUT_MS]);

    const slower = scriptedScan([scanSpawnError()]);
    const retried = await getListenerProcessStatus(sessionId, "Codex", {
      targetPath: tempRoot,
      homeDir: tempRoot,
      scanTimeoutMs: LISTENER_PROCESS_SCAN_RETRY_TIMEOUT_MS,
      _listProcesses: slower.listProcesses,
    });
    assert.equal(retried.state, "unknown");
    assert.equal(retried.reason, "process_scan_failed:ENOENT");
    assert.deepEqual(slower.timeouts, [LISTENER_PROCESS_SCAN_RETRY_TIMEOUT_MS]);

    // A record whose pid is gone proves nothing about untracked listeners.
    const deadChild = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(deadChild, "exit");
    await writeListenerPidRecord(sessionId, "Codex", {
      targetPath: tempRoot,
      homeDir: tempRoot,
      pid: deadChild.pid,
      listenerId: "listener-codex-dead",
    });
    const staleRecord = await getListenerProcessStatus(sessionId, "Codex", {
      targetPath: tempRoot,
      homeDir: tempRoot,
      _listProcesses: scriptedScan([scanTimeoutError()]).listProcesses,
    });
    assert.equal(staleRecord.state, "unknown");
    assert.equal(staleRecord.running, null);
    assert.equal(staleRecord.record.listenerId, "listener-codex-dead");

    // A live record whose command line matches counts once one scan confirms its process
    // started before the record was written. Without that scan it is unknown too.
    await writeListenerPidRecord(sessionId, "Codex", {
      targetPath: tempRoot,
      homeDir: tempRoot,
      pid: process.pid,
      listenerId: "listener-codex-live",
    });
    const confirmingScan = scriptedScan([[{ pid: process.pid, startedAtMs: Date.now() - 60_000 }]]);
    const tracked = await getListenerProcessStatus(sessionId, "Codex", {
      targetPath: tempRoot,
      homeDir: tempRoot,
      _readProcessCommandLine: async () => listenerCommandLine({ sessionId }),
      _listProcesses: confirmingScan.listProcesses,
    });
    assert.equal(tracked.state, "running");
    assert.equal(tracked.pid, process.pid);
    assert.deepEqual(confirmingScan.timeouts, [LISTENER_PROCESS_SCAN_TIMEOUT_MS]);
    const trackedUnread = await getListenerProcessStatus(sessionId, "Codex", {
      targetPath: tempRoot,
      homeDir: tempRoot,
      _readProcessCommandLine: async () => listenerCommandLine({ sessionId }),
      _listProcesses: scriptedScan([scanTimeoutError()]).listProcesses,
    });
    assert.equal(trackedUnread.state, "unknown");
    assert.equal(trackedUnread.reason, "process_scan_timeout");
    assert.equal(trackedUnread.record.listenerId, "listener-codex-live");

    // A live record that cannot be verified falls back to the scan, and so is unknown too.
    const unverified = await getListenerProcessStatus(sessionId, "Codex", {
      targetPath: tempRoot,
      homeDir: tempRoot,
      _readProcessCommandLine: async () => "",
      _listProcesses: scriptedScan([scanTimeoutError()]).listProcesses,
    });
    assert.equal(unverified.state, "unknown");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Listener scan unknown: scan helpers report a failed scan, never an empty one", async () => {
  const sessionId = "scan-unknown-helpers";

  const matches = await listMatchingListenerProcesses(sessionId, "Codex", {
    _listProcesses: scriptedScan([scanTimeoutError()]).listProcesses,
  });
  assert.deepEqual(matches, { ok: false, reason: "process_scan_timeout" });

  const unreadable = await listMatchingListenerProcesses(sessionId, "Codex", {
    _listProcesses: async () => undefined,
  });
  assert.deepEqual(unreadable, { ok: false, reason: "process_scan_unreadable" });

  const badJson = await listMatchingListenerProcesses(sessionId, "Codex", {
    _listProcesses: async () => JSON.parse("{not json"),
  });
  assert.deepEqual(badJson, { ok: false, reason: "process_scan_unreadable" });

  const summary = await summarizeLocalListenerProcesses(sessionId, ["Codex"], {
    _listProcesses: scriptedScan([scanSpawnError()]).listProcesses,
  });
  assert.deepEqual(summary, { ok: false, reason: "process_scan_failed:ENOENT", sessionId });

  const stopped = await stopMatchingListenerProcesses(sessionId, "Codex", {
    _listProcesses: scriptedScan([scanTimeoutError()]).listProcesses,
  });
  assert.deepEqual(stopped, { ok: false, reason: "process_scan_timeout" });

  const empty = await listMatchingListenerProcesses(sessionId, "Codex", {
    _listProcesses: async () => [],
  });
  assert.deepEqual(empty, { ok: true, matches: [] });
});

test("Listener scan unknown: session listeners reports local processes as unknown when the scan fails", LISTEN_TEST, async () => {
  const scan = scriptedScan([scanTimeoutError()]);
  const present = [{ agentId: "codex", lastSeenMs: Date.now() }];
  await withListenHarness({ probes: { listProcesses: scan.listProcesses }, present }, async ({ tempRoot }) => {
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 600 });

    const json = await runSessionCommand([
      "session",
      "listeners",
      session.sessionId,
      "--path",
      tempRoot,
      "--json",
    ]);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.count, 1);
    assert.equal(payload.localProcessScan.ok, false);
    assert.equal(payload.localProcessScan.reason, "process_scan_timeout");
    // No count when the table was not read: null, never 0 (0 would read as "no duplicates").
    assert.equal(payload.localProcessScan.processCount, null);
    assert.equal(payload.localProcessScan.duplicateProcessCount, null);
    assert.equal("localProcessCount" in payload.listeners[0], false);

    const text = await runSessionCommand([
      "session",
      "listeners",
      session.sessionId,
      "--path",
      tempRoot,
    ]);
    assert.match(
      text.stdout,
      /Local listener processes: unknown\. The local process check did not complete \(process_scan_timeout\)/,
    );
  });
});


// --- The checking process's own ancestors -------------------------------------------------

// The listen command a launcher carries in full: `bash -c "<it>"`, `nohup <it>`, and so on.
// A flag follows the agent, as in a real launch, so its value does not take in a closing quote.
function fullListenCommand(sessionId, agentId = "Codex") {
  return `node /opt/tools/sl/bin/sl.js session listen --session ${sessionId} --agent ${agentId} --interval 60`;
}

// node started on the CLI's entry script, as a real listener's command line reads.
function nodeListenerCommandLine(sessionId, agentId = "Codex") {
  return `${NODE_ON_COMMAND_LINE} /opt/tools/sl/bin/sl.js session listen --session ${sessionId} --agent ${agentId} --interval 60`;
}

// A command line whose first word names no executable, so it cannot tell a launcher from a
// listener (listenerProcessKind "unknown") on any platform.
function unnamedExecutableCommandLine(sessionId, agentId = "Codex") {
  return `/opt/tools/ /opt/tools/sl/bin/sl.js session listen --session ${sessionId} --agent ${agentId} --interval 60`;
}

// A pid no row in these tables has, standing for a parent outside the table.
const OUTSIDE_PID = 2_147_483_000;

// An idle process for a table row to name, so that a wrong stop lands on a process this test
// started, never on one it did not.
async function spawnIdle() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = once(child, "exit", { signal: AbortSignal.timeout(30_000) });
  await once(child, "spawn");
  return { child, pid: child.pid, exited };
}

async function stopIdles(idles) {
  for (const idle of idles) {
    if (idle.child.exitCode === null && idle.child.signalCode === null) idle.child.kill("SIGTERM");
    await idle.exited.catch(() => {});
  }
}

function isRunning(idle) {
  return idle.child.exitCode === null && idle.child.signalCode === null && isProcessAlive(idle.pid);
}

// This process as a launch chain leaves it: started by `parent`, which `grandparent` started,
// both launchers carrying the full listen command, each created before its child.
function launchedCheckerRows({ sessionId, parent, grandparent, now }) {
  const listen = fullListenCommand(sessionId);
  return [
    { pid: process.pid, ppid: parent, startedAtMs: now, commandLine: listenerCommandLine({ sessionId }) },
    { pid: parent, ppid: grandparent, startedAtMs: now - 1_000, commandLine: `/usr/bin/bash -c "${listen}"` },
    {
      pid: grandparent,
      ppid: OUTSIDE_PID,
      startedAtMs: now - 2_000,
      commandLine: `nohup timeout 86400 ${listen}`,
    },
  ];
}

test("Listener ancestors: the launchers in the table are the shapes the pattern matches", () => {
  const rows = launchedCheckerRows({ sessionId: "s-1", parent: 11, grandparent: 12, now: 1 });
  const shapes = [
    ...rows.map((row) => row.commandLine),
    nodeListenerCommandLine("s-1"),
    unnamedExecutableCommandLine("s-1"),
  ];
  for (const commandLine of shapes) {
    for (const platform of ["win32", "linux", "darwin"]) {
      assert.equal(
        listenerCommandLineMatches(commandLine, { sessionId: "s-1", agentId: "Codex", platform }),
        true,
        `${platform}: ${commandLine}`,
      );
    }
  }
});

test("Listener ancestors: a launcher is told from a listener by its executable and node's script", () => {
  const listen = "session listen --session s-1 --agent codex --interval 60";
  const kind = (commandLine, platform, name = "") => listenerProcessKind({ commandLine, name }, { platform });
  const PLATFORMS = ["win32", "linux", "darwin"];
  for (const platform of PLATFORMS) {
    // Launchers, by name: the listen command is text in their arguments.
    for (const launcher of ["bash", "sh", "dash", "zsh", "cmd", "powershell", "pwsh", "nohup", "timeout", "env", "screen", "tmux", "script", "setsid", "nice"]) {
      assert.equal(kind(`/usr/bin/${launcher} node /opt/sl/bin/sl.js ${listen}`, platform), "wrapper", `${platform} ${launcher}`);
    }
    assert.equal(kind(`/usr/bin/bash -c "node /opt/sl/bin/sl.js ${listen}"`, platform), "wrapper", platform);
    // node on a CLI entry, from any of node's names, is the listener.
    for (const node of ["node", "/usr/bin/nodejs", "NODE.EXE"]) {
      // Windows quotes the executable path; ps(1) prints POSIX arguments as they are.
      const shown = platform === "win32" ? `"${node}"` : node;
      assert.equal(kind(`${shown} /opt/sl/bin/sl.js ${listen}`, platform), "listener", `${platform} ${node}`);
    }
    assert.equal(kind(`node --no-warnings --title=sl --inspect-port 0 /opt/sl/bin/sl.js ${listen}`, platform), "listener", platform);
    assert.equal(kind(`node -- /opt/sl/bin/sl.js ${listen}`, platform), "listener", platform);
    // An executable that is neither is unknown, never a launcher.
    assert.equal(kind(`/opt/bin/mystery-runtime /opt/sl/bin/sl.js ${listen}`, platform), "unknown", platform);
    assert.equal(kind(unnamedExecutableCommandLine("s-1"), platform), "unknown", platform);
    // node arguments that cannot be read with certainty are unknown, never a launcher: a
    // preload (which may load the CLI), an option this does not know (it may take the next
    // argument), and inline code next to a CLI entry.
    for (const preload of ["-r /opt/hook.js", "--require /opt/hook.js", "--import=./setup.mjs", "--loader ./l.mjs"]) {
      assert.equal(kind(`node ${preload} /opt/sl/bin/sl.js ${listen}`, platform), "unknown", `${platform} ${preload}`);
    }
    assert.equal(kind(`node --some-new-flag value /opt/sl/bin/sl.js ${listen}`, platform), "unknown", platform);
    // An option is judged by its name whatever its spelling, so "=" proves nothing.
    assert.equal(kind(`node --unknown-opt=1 /opt/sl/bin/sl.js ${listen}`, platform), "unknown", platform);
    assert.equal(kind(`node --no-warnings=1 /opt/sl/bin/sl.js ${listen}`, platform), "unknown", platform);
    assert.equal(kind(`node --import=./x.mjs /opt/sl/bin/sl.js ${listen}`, platform), "unknown", platform);
    assert.equal(kind(`node --inspect=9229 --title sl /opt/sl/bin/sl.js ${listen}`, platform), "listener", platform);
    assert.equal(kind(`node -e "require('./x')" /opt/sl/bin/sl.js ${listen}`, platform), "unknown", platform);
    assert.equal(kind(`node -p 1 /opt/sl/bin/sl.js ${listen}`, platform), "unknown", platform);
    // Inline code with no CLI entry among the arguments is a launcher. Read through ps(1), the
    // quotes are literal bytes of the arguments, so the same line is not read with certainty.
    assert.equal(
      kind(`node -e "spawn('C:/opt/sl/bin/sl.js','session')" ${listen}`, platform),
      platform === "win32" ? "wrapper" : "unknown",
      platform,
    );
    assert.equal(kind(`node -e spawn(1) ${listen}`, platform), "wrapper", platform);
  }
  // The executable's name is the Windows process name, whatever the command line says.
  assert.equal(kind(String.raw`node C:\sl\bin\sl.js ${listen}`, "win32", "bash.exe"), "wrapper");
  assert.equal(kind(String.raw`bash C:\sl\bin\sl.js ${listen}`, "win32", "node.exe"), "listener");
  assert.equal(kind(String.raw`C:\sl\bin\sl.js ${listen}`, "win32", "mystery-runtime.exe"), "unknown");
  // Windows arguments are quoted, so node on another script is certainly a launcher there,
  // unless a quote is left open.
  assert.equal(kind(String.raw`"C:\Program Files\nodejs\node.exe" "C:\npm\bin\npx-cli.js" C:\sl\bin\sl.js ${listen}`, "win32", "node.exe"), "wrapper");
  assert.equal(kind(String.raw`"C:\Program Files\nodejs\node.exe" "C:\Program Files\nodejs\node_modules\sentinelayer-cli\bin\sl.js" ${listen}`, "win32", "node.exe"), "listener");
  assert.equal(kind(String.raw`"C:\Program Files\nodejs\node.exe" "C:\my tools\bin\sl.js ${listen}`, "win32", "node.exe"), "unknown");
  // An empty quoted argument stays an argument: here it is --title's value, so --title does
  // not take the CLI entry in its place. Empty where the script goes, it is not a script.
  assert.equal(kind(String.raw`"C:\Program Files\nodejs\node.exe" --title "" C:\sl\bin\sl.js ${listen}`, "win32", "node.exe"), "listener");
  assert.equal(kind(String.raw`"C:\Program Files\nodejs\node.exe" "" C:\sl\bin\sl.js ${listen}`, "win32", "node.exe"), "unknown");
  // A quote escaped with a backslash cannot be read with certainty.
  assert.equal(kind(String.raw`"C:\Program Files\nodejs\node.exe" --title "a \"b\"" C:\sl\bin\sl.js ${listen}`, "win32", "node.exe"), "unknown");
  // In ps output a run of spaces may hide an empty argument, so it cannot be read either.
  assert.equal(kind(`node --title  /opt/sl/bin/sl.js ${listen}`, "linux"), "unknown");
  // ps prints POSIX arguments unquoted, so a first argument that is not an entry may be the
  // first piece of an entry path with a space: unknown there.
  for (const platform of ["linux", "darwin"]) {
    // A quote in ps output is a byte of the argument. A file named with one is not the CLI
    // entry, and no name is recognised by dropping it: such a line is unknown, never a listener.
    for (const script of [`/opt/sl/bin/sl.js'`, `'/opt/sl/bin/sl.js'`, `/opt/sl/bin/"sl.js`, `"/opt/sl/bin/sl.js"`]) {
      assert.equal(kind(`node ${script} ${listen}`, platform), "unknown", `${platform} ${script}`);
    }
    // The same entry, unquoted as ps prints it, is a listener.
    assert.equal(kind(`/usr/bin/node /opt/sl/bin/sl.js ${listen}`, platform), "listener", platform);
    assert.equal(kind(`node /home/dev/my fork/bin/sl.js ${listen}`, platform), "unknown", platform);
    assert.equal(kind(`node /usr/lib/node_modules/npm/bin/npx-cli.js /opt/sl/bin/sl.js ${listen}`, platform), "unknown", platform);
    // npm links: the command names are entries on POSIX, and Debian names node "nodejs".
    assert.equal(kind(`node /usr/local/bin/sl ${listen}`, platform), "listener", platform);
    assert.equal(kind(`nodejs /usr/lib/node_modules/sentinelayer-cli/bin/sl.js ${listen}`, platform), "listener", platform);
  }
  // The checker's own node counts as node whatever it is named.
  assert.equal(kind(`${NODE_ON_COMMAND_LINE} /opt/sl/bin/sl.js ${listen}`, process.platform), "listener");
  assert.equal(
    listenerProcessKind({ commandLine: `/opt/node22/bin/node22 /opt/sl/bin/sl.js ${listen}` }, { platform: "linux", nodeExecutable: "/opt/node22/bin/node22" }),
    "listener",
  );
  assert.equal(normalizeImageName(String.raw`C:\Program Files\nodejs\NODE.EXE`), "node");
});

for (const force of [false, true]) {
  test(`Listener ancestors: the checker's own launchers are not a running listener, so it starts${force ? ", and --force stops none of them" : ""}`, LISTEN_TEST, async () => {
    const sessionId = `ancestors-own-launchers-${force ? "force" : "plain"}`;
    const idles = [await spawnIdle(), await spawnIdle()];
    const [parent, grandparent] = idles;
    try {
      const rows = launchedCheckerRows({
        sessionId,
        parent: parent.pid,
        grandparent: grandparent.pid,
        now: Date.now(),
      });
      const scan = scriptedScan([rows]);
      await withListenHarness({ probes: { listProcesses: scan.listProcesses } }, async ({ tempRoot, api }) => {
        await runSessionCommand(listenArgs(sessionId, tempRoot, force ? ["--force"] : []));

        // One scan, which found nothing, so no takeover ran.
        assert.deepEqual(scan.timeouts, [LISTENER_PROCESS_SCAN_TIMEOUT_MS]);
        assert.equal(api.calls.filter((call) => call.method === "GET").length, 1);
        await assertNoPidRecords(sessionId, tempRoot);
      });
      assert.equal(isRunning(parent), true, "the parent was stopped");
      assert.equal(isRunning(grandparent), true, "the grandparent was stopped");

      const summary = await summarizeLocalListenerProcesses(sessionId, ["Codex"], {
        _listProcesses: async () => rows,
      });
      assert.equal(summary.processCount, 0);
      assert.deepEqual(summary.agents[0].pids, []);
    } finally {
      await stopIdles(idles);
    }
  });
}

for (const force of [false, true]) {
  test(`Listener ancestors: a launcher above a parent that is not this CLI is still found and not counted${force ? ", and --force does not stop it" : ""}`, LISTEN_TEST, async () => {
    const sessionId = `ancestors-native-parent-${force ? "force" : "plain"}`;
    const grandparent = await spawnIdle();
    const nativeParentPid = process.pid + 300_000;
    try {
      const now = Date.now();
      const rows = [
        { pid: process.pid, ppid: nativeParentPid, startedAtMs: now, commandLine: listenerCommandLine({ sessionId }) },
        // As the Windows scan gives a process that names no CLI entry: no command line.
        { pid: nativeParentPid, ppid: grandparent.pid, startedAtMs: now - 1_000, name: "cmd.exe", commandLine: null },
        {
          pid: grandparent.pid,
          ppid: OUTSIDE_PID,
          startedAtMs: now - 2_000,
          commandLine: `/usr/bin/bash -c "${fullListenCommand(sessionId)}"`,
        },
      ];
      const matches = await listMatchingListenerProcesses(sessionId, "Codex", { _listProcesses: async () => rows });
      assert.deepEqual(matches.matches, []);

      const scan = scriptedScan([rows]);
      await withListenHarness({ probes: { listProcesses: scan.listProcesses } }, async ({ tempRoot, api }) => {
        await runSessionCommand(listenArgs(sessionId, tempRoot, force ? ["--force"] : []));
        assert.deepEqual(scan.timeouts, [LISTENER_PROCESS_SCAN_TIMEOUT_MS]);
        assert.equal(api.calls.filter((call) => call.method === "GET").length, 1);
      });
      assert.equal(isRunning(grandparent), true, "the grandparent was stopped");
    } finally {
      await stopIdles([grandparent]);
    }
  });
}

for (const force of [false, true]) {
  test(`Listener ancestors: a listener outside the chain, and a sibling inside it, are still duplicates${force ? "; --force stops only them" : ""}`, LISTEN_TEST, async () => {
    const sessionId = `ancestors-other-listeners-${force ? "force" : "plain"}`;
    const idles = [await spawnIdle(), await spawnIdle(), await spawnIdle(), await spawnIdle()];
    const [parent, grandparent, unrelated, sibling] = idles;
    try {
      const now = Date.now();
      const rows = [
        ...launchedCheckerRows({ sessionId, parent: parent.pid, grandparent: grandparent.pid, now }),
        // Its own chain, nothing to do with this process.
        { pid: unrelated.pid, ppid: OUTSIDE_PID, startedAtMs: now - 500, commandLine: listenerCommandLine({ sessionId }) },
        // Started by this process's grandparent: a brother of its parent, not an ancestor.
        { pid: sibling.pid, ppid: grandparent.pid, startedAtMs: now - 400, commandLine: listenerCommandLine({ sessionId }) },
      ];
      const matches = await listMatchingListenerProcesses(sessionId, "Codex", {
        _listProcesses: async () => rows,
      });
      assert.deepEqual(matches.matches.map((match) => match.pid), [unrelated.pid, sibling.pid]);

      const scan = scriptedScan([rows]);
      await withListenHarness({ probes: { listProcesses: scan.listProcesses } }, async ({ tempRoot, api }) => {
        if (!force) {
          await assert.rejects(
            runSessionCommand(listenArgs(sessionId, tempRoot)),
            new RegExp(`already running for session ${sessionId} as codex \\(pid ${unrelated.pid}\\)`),
          );
          assert.deepEqual(api.calls, []);
          return;
        }
        await runSessionCommand(listenArgs(sessionId, tempRoot, ["--force"]));
        // The status check, then the takeover's own scan.
        assert.deepEqual(scan.timeouts, [LISTENER_PROCESS_SCAN_TIMEOUT_MS, LISTENER_PROCESS_SCAN_TIMEOUT_MS]);
        assert.equal(api.calls.filter((call) => call.method === "GET").length, 1);
      });
      if (force) {
        await unrelated.exited;
        await sibling.exited;
      }
      assert.equal(isRunning(unrelated), !force);
      assert.equal(isRunning(sibling), !force);
      assert.equal(isRunning(parent), true, "the parent was stopped");
      assert.equal(isRunning(grandparent), true, "the grandparent was stopped");
    } finally {
      await stopIdles(idles);
    }
  });
}

for (const force of [false, true]) {
  test(`Listener ancestors: a listener this process runs under is a duplicate, so it refuses${force ? ", and --force refuses rather than stop it" : ""}`, LISTEN_TEST, async () => {
    const sessionId = `ancestors-listener-above-${force ? "force" : "plain"}`;
    const idles = [await spawnIdle(), await spawnIdle()];
    const [shell, listenerAbove] = idles;
    try {
      const now = Date.now();
      const rows = [
        { pid: process.pid, ppid: shell.pid, startedAtMs: now, commandLine: listenerCommandLine({ sessionId }) },
        // A shell carrying the command: a launcher.
        { pid: shell.pid, ppid: listenerAbove.pid, startedAtMs: now - 1_000, commandLine: `/usr/bin/bash -c "${fullListenCommand(sessionId)}"` },
        // node started on the CLI's entry script with this listen command: a listener.
        { pid: listenerAbove.pid, ppid: OUTSIDE_PID, startedAtMs: now - 2_000, commandLine: nodeListenerCommandLine(sessionId) },
      ];
      const matches = await listMatchingListenerProcesses(sessionId, "Codex", { _listProcesses: async () => rows });
      assert.deepEqual(matches.matches.map((match) => [match.pid, match.ancestor]), [[listenerAbove.pid, true]]);

      // With --force the takeover's own scan fails, so only the status check stands between
      // --force and the ancestor.
      const scan = scriptedScan(force ? [rows, scanTimeoutError()] : [rows]);
      await withListenHarness({ probes: { listProcesses: scan.listProcesses } }, async ({ tempRoot, api }) => {
        await assert.rejects(
          runSessionCommand(listenArgs(sessionId, tempRoot, force ? ["--force"] : [])),
          force
            ? new RegExp(`\\(pid ${listenerAbove.pid}\\), and this command runs under it, so --force will not stop it\\. No listener was stopped or started\\.`)
            : new RegExp(`already running for session ${sessionId} as codex \\(pid ${listenerAbove.pid}\\)`),
        );
        assert.deepEqual(scan.timeouts, [LISTENER_PROCESS_SCAN_TIMEOUT_MS]);
        assert.deepEqual(api.calls, []);
        await assertNoPidRecords(sessionId, tempRoot);
      });
      assert.equal(isRunning(listenerAbove), true, "the listener above was stopped");
      assert.equal(isRunning(shell), true, "the shell was stopped");
    } finally {
      await stopIdles(idles);
    }
  });
}

for (const force of [false, true]) {
  test(`Listener ancestors: an ancestor that cannot be told from a listener makes the answer unknown, so it refuses${force ? ", and --force stops nothing" : ""}`, LISTEN_TEST, async () => {
    const sessionId = `ancestors-unknown-kind-${force ? "force" : "plain"}`;
    const above = await spawnIdle();
    try {
      const now = Date.now();
      const rows = [
        { pid: process.pid, ppid: above.pid, startedAtMs: now, commandLine: listenerCommandLine({ sessionId }) },
        { pid: above.pid, ppid: OUTSIDE_PID, startedAtMs: now - 1_000, commandLine: unnamedExecutableCommandLine(sessionId) },
      ];
      const scan = scriptedScan([rows]);
      await withListenHarness({ probes: { listProcesses: scan.listProcesses } }, async ({ tempRoot, api }) => {
        await assert.rejects(
          runSessionCommand(listenArgs(sessionId, tempRoot, force ? ["--force"] : [])),
          (error) => {
            assert.match(error.message, /^Could not confirm whether a session listener is already running/);
            assert.ok(error.message.includes("(listener_unconfirmed)"), error.message);
            assert.match(error.message, /No listener was started\./);
            return true;
          },
        );
        assert.deepEqual(scan.timeouts, [LISTENER_PROCESS_SCAN_TIMEOUT_MS, LISTENER_PROCESS_SCAN_RETRY_TIMEOUT_MS]);
        assert.deepEqual(api.calls, []);
        await assertNoPidRecords(sessionId, tempRoot);
      });
      assert.equal(isRunning(above), true, "the ancestor was stopped");
    } finally {
      await stopIdles([above]);
    }
  });
}

test("Listener ancestors: a recorded parent created after its child holds a reused pid and is not an ancestor", LISTEN_TEST, async () => {
  const sessionId = "ancestors-reused-parent-pid";
  // Stands for a real listener that took the pid of this process's exited parent. Never
  // stopped: only the refusing path runs.
  const reusedPid = process.pid + 200_100;
  const now = Date.now();
  const rowsWithParentStart = (startedAtMs) => [
    { pid: process.pid, ppid: reusedPid, startedAtMs: now, commandLine: listenerCommandLine({ sessionId }) },
    { pid: reusedPid, ppid: OUTSIDE_PID, startedAtMs, commandLine: nodeListenerCommandLine(sessionId) },
  ];
  const later = rowsWithParentStart(now + 5_000);
  const matches = await listMatchingListenerProcesses(sessionId, "Codex", { _listProcesses: async () => later });
  assert.deepEqual(matches.matches.map((match) => [match.pid, Boolean(match.ancestor)]), [[reusedPid, false]]);
  const summary = await summarizeLocalListenerProcesses(sessionId, ["Codex"], { _listProcesses: async () => later });
  assert.deepEqual(summary.agents[0].pids, [reusedPid]);

  // The same row created before this process is its parent.
  const earlier = rowsWithParentStart(now - 5_000);
  const parentMatches = await listMatchingListenerProcesses(sessionId, "Codex", { _listProcesses: async () => earlier });
  assert.deepEqual(parentMatches.matches.map((match) => [match.pid, Boolean(match.ancestor)]), [[reusedPid, true]]);

  const scan = scriptedScan([later]);
  await withListenHarness({ probes: { listProcesses: scan.listProcesses } }, async ({ tempRoot, api }) => {
    await assert.rejects(
      runSessionCommand(listenArgs(sessionId, tempRoot)),
      new RegExp(`already running for session ${sessionId} as codex \\(pid ${reusedPid}\\)`),
    );
    assert.deepEqual(api.calls, []);
  });
});

test("Listener ancestors: the walk ends at a cycle, a missing parent and the depth cap, and on Windows at a link it cannot date", () => {
  const self = 1_000;
  const row = (pid, ppid, startedAtMs = null) => ({ pid, ppid, startedAtMs, commandLine: `node /x/bin/sl.js ${pid}` });
  const walk = (rows, platform = "linux") => [...listenerAncestorPids(rows, { pid: self, platform })].sort((a, b) => a - b);

  // Cycles: two processes naming each other, one naming itself, a chain back to the checker.
  assert.deepEqual(walk([row(self, 1), row(1, 2), row(2, 1)]), [1, 2]);
  assert.deepEqual(walk([row(self, 1), row(1, 1)]), [1]);
  assert.deepEqual(walk([row(self, 1), row(1, 2), row(2, self)]), [1, 2]);
  // A parent not in the table, or no parent recorded, ends the walk.
  assert.deepEqual(walk([row(self, 1), row(1, OUTSIDE_PID)]), [1]);
  assert.deepEqual(walk([row(self, OUTSIDE_PID)]), []);
  assert.deepEqual(walk([row(self, 1), { pid: 1, commandLine: "bash" }]), [1]);
  assert.deepEqual(walk([]), []);
  // A row without a command line is still a link in the chain.
  assert.deepEqual(walk([row(self, 1), { pid: 1, ppid: 2 }, row(2, OUTSIDE_PID)]), [1, 2]);
  // The parent given for the checker is used when its row records none.
  assert.deepEqual([...listenerAncestorPids([row(1, null)], { pid: self, parentPid: 1, platform: "linux" })], [1]);
  // A chain longer than any launch is cut at the cap.
  const chain = [row(self, 1), ...Array.from({ length: 500 }, (_, index) => row(index + 1, index + 2))];
  assert.equal(walk(chain).length, 64);

  // Windows never re-parents, so a link is followed only with both creation times, in order.
  assert.deepEqual(walk([row(self, 1), row(1, 2)], "win32"), []);
  assert.deepEqual(walk([row(self, 1, 300), row(1, 2, 200), row(2, 3, 100)], "win32"), [1, 2]);
  assert.deepEqual(walk([row(self, 1, 300), row(1, 2, 200), row(2, 3)], "win32"), [1]);
  assert.deepEqual(walk([row(self, 1, 300), row(1, 2, 200), row(2, 3, 201)], "win32"), [1]);
  // On POSIX too, a "parent" that started well after its child is not followed.
  assert.deepEqual(walk([row(self, 1, 300), row(1, 2, 5_300)]), []);
});

test("Listener ancestors: a pid record counts only for the process that wrote it, to each platform's precision", () => {
  const writtenAtMs = Date.parse("2026-10-11T08:00:00.000Z");
  const record = { pid: 500, startedAt: new Date(writtenAtMs).toISOString() };
  const listener = "node /opt/sl/bin/sl.js session listen --session s-1 --agent Codex";
  const holder = (startedAtMs, options) =>
    pidRecordHolder(record, { pid: 500, startedAtMs, commandLine: listener }, options);
  for (const platform of ["win32", "linux", "darwin"]) {
    // Started before the record was written: the listener that wrote it.
    assert.equal(holder(writtenAtMs - 5_000, { platform }), "confirmed", platform);
    // Unknown on either side proves nothing, so it is never confirmed.
    assert.equal(holder(null, { platform }), "unconfirmed", platform);
    assert.equal(pidRecordHolder({ pid: 500 }, { pid: 500, startedAtMs: writtenAtMs - 5_000, commandLine: listener }, { platform }), "unconfirmed");
    // Judged by what the process is: a launcher never wrote a listener's record, and a
    // process that may be a listener proves nothing. The record's own command line is used
    // when the scan's row has none.
    const older = { pid: 500, startedAtMs: writtenAtMs - 5_000 };
    assert.equal(pidRecordHolder(record, { ...older, commandLine: `bash -c "${listener}"` }, { platform }), "wrapper", platform);
    assert.equal(pidRecordHolder(record, { ...older, commandLine: `mystery-runtime /opt/sl/bin/sl.js` }, { platform }), "unconfirmed", platform);
    assert.equal(pidRecordHolder(record, older, { platform, commandLine: listener }), "confirmed", platform);
    // One of the checker's ancestors, or no process at all.
    assert.equal(holder(writtenAtMs - 5_000, { platform, ancestors: new Set([500]) }), "ancestor", platform);
    assert.equal(pidRecordHolder(record, null, { platform }), "gone", platform);
  }
  // Windows creation times are exact: a process started even 1 ms after the record is another.
  assert.equal(holder(writtenAtMs + 1, { platform: "win32" }), "reused");
  assert.equal(holder(writtenAtMs + 1_000, { platform: "win32" }), "reused");
  // A POSIX start time can read about a second late, so that much is allowed there.
  assert.equal(holder(writtenAtMs + 1_000, { platform: "linux" }), "confirmed");
  assert.equal(holder(writtenAtMs + 5_000, { platform: "linux" }), "reused");
});

for (const withinSlack of [false, true]) {
  test(`Listener ancestors: a pid record held by one of this process's launchers${withinSlack ? ", started a second after the record," : ""} is not running, and --force stops nothing`, LISTEN_TEST, async () => {
    const sessionId = `ancestors-record-held-by-launcher-${withinSlack ? "slack" : "older"}`;
    const idles = [await spawnIdle(), await spawnIdle()];
    const [parent, grandparent] = idles;
    const launcher = `/usr/bin/bash -c "${fullListenCommand(sessionId)}"`;
    const probes = { readCommandLine: async (pid) => (Number(pid) === parent.pid ? launcher : "") };
    try {
      await withListenHarness({ probes }, async ({ tempRoot, api }) => {
        await writeListenerPidRecord(sessionId, "Codex", {
          targetPath: tempRoot,
          pid: parent.pid,
          listenerId: "listener-codex-exited",
        });
        const recordedAtMs = Date.parse((await readListenerPidRecord(sessionId, "Codex", { targetPath: tempRoot })).startedAt);
        // Started before the record, so only the ancestry says it is not the record's
        // listener; or a second after it, which a POSIX start time cannot tell from before.
        const now = withinSlack ? recordedAtMs + 2_000 : Date.now();
        const rows = launchedCheckerRows({ sessionId, parent: parent.pid, grandparent: grandparent.pid, now });
        const scan = scriptedScan([rows]);
        setListenerProcessProbesForTests({ ...probes, listProcesses: scan.listProcesses });

        const status = await getListenerProcessStatus(sessionId, "Codex", { targetPath: tempRoot });
        assert.equal(status.state, "not_running");
        assert.equal(status.holder, "ancestor");
        assert.equal(status.record.pid, parent.pid);

        await runSessionCommand(listenArgs(sessionId, tempRoot, ["--force"]));
        assert.deepEqual(scan.timeouts, [LISTENER_PROCESS_SCAN_TIMEOUT_MS, LISTENER_PROCESS_SCAN_TIMEOUT_MS]);
        assert.equal(api.calls.filter((call) => call.method === "GET").length, 1);
      });
      assert.equal(isRunning(parent), true, "the parent was stopped");
      assert.equal(isRunning(grandparent), true, "the grandparent was stopped");
    } finally {
      await stopIdles(idles);
    }
  });
}

test("Listener ancestors: a pid record whose process start time is unknown authorises nothing: --force refuses and stops nothing", LISTEN_TEST, async () => {
  const sessionId = "ancestors-record-unknown-start";
  const holder = await spawnIdle();
  const probes = { readCommandLine: async () => listenerCommandLine({ sessionId }) };
  try {
    await withListenHarness({ probes }, async ({ tempRoot, api }) => {
      await writeListenerPidRecord(sessionId, "Codex", {
        targetPath: tempRoot,
        pid: holder.pid,
        listenerId: "listener-codex-unknown-start",
      });
      const rows = [
        { pid: process.pid, ppid: OUTSIDE_PID, startedAtMs: Date.now(), commandLine: listenerCommandLine({ sessionId }) },
        { pid: holder.pid, ppid: OUTSIDE_PID, commandLine: listenerCommandLine({ sessionId }) },
      ];
      const scan = scriptedScan([rows]);
      setListenerProcessProbesForTests({ ...probes, listProcesses: scan.listProcesses });

      await assert.rejects(
        runSessionCommand(listenArgs(sessionId, tempRoot, ["--force"])),
        (error) => {
          assert.match(error.message, /^Could not confirm whether a session listener is already running/);
          assert.ok(error.message.includes("(pid_record_unconfirmed)"), error.message);
          assert.match(error.message, /No listener was started\./);
          return true;
        },
      );
      assert.deepEqual(scan.timeouts, [LISTENER_PROCESS_SCAN_TIMEOUT_MS, LISTENER_PROCESS_SCAN_RETRY_TIMEOUT_MS]);
      assert.deepEqual(api.calls, []);
    });
    assert.equal(isRunning(holder), true, "the record's process was stopped");
  } finally {
    await stopIdles([holder]);
  }
});

// What the takeover's own scan can say about the listener the status check found.
const TAKEOVER_SCAN_CHANGES = {
  "is now a launcher above this process": {
    rows: (listenerPid, now) => [
      { pid: process.pid, ppid: listenerPid, startedAtMs: now },
      { pid: listenerPid, ppid: OUTSIDE_PID, startedAtMs: now - 5_000, commandLine: null },
    ],
    refusal: (pid) => new RegExp(`Could not confirm that pid ${pid} is a session listener --force can replace .*\\(unconfirmed\\)\\. No listener was stopped or started\\.`),
  },
  // The same process (the same start time), which this scan no longer counts as a listener
  // for this session and agent: never stopped, and the takeover refuses.
  "is now a launcher": {
    rows: (listenerPid, now, sessionId) => [
      { pid: process.pid, ppid: OUTSIDE_PID, startedAtMs: now },
      { pid: listenerPid, ppid: OUTSIDE_PID, startedAtMs: now - 5_000, name: "bash.exe", commandLine: `/usr/bin/bash -c "${fullListenCommand(sessionId)}"` },
    ],
    refusal: (pid) => new RegExp(`Could not confirm that pid ${pid} is a session listener --force can replace .*\\(unconfirmed\\)\\. No listener was stopped or started\\.`),
  },
  "is now a listener for another session": {
    rows: (listenerPid, now, sessionId) => [
      { pid: process.pid, ppid: OUTSIDE_PID, startedAtMs: now },
      { pid: listenerPid, ppid: OUTSIDE_PID, startedAtMs: now - 5_000, commandLine: nodeListenerCommandLine(`${sessionId}-other`) },
    ],
    refusal: (pid) => new RegExp(`Could not confirm that pid ${pid} is a session listener --force can replace .*\\(unconfirmed\\)\\. No listener was stopped or started\\.`),
  },
  "is now a listener for another agent": {
    rows: (listenerPid, now, sessionId) => [
      { pid: process.pid, ppid: OUTSIDE_PID, startedAtMs: now },
      { pid: listenerPid, ppid: OUTSIDE_PID, startedAtMs: now - 5_000, commandLine: nodeListenerCommandLine(sessionId, "Claude") },
    ],
    refusal: (pid) => new RegExp(`Could not confirm that pid ${pid} is a session listener --force can replace .*\\(unconfirmed\\)\\. No listener was stopped or started\\.`),
  },
  "is now a listener above this process": {
    rows: (listenerPid, now, sessionId) => [
      { pid: process.pid, ppid: listenerPid, startedAtMs: now },
      { pid: listenerPid, ppid: OUTSIDE_PID, startedAtMs: now - 5_000, commandLine: nodeListenerCommandLine(sessionId) },
    ],
    refusal: (pid) => new RegExp(`\\(pid ${pid}\\), and this command runs under it, so --force will not stop it\\. No listener was stopped or started\\.`),
  },
  "is now an ancestor that may be a listener": {
    rows: (listenerPid, now, sessionId) => [
      { pid: process.pid, ppid: listenerPid, startedAtMs: now },
      { pid: listenerPid, ppid: OUTSIDE_PID, startedAtMs: now - 5_000, commandLine: unnamedExecutableCommandLine(sessionId) },
    ],
    refusal: (pid) => new RegExp(`Could not confirm that pid ${pid} is a session listener --force can replace .*\\(listener_unconfirmed\\)\\. No listener was stopped or started\\.`),
  },
  "changed hands": {
    rows: (listenerPid, now) => [
      { pid: process.pid, ppid: OUTSIDE_PID, startedAtMs: now },
      { pid: listenerPid, ppid: OUTSIDE_PID, startedAtMs: now + 1_000, commandLine: null },
    ],
    refusal: (pid) => new RegExp(`Could not confirm that pid ${pid} is a session listener --force can replace .*\\(reused\\)\\. No listener was stopped or started\\.`),
  },
};

for (const [change, { rows: takeoverRows, refusal }] of Object.entries(TAKEOVER_SCAN_CHANGES)) {
  test(`Listener ancestors: --force does not stop the listener the status check found when the takeover scan says it ${change}`, LISTEN_TEST, async () => {
    const sessionId = `ancestors-takeover-${change.replace(/\W+/g, "-")}`;
    const listener = await spawnIdle();
    try {
      const now = Date.now();
      const statusRows = [
        { pid: process.pid, ppid: OUTSIDE_PID, startedAtMs: now },
        { pid: listener.pid, ppid: OUTSIDE_PID, startedAtMs: now - 5_000, commandLine: listenerCommandLine({ sessionId }) },
      ];
      const scan = scriptedScan([statusRows, takeoverRows(listener.pid, now, sessionId)]);
      await withListenHarness({ probes: { listProcesses: scan.listProcesses } }, async ({ tempRoot, api }) => {
        await assert.rejects(runSessionCommand(listenArgs(sessionId, tempRoot, ["--force"])), refusal(listener.pid));
        assert.deepEqual(scan.timeouts, [LISTENER_PROCESS_SCAN_TIMEOUT_MS, LISTENER_PROCESS_SCAN_TIMEOUT_MS]);
        assert.deepEqual(api.calls, []);
      });
      assert.equal(isRunning(listener), true, "the listener was stopped");
    } finally {
      await stopIdles([listener]);
    }
  });
}

test("Listener ancestors: --force stops nothing when the listener the status check found changed hands to another listener, not even the other listeners", LISTEN_TEST, async () => {
  const sessionId = "ancestors-takeover-changed-hands-to-a-listener";
  const idles = [await spawnIdle(), await spawnIdle()];
  const [found, other] = idles;
  try {
    const now = Date.now();
    const statusRows = [
      { pid: process.pid, ppid: OUTSIDE_PID, startedAtMs: now },
      { pid: found.pid, ppid: OUTSIDE_PID, startedAtMs: now - 5_000, commandLine: nodeListenerCommandLine(sessionId) },
      { pid: other.pid, ppid: OUTSIDE_PID, startedAtMs: now - 3_000, commandLine: nodeListenerCommandLine(sessionId) },
    ];
    // The takeover scan: the found pid is still a listener for this session and agent, but a
    // process started since holds it. Every refusal is decided before the first stop, so the
    // other listener, which the takeover would stop, is not stopped either.
    const takeoverRows = [
      statusRows[0],
      { ...statusRows[1], startedAtMs: now + 1_000 },
      statusRows[2],
    ];
    const scan = scriptedScan([statusRows, takeoverRows]);
    await withListenHarness({ probes: { listProcesses: scan.listProcesses } }, async ({ tempRoot, api }) => {
      await assert.rejects(
        runSessionCommand(listenArgs(sessionId, tempRoot, ["--force"])),
        new RegExp(`Could not confirm that pid ${found.pid} is a session listener --force can replace .*\\(reused\\)\\. No listener was stopped or started\\.`),
      );
      assert.deepEqual(scan.timeouts, [LISTENER_PROCESS_SCAN_TIMEOUT_MS, LISTENER_PROCESS_SCAN_TIMEOUT_MS]);
      assert.deepEqual(api.calls, []);
    });
    assert.equal(isRunning(found), true, "the found pid was stopped");
    assert.equal(isRunning(other), true, "the other listener was stopped");
  } finally {
    await stopIdles(idles);
  }
});

test("Listener ancestors: a pid record held by this process's real parent is not a running listener", LISTEN_TEST, async () => {
  const sessionId = "ancestors-record-held-by-real-parent";
  const parentPid = process.ppid;
  // The real process table; only the parent's command line is made up, as a launcher's.
  // Only the refusing path can run, so the parent is never stopped.
  const launcherCommandLine = `/usr/bin/bash -c "${fullListenCommand(sessionId)}"`;
  const probes = { readCommandLine: async (pid) => (Number(pid) === parentPid ? launcherCommandLine : "") };
  await withListenHarness({ probes }, async ({ tempRoot, api }) => {
    // Written after the parent started, so only the ancestry tells the two apart.
    await writeListenerPidRecord(sessionId, "Codex", {
      targetPath: tempRoot,
      pid: parentPid,
      listenerId: "listener-codex-exited",
    });
    const status = await getListenerProcessStatus(sessionId, "Codex", {
      targetPath: tempRoot,
      scanTimeoutMs: LISTENER_PROCESS_SCAN_RETRY_TIMEOUT_MS,
    });
    assert.equal(status.state, "not_running", JSON.stringify(status));
    assert.equal(status.holder, "ancestor");
    assert.equal(status.record.pid, parentPid);

    await runSessionCommand(listenArgs(sessionId, tempRoot));
    assert.equal(api.calls.filter((call) => call.method === "GET").length, 1);
  });
});

// --- Every matching process judged alike ---------------------------------------------------

for (const force of [false, true]) {
  test(`Listener ancestors: a nohup launcher around a listener elsewhere counts once, through its node child${force ? "; --force stops only the node" : ""}`, LISTEN_TEST, async () => {
    const sessionId = `uniform-nohup-sibling-${force ? "force" : "plain"}`;
    const idles = [await spawnIdle(), await spawnIdle()];
    const [launcher, listener] = idles;
    try {
      const now = Date.now();
      const rows = [
        { pid: process.pid, ppid: OUTSIDE_PID, startedAtMs: now, commandLine: listenerCommandLine({ sessionId }) },
        // Another terminal: nohup started node on the CLI's entry, and waits for it.
        { pid: launcher.pid, ppid: OUTSIDE_PID, startedAtMs: now - 2_000, commandLine: `nohup ${fullListenCommand(sessionId)}` },
        { pid: listener.pid, ppid: launcher.pid, startedAtMs: now - 1_000, commandLine: nodeListenerCommandLine(sessionId) },
      ];
      const matches = await listMatchingListenerProcesses(sessionId, "Codex", { _listProcesses: async () => rows });
      assert.deepEqual(matches.matches.map((match) => match.pid), [listener.pid]);
      const summary = await summarizeLocalListenerProcesses(sessionId, ["Codex"], { _listProcesses: async () => rows });
      assert.equal(summary.processCount, 1);
      assert.equal(summary.duplicateProcessCount, 0);
      assert.deepEqual(summary.agents[0].pids, [listener.pid]);

      const scan = scriptedScan([rows]);
      await withListenHarness({ probes: { listProcesses: scan.listProcesses } }, async ({ tempRoot, api }) => {
        if (!force) {
          await assert.rejects(
            runSessionCommand(listenArgs(sessionId, tempRoot)),
            new RegExp(`already running for session ${sessionId} as codex \\(pid ${listener.pid}\\)`),
          );
          assert.deepEqual(api.calls, []);
          return;
        }
        await runSessionCommand(listenArgs(sessionId, tempRoot, ["--force"]));
        assert.equal(api.calls.filter((call) => call.method === "GET").length, 1);
      });
      if (force) await listener.exited;
      assert.equal(isRunning(listener), !force);
      assert.equal(isRunning(launcher), true, "the nohup launcher was stopped");
    } finally {
      await stopIdles(idles);
    }
  });
}

// The chain Claude Code's shell tool leaves on Windows when it runs `bash -c "node ... session
// listen ..."` (or nohup, or timeout) under Git Bash: the tool's two bash.exe carry the
// whole command, and the inner bash was started by a forked copy of the tool's shell that has
// exited, so the walk from the listener cannot reach them.
function msysToolShellRows({ sessionId, now, toolLauncher, toolShell, innerShell, innerStub }) {
  const listen = fullListenCommand(sessionId);
  const toolCommand = `"C:\\Program Files\\Git\\bin\\bash.exe" -c "source /c/Users/dev/.claude/shell-snapshots/snapshot.sh && eval 'bash -c \\"${listen}\\"' < /dev/null"`;
  return [
    { pid: process.pid, ppid: innerStub, startedAtMs: now, name: "node.exe", commandLine: listenerCommandLine({ sessionId }) },
    { pid: innerStub, ppid: innerShell, startedAtMs: now - 100, name: "bash.exe", commandLine: `"C:\\Program Files\\Git\\usr\\bin\\bash.exe" -c "${listen}"` },
    // Its parent, the forked copy of the tool's shell, has exited.
    { pid: innerShell, ppid: OUTSIDE_PID, startedAtMs: now - 200, name: "bash.exe", commandLine: `"C:\\Program Files\\Git\\usr\\bin\\bash.exe" -c "${listen}"` },
    { pid: toolShell, ppid: toolLauncher, startedAtMs: now - 5_000, name: "bash.exe", commandLine: toolCommand },
    { pid: toolLauncher, ppid: OUTSIDE_PID - 1, startedAtMs: now - 5_100, name: "bash.exe", commandLine: toolCommand },
    { pid: OUTSIDE_PID - 1, startedAtMs: now - 60_000, name: "claude.exe", commandLine: null },
  ];
}

for (const force of [false, true]) {
  test(`Listener ancestors: under Git Bash, the tool shells above a broken parent chain are launchers, so it starts${force ? " and --force stops none of them" : ""}`, LISTEN_TEST, async () => {
    const sessionId = `uniform-msys-tool-shell-${force ? "force" : "plain"}`;
    const idles = [await spawnIdle(), await spawnIdle(), await spawnIdle(), await spawnIdle()];
    const [toolLauncher, toolShell, innerShell, innerStub] = idles;
    try {
      const rows = msysToolShellRows({
        sessionId,
        now: Date.now(),
        toolLauncher: toolLauncher.pid,
        toolShell: toolShell.pid,
        innerShell: innerShell.pid,
        innerStub: innerStub.pid,
      });
      // Not vacuous: every shell carries the listen command, and the walk does not reach
      // the tool's two.
      for (const row of rows.slice(1, 5)) {
        assert.equal(listenerCommandLineMatches(row.commandLine, { sessionId, agentId: "Codex" }), true, row.commandLine);
      }
      assert.deepEqual([...listenerAncestorPids(rows, { pid: process.pid })].sort(), [innerShell.pid, innerStub.pid].sort());
      const matches = await listMatchingListenerProcesses(sessionId, "Codex", { _listProcesses: async () => rows });
      assert.deepEqual(matches.matches, []);

      const scan = scriptedScan([rows]);
      await withListenHarness({ probes: { listProcesses: scan.listProcesses } }, async ({ tempRoot, api }) => {
        await runSessionCommand(listenArgs(sessionId, tempRoot, force ? ["--force"] : []));
        assert.deepEqual(scan.timeouts, [LISTENER_PROCESS_SCAN_TIMEOUT_MS]);
        assert.equal(api.calls.filter((call) => call.method === "GET").length, 1);
      });
      for (const idle of idles) assert.equal(isRunning(idle), true, `shell ${idle.pid} was stopped`);
    } finally {
      await stopIdles(idles);
    }
  });
}

// Processes that match a listen command but cannot be told to be a listener or a launcher.
const UNCONFIRMED_PROCESSES = {
  "an executable that is neither node nor a launcher": (sessionId) =>
    `/opt/bin/mystery-runtime /opt/tools/sl/bin/sl.js session listen --session ${sessionId} --agent Codex --interval 60`,
  "node with a preload next to the CLI entry": (sessionId) =>
    `${NODE_ON_COMMAND_LINE} --require /opt/hook.js /opt/tools/sl/bin/sl.js session listen --session ${sessionId} --agent Codex --interval 60`,
  "node with an option this does not know": (sessionId) =>
    `${NODE_ON_COMMAND_LINE} --some-new-flag value /opt/tools/sl/bin/sl.js session listen --session ${sessionId} --agent Codex --interval 60`,
};

for (const [shape, commandLine] of Object.entries(UNCONFIRMED_PROCESSES)) {
  for (const force of [false, true]) {
    test(`Listener ancestors: ${shape} may be a listener, so it refuses${force ? ", and --force stops nothing" : ""}`, LISTEN_TEST, async () => {
      const sessionId = `uniform-unconfirmed-${shape.replace(/\W+/g, "-")}-${force ? "force" : "plain"}`;
      const other = await spawnIdle();
      try {
        const rows = [
          { pid: process.pid, ppid: OUTSIDE_PID, startedAtMs: Date.now(), commandLine: listenerCommandLine({ sessionId }) },
          { pid: other.pid, ppid: OUTSIDE_PID, startedAtMs: Date.now() - 1_000, commandLine: commandLine(sessionId) },
        ];
        assert.equal(listenerProcessKind(rows[1]), "unknown");
        const scan = scriptedScan([rows]);
        await withListenHarness({ probes: { listProcesses: scan.listProcesses } }, async ({ tempRoot, api }) => {
          await assert.rejects(
            runSessionCommand(listenArgs(sessionId, tempRoot, force ? ["--force"] : [])),
            (error) => {
              assert.match(error.message, /^Could not confirm whether a session listener is already running/);
              assert.ok(error.message.includes("(listener_unconfirmed)"), error.message);
              return true;
            },
          );
          assert.deepEqual(api.calls, []);
          await assertNoPidRecords(sessionId, tempRoot);
        });
        assert.equal(isRunning(other), true, "the process was stopped");
        // `session listeners` still shows it: it may be a listener.
        const summary = await summarizeLocalListenerProcesses(sessionId, ["Codex"], { _listProcesses: async () => rows });
        assert.deepEqual(summary.agents[0].pids, [other.pid]);
      } finally {
        await stopIdles([other]);
      }
    });
  }
}
