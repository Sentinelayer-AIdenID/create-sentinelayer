import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/sl.js", import.meta.url));

test("board check honors JSON placement after its command and preserves text and exit status", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "sl-board-output-"));
  try {
    const file = path.join(workspace, "ticket.json");
    await writeFile(file, JSON.stringify({ id: "fixture-board", evidence: [] }));
    // setup-env isolates the auth home and guards fetch. No evidence means no gh
    // process or remote resolver is needed; only the real CLI's output is tested.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/token|secret|password|credential|authorization|api.?key/i.test(name)));
    env.SENTINELAYER_TOKEN = "fixture-board-local-auth";
    const invoke = (args) => {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: workspace, env, encoding: "utf8", timeout: 15000, windowsHide: true,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 2, result.stderr || result.stdout);
      return result.stdout;
    };
    const placements = [
      ["board", "--json", "check", "--file", file],
      ["board", "check", "--json", "--file", file],
      ["board", "check", "--file", file, "--json"],
    ];
    for (const [index, args] of placements.entries()) {
      await t.test(`JSON placement ${index + 1}`, () => {
        const output = JSON.parse(invoke(args));
        assert.deepEqual(output, {
          verdict: "cannot-verify", reason: "ticket claims no evidence", results: [], ticket: "fixture-board",
        });
      });
    }
    await t.test("default text remains readable", () => {
      const output = invoke(["board", "check", "--file", file]);
      assert.match(output, /^verdict: cannot-verify\nreason:  ticket claims no evidence\n$/);
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
