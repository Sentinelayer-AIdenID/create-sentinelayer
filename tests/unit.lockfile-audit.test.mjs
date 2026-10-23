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

test("lockfile has a valid packages section", () => {
  // A missing or empty packages section is indistinguishable from an
  // unparseable lockfile — the Jev action's dep_audit.py treats both as
  // unsafe_lockfile. The test must fail on absence, not silently pass.
  const packages = lockfile.packages;
  assert.ok(packages && typeof packages === "object", "lockfile must have a packages section");
  const keys = Object.keys(packages);
  assert.ok(keys.length > 0, "lockfile packages section must not be empty");
});

test("lockfile is compatible with Jev action dep audit", () => {
  // The Jev action at sentinelayer-v1-action@ebfcb813 runs dep_audit.py
  // which rejects lockfile entries it cannot resolve. Known-rejected
  // markers: peerOptional (v2 incomplete optional peers), link (symlink
  // workspace deps), and potentially peer:true entries that the action
  // misclassifies. npm v3 lockfiles include "peer": true for hoisted
  // peer dependencies — these are standard npm behavior. If the action
  // rejects them, the lockfile must be regenerated with a compatible npm
  // version, or the action must be updated to accept them.
  //
  // This test checks ALL known-rejected markers so a CI failure here
  // predicts a Jev action failure.
  const packages = lockfile.packages;
  const blocked = [];
  for (const [key, record] of Object.entries(packages)) {
    if (record.peerOptional === true) blocked.push(key + " (peerOptional)");
    if (record.link === true) blocked.push(key + " (link)");
  }
  assert.deepEqual(
    blocked,
    [],
    `lockfile entries would be rejected by dep audit: ${blocked.join(", ")}`
  );

  // Count peer:true entries for documentation. The Jev action at ebfcb813
  // may reject these; if CI still shows unsafe_lockfile after peerOptional
  // and link are cleared, the peer:true entries are the likely cause.
  let peerTrueCount = 0;
  for (const [, record] of Object.entries(packages)) {
    if (record.peer === true) peerTrueCount++;
  }
  // peer:true is standard npm v3 behavior for hoisted peer deps.
  // Document the count so triage can reference it.
  console.log(`lockfile-audit: ${peerTrueCount} peer:true entries (standard npm v3 hoisting)`);
});

test("npm audit produces a valid report with zero high/critical advisories (P1 gate compat)", () => {
  // The Jev gate severity_gate=P1 blocks on P0 (critical) and P1 (high).
  // This test ensures npm audit itself reports a clean, parseable result.
  // It rejects error responses and missing vulnerability fields — an
  // indeterminate audit (unsafe_lockfile) must fail this test, not pass
  // silently.
  let stdout;
  let exitCode = 0;
  try {
    stdout = execSync("npm audit --json", {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });
  } catch (err) {
    // npm audit exits non-zero when vulnerabilities exist, but still
    // writes valid JSON to stdout. A non-zero exit with empty stdout
    // is an error (e.g. network failure, lockfile corruption).
    stdout = err.stdout || "";
    exitCode = err.status || 1;
  }

  // Reject empty or unparseable output — an indeterminate audit.
  assert.ok(stdout.length > 0, "npm audit produced empty output (indeterminate audit)");

  let data;
  try {
    data = JSON.parse(stdout);
  } catch (parseErr) {
    assert.fail(`npm audit produced unparseable JSON: ${parseErr.message}. Output: ${stdout.slice(0, 500)}`);
  }

  // Require the audit report to have a vulnerabilities field.
  // A report without it (e.g. an error response) is indeterminate.
  const vulns = data.vulnerabilities;
  assert.ok(
    vulns && typeof vulns === "object",
    `npm audit response missing vulnerabilities field (indeterminate audit). Keys: ${Object.keys(data).join(", ")}`
  );

  // Lockfile v3 overrides field is standard; not a vulnerability.
  const blocking = [];
  for (const [name, v] of Object.entries(vulns)) {
    if (v.severity === "high" || v.severity === "critical") {
      blocking.push(name + ":" + v.severity);
    }
  }

  // Verify exit code matches: 0 = clean, non-zero = vulns found.
  if (exitCode !== 0 && blocking.length === 0) {
    console.log(`npm audit exited ${exitCode} but found no high/critical advisories (may have lower-severity findings)`);
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
