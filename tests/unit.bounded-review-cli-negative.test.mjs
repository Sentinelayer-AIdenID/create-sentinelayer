import "./setup-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runLegacyCli } from "../src/legacy-cli.js";
import { MultiProviderApiClient } from "../src/ai/client.js";
import { runAiReviewLayer } from "../src/review/ai-review.js";

// Imports only pre-existing production interfaces: also runnable on unchanged PR856.
for (const scenario of ["unaffordable", "unsupported", "truncated"]) {
  test(`actual CLI negative control: ${scenario}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "exposure-negative-"));
    const output = [], oldKey = process.env.OPENAI_API_KEY, oldExit = process.exitCode;
    let calls = 0;
    process.env.OPENAI_API_KEY = "synthetic-unused-key";
    t.mock.method(Date, "now", () => Date.parse("2026-10-21T12:00:00Z"));
    t.mock.method(console, "log", value => output.push(String(value)));
    t.mock.method(MultiProviderApiClient.prototype, "invoke", async () => {
      calls++; return { text: '{"findings":[]}', status: "incomplete", usage: { inputTokens: 10, outputTokens: 5 } };
    });
    t.mock.method(globalThis, "fetch", async () => {
      calls++; return { ok: true, json: async () => ({
        model: "gpt-5.3-codex", service_tier: "default", status: "incomplete",
        output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: '{"findings":[]}' }] }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 } },
      }) };
    });
    try {
      await fs.writeFile(path.join(root, "index.js"), "export const x = 1;\n"); process.exitCode = 0;
      await runLegacyCli(["/omargate", "deep", "--path", root, "--scope-mode", "full", "--persona", "security", "--provider", scenario === "unsupported" ? "sentinelayer" : "openai", "--model", "gpt-5.3-codex", "--max-model-token-exposure", scenario === "unaffordable" ? "0.5" : "5", "--json"]);
      assert.equal(calls, scenario === "truncated" ? 1 : 0);
      assert.equal(JSON.parse(output.at(-1)).coverage.status, "incomplete");
      assert.equal(process.exitCode, 2);
    } finally {
      process.exitCode = oldExit; if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

for (const requireUsageLedger of [false, true]) {
  test(`existing-interface negative control: bounded BYOK remote ledger required=${requireUsageLedger}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "exposure-ledger-negative-"));
    const oldKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "synthetic-unused-key";
    let calls = 0, ledgerCalls = 0;
    const boundedReview = { provider: "openai", model: "gpt-5.3-codex", invoke: async () => {
      calls++; return { text: '{"findings":[]}', completed: true, finish: "completed", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0000875 }, providerUsage: { input_tokens: 10, output_tokens: 5 }, exposure: { policySha256: "a".repeat(64) } };
    } };
    t.mock.method(MultiProviderApiClient.prototype, "invoke", async () => {
      calls++; return { text: '{"findings":[]}', usage: { inputTokens: 10, outputTokens: 5 } };
    });
    try {
      await fs.writeFile(path.join(root, "index.js"), "export const x = 1;\n");
      const run = () => runAiReviewLayer({ targetPath: root, runDirectory: path.join(root, "run"), provider: "openai", model: "gpt-5.3-codex", boundedReview, requireUsageLedger,
        usageRecorder: async () => { ledgerCalls++; return { ok: true }; } });
      if (requireUsageLedger) { await assert.rejects(run(), /remote billing ledger/); assert.equal(calls, 0); }
      else { await run(); assert.equal(calls, 1); }
      assert.equal(ledgerCalls, 0);
    } finally {
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
