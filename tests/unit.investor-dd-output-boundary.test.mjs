import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createOutputFileSystem } from "../src/config/output-filesystem.js";
import { runInvestorDd } from "../src/review/investor-dd-orchestrator.js";
import { provisionDevTestBotIdentities, runDevTestBotPhase } from "../src/review/investor-dd-devtestbot.js";

const refusal = /inside the workspace/;

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-investor-output-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await Promise.all([workspace, outside].map((directory) => fsp.mkdir(directory)));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const outputRoot = path.join(workspace, ".sentinelayer");
  const runRoot = path.join(outputRoot, "runs", "fixture");
  const artifactDir = path.join(runRoot, "investor-dd");
  const outputFs = createOutputFileSystem({ workspaceRoot: workspace });
  return { root, workspace, outside, outputRoot, runRoot, artifactDir, outputFs };
}

for (const mode of ["default", "relative", "absolute inside"]) {
  test(`investor-DD ${mode} artifact root rejects an escaping junction`, async (t) => {
    const f = await fixture(t);
    const linked = path.join(f.workspace, mode === "default" ? ".sentinelayer" : "linked");
    await fsp.symlink(f.outside, linked, "junction");
    const outputDir = mode === "default" ? "" : mode === "relative" ? "linked" : linked;
    await assert.rejects(() => runInvestorDd({ rootPath: f.workspace, outputDir, dryRun: true }), refusal);
    assert.deepEqual(await fsp.readdir(f.outside), []);
  });
}

test("investor-DD rejects relative output traversal", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => runInvestorDd({ rootPath: f.workspace, outputDir: "../outside", dryRun: true }), refusal);
  assert.deepEqual(await fsp.readdir(f.outside), []);
});

for (const mode of ["default", "relative", "absolute inside", "trusted absolute outside"]) {
  test(`investor-DD preserves ${mode} artifact layout`, async (t) => {
    const f = await fixture(t);
    const outputDir = mode === "default" ? "" : mode === "relative" ? "artifacts"
      : mode === "absolute inside" ? path.join(f.workspace, "artifacts") : f.outside;
    const result = await runInvestorDd({ rootPath: f.workspace, outputDir, dryRun: true });
    const expectedRoot = mode === "default" ? path.join(f.workspace, ".sentinelayer", "runs")
      : mode === "trusted absolute outside" ? f.outside : path.join(f.workspace, "artifacts");
    assert.equal(result.artifactDir, path.join(expectedRoot, result.runId, "investor-dd"));
    const manifest = JSON.parse(await fsp.readFile(path.join(result.artifactDir, "manifest.json"), "utf8"));
    assert.ok(manifest["report.md"]);
    assert.ok(manifest["report.html"]);
    assert.ok(manifest["stream.ndjson"]);
  });
}

for (const file of ["stream.ndjson", "summary.json", "report.md", "report.html"]) {
  test(`investor-DD actual ${file} writer rejects an existing hardlink`, async (t) => {
    const f = await fixture(t);
    t.mock.method(Date, "now", () => 1234);
    t.mock.method(crypto, "randomUUID", () => "00000000-0000-4000-8000-000000000000");
    const artifactDir = path.join(f.workspace, "artifacts", "investor-dd-1234-00000000", "investor-dd");
    await fsp.mkdir(artifactDir, { recursive: true });
    const outsideFile = path.join(f.outside, "untouched.txt");
    await fsp.writeFile(outsideFile, "unchanged");
    await fsp.link(outsideFile, path.join(artifactDir, file));
    await assert.rejects(() => runInvestorDd({ rootPath: f.workspace, outputDir: "artifacts", dryRun: true }), refusal);
    assert.equal(await fsp.readFile(outsideFile, "utf8"), "unchanged");
  });
}

