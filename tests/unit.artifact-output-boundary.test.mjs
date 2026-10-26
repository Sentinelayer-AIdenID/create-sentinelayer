import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveOutputContext } from "../src/config/service.js";
import { appendRunEvent } from "../src/telemetry/ledger.js";
import { appendCostEntry } from "../src/cost/history.js";
import { writeCodebaseIngest } from "../src/ingest/engine.js";
import { runDeterministicReviewPipeline, writeReviewReport } from "../src/review/local-review.js";
import { writeOmarGateDeterministicCache } from "../src/review/omargate-cache.js";
import { writeUnifiedReviewArtifacts } from "../src/review/report.js";
import { writeReviewRunContext, writeReviewComparisonArtifact } from "../src/review/replay.js";
import { writeSwarmPlanArtifacts } from "../src/swarm/factory.js";
import { runAuditOrchestrator } from "../src/audit/orchestrator.js";
import { writeDdPackage } from "../src/audit/package.js";
import { writeAuditComparisonArtifact } from "../src/audit/replay.js";
import { writeBlackboardArtifact } from "../src/memory/blackboard.js";
import { runDevTestBotSession } from "../src/agents/devtestbot/tool.js";
import { launch } from "../src/agents/devtestbot/runner.js";

const boundaryError = /Workspace artifact destination must resolve inside the workspace/;
const event = { eventType: "run_start", runId: "boundary" };

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-artifact-boundary-"));
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await Promise.all([cwd, outside].map((dir) => fsp.mkdir(dir)));
  await fsp.writeFile(path.join(cwd, ".sentinelayer.yml"), 'outputDir: "."\n');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return { cwd, outside, options: { targetPath: cwd, env: {} } };
}

async function linkDirectory(target, link) {
  await fsp.mkdir(path.dirname(link), { recursive: true });
  await fsp.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

async function linkFile(t, target, link) {
  await fsp.mkdir(path.dirname(link), { recursive: true });
  try {
    await fsp.symlink(target, link, "file");
    return true;
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
      t.skip("File symlink creation requires Windows Developer Mode or privilege.");
      return false;
    }
    throw error;
  }
}

const writers = [
  ["telemetry append", "observability", (f) => appendRunEvent(f.options, event)],
  ["review report", "reports", (f) => writeReviewReport({ targetPath: f.cwd, reportMarkdown: "fixture" })],
  ["deterministic review", "reviews", (f) => runDeterministicReviewPipeline({ targetPath: f.cwd })],
  ["Omar cache", "runs", (f) => writeOmarGateDeterministicCache({ targetPath: f.cwd, runId: "fixture" })],
  ["swarm plan", "swarms", (f) => writeSwarmPlanArtifacts({ plan: { targetPath: f.cwd, runId: "fixture" } })],
  ["audit run", "audits", (f) => runAuditOrchestrator({ targetPath: f.cwd, dryRun: true })],
  ["browser session", "runs", (f) => runDevTestBotSession({ targetPath: f.cwd, execute: false })],
];

for (const [name, descendant, write] of writers) {
  test(`${name} rejects a configured descendant link before writing outside`, async (t) => {
    const f = await fixture(t);
    await linkDirectory(f.outside, path.join(f.cwd, descendant));
    await assert.rejects(write(f), boundaryError);
    assert.deepEqual(await fsp.readdir(f.outside), []);
  });
}

test("telemetry rejects an existing final-file link without appending to its target", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.outside, "events.jsonl");
  await fsp.writeFile(target, "outside sentinel\n");
  if (!await linkFile(t, target, path.join(f.cwd, "observability/run-events.jsonl"))) return;
  await assert.rejects(appendRunEvent(f.options, event), boundaryError);
  assert.equal(await fsp.readFile(target, "utf8"), "outside sentinel\n");
});

for (const [name, file, payload, write] of [
  ["ingest", "CODEBASE_INGEST.json", "outside sentinel", (f) => writeCodebaseIngest({ rootPath: f.cwd, ingest: {} })],
  ["cost history", "cost-history.json", '{"entries":[]}', (f) => appendCostEntry(f.options, { provider: "openai", model: "fixture" })],
]) {
  test(`${name} rejects an existing final-file link without overwriting its target`, async (t) => {
    const f = await fixture(t);
    const target = path.join(f.outside, file);
    await fsp.writeFile(target, payload);
    if (!await linkFile(t, target, path.join(f.cwd, file))) return;
    await assert.rejects(write(f), boundaryError);
    assert.equal(await fsp.readFile(target, "utf8"), payload);
  });
}

test("dangling descendant links fail closed without creating their outside targets", async (t) => {
  const f = await fixture(t);
  await linkDirectory(path.join(f.outside, "missing"), path.join(f.cwd, "observability"));
  await assert.rejects(appendRunEvent(f.options, event), boundaryError);
  assert.deepEqual(await fsp.readdir(f.outside), []);
});

