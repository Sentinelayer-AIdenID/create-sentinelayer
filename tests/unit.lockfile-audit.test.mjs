import "./setup-env.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const lockfile = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")
);

test("lockfile has no peer=true markers (unsafe_lockfile gate compat)", () => {
  const packages = lockfile.packages || {};
  const peerTrue = [];
  for (const [key, record] of Object.entries(packages)) {
    if (record.peer === true) peerTrue.push(key);
  }
  assert.deepEqual(peerTrue, [], `peer=true entries found: ${peerTrue.join(", ")}`);
});

test("lockfile has no peerOptional=true markers (unsafe_lockfile gate compat)", () => {
  const packages = lockfile.packages || {};
  const peerOpt = [];
  for (const [key, record] of Object.entries(packages)) {
    if (record.peerOptional === true) peerOpt.push(key);
  }
  assert.deepEqual(peerOpt, [], `peerOptional=true entries found: ${peerOpt.join(", ")}`);
});

test("lockfile has no link=true markers (unsafe_lockfile gate compat)", () => {
  const packages = lockfile.packages || {};
  const linkTrue = [];
  for (const [key, record] of Object.entries(packages)) {
    if (record.link === true) linkTrue.push(key);
  }
  assert.deepEqual(linkTrue, [], `link=true entries found: ${linkTrue.join(", ")}`);
});

test("lockfile lockfileVersion is 2 or 3 (dep_audit gate compat)", () => {
  assert.ok(
    lockfile.lockfileVersion === 2 || lockfile.lockfileVersion === 3,
    `lockfileVersion ${lockfile.lockfileVersion} not in {2, 3}`
  );
});

test("lockfile packages[''] is an object (dep_audit gate compat)", () => {
  const packages = lockfile.packages || {};
  assert.ok(typeof packages[""] === "object" && packages[""] !== null,
    "packages[''] must be a non-null object for dep_audit");
});

test("lockfile is valid JSON parseable without error", () => {
  assert.ok(typeof lockfile === "object" && lockfile !== null);
});

test("lockfile packages cross-reference with package.json dependencies", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const lockPackages = lockfile.packages || {};
  const missing = [];
  for (const [name] of Object.entries(allDeps)) {
    const nodeModulesKey = "node_modules/" + name;
    if (!lockPackages[nodeModulesKey]) {
      missing.push(name);
    }
  }
  assert.deepEqual(missing, [], `deps missing from lockfile packages: ${missing.join(", ")}`);
});
