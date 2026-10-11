import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";

import {
  LISTENER_PROCESS_SCAN_RETRY_TIMEOUT_MS,
  listMatchingListenerProcesses,
  listenerCommandLineMatches,
} from "../src/session/listener-process.js";

const SESSION_ID = "4fabea10-ab74-4998-beb9-8918f0e497f9";
const AGENT_ID = "codex-mobile";
const LISTEN = `session listen --session ${SESSION_ID} --agent ${AGENT_ID} --interval 60`;
const PLATFORMS = ["win32", "linux", "darwin"];
const POSIX_PLATFORMS = ["linux", "darwin"];

// package.json "bin", stated here rather than taken from the code under test.
const BIN_SCRIPTS = ["create-sentinelayer.js", "sentinelayer-cli.js", "sl.js"];
const BIN_COMMANDS = ["create-sentinelayer", "sentinel", "sentinelayer-cli", "sl-cli", "slc", "sl"];

// Command-line templates: <bin> is the entry and <listen> the listen arguments. The Windows
// shapes were read from running processes (Win32_Process.CommandLine), the POSIX ones from ps.
function fill(template, bin, listen = LISTEN) {
  return template.replace("<bin>", bin).replace("<listen>", listen);
}

function matches(commandLine, platform) {
  return listenerCommandLineMatches(commandLine, {
    sessionId: SESSION_ID,
    agentId: AGENT_ID,
    platform,
  });
}

// node started on a bin script by path: recognised on every platform.
const SCRIPT_LAUNCHES = {
  "Windows global install, .cmd shim": String.raw`"C:\Program Files\nodejs\\node.exe"  "C:\Program Files\nodejs\\node_modules\sentinelayer-cli\bin\<bin>" <listen>`,
  "Windows global install, .ps1 shim": String.raw`"C:\Program Files\nodejs\node.exe" "C:\Program Files\nodejs/node_modules/sentinelayer-cli/bin/<bin>" <listen>`,
  "Windows wrapper spawning the global script": String.raw`"C:\Program Files\nodejs\node.exe" "C:/Program Files/nodejs/node_modules/sentinelayer-cli/bin/<bin>" <listen>`,
  "Windows npx": String.raw`"node"   "C:\Users\dev\AppData\Local\npm-cache\_npx\9833c18b2d85bc59\node_modules\.bin\\..\sentinelayer-cli\bin\<bin>" <listen>`,
  "Windows checkout, unquoted forward slashes": String.raw`"C:\Program Files\nodejs\node.exe" H:/create-sentinelayer/bin/<bin> <listen>`,
  "Windows renamed checkout, unquoted backslashes": String.raw`node D:\src\my-fork\bin\<bin> <listen>`,
  "Windows renamed checkout, quoted path with a space": String.raw`"C:\Program Files\nodejs\node.exe" "D:\dev tools\fork\bin\<bin>" <listen>`,
  "POSIX global install, by script path": "node /usr/local/lib/node_modules/sentinelayer-cli/bin/<bin> <listen>",
  "POSIX checkout, relative path": "node bin/<bin> <listen>",
  "POSIX renamed checkout": "/usr/bin/node /home/dev/work/my-fork/bin/<bin> <listen>",
  "POSIX path in single quotes": "node '/home/dev/my fork/bin/<bin>' <listen>",
};

// node started on an npm bin link: the kernel passes the link path, so POSIX only.
const LINK_LAUNCHES = {
  "npm install -g, started by name": "node /usr/local/bin/<bin> <listen>",
  "nvm install": "node /home/dev/.nvm/versions/node/v22.11.0/bin/<bin> <listen>",
  npx: "node /home/dev/.npm/_npx/112d4d9546e31a6a/node_modules/.bin/<bin> <listen>",
  "local install or npm run": "node /home/dev/proj/node_modules/.bin/<bin> <listen>",
};

test("Listener bins: each bin script, by any path, is a listener for its session and agent", () => {
  for (const script of BIN_SCRIPTS) {
    for (const [shape, template] of Object.entries(SCRIPT_LAUNCHES)) {
      const commandLine = fill(template, script);
      for (const platform of PLATFORMS) {
        assert.equal(matches(commandLine, platform), true, `${platform} ${shape}: ${commandLine}`);
      }
    }
  }
});

test("Listener bins: each command name started through its npm link is a listener on POSIX", () => {
  for (const command of BIN_COMMANDS) {
    for (const [shape, template] of Object.entries(LINK_LAUNCHES)) {
      const commandLine = fill(template, command);
      for (const platform of POSIX_PLATFORMS) {
        assert.equal(matches(commandLine, platform), true, `${platform} ${shape}: ${commandLine}`);
      }
    }
  }
});

