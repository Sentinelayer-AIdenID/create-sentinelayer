// Preloaded by the test harness via --import ./tests/setup-env.mjs
// (the repo consistently uses tests/ not test/; see package.json scripts).
// Explicit import for standalone runs: node --test tests/unit.lockfile-audit.test.mjs
import "./setup-env.mjs";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

let lockfile;
try {
  lockfile = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")
  );
} catch (err) {
  throw new Error(`Failed to read package-lock.json: ${err.message}`);
}

test("lockfile is compatible with Jev action dep audit", () => {
  // The Jev action at sentinelayer-v1-action@ebfcb813 runs dep_audit.py
  // which rejects lockfile v2 markers (peerOptional, link) that indicate
  // incomplete resolution data. npm v3 lockfiles include "peer": true for
  // hoisted peer dependencies — these are standard npm behavior. The action
  // may also check for unknown markers; we verify only the known-rejected
  // markers are absent. If a CI run reveals additional rejections, the
  // lockfile must be regenerated with a compatible npm version.
  const packages = lockfile.packages || {};
  const blocked = [];
  for (const [key, record] of Object.entries(packages)) {
    if (record.peerOptional === true) blocked.push(key + " (peerOptional)");
    if (record.link === true) blocked.push(key + " (link)");
  }
  assert.deepEqual(blocked, [], `lockfile entries would be rejected by dep audit: ${blocked.join(", ")}`);
});

test("npm audit reports zero high or critical advisories (P1 gate compat)", () => {
  // The Jev gate severity_gate=P1 blocks on P0 (critical) and P1 (high).
  // This test ensures npm audit itself reports 0 such advisories, which
  // is what the dep_audit harness uses to decide HARNESS-NPM-AUDIT.
  let stdout;
  try {
    stdout = execSync("npm audit --json", {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });
  } catch (err) {
    // npm audit exits non-zero when vulnerabilities exist, but still
    // writes valid JSON to stdout.
    stdout = err.stdout || "";
  }
  const data = JSON.parse(stdout);
  const vulns = data.vulnerabilities || {};
  const blocking = [];
  for (const [name, v] of Object.entries(vulns)) {
    if (v.severity === "high" || v.severity === "critical") {
      blocking.push(name + ":" + v.severity);
    }
  }
  assert.deepEqual(
    blocking,
    [],
    `npm audit blocking advisories (high/critical): ${blocking.join(", ")}`
  );
});

test("Jev workflow action pin is in the actions-lock allowlist", () => {
  const workflowPath = new URL("../.github/workflows/omar-gate-jev.yml", import.meta.url);
  const lockPath = new URL("../.github/policies/actions-lock.json", import.meta.url);
  const workflow = readFileSync(workflowPath, "utf8");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));

  const usesMatch = workflow.match(/uses:\s*Sentinelayer-AIdenID\/sentinelayer-v1-action@([a-f0-9]{40})/);
  assert.ok(usesMatch, "Jev workflow must pin Sentinelayer-AIdenID/sentinelayer-v1-action with a 40-char SHA");
  const pin = usesMatch[1];

  const allowed = lock["Sentinelayer-AIdenID/sentinelayer-v1-action"] || [];
  assert.ok(
    allowed.includes(pin),
    `Jev workflow pin ${pin} must be in actions-lock.json allowlist for Sentinelayer-AIdenID/sentinelayer-v1-action (allowed: ${allowed.join(", ")})`
  );
});
