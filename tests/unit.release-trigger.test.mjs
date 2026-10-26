import "./setup-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
const steps = workflow.jobs["policy-precheck"].steps;
const trigger = steps.find(step => step.name === "Enforce trusted tag trigger policy");
const freshness = steps.find(step => step.name === "Fail stale release runs");
const expression = "${{ toJSON(github.event.created) }}";

test("both release created-event bindings preserve the boolean without a truthy fallback", () => {
  assert.equal(trigger.env.EVENT_CREATED, expression);
  assert.equal(freshness.env.EVENT_CREATED, expression);
  assert.equal(JSON.stringify(false), "false");
});

test("actual release creation guard accepts only a serialized true event", async () => {
  const owned = await mkdtemp(path.join(os.tmpdir(), "sl-release-trigger-"));
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  try {
    // Run the event guard itself, without unrelated jq/platform or GitHub API dependencies.
    const guard = trigger.run.match(/^if \[ "\$\{EVENT_CREATED\}" != "true" \]; then\n[\s\S]*?^fi$/m)?.[0];
    assert.ok(guard, "actual workflow creation guard must be present");
    const env = Object.fromEntries(["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    Object.assign(env, { HOME: owned, USERPROFILE: owned, GITHUB_STEP_SUMMARY: path.join(owned, "summary"), EVENT_DELETED: "false", EVENT_NAME: "push" });
    for (const value of [true, false, null, "true", "", 1]) {
      const result = spawnSync(bash, ["-c", guard], {
        cwd: owned, env: { ...env, EVENT_CREATED: JSON.stringify(value) }, encoding: "utf8", timeout: 15000,
      });
      if (value === true) assert.equal(result.status, 0, result.stderr || result.stdout);
      else { assert.equal(result.status, 1, result.stderr || result.stdout); assert.match(result.stdout, /requires newly created semver tags/); }
    }
  } finally { await rm(owned, { recursive: true, force: true }); }
});
