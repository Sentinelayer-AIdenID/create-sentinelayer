import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// A newcomer reads `sl session --help` before signing in. Help prints without login; anything that could run a
// command (an option before the flag, no flag at all) still meets the auth gate.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "bin", "create-sentinelayer.js");

function runUnauthenticated(cwd, args) {
  const env = {
    ...process.env,
    SENTINELAYER_SKIP_REMOTE_SYNC: "1",
    SENTINELAYER_SKIP_SENTI_AUTOSTART: "1",
    HOME: cwd,
    USERPROFILE: cwd,
    XDG_CONFIG_HOME: path.join(cwd, ".config"),
  };
  for (const key of ["SENTINELAYER_TOKEN", "SENTINELAYER_CLI_SKIP_AUTH", "SENTINELAYER_CLI_TEST_BYPASS_NONCE", "SENTINELAYER_CLI_TEST_BYPASS_SECRET", "SENTINELAYER_CLI_TEST_BYPASS_TOKEN", "SENTINELAYER_AGENT_ID"]) {
    delete env[key];
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("CLI help prints without login for a command and its subcommands; a runnable command stays gated", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-help-without-login-e2e-"));
  try {
    await writeFile(path.join(tempRoot, "package.json"), '{"name":"help-without-login-e2e","version":"1.0.0"}\n', "utf-8");

    for (const args of [["session", "--help"], ["session", "-h"], ["session", "say", "--help"], ["session", "say", "room-1", "hello", "--help"]]) {
      const result = await runUnauthenticated(tempRoot, args);
      assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stdout, /Usage: sentinelayer-cli session/, args.join(" "));
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Authentication required/, args.join(" "));
    }

    // Controls: an option before the flag, the bare command, and a word Commander does not dispatch (the legacy path,
    // which could act on its arguments) meet the gate.
    for (const args of [["session", "say", "room-1", "--message-file", "--help"], ["session", "say", "room-1", "hello"], ["my-new-project", "--help"], ["session", "say", "room-1", " --help"], ["session", "say", "room-1", "\t-h"], ["session", "say", "room-1", "\n--help"]]) {
      const result = await runUnauthenticated(tempRoot, args);
      assert.notEqual(result.code, 0, args.join(" "));
      assert.match(result.stderr, /Authentication required/, args.join(" "));
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