test("resolved capability checks newly introduced descendants for every mutating operation", async (t) => {
  const f = await fixture(t);
  const { outputFs } = await resolveOutputContext({ cwd: f.cwd, env: {} });
  await linkDirectory(f.outside, path.join(f.cwd, "late"));
  const destination = path.join(f.cwd, "late/artifact.json");
  const inside = path.join(f.cwd, "source.json");
  await fsp.writeFile(inside, "source");
  for (const action of [
    () => outputFs.writeFile(destination, "bad"),
    () => outputFs.appendFile(destination, "bad"),
    () => outputFs.mkdir(path.join(f.cwd, "late/new"), { recursive: true }),
    () => outputFs.open(destination, "w"),
    () => outputFs.copyFile(inside, destination),
    () => outputFs.rename(inside, destination),
    () => outputFs.unlink(destination),
    () => outputFs.truncate(destination),
    () => outputFs.rm(destination, { force: true }),
  ]) await assert.rejects(action, boundaryError);
  assert.deepEqual(await fsp.readdir(f.outside), []);
  assert.equal(await fsp.readFile(inside, "utf8"), "source");
});

test("copying a trusted external input into the workspace preserves read semantics", async (t) => {
  const f = await fixture(t);
  const { outputFs } = await resolveOutputContext({ cwd: f.cwd, env: {} });
  const source = path.join(f.outside, "input.txt");
  const destination = path.join(f.cwd, "copied.txt");
  await fsp.writeFile(source, "trusted input");
  await outputFs.copyFile(source, destination);
  assert.equal(await fsp.readFile(destination, "utf8"), "trusted input");
  await assert.rejects(outputFs.rename(source, path.join(f.cwd, "moved.txt")), boundaryError);
  assert.equal(await outputFs.readFile(source, "utf8"), "trusted input");
});

test("mutation uses the same normalized destination it validates across a linked dot segment", async (t) => {
  const f = await fixture(t);
  await fsp.mkdir(path.join(f.outside, "child"));
  await linkDirectory(path.join(f.outside, "child"), path.join(f.cwd, "bridge"));
  const { outputFs } = await resolveOutputContext({ cwd: f.cwd, env: {} });
  const requested = `${f.cwd}${path.sep}bridge${path.sep}..${path.sep}artifact.txt`;
  const checked = await outputFs.assertPath(requested);
  assert.equal(checked, path.join(f.cwd, "artifact.txt"));
  await outputFs.writeFile(requested, "normalized destination");
  assert.equal(await fsp.readFile(checked, "utf8"), "normalized destination");
  assert.deepEqual(await fsp.readdir(f.outside), ["child"]);
});

test("constrained writes refuse final-file links even when their targets remain inside", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.cwd, "target.txt");
  const link = path.join(f.cwd, "linked.txt");
  await fsp.writeFile(target, "inside sentinel");
  if (!await linkFile(t, target, link)) return;
  const { outputFs } = await resolveOutputContext({ cwd: f.cwd, env: {} });
  for (const write of [() => outputFs.writeFile(link, "bad"), () => outputFs.appendFile(link, "bad"), () => outputFs.open(link, "w")]) {
    await assert.rejects(write, boundaryError);
  }
  assert.equal(await fsp.readFile(target, "utf8"), "inside sentinel");
  const explicit = await resolveOutputContext({ cwd: f.cwd, outputDirOverride: f.cwd });
  await explicit.outputFs.appendFile(link, " explicit");
  assert.equal(await fsp.readFile(target, "utf8"), "inside sentinel explicit");
});

test("native no-follow refuses a final link introduced after validation", { skip: !constants.O_NOFOLLOW }, async (t) => {
  const f = await fixture(t);
  const target = path.join(f.outside, "target.txt");
  const destination = path.join(f.cwd, "late.txt");
  await fsp.writeFile(target, "outside sentinel");
  const { outputFs } = await resolveOutputContext({ cwd: f.cwd, env: {} });
  const nativeWrite = fsp.writeFile;
  t.mock.method(fsp, "writeFile", async (file, data, options) => {
    if (file === destination) {
      assert.ok(options.flag & constants.O_NOFOLLOW);
      await fsp.symlink(target, destination, "file");
    }
    return nativeWrite(file, data, options);
  });
  await assert.rejects(outputFs.writeFile(destination, "bad"), { code: "ELOOP" });
  assert.equal(await fsp.readFile(target, "utf8"), "outside sentinel");
});

