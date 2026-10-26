import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createOutputFileSystem, requireOutputFileSystem, bindOutputFileSystem } from "../src/config/output-filesystem.js";
import { writeCodebaseIngest } from "../src/ingest/engine.js";
import { saveCostHistory } from "../src/cost/history.js";
import { writeUnifiedReviewArtifacts } from "../src/review/report.js";
import { writeReviewRunContext, writeReviewComparisonArtifact } from "../src/review/replay.js";
import { writeDdPackage } from "../src/audit/package.js";
import { writeAuditComparisonArtifact } from "../src/audit/replay.js";
import { writeBlackboardArtifact } from "../src/memory/blackboard.js";
import { launch, writeMp4FromPngFrames } from "../src/agents/devtestbot/runner.js";

const invalidCapabilities = {
  missing: undefined,
  null: null,
  native: fsp,
  forged: { ...fsp, assertPath: async x => x, assertFilePath: async x => x },
};

for (const [kind, outputFs] of Object.entries(invalidCapabilities)) {
  test(`exported artifact writers reject ${kind} capability without side effects`, async t => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-required-output-"));
    t.after(() => fsp.rm(root, { force: true, recursive: true }));
    const runDirectory = path.join(root, "run");
    const outputPath = path.join(root, "capture.mp4");
    const writers = {
      ingest: () => writeCodebaseIngest({ rootPath: root, ingest: {}, outputFs }),
      cost: () => saveCostHistory({ filePath: path.join(root, "cost.json"), history: {}, outputFs }),
      report: () => writeUnifiedReviewArtifacts({ runDirectory, report: {}, markdown: "fixture", outputFs }),
      context: () => writeReviewRunContext({ runDirectory, targetPath: root, outputFs }),
      comparison: () => writeReviewComparisonArtifact({ runDirectory, comparison: {}, outputFs }),
      package: () => writeDdPackage({ runDirectory, report: {}, outputFs }),
      audit: () => writeAuditComparisonArtifact({ outputDirectory: runDirectory, baseReport: {}, candidateReport: {}, outputFs }),
      memory: () => writeBlackboardArtifact({ entries: [] }, { outputRoot: root, outputFs }),
      browser: () => launch({ baseUrl: "http://localhost:3000", outputDir: runDirectory, outputFs }),
      video: () => writeMp4FromPngFrames({}, [], outputPath, undefined, outputFs),
    };
    const mutations = [];
    for (const method of ["mkdir", "writeFile", "appendFile", "open", "rename", "copyFile", "truncate"]) {
      t.mock.method(fsp, method, async () => { mutations.push(method); throw new Error("unexpected native mutation"); });
    }
    for (const [name, write] of Object.entries(writers)) {
      await t.test(name, async () => {
        const before = mutations.length;
        await assert.rejects(write, { name: "TypeError", message: /output filesystem capability is required/ }, name);
        assert.equal(mutations.length, before, "rejected writer must not enter native filesystem mutation");
      });
    }
    assert.deepEqual(mutations, []);
    assert.deepEqual(await fsp.readdir(root), []);
  });
}

test("capability brand cannot be replaced by a copied interface and stays outside JSON", () => {
  const capability = createOutputFileSystem();
  assert.equal(requireOutputFileSystem(capability), capability);
  assert.ok(Object.isFrozen(capability));
  assert.throws(() => requireOutputFileSystem({ ...capability }), TypeError);
  assert.throws(() => bindOutputFileSystem({}, fsp), TypeError);
  const storage = bindOutputFileSystem({ artifact: "example" }, capability);
  assert.equal(storage.outputFs, capability);
  assert.equal(JSON.stringify(storage), '{"artifact":"example"}');
});

test("workspace capability refuses pre-existing hard-linked file mutations", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-hardlink-output-"));
  t.after(() => fsp.rm(root, { force: true, recursive: true }));
  const workspaceRoot = path.join(root, "workspace");
  const outside = path.join(root, "outside.txt");
  await fsp.mkdir(workspaceRoot);
  await fsp.writeFile(outside, "untouched");
  const linked = path.join(workspaceRoot, "artifact.txt");
  await fsp.link(outside, linked);
  const source = path.join(workspaceRoot, "source.txt");
  await fsp.writeFile(source, "source");
  const io = createOutputFileSystem({ workspaceRoot });
  for (const mutation of [
    () => io.writeFile(linked, "changed"),
    () => io.appendFile(linked, "changed"),
    () => io.open(linked, "w"),
    () => io.truncate(linked, 0),
    () => io.copyFile(source, linked),
    () => io.rename(linked, path.join(workspaceRoot, "renamed.txt")),
  ]) await assert.rejects(mutation, /Workspace artifact destination.*without linked files/);
  assert.equal(await fsp.readFile(outside, "utf8"), "untouched");
  assert.equal(await fsp.readFile(linked, "utf8"), "untouched");
  assert.equal(await fsp.readFile(source, "utf8"), "source");
});
