import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { registerMcpCommand } from "../src/commands/mcp.js";
import { registerPluginCommand } from "../src/commands/plugin.js";
import { writeJsonFile as writeMcpJsonFile } from "../src/mcp/registry.js";
import { writeJsonFile as writePluginJsonFile } from "../src/plugin/manifest.js";
import { createOutputFileSystem } from "../src/config/output-filesystem.js";

const refusal = /Workspace artifact destination must resolve inside the workspace/;
const writers = [
  { args: ["mcp", "schema", "write"], file: "mcp/tool-registry.schema.json" },
  { args: ["mcp", "registry", "init-aidenid"], file: "mcp/tool-registry.aidenid-template.json" },
  { args: ["mcp", "registry", "init-aidenid-adapter"], file: "mcp/aidenid-provisioning-adapter.json" },
  { args: ["mcp", "registry", "init-session"], file: "mcp/tool-registry.session-tools.json" },
  { args: ["mcp", "registry", "init-senti-session"], file: "mcp/tool-registry.senti-session-tools.json" },
  { args: ["mcp", "registry", "init-hosted-session-connector"], file: "mcp/hosted-senti-session-connector.json" },
  { args: ["mcp", "registry", "init-cli"], file: "mcp/tool-registry.cli-tools.json" },
  { args: ["mcp", "server", "init", "--id", "fixture"], file: "mcp/servers/fixture.json" },
  { args: ["plugin", "init", "--id", "fixture"], file: "plugins/fixture/plugin.json" },
];

for (const [name, write] of [["MCP", writeMcpJsonFile], ["plugin", writePluginJsonFile]]) {
  test(`${name} exported JSON writer rejects missing or unregistered capabilities before mutation`, async (t) => {
    const f = await fixture(t);
    const destination = path.join(f.outside, "existing.json");
    await fsp.writeFile(destination, "unchanged");
    const mutations = [];
    for (const method of ["mkdir", "writeFile"]) {
      t.mock.method(fsp, method, async () => { mutations.push(method); });
    }
    for (const options of [undefined, {}, { force: true }, { outputFs: null }, { outputFs: fsp }, { outputFs: { ...fsp, assertPath: async () => {} } }]) {
      await assert.rejects(() => write(destination, { changed: true }, options), TypeError);
    }
    assert.deepEqual(mutations, []);
    assert.equal(await fsp.readFile(destination, "utf8"), "unchanged");
  });

  test(`${name} exported JSON writer accepts explicit factory capabilities`, async (t) => {
    const f = await fixture(t);
    for (const [directory, outputFs] of [
      [f.cwd, createOutputFileSystem({ workspaceRoot: f.cwd })],
      [f.outside, createOutputFileSystem()],
    ]) {
      const destination = path.join(directory, "new", "manifest.json");
      assert.equal(await write(destination, { written: true }, { outputFs }), destination);
      assert.deepEqual(JSON.parse(await fsp.readFile(destination, "utf8")), { written: true });
      await assert.rejects(() => write(destination, {}, { outputFs }), /File already exists/);
    }
  });
}

async function fixture(t, project = ".") {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-mcp-plugin-output-"));
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const homeDir = path.join(root, "home");
  await Promise.all([cwd, outside, homeDir].map((dir) => fsp.mkdir(dir)));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  if (project !== null) {
    await fsp.writeFile(path.join(cwd, ".sentinelayer.yml"), `outputDir: ${JSON.stringify(project)}\n`);
  }
  t.mock.method(process, "cwd", () => cwd);
  t.mock.method(os, "homedir", () => homeDir);
  const emitted = [];
  t.mock.method(console, "log", (body) => emitted.push(body));
  const run = async (args) => {
    const program = new Command().exitOverride();
    registerMcpCommand(program);
    registerPluginCommand(program);
    await program.parseAsync([...args, "--force", "--json"], { from: "user" });
    return JSON.parse(emitted.at(-1));
  };
  return { cwd, outside, homeDir, run };
}

