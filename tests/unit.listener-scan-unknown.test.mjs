import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
import {
  LISTENER_PROCESS_SCAN_RETRY_TIMEOUT_MS,
  LISTENER_PROCESS_SCAN_TIMEOUT_MS,
  getListenerProcessStatus,
  listMatchingListenerProcesses,
  listenerAncestorPids,
  listenerCommandLineMatches,
  readGlobalListenerPidRecord,
  readListenerPidRecord,
  readProcessStartTime,
  resolveGlobalListenerPidPath,
  resolveListenerPidPath,
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
  const scan = scriptedScan([scanTimeoutError()]);
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

      // The verified record answered the status check; only the takeover scan ran, and failed.
      assert.deepEqual(scan.timeouts, [LISTENER_PROCESS_SCAN_TIMEOUT_MS]);
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

    // A live record whose command line matches is certain, so no scan is needed.
    await writeListenerPidRecord(sessionId, "Codex", {
      targetPath: tempRoot,
      homeDir: tempRoot,
      pid: process.pid,
      listenerId: "listener-codex-live",
    });
    const unusedScan = scriptedScan([scanTimeoutError()]);
    const tracked = await getListenerProcessStatus(sessionId, "Codex", {
      targetPath: tempRoot,
      homeDir: tempRoot,
      _readProcessCommandLine: async () => listenerCommandLine({ sessionId }),
      _listProcesses: unusedScan.listProcesses,
    });
    assert.equal(tracked.state, "running");
    assert.equal(tracked.pid, process.pid);
    assert.deepEqual(unusedScan.timeouts, []);

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

// --- The checking process's own launchers ---------------------------------------------------

// The listen command a launcher carries in full: `bash -c "<it>"`, `nohup <it>`, and so on.
// A flag follows the agent, as in a real launch, so its value does not take in a closing quote.
function fullListenCommand(sessionId, agentId = "Codex") {
  return `node /opt/tools/sl/bin/sl.js session listen --session ${sessionId} --agent ${agentId} --interval 60`;
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
// both carrying the full listen command, each created before its child.
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
  for (const row of rows) {
    for (const platform of ["win32", "linux", "darwin"]) {
      assert.equal(
        listenerCommandLineMatches(row.commandLine, { sessionId: "s-1", agentId: "Codex", platform }),
        true,
        `${platform}: ${row.commandLine}`,
      );
    }
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

test("Listener ancestors: a recorded parent created after its child holds a reused pid and is still a duplicate", LISTEN_TEST, async () => {
  const sessionId = "ancestors-reused-parent-pid";
  // Stands for a real listener that took the pid of this process's exited parent. Never
  // stopped: only the refusing path runs.
  const reusedPid = process.pid + 200_100;
  const now = Date.now();
  const rowsWithParentStart = (startedAtMs) => [
    { pid: process.pid, ppid: reusedPid, startedAtMs: now, commandLine: listenerCommandLine({ sessionId }) },
    { pid: reusedPid, ppid: OUTSIDE_PID, startedAtMs, commandLine: listenerCommandLine({ sessionId }) },
  ];
  const later = rowsWithParentStart(now + 5_000);

  const matches = await listMatchingListenerProcesses(sessionId, "Codex", { _listProcesses: async () => later });
  assert.deepEqual(matches.matches.map((match) => match.pid), [reusedPid]);
  const summary = await summarizeLocalListenerProcesses(sessionId, ["Codex"], { _listProcesses: async () => later });
  assert.deepEqual(summary.agents[0].pids, [reusedPid]);

  // The same row created before this process is its parent, and so not counted.
  const earlier = rowsWithParentStart(now - 5_000);
  const parentMatches = await listMatchingListenerProcesses(sessionId, "Codex", { _listProcesses: async () => earlier });
  assert.deepEqual(parentMatches.matches, []);

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
  // The parent given for the checker is used when its row records none.
  assert.deepEqual([...listenerAncestorPids([row(1, null)], { pid: self, parentPid: 1, platform: "linux" })], [1]);
  // A chain longer than any launch is cut at the cap.
  const chain = [row(self, 1), ...Array.from({ length: 500 }, (_, index) => row(index + 1, index + 2))];
  assert.equal(walk(chain).length, 64);

  // Windows never re-parents, so a link is followed only with both creation times, in order.
  assert.deepEqual(walk([row(self, 1), row(1, 2)], "win32"), []);
  assert.deepEqual(walk([row(self, 1, 300), row(1, 2, 200), row(2, 3, 100)], "win32"), [1, 2]);
  assert.deepEqual(walk([row(self, 1, 300), row(1, 2, 200), row(2, 3)], "win32"), [1]);
  assert.deepEqual(walk([row(self, 1, 300), row(1, 2, 200), row(2, 3, 250)], "win32"), [1]);
  // On POSIX too, a "parent" known to be newer than its child is not followed.
  assert.deepEqual(walk([row(self, 1, 300), row(1, 2, 400)]), []);
});

test("Listener ancestors: a stale pid record now held by this process's own parent is not a running listener", LISTEN_TEST, async () => {
  const sessionId = "ancestors-record-held-by-parent";
  const parentPid = process.ppid;
  const parentStartedAtMs = await readProcessStartTime(parentPid);
  assert.equal(Number.isFinite(parentStartedAtMs), true, "could not read the parent's start time");
  // What a launcher of this process shows, had it been given the pid of the listener that
  // wrote the record. Only the refusing path can run, so the parent is never stopped.
  const launcherCommandLine = `/usr/bin/bash -c "${fullListenCommand(sessionId)}"`;
  const probes = {
    listProcesses: async () => [],
    readCommandLine: async (pid) => (Number(pid) === parentPid ? launcherCommandLine : ""),
  };
  await withListenHarness({ probes }, async ({ tempRoot, api }) => {
    // A listener that wrote its record a minute before this process's parent was created.
    await writeListenerPidRecord(sessionId, "Codex", {
      targetPath: tempRoot,
      pid: parentPid,
      listenerId: "listener-codex-exited",
    });
    const writtenAt = new Date(parentStartedAtMs - 60_000).toISOString();
    for (const recordPath of [
      resolveListenerPidPath(sessionId, "Codex", { targetPath: tempRoot }),
      resolveGlobalListenerPidPath(sessionId, "Codex"),
    ]) {
      const record = JSON.parse(await readFile(recordPath, "utf-8"));
      await writeFile(recordPath, `${JSON.stringify({ ...record, startedAt: writtenAt }, null, 2)}\n`, "utf-8");
    }

    const status = await getListenerProcessStatus(sessionId, "Codex", { targetPath: tempRoot });
    assert.equal(status.state, "not_running");
    assert.equal(status.stale, true);
    assert.equal(status.reused, true);
    assert.equal(status.record.pid, parentPid);

    await runSessionCommand(listenArgs(sessionId, tempRoot));
    assert.equal(api.calls.filter((call) => call.method === "GET").length, 1);
  });
});
