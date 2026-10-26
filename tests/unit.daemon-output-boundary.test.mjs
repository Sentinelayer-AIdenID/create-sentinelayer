import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { appendAdminErrorEvent, resolveErrorDaemonStorage } from "../src/daemon/error-worker.js";
import { ensureWorkItemQueued, resolveAssignmentLedgerStorage } from "../src/daemon/assignment-ledger.js";
import { resolveScopeEngineStorage } from "../src/daemon/scope-engine.js";
import { resolveArtifactLineageStorage } from "../src/daemon/artifact-lineage.js";
import { resolveBudgetGovernorStorage } from "../src/daemon/budget-governor.js";
import { resolveHybridMappingStorage } from "../src/daemon/hybrid-mapper.js";
import { resolveJiraLifecycleStorage } from "../src/daemon/jira-lifecycle.js";
import { resolveOperatorControlStorage } from "../src/daemon/operator-control.js";
import { resolveReliabilityLaneStorage, setMaintenanceBillboard } from "../src/daemon/reliability-lane.js";
import { resolveWatchdogStorage } from "../src/daemon/watchdog.js";

const boundaryError = /Workspace artifact destination must resolve inside the workspace/;
const event = { service: "test", endpoint: "/test", errorCode: "TEST", message: "test event" };

async function fixture(t, projectConfig = 'outputDir: "."\n') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-daemon-output-boundary-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const homeDir = path.join(root, "home");
  await Promise.all([workspace, outside, homeDir].map((dir) => fsp.mkdir(dir)));
  if (projectConfig) await fsp.writeFile(path.join(workspace, ".sentinelayer.yml"), projectConfig);
  return { workspace, outside, homeDir, options: { targetPath: workspace, homeDir, env: {} } };
}

async function linkDirectory(target, link) {
  await fsp.mkdir(path.dirname(link), { recursive: true });
  await fsp.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

async function linkFile(t, target, link) {
  await fsp.mkdir(path.dirname(link), { recursive: true });
  try {
    await fsp.symlink(target, link, "file");
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
      t.skip("File symlink creation requires Windows Developer Mode or privilege.");
      return false;
    }
    throw error;
  }
  return true;
}

test("daemon append rejects a configured descendant junction before creating outside artifacts", async (t) => {
  const { workspace, outside, options } = await fixture(t);
  await linkDirectory(outside, path.join(workspace, "observability"));
  await assert.rejects(appendAdminErrorEvent({ ...options, event }), boundaryError);
  assert.deepEqual(await fsp.readdir(outside), []);
});

test("daemon append rejects an existing final stream symlink without modifying its target", async (t) => {
  const { workspace, outside, options } = await fixture(t);
  const target = path.join(outside, "stream.ndjson");
  await fsp.writeFile(target, "outside sentinel\n");
  if (!await linkFile(t, target, path.join(workspace, "observability", "error-daemon", "admin-error-stream.ndjson"))) return;
  await assert.rejects(appendAdminErrorEvent({ ...options, event }), boundaryError);
  assert.equal(await fsp.readFile(target, "utf8"), "outside sentinel\n");
});

test("assignment queue writer preserves the configured boundary through derived storage", async (t) => {
  const { workspace, outside, options } = await fixture(t);
  const target = path.join(outside, "queue.json");
  const original = JSON.stringify({ items: [] });
  await fsp.writeFile(target, original);
  if (!await linkFile(t, target, path.join(workspace, "observability", "error-daemon", "queue.json"))) return;
  await assert.rejects(ensureWorkItemQueued({ ...options, workItemId: "boundary-work-item" }), boundaryError);
  assert.equal(await fsp.readFile(target, "utf8"), original);
});

test("reliability writer rejects a nested junction inherited from daemon storage", async (t) => {
  const { workspace, outside, options } = await fixture(t);
  await linkDirectory(outside, path.join(workspace, "observability", "error-daemon", "reliability"));
  await assert.rejects(setMaintenanceBillboard({ ...options, enabled: true }), boundaryError);
  assert.deepEqual(await fsp.readdir(outside), []);
});

test("all daemon storage families retain a private boundary that checks paths at mutation time", async (t) => {
  const { workspace, outside, options } = await fixture(t);
  const resolvers = [
    resolveErrorDaemonStorage, resolveScopeEngineStorage, resolveAssignmentLedgerStorage,
    resolveArtifactLineageStorage, resolveBudgetGovernorStorage, resolveHybridMappingStorage,
    resolveJiraLifecycleStorage, resolveOperatorControlStorage, resolveReliabilityLaneStorage,
    resolveWatchdogStorage,
  ];
  // Introduce the descendant after resolution: root validation alone is insufficient.
  const storages = await Promise.all(resolvers.map((resolve) => resolve(options)));
  await linkDirectory(outside, path.join(workspace, "observability"));
  for (const storage of storages) {
    assert.equal(Object.prototype.propertyIsEnumerable.call(storage, "outputFs"), false);
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(storage)), "outputFs"), false);
    await assert.rejects(storage.outputFs.mkdir(path.join(storage.baseDir, "late-write"), { recursive: true }), boundaryError);
  }
  assert.deepEqual(await fsp.readdir(outside), []);
});

test("daemon writers permit a descendant symlink whose target remains in the workspace", async (t) => {
  const { workspace, options } = await fixture(t);
  const target = path.join(workspace, "safe-observability");
  await fsp.mkdir(target);
  await linkDirectory(target, path.join(workspace, "observability"));
  await appendAdminErrorEvent({ ...options, event });
  const stream = await fsp.readFile(path.join(target, "error-daemon", "admin-error-stream.ndjson"), "utf8");
  assert.equal(JSON.parse(stream.trim()).errorCode, event.errorCode);
});

test("daemon writers retain an explicit CLI output outside the workspace", async (t) => {
  const { outside, options } = await fixture(t);
  const selected = { ...options, outputDir: outside };
  await appendAdminErrorEvent({ ...selected, event });
  await ensureWorkItemQueued({ ...selected, workItemId: "cli-work-item" });
  await setMaintenanceBillboard({ ...selected, enabled: true });
  const storage = await resolveAssignmentLedgerStorage(selected);
  assert.equal(storage.outputRoot, outside);
  assert.equal(JSON.parse(await fsp.readFile(storage.queuePath, "utf8")).items[0].workItemId, "cli-work-item");
});

test("daemon writers retain a global output outside the workspace", async (t) => {
  const { outside, homeDir, options } = await fixture(t, "");
  await fsp.mkdir(path.join(homeDir, ".sentinelayer"));
  await fsp.writeFile(path.join(homeDir, ".sentinelayer", "config.yml"), `outputDir: ${JSON.stringify(outside)}\n`);
  await appendAdminErrorEvent({ ...options, event });
  await ensureWorkItemQueued({ ...options, workItemId: "global-work-item" });
  await setMaintenanceBillboard({ ...options, enabled: true });
  const storage = await resolveAssignmentLedgerStorage(options);
  assert.equal(storage.outputRoot, outside);
  assert.equal(JSON.parse(await fsp.readFile(storage.queuePath, "utf8")).items[0].workItemId, "global-work-item");
});