for (const writer of writers) {
  test(`${writer.args.join(" ")} rejects relative explicit paths outside the workspace`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(() => f.run([...writer.args, "--path", "../outside/escaped.json"]), /inside the workspace/);
    await assert.rejects(() => fsp.access(path.join(f.outside, "escaped.json")), { code: "ENOENT" });
  });

  test(`${writer.args.join(" ")} guards explicit absolute paths inside the workspace`, async (t) => {
    const f = await fixture(t);
    await fsp.symlink(f.outside, path.join(f.cwd, "linked"), "junction");
    await assert.rejects(() => f.run([...writer.args, "--path", path.join(f.cwd, "linked", "escaped.json")]), /inside the workspace/);
    await assert.rejects(() => fsp.access(path.join(f.outside, "escaped.json")), { code: "ENOENT" });
  });

  test(`${writer.args.join(" ")} rejects a linked descendant before changing outside files`, async (t) => {
    const f = await fixture(t);
    const [directory, ...rest] = writer.file.split("/");
    const external = path.join(f.outside, ...rest);
    await fsp.mkdir(path.dirname(external), { recursive: true });
    await fsp.writeFile(external, "unchanged");
    await fsp.symlink(f.outside, path.join(f.cwd, directory), "junction");
    await assert.rejects(() => f.run(writer.args), refusal);
    assert.equal(await fsp.readFile(external, "utf8"), "unchanged");
  });

  for (const mode of ["workspace", "explicit path", "explicit output root", "global"]) {
    test(`${writer.args.join(" ")} preserves ${mode} writes`, async (t) => {
      const f = await fixture(t, mode === "global" ? null : mode === "workspace" ? "artifacts" : "../rejected-project-output");
      const expected = mode === "workspace" ? path.join(f.cwd, "artifacts", writer.file)
        : mode === "explicit path" ? path.join(f.outside, "explicit.json")
        : path.join(f.outside, writer.file);
      const args = [...writer.args];
      if (mode === "explicit path") args.push("--path", expected);
      if (mode === "explicit output root") args.push("--output-dir", f.outside);
      if (mode === "global") {
        await fsp.mkdir(path.join(f.homeDir, ".sentinelayer"));
        await fsp.writeFile(path.join(f.homeDir, ".sentinelayer/config.yml"), `outputDir: ${JSON.stringify(f.outside)}\n`);
      }
      const result = await f.run(args);
      assert.equal(result.outputPath, expected);
      assert.equal(typeof JSON.parse(await fsp.readFile(expected, "utf8")), "object");
      assert.equal(Object.hasOwn(result, "outputFs"), false, "filesystem capabilities must not leak into command JSON");
    });
  }
}

for (const writer of [writers[0], writers.at(-1)]) {
  test(`${writer.args.join(" ")} validates the resolved final file before any mutation`, async (t) => {
    const f = await fixture(t);
    const destination = path.join(f.cwd, writer.file);
    const external = path.join(f.outside, "external.json");
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, "local unchanged");
    await fsp.writeFile(external, "outside unchanged");
    const realpath = fsp.realpath.bind(fsp);
    // Model the resolution of an existing final-file link on hosts that cannot
    // create file symlinks. The native-link case below remains a separate test.
    t.mock.method(fsp, "realpath", async (value, ...args) =>
      path.resolve(String(value)) === destination ? external : realpath(value, ...args));
    const mutations = [];
    for (const method of ["mkdir", "writeFile"]) {
      t.mock.method(fsp, method, async () => { mutations.push(method); });
    }
    await assert.rejects(() => f.run(writer.args), refusal);
    assert.deepEqual(mutations, []);
    assert.equal(await fsp.readFile(destination, "utf8"), "local unchanged");
    assert.equal(await fsp.readFile(external, "utf8"), "outside unchanged");
  });

  test(`${writer.args.join(" ")} rejects a final-file symlink without modifying its target`, async (t) => {
    const f = await fixture(t);
    const destination = path.join(f.cwd, writer.file);
    const external = path.join(f.outside, "external.json");
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(external, "unchanged");
    try {
      await fsp.symlink(external, destination, "file");
    } catch (error) {
      if (process.platform === "win32" && error.code === "EPERM") {
        t.skip("Windows host lacks file-symlink privilege; directory-junction cases run separately.");
        return;
      }
      throw error;
    }
    await assert.rejects(() => f.run(writer.args), refusal);
    assert.equal(await fsp.readFile(external, "utf8"), "unchanged");
  });
}

test("MCP VS Code bridge binds its default destination and preserves trusted absolute override", async (t) => {
  const f = await fixture(t);
  const args = ["mcp", "bridge", "init-vscode", "--server-id", "fixture", "--server-config", "server.json"];
  await fsp.symlink(f.outside, path.join(f.cwd, ".vscode"), "junction");
  await assert.rejects(() => f.run(args), /inside the workspace/);
  await assert.rejects(() => fsp.access(path.join(f.outside, "mcp.json")), { code: "ENOENT" });
  await assert.rejects(() => f.run([...args, "--path", "../outside/relative.json"]), /inside the workspace/);
  const destination = path.join(f.outside, "explicit.json");
  const result = await f.run([...args, "--path", destination]);
  assert.equal(result.outputPath, destination);
  assert.equal(typeof JSON.parse(await fsp.readFile(destination, "utf8")), "object");
});
