import "./setup-env.mjs";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runOmarGateOrchestrator } from "../src/review/omargate-orchestrator.js";
import { MultiProviderApiClient } from "../src/ai/client.js";
import { runLegacyCli } from "../src/legacy-cli.js";

const fixtures = JSON.parse(await fs.readFile(new URL("./evals/omargate-coverage-cases.json", import.meta.url), "utf8"));
const roots = [];
const summary = { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false };
async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omar-coverage-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

for (const fixture of fixtures.cases) {
  test(`Omar coverage: ${fixture.id}`, async () => {
    const targetPath = await makeRoot();
    const events = [];
    const calls = [];
    const files = Array.from({ length: fixture.files }, (_, index) => `src/File${index}.js`);
    const result = await runOmarGateOrchestrator({
      targetPath, scanMode: "deep", includeOnly: fixture.personas,
      maxParallel: 1, maxCostUsd: fixture.maxCostUsd ?? 5, dryRun: fixture.dryRun || false,
      deterministic: { summary, findings: [], scope: { scannedRelativeFiles: files, scannedFiles: files.length }, layers: {}, metadata: {}, artifacts: {} },
      onEvent: (event) => events.push(event),
      aiReviewRunner: async ({ runId }) => {
        calls.push(runId);
        const secondPartition = runId.endsWith("-swarm-2");
        if ((fixture.behavior === "fail-security" && runId.endsWith("-security")) ||
            (fixture.behavior === "fail-second-partition" && secondPartition)) throw new Error("Synthetic unavailable lane");
        const unverified = fixture.behavior === "unverified-second-partition" && secondPartition;
        return {
          findings: [{ severity: "P2", file: files[0], line: 1, message: "Synthetic retained finding", confidence: 0.95 }],
          usage: { inputTokens: unverified ? 0 : 10, outputTokens: unverified ? 0 : 5, costUsd: fixture.behavior === "spend-budget" ? 0.02 : 0 },
          budget: { blocking: fixture.behavior === "budget-stop", reasons: fixture.behavior === "budget-stop" ? [{ code: "MAX_COST_EXCEEDED" }] : [] },
        };
      },
    });
    assert.equal(result.summary.blocking, fixture.candidateBlocking);
    assert.equal(result.personaHealth.healthy, !fixture.candidateBlocking);
    assert.equal(result.coverage.status, fixture.candidateBlocking ? "incomplete" : fixture.dryRun ? "simulated" : "complete");
    assert.ok(result.findings.some((finding) => finding.message === "Synthetic retained finding"), "partial findings must survive");
    assert.equal(events.at(-1).event, "omargate_complete");
    assert.equal(events.at(-1).payload.summary.blocking, fixture.candidateBlocking);
    if (fixture.candidateBlocking) {
      assert.equal(result.summary.P1, 1);
      assert.equal(result.findings.at(-1).category, "Omar AI Coverage");
      assert.ok(result.coverage.completedPersonas < result.coverage.requestedPersonas);
    }
    if (fixture.behavior === "spend-budget") {
      assert.equal(calls.length, 1);
      assert.equal(result.personaHealth.skipped, 2);
      assert.equal(result.personas.filter((persona) => persona.reason === "global_budget_exhausted").length, 2);
    }
    if (fixture.files > 1 && fixture.candidateBlocking) {
      assert.ok(result.personas[0].swarm.coverage.incomplete > 0);
    }
  });
}

test("Omar coverage CLI: a failed minority lane makes real JSON/report exit blocking", async (t) => {
  const targetPath = await makeRoot();
  await fs.writeFile(path.join(targetPath, "index.js"), "export const value = 1;\n");
  const output = [];
  const previousExit = process.exitCode;
  let calls = 0;
  t.mock.method(console, "log", (text) => output.push(String(text)));
  t.mock.method(MultiProviderApiClient.prototype, "invoke", async () => {
    if (++calls === 1) throw new Error("Synthetic provider outage");
    return { text: JSON.stringify({ summary: { highLevel: "Synthetic only" }, findings: [] }), usage: { inputTokens: 10, outputTokens: 5 } };
  });
  try {
    process.exitCode = 0;
    await runLegacyCli(["/omargate", "deep", "--path", targetPath, "--scope-mode", "full", "--persona", "security,backend,testing", "--max-parallel", "1", "--provider", "openai", "--json"]);
    const report = JSON.parse(output.at(-1));
    assert.equal(calls, 3);
    assert.equal(report.blocking, true);
    assert.equal(report.coverage.status, "incomplete");
    assert.equal(process.exitCode, 2);
    assert.match(await fs.readFile(report.reportPath, "utf8"), /AI coverage: incomplete/);
    const reconciled = JSON.parse(await fs.readFile(report.artifacts.reconciled, "utf8"));
    assert.equal(reconciled.coverage.status, "incomplete");
    assert.equal(reconciled.summary.blocking, true);
  } finally { process.exitCode = previousExit; }
});

test("Omar coverage CLI: an orchestrator exception cannot become a clean fallback", async (t) => {
  const targetPath = await makeRoot();
  await fs.writeFile(path.join(targetPath, "index.js"), "export const value = 1;\n");
  const output = [];
  const previousExit = process.exitCode;
  let calls = 0;
  t.mock.method(console, "log", (text) => output.push(String(text)));
  t.mock.method(MultiProviderApiClient.prototype, "invoke", async () => { calls++; throw new Error("No call expected"); });
  try {
    process.exitCode = 0;
    await runLegacyCli(["/omargate", "deep", "--path", targetPath, "--scan-mode", "unknown", "--json"]);
    const report = JSON.parse(output.at(-1));
    assert.equal(calls, 0);
    assert.equal(report.blocking, true);
    assert.equal(report.coverage.status, "incomplete");
    assert.equal(process.exitCode, 2);
    assert.match(await fs.readFile(report.reportPath, "utf8"), /requested AI review did not complete/);
  } finally { process.exitCode = previousExit; }
});
