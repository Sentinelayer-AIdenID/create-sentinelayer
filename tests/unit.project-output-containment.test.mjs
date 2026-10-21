import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveOutputRoot } from "../src/config/service.js";
import { appendRunEvent } from "../src/telemetry/ledger.js";

const rejection = "Workspace outputDir must resolve to a relative path inside the workspace.";

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-output-containment-"));
  const cwd = path.join(root, "workspace");
  const sibling = path.join(root, "workspace-sibling");
  const homeDir = path.join(root, "home");
  await Promise.all([cwd, sibling, homeDir].map((dir) => fsp.mkdir(dir)));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const project = (value) => fsp.writeFile(path.join(cwd, ".sentinelayer.yml"), `outputDir: ${JSON.stringify(value)}\n`);
  const global = async (value) => {
    await fsp.mkdir(path.join(homeDir, ".sentinelayer"), { recursive: true });
    await fsp.writeFile(path.join(homeDir, ".sentinelayer/config.yml"), `outputDir: ${JSON.stringify(value)}\n`);
  };
  return { cwd, sibling, root, project, global, options: { targetPath: cwd, homeDir, env: {} } };
}

async function rejectedBeforeWrite(t, options) {
  const calls = [];
  for (const method of ["mkdir", "writeFile", "appendFile"]) {
    t.mock.method(fsp, method, async () => {
      calls.push(method);
      throw new Error("Unexpected artifact write");
    });
  }
  await assert.rejects(() => appendRunEvent(options, { eventType: "run_start", runId: "containment-fixture" }), { message: rejection });
  assert.deepEqual(calls, [], "configuration must be rejected before artifact directory or file creation");
}

for (const value of ["../workspace-sibling/PRIVATE_CONFIG_VALUE", "..\\workspace-sibling\\out", "nested/..\\..\\workspace-sibling/out"]) {
  test(`project output rejects traversal before artifact writes: ${value}`, async (t) => {
    const f = await fixture(t);
    await f.project(value);
    await rejectedBeforeWrite(t, f.options);
  });
}

for (const value of ["/absolute", "C:\\absolute", "C:relative", "\\rooted", "\\\\server.invalid\\share", "\\\\?\\C:\\device"]) {
  test(`project output rejects absolute/rooted forms on every platform: ${value}`, async (t) => {
    const f = await fixture(t);
    await f.project(value);
    await rejectedBeforeWrite(t, f.options);
  });
}

test("project output rejects even an absolute workspace descendant", async (t) => {
  const f = await fixture(t);
  await f.project(path.join(f.cwd, "inside"));
  await rejectedBeforeWrite(t, f.options);
});

for (const suffix of ["", "/missing/deep"]) {
  test(`project output rejects external symlink/junction with suffix '${suffix}'`, async (t) => {
    const f = await fixture(t);
    await fsp.symlink(f.sibling, path.join(f.cwd, "link"), "junction");
    await f.project(`link${suffix}`);
    await rejectedBeforeWrite(t, f.options);
  });
}

test("project output fails closed for a dangling symlink/junction", async (t) => {
  const f = await fixture(t);
  await fsp.symlink(path.join(f.sibling, "not-created"), path.join(f.cwd, "dangling"), "junction");
  await f.project("dangling/missing");
  await rejectedBeforeWrite(t, f.options);
});

test("project output fails closed on filesystem errors without revealing paths", async (t) => {
  const f = await fixture(t);
  await f.project("PRIVATE_CONFIG_VALUE");
  t.mock.method(fsp, "realpath", async () => {
    throw Object.assign(new Error("permission denied PRIVATE_CONFIG_VALUE"), { code: "EACCES" });
  });
  await rejectedBeforeWrite(t, f.options);
});

for (const value of [undefined, ".out", "..hidden", "nested/../safe", "new/nested/output", "."]) {
  test(`safe project output preserves actual artifact writes: ${value ?? "default"}`, async (t) => {
    const f = await fixture(t);
    if (value !== undefined) await f.project(value);
    const result = await appendRunEvent(f.options, { eventType: "run_start", runId: "safe-fixture" });
    const expected = path.resolve(f.cwd, value ?? ".sentinelayer", "observability", "run-events.jsonl");
    assert.equal(result.filePath, expected);
    assert.equal(JSON.parse((await fsp.readFile(expected, "utf8")).trim()).runId, "safe-fixture");
  });
}

test("project output preserves internal links and a workspace reached through a junction", async (t) => {
  const f = await fixture(t);
  await fsp.mkdir(path.join(f.cwd, "actual"));
  await fsp.symlink(path.join(f.cwd, "actual"), path.join(f.cwd, "internal"), "junction");
  const alias = path.join(f.root, "alias");
  await fsp.symlink(f.cwd, alias, "junction");
  await f.project("internal/new/deep");
  const result = await appendRunEvent({ ...f.options, targetPath: alias }, { eventType: "run_start", runId: "linked-fixture" });
  assert.equal(await fsp.realpath(result.filePath), await fsp.realpath(path.join(f.cwd, "actual/new/deep/observability/run-events.jsonl")));
});

for (const absolute of [true, false]) {
  test(`trusted global ${absolute ? "absolute" : "relative"} output remains available`, async (t) => {
    const f = await fixture(t);
    await f.global(absolute ? path.join(f.sibling, "global") : "../workspace-sibling/global");
    const result = await appendRunEvent(f.options, { eventType: "run_start", runId: "global-fixture" });
    assert.equal(result.filePath, path.join(f.sibling, "global/observability/run-events.jsonl"));
  });
}

test("explicit user override remains trusted even with unsafe project configuration", async (t) => {
  const f = await fixture(t);
  await f.project("../workspace-sibling/untrusted");
  const result = await appendRunEvent({ ...f.options, outputDirOverride: path.join(f.sibling, "explicit") }, { eventType: "run_start", runId: "override-fixture" });
  assert.equal(result.filePath, path.join(f.sibling, "explicit/observability/run-events.jsonl"));
});

test("project output takes precedence over a global output value", async (t) => {
  const f = await fixture(t);
  await f.global(path.join(f.sibling, "global"));
  await f.project(".project");
  assert.equal(await resolveOutputRoot({ cwd: f.cwd, homeDir: f.options.homeDir, env: {} }), path.join(f.cwd, ".project"));
});
