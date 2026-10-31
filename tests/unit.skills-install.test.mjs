import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { checkAuthGate } from "../src/auth/gate.js";
import { registerSkillsCommand } from "../src/commands/skills.js";
import { buildCliCommandMcpTools } from "../src/mcp/cli-command-tools.js";
import {
  DEFAULT_SKILL_BUNDLE,
  SKILLS_ROOT,
  installSkills,
  listSkills,
  readSkillBundle,
  resolveInside,
  resolveSkillsDestination,
  safePathSegments,
  sha256Hex,
} from "../src/skills/install.js";
import { buildSkillsManifest, serializeSkillsManifest } from "../scripts/skills-manifest.mjs";

const CLI = fileURLToPath(new URL("../bin/sl.js", import.meta.url));
const MANIFEST_PATH = path.join(SKILLS_ROOT, `${DEFAULT_SKILL_BUNDLE}.manifest.json`);
const MANIFEST = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const SKILL_NAMES = MANIFEST.skills.map((skill) => skill.name);

function freshDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sl-skills-${prefix}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A private copy of the bundled skills that a test may corrupt.
function copyOfBundle(t) {
  const skillsRoot = freshDir(t, "bundle");
  fs.cpSync(SKILLS_ROOT, skillsRoot, { recursive: true });
  return skillsRoot;
}

function writeManifest(skillsRoot, manifest) {
  fs.writeFileSync(path.join(skillsRoot, `${DEFAULT_SKILL_BUNDLE}.manifest.json`), JSON.stringify(manifest, null, 2));
}

function tree(dir) {
  if (!fs.existsSync(dir)) return null;
  const out = {};
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) out[relative] = `link:${fs.readlinkSync(path.join(current, entry.name))}`;
      else if (entry.isDirectory()) walk(path.join(current, entry.name), relative);
      else out[relative] = sha256Hex(fs.readFileSync(path.join(current, entry.name)));
    }
  };
  walk(dir, "");
  return out;
}

function bundledTree() {
  const out = {};
  for (const file of MANIFEST.files) if (file.path.includes("/")) out[file.path] = file.sha256;
  return out;
}

async function rejectsWithCode(promise, code, pattern) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

async function runSkills(args) {
  const program = new Command();
  program.name("sl").exitOverride();
  registerSkillsCommand(program);
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...parts) => stdout.push(parts.join(" "));
  console.error = (...parts) => stderr.push(parts.join(" "));
  try {
    await program.parseAsync(["node", "sl", "skills", ...args]);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const exitCode = process.exitCode ?? 0;
  process.exitCode = previousExitCode;
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode };
}

test("the committed manifest matches the bundled files, and every skill has a SKILL.md", async () => {
  const generated = await buildSkillsManifest();
  assert.equal(serializeSkillsManifest(generated), fs.readFileSync(MANIFEST_PATH, "utf8"));
  assert.deepEqual(SKILL_NAMES, ["senti-agent-identity", "senti-room-notifications", "sentinelayer-cli"]);
  for (const name of SKILL_NAMES) assert.ok(MANIFEST.files.some((file) => file.path === `${name}/SKILL.md`), name);
  // nothing in the bundle asks for an executable bit
  assert.ok(MANIFEST.files.every((file) => file.executable === false));
});

test("install writes each skill into ~/.claude/skills by default, byte for byte", async (t) => {
  const homeDir = freshDir(t, "home");
  const result = await installSkills({ homeDir });
  const targetDir = path.join(homeDir, ".claude", "skills");
  assert.equal(result.target, "claude");
  assert.equal(result.targetDir, targetDir);
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.skills.map((skill) => [skill.name, skill.action, skill.path]),
    SKILL_NAMES.map((name) => [name, "installed", path.join(targetDir, name)]));
  assert.deepEqual(tree(targetDir), bundledTree());
  assert.match(result.next, /Restart Claude Code/);
  // the bundle README is verified but not installed: only skill folders land in the skills folder
  assert.deepEqual(fs.readdirSync(targetDir).sort(), SKILL_NAMES);
  if (process.platform !== "win32") {
    for (const file of Object.keys(bundledTree())) {
      assert.equal(fs.statSync(path.join(targetDir, file)).mode & 0o111, 0, `${file} must not be executable`);
    }
  }
});

