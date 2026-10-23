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

test("lockfile is compatible with Jev action dep audit (no peerOptional/link markers)", () => {
  // The Jev action at sentinelayer-v1-action (ebfcb813) accepts npm v3 "peer": true
  // markers (they are standard npm behavior for packages hoisted as peers).
  // It still rejects peerOptional: true and link: true which indicate
  // genuinely incomplete resolution data.
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