test("constrained writes preserve encoding, mode, exclusive flags, flush and abort behavior", async (t) => {
  const f = await fixture(t);
  const { outputFs } = await resolveOutputContext({ cwd: f.cwd, env: {} });
  const destination = path.join(f.cwd, "options.txt");
  await outputFs.writeFile(destination, "6869", { encoding: "hex", mode: 0o600, flag: "wx", flush: true });
  assert.equal(await fsp.readFile(destination, "utf8"), "hi");
  if (process.platform !== "win32") assert.equal((await fsp.stat(destination)).mode & 0o777, 0o600);
  await assert.rejects(outputFs.writeFile(destination, "bad", { flag: "wx" }), { code: "EEXIST" });
  await outputFs.appendFile(destination, Buffer.from("!"), { flush: true });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(outputFs.writeFile(destination, "bad", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(await fsp.readFile(destination, "utf8"), "hi!");
  const readHandle = await outputFs.open(destination, constants.O_RDONLY);
  await readHandle.close();
});

test("concurrent configured and explicit operations at the same root keep separate policies", async (t) => {
  const f = await fixture(t);
  await linkDirectory(f.outside, path.join(f.cwd, "observability"));
  const results = await Promise.allSettled([
    appendRunEvent(f.options, { ...event, runId: "restricted" }),
    appendRunEvent({ ...f.options, outputDirOverride: f.cwd }, { ...event, runId: "explicit" }),
  ]);
  assert.equal(results[0].status, "rejected");
  assert.match(results[0].reason.message, boundaryError);
  assert.equal(results[1].status, "fulfilled");
  const lines = (await fsp.readFile(path.join(f.outside, "run-events.jsonl"), "utf8")).trim().split("\n");
  assert.deepEqual(lines.map((line) => JSON.parse(line).runId), ["explicit"]);
});

test("internal descendant links and explicit external file overrides stay usable", async (t) => {
  const f = await fixture(t);
  const actual = path.join(f.cwd, "real-observability");
  await fsp.mkdir(actual);
  await linkDirectory(actual, path.join(f.cwd, "observability"));
  await appendRunEvent(f.options, event);
  assert.equal(JSON.parse((await fsp.readFile(path.join(actual, "run-events.jsonl"), "utf8")).trim()).runId, "boundary");
  const outsideFile = path.join(f.outside, "explicit-ingest.json");
  await writeCodebaseIngest({ rootPath: f.cwd, outputFile: outsideFile, ingest: { allowed: true } });
  assert.equal(JSON.parse(await fsp.readFile(outsideFile, "utf8")).allowed, true);
});

test("inherited browser and ingest paths retain the configured boundary through explicit child paths", async (t) => {
  const f = await fixture(t);
  const { outputFs } = await resolveOutputContext({ cwd: f.cwd, env: {} });
  await linkDirectory(f.outside, path.join(f.cwd, "child"));
  await assert.rejects(runDevTestBotSession({ targetPath: f.cwd, outputRoot: f.cwd, outputDir: path.join(f.cwd, "child"), execute: false }, { outputFs }), boundaryError);
  await assert.rejects(writeCodebaseIngest({ rootPath: f.cwd, outputDir: path.join(f.cwd, "child"), outputFs, ingest: {} }), boundaryError);
  assert.deepEqual(await fsp.readdir(f.outside), []);
});

test("browser runner validates a linked video directory before launching browser processes", async (t) => {
  const f = await fixture(t);
  const { outputFs } = await resolveOutputContext({ cwd: f.cwd, env: {} });
  await linkDirectory(f.outside, path.join(f.cwd, "capture/video"));
  await assert.rejects(launch({ baseUrl: "http://localhost:3000", outputDir: path.join(f.cwd, "capture"), outputFs }), boundaryError);
  assert.deepEqual(await fsp.readdir(f.outside), []);
});

test("derived report, replay, package and memory writers preserve an inherited boundary", async (t) => {
  const f = await fixture(t);
  const { outputFs } = await resolveOutputContext({ cwd: f.cwd, env: {} });
  const runDirectory = path.join(f.cwd, "run");
  await linkDirectory(f.outside, runDirectory);
  for (const write of [
    () => writeUnifiedReviewArtifacts({ runDirectory, report: {}, markdown: "fixture", outputFs }),
    () => writeReviewRunContext({ runDirectory, targetPath: f.cwd, outputFs }),
    () => writeReviewComparisonArtifact({ runDirectory, comparison: {}, outputFs }),
    () => writeDdPackage({ runDirectory, report: {}, outputFs }),
    () => writeAuditComparisonArtifact({ outputDirectory: runDirectory, baseReport: {}, candidateReport: {}, outputFs }),
    () => writeBlackboardArtifact({ entries: [] }, { outputRoot: runDirectory, outputFs }),
  ]) await assert.rejects(write, boundaryError);
  assert.deepEqual(await fsp.readdir(f.outside), []);
});