test("Listener bins: on Windows the Git Bash sh shim, which waits next to node, is not a listener", () => {
  const stubs = [
    String.raw`"C:\Program Files\Git\usr\bin\sh.exe" "/c/Program Files/nodejs/<bin>" <listen>`,
    String.raw`"C:\Program Files\Git\usr\bin\sh.exe" /c/Users/dev/AppData/Roaming/npm/<bin> <listen>`,
  ];
  for (const command of BIN_COMMANDS) {
    for (const template of stubs) {
      const commandLine = fill(template, command);
      assert.equal(matches(commandLine, "win32"), false, commandLine);
    }
  }
});

test("Listener bins: another session, another agent or another command is not this listener", () => {
  const checkout = "node /home/dev/fork/bin/<bin> <listen>";
  const others = {
    "another session": `session listen --session 4fabea10-ab74-4998-beb9-8918f0e497f0 --agent ${AGENT_ID}`,
    "another agent": `session listen --session ${SESSION_ID} --agent codex-mobile-2`,
    "a prefix of the agent": `session listen --session ${SESSION_ID} --agent codex`,
    "session say": `session say --session ${SESSION_ID} --agent ${AGENT_ID} hello`,
  };
  for (const script of BIN_SCRIPTS) {
    // The same line with the right arguments is a listener, so each miss below is the argument's.
    for (const platform of PLATFORMS) {
      assert.equal(matches(fill(checkout, script), platform), true, `${platform} ${script}`);
    }
    for (const [label, listen] of Object.entries(others)) {
      const commandLine = fill(checkout, script, listen);
      for (const platform of PLATFORMS) {
        assert.equal(matches(commandLine, platform), false, `${platform} ${label}: ${commandLine}`);
      }
    }
  }
});

