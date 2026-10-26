import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { registerWatchCommand } from "../src/commands/watch.js";

for (const mode of ["default", "project", "relative CLI", "absolute CLI within workspace"]) {
  test(`watch refuses linked ${mode} artifacts before authentication or polling`, async (t) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-watch-boundary-"));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await Promise.all([fsp.mkdir(workspace), fsp.mkdir(outside)]);
    if (mode === "project") await fsp.writeFile(path.join(workspace, ".sentinelayer.yml"), "outputDir: artifacts\n");
    const artifactRoot = path.join(workspace, mode === "default" ? ".sentinelayer" : "artifacts");
    await fsp.symlink(outside, artifactRoot, process.platform === "win32" ? "junction" : "dir");
    let fetches = 0;
    t.mock.method(globalThis, "fetch", async () => { fetches += 1; throw new Error("Unexpected request"); });
    const program = new Command().exitOverride();
    registerWatchCommand(program);
    const args = ["watch", "run-events", "--run-id", "fixture", "--path", workspace, "--json"];
    if (mode.includes("CLI")) args.push("--output-dir", mode.startsWith("relative") ? "artifacts" : artifactRoot);
    await assert.rejects(program.parseAsync(args, { from: "user" }), /Workspace (artifact destination|outputDir) must resolve/);
    assert.equal(fetches, 0);
    assert.deepEqual(await fsp.readdir(outside), []);
  });
}