test("investor-DD internal exported writers reject absent and unregistered capabilities before work", async (t) => {
  const f = await fixture(t);
  let externalCalls = 0;
  const provisionIdentity = async () => { externalCalls += 1; return { id: "fixture" }; };
  const plannerClient = { decideDevTestBotPhase: async () => { externalCalls += 1; return {}; } };
  for (const outputFs of [undefined, null, fsp, { ...fsp, assertPath: async () => {} }]) {
    await assert.rejects(() => provisionDevTestBotIdentities({ outputRoot: f.outputRoot, runId: "fixture", count: 1, outputFs, provisionIdentity }), TypeError);
    await assert.rejects(() => runDevTestBotPhase({
      rootPath: f.workspace, outputRoot: f.outputRoot, runRoot: f.runRoot,
      artifactDir: f.artifactDir, runId: "fixture", outputFs, options: { plannerClient },
    }), TypeError);
  }
  assert.equal(externalCalls, 0);
  assert.deepEqual(await fsp.readdir(f.workspace), []);
});

test("investor-DD phase rejects a linked phase root before invoking its planner", async (t) => {
  const f = await fixture(t);
  await fsp.mkdir(f.runRoot, { recursive: true });
  await fsp.symlink(f.outside, path.join(f.runRoot, "devtestbot"), "junction");
  let planned = 0;
  await assert.rejects(() => runDevTestBotPhase({
    rootPath: f.workspace, outputRoot: f.outputRoot, runRoot: f.runRoot,
    artifactDir: f.artifactDir, runId: "fixture", outputFs: f.outputFs,
    options: { plannerClient: { decideDevTestBotPhase: async () => { planned += 1; return {}; } } },
  }), refusal);
  assert.equal(planned, 0);
  assert.deepEqual(await fsp.readdir(f.outside), []);
});

test("investor-DD phase summary writer rejects a final-file hardlink", async (t) => {
  const f = await fixture(t);
  await fsp.mkdir(f.artifactDir, { recursive: true });
  const outsideFile = path.join(f.outside, "untouched.json");
  await fsp.writeFile(outsideFile, "unchanged");
  await fsp.link(outsideFile, path.join(f.artifactDir, "devtestbot-summary.json"));
  await assert.rejects(() => runDevTestBotPhase({
    rootPath: f.workspace, outputRoot: f.outputRoot, runRoot: f.runRoot,
    artifactDir: f.artifactDir, runId: "fixture", outputFs: f.outputFs, options: { enabled: false },
  }), refusal);
  assert.equal(await fsp.readFile(outsideFile, "utf8"), "unchanged");
});

test("investor-DD identity provisioning rejects a linked output root before the provider callback", async (t) => {
  const f = await fixture(t);
  await fsp.symlink(f.outside, f.outputRoot, "junction");
  let provisioned = 0;
  await assert.rejects(() => provisionDevTestBotIdentities({
    outputRoot: f.outputRoot, runId: "fixture", count: 1, outputFs: f.outputFs,
    provisionIdentity: async () => { provisioned += 1; return { id: "fixture" }; },
  }), refusal);
  assert.equal(provisioned, 0);
  assert.deepEqual(await fsp.readdir(f.outside), []);
});

test("investor-DD phase propagates its capability through real offline identity and artifact writers", async (t) => {
  const f = await fixture(t);
  const result = await runDevTestBotPhase({
    rootPath: f.workspace, outputRoot: f.outputRoot, runRoot: f.runRoot,
    artifactDir: f.artifactDir, runId: "fixture", outputFs: f.outputFs,
    options: { execute: false, identityCount: 1, swarmCount: 1 },
  });
  assert.equal(result.skipped, false);
  assert.equal(result.identities.length, 1);
  assert.equal(result.subagents.length, 1);
  assert.equal(result.subagents[0].completed, true);
  await fsp.access(result.identities[0].registryPath);
  await fsp.access(path.join(f.artifactDir, "devtestbot-summary.json"));
  assert.deepEqual(await fsp.readdir(f.outside), []);
});