test("Listener bins: look-alike file names, directories named like a bin and launch wrappers are not listeners", () => {
  const lookAlikes = BIN_SCRIPTS.flatMap((script) => [
    `x${script}`,
    `my-${script}`,
    `${script}on`,
    `${script}x`,
    `${script}.bak`,
    script.replace(/\.js$/, ".cjs"),
  ]);
  const commandLookAlikes = ["slack", "xsl", "sl2", "sentinels", "sl.cmd", "sl-cli.ps1", "create-sentinelayer.cmd"];
  const commandLines = [
    ...lookAlikes.map((name) => fill("node /opt/tools/bin/<bin> <listen>", name)),
    ...lookAlikes.map((name) => fill(String.raw`"C:\Program Files\nodejs\node.exe" "C:\tools\bin\<bin>" <listen>`, name)),
    ...commandLookAlikes.map((name) => fill("node /usr/local/bin/<bin> <listen>", name)),
    // A directory named like an entry is not the entry.
    fill("node /opt/create-sentinelayer/worker.js <listen>", ""),
    fill("node /opt/sentinelayer-cli/scripts/run.js <listen>", ""),
    fill("node /home/dev/sl/main.js <listen>", ""),
    fill(String.raw`node C:\tools\sl.js\main.js <listen>`, ""),
    // The processes a launch leaves around the listener name the command, not a path to it.
    fill("npm exec sentinelayer-cli <listen>", ""),
    fill("sh -c sentinelayer-cli <listen>", ""),
    fill(String.raw`"C:\Windows\system32\cmd.exe" /d /s /c "sentinelayer-cli <listen>"`, ""),
    fill(String.raw`"C:\Program Files\nodejs\node.exe" "C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js" sentinelayer-cli <listen>`, ""),
    fill(String.raw`"C:\Windows\system32\cmd.exe" /d /s /c ""C:\Program Files\nodejs\sl.cmd" <listen>"`, ""),
    fill(String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -File "C:\Program Files\nodejs\create-sentinelayer.ps1" <listen>`, ""),
  ];
  for (const commandLine of commandLines) {
    for (const platform of PLATFORMS) {
      assert.equal(matches(commandLine, platform), false, `${platform}: ${commandLine}`);
    }
  }
});

test("Listener bins: every bin in package.json is recognised, and this file covers each one", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"));
  const bins = Object.entries(pkg.bin || {});
  assert.ok(bins.length > 0, "package.json declares no bin");
  for (const [command, target] of bins) {
    const script = path.posix.basename(target);
    const byScript = fill("node /opt/install/bin/<bin> <listen>", script);
    for (const platform of PLATFORMS) {
      assert.equal(matches(byScript, platform), true, `${platform} bin "${command}" by script: ${byScript}`);
    }
    const byLink = fill("node /usr/local/bin/<bin> <listen>", command);
    for (const platform of POSIX_PLATFORMS) {
      assert.equal(matches(byLink, platform), true, `${platform} bin "${command}" by link: ${byLink}`);
    }
  }
  // The cases above are written for these entries; a new bin needs its own.
  const scripts = [...new Set(bins.map(([, target]) => path.posix.basename(target)))].sort();
  assert.deepEqual(scripts, [...BIN_SCRIPTS].sort());
  assert.deepEqual(bins.map(([command]) => command).sort(), [...BIN_COMMANDS].sort());
});

// A script that says it is running, then idles.
const IDLE_SCRIPT = 'process.stdout.write("ready\\n");\nsetInterval(() => {}, 1000);\n';

// Starts an idle process and resolves once its script runs. Before that, exec can still be in
// progress, and the process table may show no command line, or an interpreter's, for it.
async function startIdle(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
  await once(child, "spawn");
  const exited = once(child, "exit");
  await once(child.stdout, "data");
  return { child, exited };
}

async function stopIdle({ child, exited }) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await exited;
}

test("Listener bins: the real process scan finds a listener started through create-sentinelayer.js from a renamed install", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sl-listener-bins-"));
  // The path must not name the package, or this would pass on the old match too.
  assert.equal(root.toLowerCase().includes("sentinelayer-cli"), false, root);
  const sessionId = `listener-bins-${randomUUID()}`;
  const agentId = "codex";
  const binDir = path.join(root, "renamed-install", "bin");
  await mkdir(binDir, { recursive: true });
  const listenArgs = ["session", "listen", "--session", sessionId, "--agent", agentId];
  const started = [];
  try {
    for (const script of ["create-sentinelayer.js", "xcreate-sentinelayer.js"]) {
      await writeFile(path.join(binDir, script), IDLE_SCRIPT);
      started.push(await startIdle(process.execPath, [path.join(binDir, script), ...listenArgs]));
    }
    const [listener, lookAlike] = started.map(({ child }) => child);
    const scan = await listMatchingListenerProcesses(sessionId, agentId, {
      timeoutMs: LISTENER_PROCESS_SCAN_RETRY_TIMEOUT_MS,
    });
    assert.equal(scan.ok, true, `scan failed: ${scan.reason}`);
    const pids = scan.matches.map((match) => match.pid);
    assert.deepEqual(pids, [listener.pid], `matched ${JSON.stringify(scan.matches)}`);
    assert.equal(pids.includes(lookAlike.pid), false);
  } finally {
    await Promise.all(started.map(stopIdle));
    await rm(root, { recursive: true, force: true });
  }
});

test("Listener bins: on POSIX the real process scan finds a listener started through an npm bin link", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sl-listener-bins-"));
  const sessionId = `listener-bins-${randomUUID()}`;
  const agentId = "codex";
  // What `npm install -g` makes: bin/sentinel -> ../lib/.../bin/create-sentinelayer.js.
  const scriptDir = path.join(root, "lib", "node_modules", "renamed", "bin");
  const linkDir = path.join(root, "bin");
  await mkdir(scriptDir, { recursive: true });
  await mkdir(linkDir, { recursive: true });
  const script = path.join(scriptDir, "create-sentinelayer.js");
  await writeFile(script, `#!/usr/bin/env node\n${IDLE_SCRIPT}`);
  await chmod(script, 0o755);
  const link = path.join(linkDir, "sentinel");
  await symlink(path.relative(linkDir, script), link);
  let started = null;
  try {
    started = await startIdle(link, ["session", "listen", "--session", sessionId, "--agent", agentId]);
    const scan = await listMatchingListenerProcesses(sessionId, agentId, {
      timeoutMs: LISTENER_PROCESS_SCAN_RETRY_TIMEOUT_MS,
    });
    assert.equal(scan.ok, true, `scan failed: ${scan.reason}`);
    assert.deepEqual(scan.matches.map((match) => match.pid), [started.child.pid]);
    // The kernel hands node the link path, not the script it points to.
    assert.match(scan.matches[0].commandLine, /[\\/]bin[\\/]sentinel session listen /);
  } finally {
    if (started) await stopIdle(started);
    await rm(root, { recursive: true, force: true });
  }
});
