import "./setup-env.mjs";
// Tests that verify the SentinelLayer config.json token leak fix by driving
// the actual exported functions from legacy-cli.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  writeInitConfigLockfile,
  ensureSentinelConfigIgnored,
  warnIfSentinelConfigTracked,
} from "../src/legacy-cli.js";

test("writeInitConfigLockfile does NOT write sentinelayer_token to config.json", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-init-config-"));
  const ws = path.join(root, "workspace");
  await fsp.mkdir(ws, { recursive: true });

  // Use a runtime-built token value (never a slt_-shaped literal)
  const fakeToken = "x".repeat(8) + "-fixture-token";
  const fakeSpecId = "spec-abc123";
  const fakeWorkflow = path.join(ws, ".github", "workflows", "omar-gate.yml");
  await fsp.mkdir(path.dirname(fakeWorkflow), { recursive: true });
  await fsp.writeFile(fakeWorkflow, "name: test\n", "utf-8");

  await writeInitConfigLockfile({
    projectDir: ws,
    specId: fakeSpecId,
    sentinelayerToken: fakeToken,
    secretName: "SENTINELAYER_TOKEN",
    repoSlug: "acme/test-repo",
    workflowPath: fakeWorkflow,
    sessionId: "sess-001",
  });

  const configRaw = await fsp.readFile(path.join(ws, ".sentinelayer", "config.json"), "utf-8");
  const config = JSON.parse(configRaw);

  // Token must NOT be in the file at all
  assert.ok(
    !configRaw.includes(fakeToken),
    "config.json must not contain the token value"
  );
  assert.equal(
    config.sentinelayer_token,
    undefined,
    "sentinelayer_token key must not exist in config.json"
  );

  // Other fields still work
  assert.equal(config.spec_id, fakeSpecId);
  assert.equal(config.required_secret_name, "SENTINELAYER_TOKEN");
  assert.equal(config.repo_slug, "acme/test-repo");
  assert.equal(config.session_id, "sess-001");
});

test("ensureSentinelConfigIgnored appends .sentinelayer/ to .gitignore and is idempotent", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-init-gitignore-"));
  const ws = path.join(root, "workspace");
  await fsp.mkdir(ws, { recursive: true });

  // Existing repo with .gitignore that has node_modules/ but NOT .sentinelayer/
  spawnSync("git", ["init"], { cwd: ws, encoding: "utf-8" });
  await fsp.writeFile(path.join(ws, ".gitignore"), "node_modules/\n", "utf-8");

  await ensureSentinelConfigIgnored(ws);

  // git check-ignore should confirm .sentinelayer/config.json is ignored
  const check = spawnSync("git", ["-C", ws, "check-ignore", ".sentinelayer/config.json"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(check.status, 0, "git check-ignore must exit 0 after ensureSentinelConfigIgnored");
  assert.match(check.stdout || "", /\.sentinelayer\/config\.json/);

  // Verify the exact entry is in .gitignore
  const gitignore = await fsp.readFile(path.join(ws, ".gitignore"), "utf-8");
  assert.match(gitignore, /(^|\r?\n)\.sentinelayer\/\r?\n/);

  // Idempotency: run again, entry appears exactly once
  await ensureSentinelConfigIgnored(ws);
  const gitignore2 = await fsp.readFile(path.join(ws, ".gitignore"), "utf-8");
  const count = (gitignore2.match(/\.sentinelayer\//g) || []).length;
  assert.equal(count, 1, ".sentinelayer/ must appear exactly once after idempotent call");
});

test("ensureSentinelConfigIgnored handles CRLF .gitignore", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-init-gitignore-crlf-"));
  const ws = path.join(root, "workspace");
  await fsp.mkdir(ws, { recursive: true });

  spawnSync("git", ["init"], { cwd: ws, encoding: "utf-8" });
  await fsp.writeFile(path.join(ws, ".gitignore"), "node_modules/\r\n", "utf-8");

  await ensureSentinelConfigIgnored(ws);

  const check = spawnSync("git", ["-C", ws, "check-ignore", ".sentinelayer/config.json"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(check.status, 0, "git check-ignore must exit 0 with CRLF .gitignore");
});

test("ensureSentinelConfigIgnored handles empty .gitignore", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-init-gitignore-empty-"));
  const ws = path.join(root, "workspace");
  await fsp.mkdir(ws, { recursive: true });

  spawnSync("git", ["init"], { cwd: ws, encoding: "utf-8" });
  // No .gitignore file at all

  await ensureSentinelConfigIgnored(ws);

  const gitignore = await fsp.readFile(path.join(ws, ".gitignore"), "utf-8");
  assert.match(gitignore, /\.sentinelayer\/\n/);
});

test("warnIfSentinelConfigTracked warns when config.json is tracked by git", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-init-tracked-"));
  const ws = path.join(root, "workspace");
  await fsp.mkdir(ws, { recursive: true });

  spawnSync("git", ["init"], { cwd: ws, encoding: "utf-8" });
  await fsp.mkdir(path.join(ws, ".sentinelayer"), { recursive: true });
  await fsp.writeFile(
    path.join(ws, ".sentinelayer", "config.json"),
    JSON.stringify({ sentinelayer_token: "old-leaked-token" }, null, 2),
    "utf-8"
  );
  spawnSync("git", ["-C", ws, "add", ".sentinelayer/config.json"], { encoding: "utf-8" });
  spawnSync("git", ["-C", ws, "commit", "-m", "accidentally tracked config"], { encoding: "utf-8" });

  // Capture console.log output
  const originalLog = console.log;
  let captured = "";
  console.log = (...args) => { captured += args.join(" ") + "\n"; };

  try {
    await warnIfSentinelConfigTracked(ws);
  } finally {
    console.log = originalLog;
  }

  assert.ok(
    captured.includes(".sentinelayer/config.json"),
    "warning must name the tracked config file"
  );
  assert.ok(
    captured.includes("git rm --cached"),
    "warning must tell user how to untrack"
  );
  assert.ok(
    captured.includes("rotate your token"),
    "warning must advise token rotation"
  );
  assert.ok(
    captured.includes("sentinelayer.com/dashboard"),
    "warning must link to dashboard for rotation"
  );
});

test("warnIfSentinelConfigTracked is silent when config.json is not tracked", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-init-untracked-"));
  const ws = path.join(root, "workspace");
  await fsp.mkdir(ws, { recursive: true });

  // git repo, but config.json never committed
  spawnSync("git", ["init"], { cwd: ws, encoding: "utf-8" });
  await fsp.mkdir(path.join(ws, ".sentinelayer"), { recursive: true });
  await fsp.writeFile(
    path.join(ws, ".sentinelayer", "config.json"),
    JSON.stringify({ spec_id: "test" }, null, 2),
    "utf-8"
  );

  const originalLog = console.log;
  let captured = "";
  console.log = (...args) => { captured += args.join(" ") + "\n"; };

  try {
    await warnIfSentinelConfigTracked(ws);
  } finally {
    console.log = originalLog;
  }

  assert.equal(captured, "", "must not warn when config.json is not tracked");
});

test("warnIfSentinelConfigTracked is silent in non-repo directory", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-init-nonrepo-"));
  const ws = path.join(root, "workspace");
  await fsp.mkdir(ws, { recursive: true });

  const originalLog = console.log;
  let captured = "";
  console.log = (...args) => { captured += args.join(" ") + "\n"; };

  try {
    await warnIfSentinelConfigTracked(ws);
  } finally {
    console.log = originalLog;
  }

  assert.equal(captured, "", "must not throw or warn in non-repo directory");
});