test("--target codex installs into ~/.agents/skills; an unknown target or --target with --dir is refused", async (t) => {
  const homeDir = freshDir(t, "home");
  const result = await installSkills({ homeDir, target: "codex" });
  assert.equal(result.targetDir, path.join(homeDir, ".agents", "skills"));
  assert.deepEqual(tree(result.targetDir), bundledTree());
  assert.match(result.next, /Codex/);
  await rejectsWithCode(installSkills({ homeDir, target: "cursor" }), "target_invalid", /claude or codex/);
  await rejectsWithCode(installSkills({ homeDir, target: "codex", dir: homeDir }), "target_conflict");
});

test("--dir installs into an explicit folder, relative to cwd or under ~", async (t) => {
  const base = freshDir(t, "dir");
  const homeDir = freshDir(t, "home");
  const relative = await installSkills({ dir: "agent/skills", cwd: base, homeDir });
  assert.equal(relative.targetDir, path.join(base, "agent", "skills"));
  assert.equal(relative.target, "dir");
  assert.deepEqual(tree(relative.targetDir), bundledTree());
  const tilde = resolveSkillsDestination({ dir: "~/my-skills", homeDir, cwd: base });
  assert.equal(tilde.targetDir, path.join(homeDir, "my-skills"));
  assert.equal(fs.existsSync(path.join(homeDir, ".claude")), false, "--dir never touches the default target");
});

test("--dry-run lists what would be written and writes nothing", async (t) => {
  const homeDir = freshDir(t, "home");
  const result = await installSkills({ homeDir, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.skills.map((skill) => skill.action), SKILL_NAMES.map(() => "would-install"));
  assert.deepEqual(
    result.skills.flatMap((skill) => skill.files.map((file) => `${skill.name}/${file.path}`)).sort(),
    Object.keys(bundledTree()).sort(),
  );
  assert.equal(fs.existsSync(path.join(homeDir, ".claude")), false);
});

test("an existing, different skill folder is refused without --force, and nothing is written", async (t) => {
  const homeDir = freshDir(t, "home");
  const targetDir = path.join(homeDir, ".claude", "skills");
  const edited = path.join(targetDir, "sentinelayer-cli");
  fs.mkdirSync(edited, { recursive: true });
  fs.writeFileSync(path.join(edited, "SKILL.md"), "---\nname: sentinelayer-cli\ndescription: my own notes\n---\n");
  const before = tree(targetDir);

  await rejectsWithCode(installSkills({ homeDir }), "destination_exists", /--force/);
  await rejectsWithCode(installSkills({ homeDir, dryRun: true }), "destination_exists");
  assert.deepEqual(tree(targetDir), before, "the edited skill is untouched and no other skill was written");

  const json = await runSkills(["install", "--dir", targetDir, "--json"]);
  assert.equal(json.exitCode, 1);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "destination_exists");
  assert.deepEqual(payload.error.conflicts.map((conflict) => [conflict.name, conflict.state]), [["sentinelayer-cli", "skill"]]);
  assert.deepEqual(tree(targetDir), before);
});

test("--force replaces an existing skill folder (stale files go) and leaves identical copies alone", async (t) => {
  const homeDir = freshDir(t, "home");
  const targetDir = path.join(homeDir, ".claude", "skills");
  await installSkills({ homeDir });
  const skillDir = path.join(targetDir, "senti-room-notifications");
  fs.appendFileSync(path.join(skillDir, "SKILL.md"), "\nlocal edit\n");
  fs.writeFileSync(path.join(skillDir, "stale-notes.md"), "from an older version\n");

  const result = await installSkills({ homeDir, force: true });
  assert.deepEqual(
    result.skills.map((skill) => [skill.name, skill.action]),
    [["senti-agent-identity", "unchanged"], ["senti-room-notifications", "replaced"], ["sentinelayer-cli", "unchanged"]],
  );
  assert.deepEqual(tree(targetDir), bundledTree(), "replaced byte for byte, the stale file is gone");
  assert.deepEqual(fs.readdirSync(targetDir).sort(), SKILL_NAMES, "no staging or backup folder is left behind");

  const again = await installSkills({ homeDir });
  assert.deepEqual(again.skills.map((skill) => skill.action), SKILL_NAMES.map(() => "unchanged"));
});

