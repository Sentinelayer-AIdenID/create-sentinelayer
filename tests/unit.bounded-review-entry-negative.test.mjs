import "./setup-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCliProgram } from "../src/cli.js";
import { runLegacyCli } from "../src/legacy-cli.js";
import { MultiProviderApiClient } from "../src/ai/client.js";

// Only existing interfaces: these regressions also run on held candidate 60a2def.
const flag = "--max-model-token-exposure";
const scenarios = [
  { name: "Commander forwards spaced limit", commander: true, limit: [flag, "0.5"] },
  { name: "Commander forwards equals limit", commander: true, limit: [`${flag}=0.5`] },
  { name: "Commander rejects duplicate limit", commander: true, limit: [flag, "0.5", `${flag}=5`], rejects: /exactly once/ },
  { name: "raw slash enforces equals limit", limit: [`${flag}=0.5`] },
  { name: "raw slash rejects duplicate limit", limit: [flag, "5", `${flag}=0.5`], rejects: /exactly once/ },
  { name: "raw slash rejects flag after delimiter", limit: ["--", flag, "5"], rejects: /supported only after omargate deep/ },
  { name: "raw investor-DD rejects unsupported bound", mode: "investor-dd", limit: [flag, "0.5", "--dry-run", "--no-devtestbot", "--no-email", "--no-dashboard"], rejects: /supported only after omargate deep/ },
  { name: "raw unrelated command rejects misplaced bound", command: "/audit", limit: [flag, "0.5"], rejects: /supported only after omargate deep/ },
  { name: "full context reservation refuses former underbound", limit: [flag, "0.6"] },
];
for (const scenario of scenarios) {
  test(scenario.name, async t => {
    const targetPath = await fs.mkdtemp(path.join(os.tmpdir(), "exposure-entry-"));
    const oldKey = process.env.OPENAI_API_KEY, oldExit = process.exitCode, output = [];
    let calls = 0; process.env.OPENAI_API_KEY = "synthetic-unused-key";
    t.mock.method(Date, "now", () => Date.parse("2026-10-21T12:00:00Z"));
    t.mock.method(console, "log", value => output.push(String(value)));
    t.mock.method(MultiProviderApiClient.prototype, "invoke", async () => { calls++; return { text: '{"findings":[]}', usage: { inputTokens: 10, outputTokens: 5 } }; });
    t.mock.method(globalThis, "fetch", async () => { calls++; return { ok: true, json: async () => ({
      model: "gpt-5.3-codex", service_tier: "default", status: "completed",
      output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: '{"findings":[]}' }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 } },
    }) }; });
    try {
      await fs.writeFile(path.join(targetPath, "index.js"), "export const x = 1;\n"); process.exitCode = 0;
      const args = [scenario.command || (scenario.commander ? "omargate" : "/omargate"), ...(scenario.command ? [] : [scenario.mode || "deep"]), "--path", targetPath, "--provider", "openai", "--model", "gpt-5.3-codex", "--persona", "security", "--json", ...scenario.limit];
      const program = scenario.commander ? await buildCliProgram({ invokeLegacy: runLegacyCli, onlyCommand: "omargate" }) : null;
      program?.exitOverride();
      const run = () => program ? program.parseAsync(["node", "sl", ...args]) : runLegacyCli(args);
      if (scenario.rejects) await assert.rejects(run(), scenario.rejects);
      else {
        await run(); assert.equal(process.exitCode, 2);
        const report = JSON.parse(output.at(-1));
        assert.equal(report.coverage.status, "incomplete");
        assert.equal(report.modelTokenExposure.requestCounts.attempted, 0);
      }
      assert.equal(calls, 0);
    } finally {
      process.exitCode = oldExit; if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
      await fs.rm(targetPath, { recursive: true, force: true });
    }
  });
}

test("normal help and explicit session progress describe local-only exposure evidence", async t => {
  const targetPath = await fs.mkdtemp(path.join(os.tmpdir(), "exposure-operator-"));
  const oldKey = process.env.OPENAI_API_KEY, oldExit = process.exitCode, output = [];
  let calls = 0; process.env.OPENAI_API_KEY = "synthetic-unused-key";
  t.mock.method(Date, "now", () => Date.parse("2026-10-21T12:00:00Z"));
  t.mock.method(console, "log", value => output.push(String(value)));
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("no transport allowed"); });
  t.mock.method(MultiProviderApiClient.prototype, "invoke", async () => { calls++; throw new Error("no transport allowed"); });
  try {
    await fs.writeFile(path.join(targetPath, "index.js"), "export const x = 1;\n"); process.exitCode = 0;
    const program = await buildCliProgram({ invokeLegacy: runLegacyCli, onlyCommand: "omargate" });
    const deep = program.commands.find(c => c.name() === "omargate").commands.find(c => c.name() === "deep");
    assert.match(deep.helpInformation(), /exposure mode uses this ID locally only/);
    await program.parseAsync(["node", "sl", "omargate", "deep", "--path", targetPath, "--provider", "openai", "--model", "gpt-5.3-codex", "--persona", "security", flag, "0.5", "--notify-session", "operator-session"]);
    assert.equal(calls, 0); assert.equal(process.exitCode, 2);
    assert.match(output.join("\n"), /Usage evidence: local only \(session operator-session\); no remote billing entries/);
    assert.equal(output.some(line => line.includes("Usage ledger: using")), false);
  } finally {
    process.exitCode = oldExit; if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    await fs.rm(targetPath, { recursive: true, force: true });
  }
});
