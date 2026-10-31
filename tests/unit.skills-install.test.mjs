import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI = path.join(ROOT, "bin/sentinelayer-cli.js");
const NAMES = ["senti-agent-identity", "senti-room-listen", "sentinelayer-cli"];
const run = (cwd, args) => spawnSync(process.execPath, [CLI, ...args], {
  cwd, encoding: "utf8", env: process.env,
});

test("skills install works before login, repeats without writes, and lists shipped skills", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "skills-install-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const list = run(cwd, ["skills", "list", "--json"]);
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout).skills.map((s) => s.name), NAMES);
  const first = run(cwd, ["skills", "install", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.written.length, 4);
  for (const name of NAMES) {
    assert.equal(await readFile(path.join(cwd, ".claude/skills", name, "SKILL.md"), "utf8"),
      await readFile(path.join(ROOT, "skills", name, "SKILL.md"), "utf8"));
  }
  const wrapper = path.join(cwd, ".claude/skills/senti-room-listen/listen-wrapper.cjs");
  const before = await stat(wrapper);
  const repeat = run(cwd, ["skills", "install", "--json"]);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.deepEqual(JSON.parse(repeat.stdout).written, []);
  assert.equal((await stat(wrapper)).mtimeMs, before.mtimeMs);
});

test("skills install refuses edited content before writing and force preserves unrelated files", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "skills-conflict-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const dir = path.join(cwd, "custom skills");
  const skill = path.join(dir, "sentinelayer-cli");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "user changes\n");
  await writeFile(path.join(skill, "notes.md"), "keep me\n");
  const refused = run(cwd, ["skills", "install", "--dir", dir]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--force/);
  await assert.rejects(stat(path.join(dir, "senti-agent-identity/SKILL.md")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(skill, "SKILL.md"), "utf8"), "user changes\n");
  const forced = run(cwd, ["skills", "install", "--dir", dir, "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /Wrote .*SKILL\.md/);
  assert.equal(await readFile(path.join(skill, "notes.md"), "utf8"), "keep me\n");
  assert.equal(await readFile(path.join(skill, "SKILL.md"), "utf8"),
    await readFile(path.join(ROOT, "skills/sentinelayer-cli/SKILL.md"), "utf8"));
});

test("skills install refuses linked skill directories even with force", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "skills-link-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const dir = path.join(cwd, "skills");
  const outside = path.join(cwd, "outside");
  await mkdir(dir);
  await mkdir(outside);
  await writeFile(path.join(outside, "SKILL.md"), "untouched\n");
  await symlink(outside, path.join(dir, "senti-room-listen"), "junction");
  const result = run(cwd, ["skills", "install", "--dir", dir, "--force"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symbolic link/);
  assert.equal(await readFile(path.join(outside, "SKILL.md"), "utf8"), "untouched\n");
});

test("local skills exemption does not admit unknown or remote commands", async () => {
  const { checkAuthGate } = await import("../src/auth/gate.js");
  for (const args of [["skills", "install"], ["skills", "list"]]) {
    assert.equal((await checkAuthGate(args)).authenticated, true);
  }
  for (const args of [["skills", "publish"], ["skills"], ["audit"], ["session", "join", "room"]]) {
    assert.equal((await checkAuthGate(args)).authenticated, false);
  }
});

test("skills installation and listing remain direct CLI operations in the MCP bridge", async () => {
  const { buildCliCommandMcpTools } = await import("../src/mcp/cli-command-tools.js");
  const tools = await buildCliCommandMcpTools();
  for (const name of ["sl.skills.install", "sl.skills.list"]) {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool);
    assert.equal(tool.metadata.blocked, true);
    assert.equal(tool.metadata.blockedReason, "blocked_sensitive_cli_command");
  }
});