test("--force never replaces a folder that is not a skill, a file, or a link", async (t) => {
  const homeDir = freshDir(t, "home");
  const targetDir = path.join(homeDir, ".claude", "skills");
  fs.mkdirSync(path.join(targetDir, "senti-agent-identity", "src"), { recursive: true });
  fs.writeFileSync(path.join(targetDir, "senti-agent-identity", "src", "work.js"), "keep me\n");
  fs.writeFileSync(path.join(targetDir, "sentinelayer-cli"), "a file, not a folder\n");
  const elsewhere = freshDir(t, "elsewhere");
  fs.writeFileSync(path.join(elsewhere, "SKILL.md"), "---\nname: x\ndescription: y\n---\n");
  let linked = true;
  try {
    fs.symlinkSync(elsewhere, path.join(targetDir, "senti-room-notifications"), "junction");
  } catch {
    linked = false;
  }
  const before = tree(targetDir);
  const elsewhereBefore = tree(elsewhere);

  await assert.rejects(installSkills({ homeDir, force: true }), (error) => {
    assert.equal(error.code, "destination_exists");
    const states = Object.fromEntries(error.details.conflicts.map((conflict) => [conflict.name, conflict.state]));
    assert.equal(states["senti-agent-identity"], "folder");
    assert.equal(states["sentinelayer-cli"], "file");
    if (linked) assert.equal(states["senti-room-notifications"], "link");
    return true;
  });
  assert.deepEqual(tree(targetDir), before);
  assert.deepEqual(tree(elsewhere), elsewhereBefore, "a linked folder's target is never touched");
});

test("a corrupted bundled file fails loudly before anything is written", async (t) => {
  const homeDir = freshDir(t, "home");
  const targetDir = path.join(homeDir, ".claude", "skills");

  // Same length, one byte changed: only the sha256 can catch it. It is the last file installed,
  // so a writer that went file by file would already have written the others.
  const flipped = copyOfBundle(t);
  const victim = path.join(flipped, DEFAULT_SKILL_BUNDLE, "sentinelayer-cli", "SKILL.md");
  const bytes = fs.readFileSync(victim);
  bytes[bytes.length - 2] = bytes[bytes.length - 2] === 0x2e ? 0x21 : 0x2e;
  fs.writeFileSync(victim, bytes);
  await rejectsWithCode(
    installSkills({ homeDir, skillsRoot: flipped }),
    "bundle_corrupt",
    /sentinelayer-cli\/SKILL\.md does not match the package manifest[\s\S]*nothing was written/,
  );
  assert.equal(fs.existsSync(targetDir), false);
  await rejectsWithCode(installSkills({ homeDir, skillsRoot: flipped, dryRun: true }), "bundle_corrupt");
  await rejectsWithCode(listSkills({ homeDir, skillsRoot: flipped }), "bundle_corrupt");

  const truncated = copyOfBundle(t);
  fs.writeFileSync(path.join(truncated, DEFAULT_SKILL_BUNDLE, "senti-agent-identity", "SKILL.md"), "---\n");
  await rejectsWithCode(installSkills({ homeDir, skillsRoot: truncated }), "bundle_corrupt", /senti-agent-identity\/SKILL\.md/);

  const missing = copyOfBundle(t);
  fs.rmSync(path.join(missing, DEFAULT_SKILL_BUNDLE, "senti-room-notifications", "listen-wrapper.cjs"));
  await rejectsWithCode(installSkills({ homeDir, skillsRoot: missing }), "bundle_corrupt", /listen-wrapper\.cjs is missing/);

  const unlisted = copyOfBundle(t);
  fs.writeFileSync(path.join(unlisted, DEFAULT_SKILL_BUNDLE, "senti-agent-identity", "extra.md"), "not in the manifest\n");
  await rejectsWithCode(installSkills({ homeDir, skillsRoot: unlisted }), "bundle_corrupt", /senti-agent-identity\/extra\.md/);

  const noManifest = copyOfBundle(t);
  fs.rmSync(path.join(noManifest, `${DEFAULT_SKILL_BUNDLE}.manifest.json`));
  await rejectsWithCode(installSkills({ homeDir, skillsRoot: noManifest }), "manifest_invalid", /missing/);

  assert.equal(fs.existsSync(targetDir), false, "no failure above wrote anything");

  const json = await runSkills(["install", "--dir", targetDir, "--json"]);
  assert.equal(json.exitCode, 0, "the real bundle still installs");
});

