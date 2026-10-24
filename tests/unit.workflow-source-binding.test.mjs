import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

const PR_HEAD_EXPRESSION =
  "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";

function jobBlock(workflow, jobName, nextJobName) {
  const start = workflow.indexOf(`\n  ${jobName}:`);
  assert.notEqual(start, -1, `missing ${jobName} job`);
  const end = nextJobName
    ? workflow.indexOf(`\n  ${nextJobName}:`, start + 1)
    : workflow.length;
  assert.notEqual(end, -1, `missing ${nextJobName} job boundary`);
  return workflow.slice(start, end);
}

test("package provenance builds and attestation rebuild use the immutable PR head", async () => {
  const quality = await readFile(".github/workflows/quality-gates.yml", "utf8");
  const attestations = await readFile(".github/workflows/attestations.yml", "utf8");

  const reproducibleBuild = jobBlock(
    quality,
    "reproducible-build",
    "build-package"
  );
  const buildPackage = jobBlock(
    quality,
    "build-package",
    "deploy-readiness"
  );
  const trustedAttestation = jobBlock(attestations, "attest-build", "attest-untrusted");

  for (const [name, block] of [
    ["reproducible-build", reproducibleBuild],
    ["build-package", buildPackage],
    ["attest-build", trustedAttestation],
  ]) {
    assert.match(
      block,
      new RegExp(`ref: ${PR_HEAD_EXPRESSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      `${name} must check out the canonical PR-head source`
    );
  }

  assert.match(
    buildPackage,
    new RegExp(
      `TARGET_COMMIT_SHA: ${PR_HEAD_EXPRESSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
    ),
    "the package manifest must name the same canonical source commit"
  );
});

test("required-check polling retries transient GitHub API failures within bounded requests", async () => {
  const gate = await readFile(".github/scripts/require-check-runs.sh", "utf8");

  assert.match(gate, /github_api_get\(\)/);
  assert.match(gate, /--connect-timeout "\$\{GITHUB_API_CONNECT_TIMEOUT_SECONDS\}"/);
  assert.match(gate, /--max-time "\$\{GITHUB_API_REQUEST_TIMEOUT_SECONDS\}"/);
  assert.match(gate, /--retry "\$\{GITHUB_API_RETRY_COUNT\}"/);
  assert.match(gate, /--retry-max-time "\$\{GITHUB_API_RETRY_MAX_SECONDS\}"/);
  assert.match(gate, /--retry-all-errors/);
  assert.doesNotMatch(gate, /curl -fsSL/);
});

test("rollback confirmation stays data even when the dispatch input contains shell syntax", async () => {
  const workflow = parse(await readFile(".github/workflows/rollback.yml", "utf8"));
  const confirmation = workflow.jobs["rollback-execute"].steps.find(
    (step) => step.name === "Require explicit rollback confirmation"
  );
  assert.ok(confirmation, "rollback confirmation step must exist");
  assert.equal(confirmation.env.INPUT_CONFIRM, "${{ inputs.confirm }}");
  assert.doesNotMatch(confirmation.run, /\$\{\{\s*inputs\./);

  const bash = process.platform === "win32"
    ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"].find(existsSync)
    : "bash";
  if (!bash) return;
  const root = await mkdtemp(path.join(os.tmpdir(), "sl-rollback-confirm-"));
  const marker = path.join(root, "injected");
  try {
    const injection = spawnSync(bash, ["-c", confirmation.run], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, INPUT_CONFIRM: '$(touch "$INJECTION_MARKER")', INJECTION_MARKER: "injected" },
    });
    assert.equal(injection.status, 1, injection.stderr);
    assert.equal(existsSync(marker), false, "dispatch input must not execute as Bash");

    const allowed = spawnSync(bash, ["-c", confirmation.run], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, INPUT_CONFIRM: "ROLLBACK" },
    });
    assert.equal(allowed.status, 0, allowed.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
