import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveOutputContext } from "../src/config/service.js";
import { createOutputFileSystem } from "../src/config/output-filesystem.js";
import { createAgentContext, createToolDispatcher } from "../src/agents/shared-tools/dispatch-core.js";
import { createIsolatedPersonaContext, runPersonaAgenticLoop } from "../src/audit/persona-loop.js";
import { resolveRunEventsPath } from "../src/telemetry/ledger.js";

const agent = { id: "security", persona: "Reviewer", domain: "Security", tools: ["FileRead"], maxTurns: 3 };
const largeResult = { content: "evidence ".repeat(800) };
const boundaryError = /Workspace artifact destination must resolve inside the workspace/;

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-persona-output-boundary-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const artifactDir = path.join(workspace, "agents");
  await Promise.all([fsp.mkdir(artifactDir, { recursive: true }), fsp.mkdir(outside)]);
  await fsp.writeFile(path.join(workspace, ".sentinelayer.yml"), 'outputDir: "."\n');
  const { outputFs } = await resolveOutputContext({ cwd: workspace });
  return { workspace, outside, artifactDir, outputFs };
}

async function linkDirectory(target, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.symlink(target, destination, process.platform === "win32" ? "junction" : "dir");
}

test("persona context retains the boundary for large tool result persistence", async (t) => {
  const { workspace, outside, artifactDir, outputFs } = await fixture(t);
  const isolated = createIsolatedPersonaContext({
    agent, rootPath: workspace, artifactDir, outputFs,
    clientFactory: () => ({ invoke: async () => ({ text: "[]" }) }),
  });
  await linkDirectory(outside, path.join(artifactDir, "tool-results"));
  const dispatcher = createToolDispatcher({ Evidence: () => largeResult });
  await assert.rejects(dispatcher.dispatchTool("Evidence", {}, isolated.ctx), boundaryError);
  assert.deepEqual(await fsp.readdir(outside), []);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(isolated.ctx)), "outputFs"), false);
});

test("persona loop passes the configured boundary into its dispatcher", async (t) => {
  const { workspace, outside, artifactDir, outputFs } = await fixture(t);
  const filePath = path.join(workspace, "evidence.js");
  await fsp.writeFile(filePath, largeResult.content);
  await linkDirectory(outside, path.join(artifactDir, "tool-results"));
  const prompts = [];
  await runPersonaAgenticLoop({
    agent, rootPath: workspace, artifactDir, outputFs,
    clientFactory: () => ({
      async invoke({ prompt }) {
        prompts.push(prompt);
        return {
          provider: "test", model: "test",
          text: prompts.length === 1
            ? `\`\`\`tool_use\n${JSON.stringify({ tool: "FileRead", input: { file_path: filePath } })}\n\`\`\``
            : "```json\n[]\n```",
        };
      },
    }),
  });
  assert.ok(prompts.length >= 2);
  assert.match(prompts[1], boundaryError);
  assert.deepEqual(await fsp.readdir(outside), []);
});

test("dispatcher telemetry preserves the inherited boundary even when failures are best effort", async (t) => {
  const { outside, artifactDir, outputFs } = await fixture(t);
  const ledgerPath = await resolveRunEventsPath({ targetPath: artifactDir, outputDir: artifactDir });
  await linkDirectory(outside, path.dirname(ledgerPath));
  const ctx = createAgentContext({ artifactDir, outputFs });
  const dispatcher = createToolDispatcher({ Evidence: () => ({ ok: true }) });
  assert.deepEqual(await dispatcher.dispatchTool("Evidence", {}, ctx), { ok: true });
  assert.deepEqual(await fsp.readdir(outside), []);
});

test("dispatcher keeps explicit external output and standalone context behavior", async (t) => {
  const { workspace, outside } = await fixture(t);
  const { outputFs } = await resolveOutputContext({ cwd: workspace, outputDirOverride: outside });
  for (const [name, capability] of [["explicit", outputFs], ["standalone", createOutputFileSystem({ workspaceRoot: outside })]]) {
    const artifactDir = path.join(outside, name);
    const dispatcher = createToolDispatcher({ Evidence: () => largeResult });
    const result = await dispatcher.dispatchTool("Evidence", {}, createAgentContext({ artifactDir, outputFs: capability }));
    assert.equal(result._persisted, true);
    assert.deepEqual(JSON.parse(await fsp.readFile(result._refPath, "utf8")), largeResult);
  }
});

test("artifact-producing persona entries refuse missing, null, raw and forged IO before effects", async (t) => {
  const { workspace, artifactDir, outputFs } = await fixture(t);
  let calls = 0;
  const dispatcher = createToolDispatcher({ Evidence: () => { calls += 1; return largeResult; } });
  const clientFactory = () => { calls += 1; return { invoke: async () => ({ text: "[]" }) }; };
  for (const method of ["mkdir", "writeFile", "appendFile", "open"]) {
    t.mock.method(fsp, method, async () => { calls += 1; throw new Error("Unexpected file mutation"); });
  }
  for (const capability of [undefined, null, fsp, Object.freeze({ ...outputFs }), new Proxy(outputFs, {})]) {
    assert.throws(() => createAgentContext({ artifactDir, outputFs: capability }), TypeError);
    assert.throws(() => createIsolatedPersonaContext({ agent, rootPath: workspace, artifactDir, outputFs: capability, clientFactory }), TypeError);
    await assert.rejects(runPersonaAgenticLoop({ agent, rootPath: workspace, artifactDir, outputFs: capability, clientFactory }), TypeError);
    await assert.rejects(dispatcher.dispatchTool("Evidence", {}, { artifactDir, outputFs: capability }), TypeError);
  }
  assert.equal(calls, 0, "invalid capability must not reach the filesystem, tool, or model factory");
});
