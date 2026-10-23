// Preloaded by the test harness via --import ./tests/setup-env.mjs
// (the repo consistently uses tests/ not test/; see package.json scripts).
// Explicit import for standalone runs: node --test tests/unit.lockfile-audit.test.mjs
import "./setup-env.mjs";
import assert from "node:assert/strict";
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

test("lockfile has no peer=true markers (unsafe_lockfile gate compat)", () => {
  const packages = lockfile.packages || {};
  const peerTrue = [];
  for (const [key, record] of Object.entries(packages)) {
    if (record.peer === true) peerTrue.push(key);
  }
  assert.deepEqual(peerTrue, [], `peer=true entries found: ${peerTrue.join(", ")}`);
});
