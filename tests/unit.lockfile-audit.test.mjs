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

test("lockfile has no legacy peer:true markers (Jev dep audit compat)", () => {
  const packages = lockfile.packages || {};
  const blocked = [];
  for (const [key, record] of Object.entries(packages)) {
    if (record.peer === true) blocked.push(key);
  }
  assert.deepEqual(
    blocked,
    [],
    `lockfile contains legacy "peer": true markers that the Jev dep_audit harness rejects as unsafe_lockfile: ${blocked.join(", ")}`
  );
});
