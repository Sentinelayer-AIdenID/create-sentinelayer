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
import { writeAstSnapshot, DEFAULT_AST_SNAPSHOT_RELATIVE_PATH } from "../src/daemon/ast-drift.js";
import { refreshIngestIfNeeded } from "../src/daemon/ingest-refresh.js";
import { runFixCycle } from "../src/daemon/fix-cycle.js";
import { runFixCycle as runJulesFixCycle } from "../src/agents/jules/fix-cycle.js";
import { createOutputFileSystem } from "../src/config/output-filesystem.js";

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

test("default daemon output rejects a committed .sentinelayer link", async (t) => {
  const { workspace, outside, options } = await fixture(t, "");
  await linkDirectory(outside, path.join(workspace, ".sentinelayer"));
  const rootError = /Workspace outputDir must resolve/;
  await assert.rejects(appendAdminErrorEvent({ ...options, event }), rootError);
  await assert.rejects(ensureWorkItemQueued({ ...options, workItemId: "default-boundary" }), rootError);
  await assert.rejects(setMaintenanceBillboard({ ...options, enabled: true }), rootError);
  assert.deepEqual(await fsp.readdir(outside), []);
});

test("fixed snapshot and fix-cycle writers require a branded capability before effects", async (t) => {
  const { workspace } = await fixture(t, "");
  const valid = createOutputFileSystem({ workspaceRoot: workspace });
  let effects = 0;
  for (const method of ["mkdir", "writeFile", "appendFile", "rename", "open"]) {
    t.mock.method(fsp, method, async () => { effects += 1; throw new Error("Unexpected mutation"); });
  }
  for (const outputFs of [undefined, null, fsp, Object.freeze({ ...valid })]) {
    await assert.rejects(writeAstSnapshot({ rootPath: workspace, snapshot: {}, outputFs }), TypeError);
    await assert.rejects(runFixCycle({ rootPath: workspace, workItemId: "fixture", outputFs, onEvent: () => { effects += 1; } }), TypeError);
    await assert.rejects(runJulesFixCycle({ rootPath: workspace, workItemId: "fixture", outputFs, onEvent: () => { effects += 1; } }), TypeError);
  }
  assert.equal(effects, 0);
});

test("fixed snapshot and Jules roots cannot follow .sentinelayer outside the workspace", async (t) => {
  const { workspace, outside } = await fixture(t, "");
  await linkDirectory(outside, path.join(workspace, ".sentinelayer"));
  const outputFs = createOutputFileSystem({ workspaceRoot: workspace });
  await assert.rejects(writeAstSnapshot({ rootPath: workspace, snapshot: {}, outputFs }), boundaryError);
  await assert.rejects(runFixCycle({ rootPath: workspace, workItemId: "fixture", outputFs }), boundaryError);
  await assert.rejects(runJulesFixCycle({ rootPath: workspace, workItemId: "fixture" }), /Workspace outputDir must resolve/);
  await assert.rejects(refreshIngestIfNeeded(workspace, { driftMode: "ast" }), /Workspace outputDir must resolve/);
  assert.deepEqual(await fsp.readdir(outside), []);
});

test("snapshot writes permit scoped defaults and deliberately trusted absolute external targets", async (t) => {
  const { workspace, outside } = await fixture(t, "");
  const snapshot = { schemaVersion: "fixture", files: {} };
  const outputFs = createOutputFileSystem({ workspaceRoot: workspace });
  const local = await writeAstSnapshot({ rootPath: workspace, snapshot, outputFs });
  assert.equal(local, path.join(workspace, DEFAULT_AST_SNAPSHOT_RELATIVE_PATH));
  assert.deepEqual(JSON.parse(await fsp.readFile(local, "utf8")), snapshot);
  const snapshotPath = path.join(outside, "external.json");
  await assert.rejects(writeAstSnapshot({ rootPath: workspace, snapshotPath, snapshot, outputFs }), boundaryError);
  await writeAstSnapshot({ rootPath: workspace, snapshotPath, snapshot, outputFs: createOutputFileSystem() });
  assert.deepEqual(JSON.parse(await fsp.readFile(snapshotPath, "utf8")), snapshot);
});

test("snapshot writer refuses an existing final-file symlink before staging a replacement", async (t) => {
  const { workspace } = await fixture(t, "");
  const target = path.join(workspace, "snapshot-target.json");
  await fsp.writeFile(target, "snapshot sentinel\n");
  const snapshotPath = path.join(workspace, DEFAULT_AST_SNAPSHOT_RELATIVE_PATH);
  if (!await linkFile(t, target, snapshotPath)) return;
  const outputFs = createOutputFileSystem({ workspaceRoot: workspace });
  await assert.rejects(writeAstSnapshot({ rootPath: workspace, snapshot: {}, outputFs }), /without linked files/);
  assert.equal(await fsp.readFile(target, "utf8"), "snapshot sentinel\n");
  assert.equal((await fsp.lstat(snapshotPath)).isSymbolicLink(), true);
  assert.deepEqual(await fsp.readdir(path.dirname(snapshotPath)), [path.basename(snapshotPath)]);
});

for (const mode of ["relative CLI", "absolute CLI within workspace", "relative global", "absolute global within workspace"]) {
  test(`daemon writers guard ${mode} output from descendant links`, async (t) => {
    const { workspace, outside, homeDir, options } = await fixture(t, "");
    const root = path.join(workspace, "artifacts");
    await fsp.mkdir(root);
    await linkDirectory(outside, path.join(root, "observability"));
    const configured = mode.startsWith("relative") ? "artifacts" : root;
    const selected = { ...options };
    if (mode.includes("CLI")) selected.outputDir = configured;
    else {
      await fsp.mkdir(path.join(homeDir, ".sentinelayer"));
      await fsp.writeFile(path.join(homeDir, ".sentinelayer", "config.yml"), `outputDir: ${JSON.stringify(configured)}\n`);
    }
    await assert.rejects(appendAdminErrorEvent({ ...selected, event }), boundaryError);
    assert.deepEqual(await fsp.readdir(outside), []);
  });
}

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
