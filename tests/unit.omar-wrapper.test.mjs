import "./setup-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "omar-gate.yml");
const scannerPath = path.join(repoRoot, ".github", "scripts", "scan-omar-artifacts.js");

test("Unit Omar workflow: the canonical deep gate uses only direct OpenAI Sol", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /name: Omar Gate\b/);
  assert.match(workflow, /name: Omar Gate \(Deep Scan\)/);
  assert.match(workflow, /name: Omar Gate Untrusted Scan/);
  assert.match(workflow, /omar_enforce:[\s\S]*?if:\s*\$\{\{\s*always\(\)\s*\}\}/);
  assert.match(workflow, /openai_api_key:\s*\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/);
  assert.match(workflow, /llm_provider:\s*openai/);
  assert.match(workflow, /review_routing:\s*legacy/);
  assert.match(workflow, /sentinelayer_managed_llm:\s*"false"/);
  assert.match(workflow, /model:\s*gpt-6\.1-sol/);
  assert.match(workflow, /codex_model:\s*gpt-6\.1-sol/);
  assert.match(workflow, /model_fallback:\s*gpt-6\.1-sol/);
  assert.match(workflow, /use_codex:\s*"false"/);
  assert.match(workflow, /llm_failure_policy:\s*block/);
  assert.match(workflow, /rate_limit_fail_mode:\s*closed/);
  assert.match(workflow, /Require direct OpenAI key/);
  assert.match(workflow, /Select Omar Gate result/);
  assert.match(workflow, /Direct OpenAI Omar scan did not succeed/);
  assert.match(workflow, /"llm_scope": "legacy_bounded_context"/);
  assert.match(workflow, /"source_wide_llm_coverage": False/);
  assert.match(workflow, /Stage Omar artifacts/);
  assert.match(workflow, /Upload Omar artifacts/);
  assert.match(workflow, /Require selected Omar scan success/);
  assert.doesNotMatch(
    workflow,
    /GOOGLE_API_KEY|GOOGLE_GEMINI_API_KEY|google_api_key:|typesafe_api_key:|gemini-|gpt-5\.3-codex|provider_outage_break_glass|Run deterministic Omar Gate fallback|classify_omar_provider_outage\.py/i,
  );
});

test("Unit Omar workflow: Action pin is the reviewed PR135 security release", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const uses = [...workflow.matchAll(/uses:\s*(mrrCarter\/sentinelayer-v1-action@\S+)/g)];
  // The first attempt and its quota retry: the same reviewed pin, and no other invocation.
  const pin = "mrrCarter/sentinelayer-v1-action@2d5a8edd485595148254926c9fb318e0adae416a";
  assert.deepEqual(uses.map((use) => use[1]), [pin, pin]);
});

test("Unit Omar artifacts: a configured secret is refused verbatim in a staged file of any size", async (t) => {
  const endpoint = "https://example-resource.example.test/openai/v1";
  const root = await mkdtemp(path.join(os.tmpdir(), "omar-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staged = path.join(root, "omar-artifacts");
  await mkdir(path.join(staged, "telemetry"), { recursive: true });
  await writeFile(path.join(staged, "telemetry", "run.json"), `{"base_url":"${endpoint}"}\n`, "utf8");
  const inherited = { ...process.env };
  for (const name of ["OPENAI_API_KEY", "AZURE_SOL61_API_KEY", "AZURE_SOL61_BASE_URL"]) {
    delete inherited[name];
  }
  // --max-bytes 16 puts the file past the pattern scan's size limit; the configured value is still found.
  const scan = (env, report) =>
    spawnSync(process.execPath, [scannerPath, "--path", staged, "--report", report, "--max-bytes", "16"], {
      env: { ...inherited, ...env },
      encoding: "utf8",
    });

  const blockedReport = path.join(root, "blocked.json");
  assert.equal(scan({ AZURE_SOL61_BASE_URL: endpoint }, blockedReport).status, 2);
  const report = await readFile(blockedReport, "utf8");
  assert.deepEqual(
    JSON.parse(report).map(({ type, name }) => [type, name]),
    [["configured_secret", "AZURE_SOL61_BASE_URL"]],
  );
  // The finding names the variable, never its value.
  assert.doesNotMatch(report, /example-resource/);

  // Without the configured value the same tree passes, so the finding came from the configured secret.
  assert.equal(scan({}, path.join(root, "clean.json")).status, 0);
});
