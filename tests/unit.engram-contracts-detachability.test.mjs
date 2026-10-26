import "./setup-env.mjs";
// unit.engram-contracts-detachability.test.mjs — EW02: contracts module keeps ENGRAM detachable.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = path.join(HERE, "..", "src", "engram", "contracts");
const ENGRAM_DIR = path.join(HERE, "..", "src", "engram");
const RECALL_CORE_DIR = path.join(HERE, "..", "src", "session", "recall");

function isWithinRoot(file, root) {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function moduleSpecifiers(source) {
  const specs = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^"']*?\sfrom\s*)?["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) specs.add(match[1]);
  }
  return Array.from(specs);
}

async function inspectDependencyClosure(entryFiles, allowedRoots) {
  const queue = entryFiles.map((file) => path.resolve(file));
  const visited = new Set();
  const violations = [];

  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(file, "utf-8");
    for (const specifier of moduleSpecifiers(source)) {
      if (specifier.startsWith("node:") || !specifier.startsWith(".")) continue;
      let resolved = path.resolve(path.dirname(file), specifier);
      if (!path.extname(resolved)) resolved += ".js";
      if (!allowedRoots.some((root) => isWithinRoot(resolved, root))) {
        violations.push({ file, specifier, resolved });
        continue;
      }
      queue.push(resolved);
    }
  }

  return { visited, violations };
}

test("contracts module imports only engram + recall-core (HARD detachability)", async () => {
  const entries = (await readdir(CONTRACTS_DIR))
    .filter((file) => file.endsWith(".js"))
    .map((file) => path.join(CONTRACTS_DIR, file));
  assert.ok(entries.length >= 4, "expected at least 4 contracts modules");

  const result = await inspectDependencyClosure(entries, [CONTRACTS_DIR, ENGRAM_DIR, RECALL_CORE_DIR]);
  assert.deepEqual(
    result.violations.map(({ file, specifier }) => ({
      file: path.relative(path.join(HERE, ".."), file),
      specifier,
    })),
    [],
    "contracts module's complete relative-import closure must stay inside src/engram or the pure recall core",
  );
});

test("contracts barrel re-exports all expected symbols from index.js", async () => {
  const mod = await import("../src/engram/index.js");

  // Money
  assert.equal(typeof mod.moneySchema, "object");
  assert.equal(typeof mod.toMinorUnits, "function");
  assert.equal(typeof mod.formatFromMinorUnits, "function");
  assert.equal(typeof mod.currencyExponent, "function");

  // Graph
  assert.ok(Array.isArray(mod.PROVENANCE_CLASSES));
  assert.equal(typeof mod.provenanceClassSchema, "object");
  assert.equal(typeof mod.graphSchema, "object");
  assert.equal(typeof mod.classifyProvenance, "function");
  assert.equal(typeof mod.validateGraphIntegrity, "function");

  // Capability
  assert.equal(typeof mod.capabilityVersionSchema, "object");
  assert.equal(typeof mod.tenantScopeSchema, "object");
  assert.equal(typeof mod.negotiateCapability, "function");
  assert.equal(typeof mod.CapabilityError, "function");

  // Evidence
  assert.equal(typeof mod.evidenceAddressSchema, "object");
  assert.equal(typeof mod.EvidenceError, "function");
  assert.equal(typeof mod.validateNotScreenshotInferred, "function");
});