test("a manifest path that escapes the skills folder is refused before anything is read or written", async (t) => {
  const homeDir = freshDir(t, "home");
  const targetDir = path.join(homeDir, ".claude", "skills");
  const escapes = [
    "senti-agent-identity/../../escape.md",
    "../escape.md",
    "senti-agent-identity/..",
    "/tmp/escape.md",
    "C:/escape.md",
    "senti-agent-identity\\..\\..\\escape.md",
    "senti-agent-identity/.hidden",
    "senti-agent-identity//SKILL.md",
    "senti-agent-identity/SKILL.md.",
  ];
  for (const bad of escapes) {
    const skillsRoot = copyOfBundle(t);
    const manifest = structuredClone(MANIFEST);
    manifest.files.push({ path: bad, sha256: "0".repeat(64), bytes: 0, executable: false });
    writeManifest(skillsRoot, manifest);
    await rejectsWithCode(installSkills({ homeDir, skillsRoot }), "unsafe_path", undefined);
    assert.equal(fs.existsSync(targetDir), false, bad);
    assert.equal(fs.existsSync(path.join(homeDir, ".claude", "escape.md")), false, bad);
    assert.equal(fs.existsSync(path.join(homeDir, "escape.md")), false, bad);
  }

  const badName = copyOfBundle(t);
  const renamed = structuredClone(MANIFEST);
  renamed.skills[0].name = "../escape";
  writeManifest(badName, renamed);
  await rejectsWithCode(installSkills({ homeDir, skillsRoot: badName }), "manifest_invalid", /invalid skill name/);
  assert.equal(fs.existsSync(targetDir), false);
});

test("the path guards refuse every escape on their own", () => {
  for (const bad of ["", "..", "../x", "a/../../x", "/abs", "C:/x", "C:x", "a\\b", "a//b", ".git/config", "a/./b", "x.", `a\u0000b`]) {
    assert.throws(() => safePathSegments(bad), (error) => error.code === "unsafe_path", JSON.stringify(bad));
  }
  assert.deepEqual(safePathSegments("senti-room-notifications/listen-wrapper.cjs"), ["senti-room-notifications", "listen-wrapper.cjs"]);

  const root = path.join(os.tmpdir(), "sl-skills-root");
  for (const segments of [[".."], ["..", "x"], ["a", "..", "..", "x"], [path.resolve(os.tmpdir(), "elsewhere")], ["."]]) {
    assert.throws(() => resolveInside(root, segments), (error) => error.code === "unsafe_path", segments.join("/"));
  }
  assert.equal(resolveInside(root, ["a", "b.md"]), path.join(root, "a", "b.md"));
});

test("readSkillBundle verifies the shipped bundle and groups files by skill", async () => {
  const bundle = await readSkillBundle();
  assert.deepEqual(bundle.skills.map((skill) => skill.name), SKILL_NAMES);
  const notifications = bundle.skills.find((skill) => skill.name === "senti-room-notifications");
  assert.deepEqual(notifications.files.map((file) => file.path), ["SKILL.md", "listen-wrapper.cjs"]);
  for (const skill of bundle.skills) assert.ok(skill.description.length > 40, skill.name);
});

