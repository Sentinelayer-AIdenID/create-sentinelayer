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
  return [
    process.execPath,
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
  // As the process table shows a checkout's listener: no "sentinelayer-cli" anywhere in it.
  const commandLine = `"C:\\Program Files\\nodejs\\node.exe" H:/create-sentinelayer/bin/create-sentinelayer.js session listen --session ${sessionId} --agent Codex`;
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

test("Listener scan unknown: --force replaces a verified tracked listener one-for-one when the takeover scan fails, and says so", LISTEN_TEST, async () => {
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

      const { stderr } = await runSessionCommand(listenArgs(sessionId, tempRoot, ["--force"]));

      // One scan confirmed the record for the status check; the takeover scan failed.
      assert.deepEqual(scan.timeouts, [LISTENER_PROCESS_SCAN_TIMEOUT_MS, LISTENER_PROCESS_SCAN_TIMEOUT_MS]);
      assert.match(
        stderr,
        new RegExp(`did not complete \\(process_scan_timeout\\); replacing listener pid ${child.pid} only`),
      );
      await exited;
      assert.equal(api.calls.filter((call) => call.method === "GET").length, 1);
      await assertNoPidRecords(sessionId, tempRoot);
    });
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
  return `"${process.execPath}" /opt/tools/sl/bin/sl.js session listen --session ${sessionId} --agent ${agentId} --interval 60`;
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
  // Launchers: the listen command is text in their arguments.
  for (const platform of ["win32", "linux", "darwin"]) {
    assert.equal(kind(`/usr/bin/bash -c "node /opt/sl/bin/sl.js ${listen}"`, platform), "wrapper", platform);
    assert.equal(kind(`sh -c "node /opt/sl/bin/sl.js ${listen}"`, platform), "wrapper", platform);
    assert.equal(kind(`nohup node /opt/sl/bin/sl.js ${listen}`, platform), "wrapper", platform);
    assert.equal(kind(`timeout 600 node /opt/sl/bin/sl.js ${listen}`, platform), "wrapper", platform);
    assert.equal(kind(`node -e "require('child_process')" /opt/sl/bin/sl.js ${listen}`, platform), "wrapper", platform);
  }
  // Windows rows come from Win32_Process: Name is the executable, and double quotes group.
  const win = (commandLine, name) => kind(commandLine, "win32", name);
  assert.equal(win(String.raw`"C:\Program Files\Git\usr\bin\bash.exe" -c "node C:/sl/bin/sl.js ${listen}"`, "bash.exe"), "wrapper");
  assert.equal(win(String.raw`C:\Windows\system32\cmd.exe /d /s /c "node C:\sl\bin\sl.js ${listen}"`, "cmd.exe"), "wrapper");
  assert.equal(win(String.raw`powershell.exe -NoProfile -Command "node C:\sl\bin\sl.js ${listen}"`, "powershell.exe"), "wrapper");
  assert.equal(win(String.raw`"C:\Program Files\nodejs\node.exe" C:\tools\wrapper.js C:\sl\bin\sl.js ${listen}`, "node.exe"), "wrapper");
  assert.equal(win(String.raw`"C:\Program Files\nodejs\node.exe" "C:\Program Files\nodejs\node_modules\sentinelayer-cli\bin\sl.js" ${listen}`, "node.exe"), "listener");
  assert.equal(win(String.raw`"C:\Program Files\nodejs\node.exe" --import ./setup.mjs H:/create-sentinelayer/bin/create-sentinelayer.js ${listen}`, "node.exe"), "listener");
  // The executable is the one Windows ran, whatever the command line's first word says.
  assert.equal(win(String.raw`node C:\sl\bin\sl.js ${listen}`, "bash.exe"), "wrapper");
  // POSIX rows come from ps: the first argument is the executable, and nothing is quoted.
  assert.equal(kind(`/usr/local/bin/node /usr/local/lib/node_modules/sentinelayer-cli/bin/sl.js ${listen}`, "linux"), "listener");
  assert.equal(kind(`node /usr/local/bin/sl ${listen}`, "darwin"), "listener");
  assert.equal(kind(`node --require /opt/hook.js /opt/sl/bin/sl.js ${listen}`, "linux"), "listener");
  // A script path with a space reads as two arguments there, so node's script cannot be told.
  assert.equal(kind(`node /home/dev/my fork/bin/sl.js ${listen}`, "linux"), "unknown");
  assert.equal(kind(`node /opt/tools/wrapper.js /opt/sl/bin/sl.js ${listen}`, "darwin"), "unknown");
  // No executable named at all.
  for (const platform of ["win32", "linux", "darwin"]) {
    assert.equal(kind(unnamedExecutableCommandLine("s-1"), platform), "unknown", platform);
  }
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
            assert.ok(error.message.includes("(ancestor_unconfirmed)"), error.message);
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
  const holder = (startedAtMs, options) => pidRecordHolder(record, { pid: 500, startedAtMs }, options);
  for (const platform of ["win32", "linux", "darwin"]) {
    // Started before the record was written: the listener that wrote it.
    assert.equal(holder(writtenAtMs - 5_000, { platform }), "confirmed", platform);
    // Unknown on either side proves nothing, so it is never confirmed.
    assert.equal(holder(null, { platform }), "unconfirmed", platform);
    assert.equal(pidRecordHolder({ pid: 500 }, { pid: 500, startedAtMs: writtenAtMs - 5_000 }, { platform }), "unconfirmed");
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
    refusal: (pid) => new RegExp(`Could not confirm that pid ${pid} is a session listener --force can replace .*\\(ancestor\\)\\. No listener was stopped or started\\.`),
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
    refusal: (pid) => new RegExp(`Could not confirm that pid ${pid} is a session listener --force can replace .*\\(ancestor_unconfirmed\\)\\. No listener was stopped or started\\.`),
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