test("list reports each skill's state at the destination", async (t) => {
  const homeDir = freshDir(t, "home");
  let listed = await listSkills({ homeDir });
  assert.deepEqual(listed.skills.map((skill) => skill.status), SKILL_NAMES.map(() => "not-installed"));
  await installSkills({ homeDir });
  fs.appendFileSync(path.join(homeDir, ".claude", "skills", "sentinelayer-cli", "SKILL.md"), "edit\n");
  listed = await listSkills({ homeDir });
  assert.deepEqual(listed.skills.map((skill) => [skill.name, skill.status]),
    [["senti-agent-identity", "installed"], ["senti-room-notifications", "installed"], ["sentinelayer-cli", "changed"]]);
});

test("skills install --json prints one parseable result: where each skill went and how to use it", async (t) => {
  const dir = freshDir(t, "json");
  const { stdout, stderr, exitCode } = await runSkills(["install", "--dir", dir, "--json"]);
  assert.equal(exitCode, 0, stderr);
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, "skills install");
  assert.equal(payload.target, "dir");
  assert.equal(payload.targetDir, dir);
  assert.equal(payload.verified, true);
  assert.deepEqual(payload.skills.map((skill) => [skill.name, skill.action, skill.path]),
    SKILL_NAMES.map((name) => [name, "installed", path.join(dir, name)]));
  for (const skill of payload.skills) {
    for (const file of skill.files) {
      assert.equal(sha256Hex(fs.readFileSync(path.join(skill.path, file.path))), file.sha256);
    }
  }
  assert.match(payload.next, /join a Senti room/);

  const text = await runSkills(["install", "--dir", dir]);
  assert.equal(text.exitCode, 0);
  assert.match(text.stdout, /already installed/);

  const listing = JSON.parse((await runSkills(["list", "--dir", dir, "--json"])).stdout);
  assert.deepEqual(listing.skills.map((skill) => skill.status), SKILL_NAMES.map(() => "installed"));
});

test("only skills install and skills list skip the login gate", async () => {
  for (const args of [["skills", "install"], ["skills", "install", "--dry-run"], ["skills", "list", "--json"]]) {
    const result = await checkAuthGate(args);
    assert.equal(result.authenticated, true, args.join(" "));
    assert.equal(result.bypassReason, "skills_no_auth_required");
  }
  for (const args of [["skills"], ["skills", "publish"], ["skillsx", "install"]]) {
    const result = await checkAuthGate(args);
    assert.notEqual(result.bypassReason, "skills_no_auth_required", args.join(" "));
  }
});

test("the MCP CLI bridge never exposes the skills commands", async () => {
  const tools = await buildCliCommandMcpTools();
  for (const name of ["sl.skills.install", "sl.skills.list"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name}: the generated tool exists`);
    assert.equal(tool.metadata.blocked, true, name);
    assert.equal(tool.metadata.blockedReason, "blocked_sensitive_cli_command", name);
  }
});

test("the real CLI installs the skills without a login", (t) => {
  const dir = freshDir(t, "bin");
  const env = { ...process.env, SENTINELAYER_SKIP_SENTI_AUTOSTART: "1" };
  delete env.SENTINELAYER_TOKEN;
  delete env.SENTINELAYER_API_TOKEN;
  delete env.SENTINELAYER_CLI_SKIP_AUTH;
  const run = (args) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: "utf8", timeout: 60_000, windowsHide: true });

  const installed = run(["skills", "install", "--dir", path.join(dir, "skills"), "--json"]);
  assert.equal(installed.status, 0, installed.stderr);
  const payload = JSON.parse(installed.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(tree(path.join(dir, "skills")), bundledTree());

  // control: the same login-free process still refuses a command the gate does not exempt
  const gated = run(["skills", "publish"]);
  assert.notEqual(gated.status, 0);
  assert.match(gated.stderr, /Authentication required/);
});
