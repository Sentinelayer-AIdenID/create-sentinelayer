import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const names = ["senti-agent-identity", "senti-room-notifications", "sentinelayer-cli", "senti-judge", "omar-gate-setup"];
const expectedFiles = [
  "senti-agent-identity/SKILL.md", "sentinelayer-cli/SKILL.md",
  "senti-room-notifications/SKILL.md", "senti-room-notifications/listen-wrapper.cjs",
  "senti-room-notifications/test-classifier.js", "senti-room-notifications/test-receipt.js",
  "senti-room-notifications/package.json",
  "senti-judge/SKILL.md", "omar-gate-setup/SKILL.md",
];

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sl-skills-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, directory: path.join(home, ".claude", "skills") };
}

function cli(home, args, status = 0, entry = path.join(root, "bin", "sl.js")) {
  // setup-env has isolated all other state overrides and enabled the inherited egress guard.
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.SENTINELAYER_CLI_SKIP_AUTH;
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: home, env, encoding: "utf8", timeout: 20000,
  });
  assert.equal(result.status, status, result.error?.message || result.stderr || result.stdout);
  return args.includes("--json") ? JSON.parse(result.stdout) : result.stdout;
}

async function missing(file) {
  await assert.rejects(fs.access(file), { code: "ENOENT" });
}

test("skills: fresh HOME install is offline, complete and a repeat preserves files", async (t) => {
  const { home, directory } = await fixture(t);
  const help = cli(home, ["--help"]);
  assert.match(help, /sl skills install/);
  assert.match(help, /sl skills list/);
  const before = cli(home, ["skills", "list", "--json"]);
  assert.equal(before.directory, directory);
  assert.deepEqual(before.skills.map((s) => s.name), names);
  assert.ok(before.skills.every((s) => s.status === "not-installed" && s.installed === null));
  await missing(directory);
  const first = cli(home, ["skills", "install", "--json"]);
  assert.equal(first.skills.reduce((n, s) => n + s.written, 0), expectedFiles.length);
  const modifiedTimes = [];
  for (const file of expectedFiles) {
    assert.deepEqual(await fs.readFile(path.join(directory, file)), await fs.readFile(path.join(root, "skills", file)));
    modifiedTimes.push((await fs.stat(path.join(directory, file))).mtimeMs);
  }
  for (const extra of [[], ["--force"]]) {
    const again = cli(home, ["skills", "install", ...extra, "--json"]);
    assert.ok(again.skills.every((s) => s.written === 0));
    assert.equal(again.skills.reduce((n, s) => n + s.unchanged, 0), expectedFiles.length);
    assert.deepEqual(await Promise.all(expectedFiles.map(async (f) => (await fs.stat(path.join(directory, f))).mtimeMs)), modifiedTimes);
  }
  const after = cli(home, ["skills", "list", "--json"]);
  for (const skill of after.skills) {
    assert.equal(skill.status, "installed");
    assert.equal(skill.bundled.version, "1.0.0");
    assert.match(skill.bundled.hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(skill.installed, skill.bundled);
  }
  assert.ok(cli(home, ["skills", "install"]).includes(directory));
  const text = cli(home, ["skills", "list"]);
  assert.ok(text.includes(directory));
  assert.ok(text.includes(after.skills[0].bundled.hash));
});

test("skills: custom directory, full preflight, local edits and forced replacement", async (t) => {
  const { home, directory: defaultDirectory } = await fixture(t);
  const directory = path.join(home, "custom skills");
  const changed = path.join(directory, "sentinelayer-cli", "SKILL.md");
  await fs.mkdir(path.dirname(changed), { recursive: true });
  await fs.writeFile(changed, "my local edits\n");
  let result = cli(home, ["skills", "install", "--dir", directory, "--json"], 1);
  assert.equal(result.error.code, "SKILLS_CONFLICT");
  assert.deepEqual(result.error.files, [changed]);
  assert.equal(await fs.readFile(changed, "utf8"), "my local edits\n");
  await missing(path.join(directory, names[0]));
  await missing(defaultDirectory);
  cli(home, ["skills", "install", "--dir", directory, "--force", "--json"]);
  const helper = path.join(directory, "senti-room-notifications", "listen-wrapper.cjs");
  await fs.appendFile(helper, "\n// local customization\n");
  const listing = cli(home, ["skills", "list", "--dir", directory, "--json"]);
  assert.equal(listing.skills[1].status, "modified");
  assert.notEqual(listing.skills[1].installed.hash, listing.skills[1].bundled.hash);
  result = cli(home, ["skills", "install", "--dir", directory, "--json"], 1);
  assert.deepEqual(result.error.files, [helper]);
  const extra = path.join(directory, names[0], "notes.txt");
  await fs.writeFile(extra, "keep me");
  cli(home, ["skills", "install", "--dir", directory, "--force", "--json"]);
  assert.deepEqual(await fs.readFile(helper), await fs.readFile(path.join(root, "skills", "senti-room-notifications", "listen-wrapper.cjs")));
  assert.equal(await fs.readFile(extra, "utf8"), "keep me");
  await missing(defaultDirectory);
});

test("skills: symlink destinations and file/directory collisions refuse even with force", async (t) => {
  const { home, directory } = await fixture(t);
  const external = path.join(home, "external.md");
  await fs.writeFile(external, "keep external");
  const skill = path.join(directory, names[0]);
  await fs.mkdir(skill, { recursive: true });
  const destination = path.join(skill, "SKILL.md");
  await fs.symlink(external, destination);
  for (const extra of [[], ["--force"]]) {
    assert.equal(cli(home, ["skills", "install", ...extra, "--json"], 1).error.code, "SKILLS_UNSAFE_PATH");
    assert.equal(await fs.readFile(external, "utf8"), "keep external");
    assert.equal(cli(home, ["skills", "list", "--json"]).skills[0].status, "invalid");
  }
  await fs.unlink(destination);
  await fs.link(external, destination);
  cli(home, ["skills", "install", "--force", "--json"]);
  assert.equal(await fs.readFile(external, "utf8"), "keep external");
  await fs.unlink(destination);
  await fs.mkdir(destination);
  assert.equal(cli(home, ["skills", "install", "--force", "--json"], 1).error.code, "SKILLS_UNSAFE_PATH");
  await fs.rm(skill, { recursive: true });
  const outside = path.join(home, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, skill, process.platform === "win32" ? "junction" : "dir");
  assert.equal(cli(home, ["skills", "install", "--force", "--json"], 1).error.code, "SKILLS_UNSAFE_PATH");
  assert.deepEqual(await fs.readdir(outside), []);
});

test("skills: missing files, local versions and malformed metadata remain observable", async (t) => {
  const { home, directory } = await fixture(t);
  cli(home, ["skills", "install", "--json"]);
  const file = path.join(directory, names[0], "SKILL.md");
  await fs.writeFile(file, '---\nmetadata:\n  version: "0.1.0"\n---\nLocal skill\n');
  let listing = cli(home, ["skills", "list", "--json"]);
  assert.equal(listing.skills[0].installed.version, "0.1.0");
  assert.equal(listing.skills[0].status, "modified");
  await fs.writeFile(file, "---\nmetadata: [broken\n---\n");
  listing = cli(home, ["skills", "list", "--json"]);
  assert.equal(listing.skills[0].installed.version, null);
  assert.equal(listing.skills[0].status, "modified");
  await fs.unlink(file);
  listing = cli(home, ["skills", "list", "--json"]);
  assert.equal(listing.skills[0].status, "modified");
  cli(home, ["skills", "install", "--json"]);
  assert.equal(cli(home, ["skills", "list", "--json"]).skills[0].status, "installed");
});

test("skills: forced replacement retries transient filesystem contention", async (t) => {
  const { directory } = await fixture(t);
  const { installSkills } = await import("../src/skills/service.js");
  await installSkills({ dir: directory });
  const file = path.join(directory, names[0], "SKILL.md");
  await fs.writeFile(file, "local edits");
  const rename = fs.rename;
  let attempts = 0;
  fs.rename = async (...args) => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("temporarily busy"), { code: "EBUSY" });
    return rename(...args);
  };
  try {
    await installSkills({ dir: directory, force: true });
  } finally {
    fs.rename = rename;
  }
  assert.equal(attempts, 2);
  assert.deepEqual(await fs.readFile(file), await fs.readFile(path.join(root, "skills", names[0], "SKILL.md")));
  assert.deepEqual(await fs.readdir(path.dirname(file)), ["SKILL.md"]);
});

test("skills: named install touches only the named skills, so one local edit does not block another", async (t) => {
  const { home, directory } = await fixture(t);
  const edited = path.join(directory, "sentinelayer-cli", "SKILL.md");
  await fs.mkdir(path.dirname(edited), { recursive: true });
  await fs.writeFile(edited, "my local edits\n");
  assert.equal(cli(home, ["skills", "install", "--json"], 1).error.code, "SKILLS_CONFLICT");
  const named = cli(home, ["skills", "install", "omar-gate-setup", "senti-judge", "--json"]);
  assert.deepEqual(named.skills.map((s) => s.name), ["senti-judge", "omar-gate-setup"]);
  for (const name of ["senti-judge", "omar-gate-setup"]) {
    assert.deepEqual(await fs.readFile(path.join(directory, name, "SKILL.md")), await fs.readFile(path.join(root, "skills", name, "SKILL.md")));
  }
  assert.equal(await fs.readFile(edited, "utf8"), "my local edits\n");
  await missing(path.join(directory, "senti-agent-identity"));
  const unknown = cli(home, ["skills", "install", "senti-judge", "no-such-skill", "--json"], 1);
  assert.equal(unknown.error.code, "SKILLS_UNKNOWN");
  assert.match(unknown.error.message, /no-such-skill/);
  await missing(path.join(directory, "senti-agent-identity"));
});

test("skills: empty destination refuses and unrecognized operations remain gated", async (t) => {
  const { home } = await fixture(t);
  assert.match(cli(home, ["skills", "install", "--dir", "", "--json"], 1).error.message, /nonempty path/);
  for (const args of [["skills", "publish"], ["session", "say", "example-room", "example message"]]) {
    const result = spawnSync(process.execPath, [path.join(root, "bin", "sl.js"), ...args], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8", timeout: 20000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /Authentication required/);
  }
});

test("skills: every shipped document and helper passes the public-content check", async () => {
  const forbidden = [
    /\bFunction\s*\(/,
    /\beval\s*\(/,
    /\bvm\.run/,
    /\brequire\s*\(\s*(["'])(?:node:)?vm\1\s*\)/,
    /\bvm\s*\.\s*Script\b/,
    /child_process/,
    /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i,
    /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/,
    /\b(?:f[cd][0-9a-f]{2}|fe80):[0-9a-f:]+/i,
    /\b[\w.-]+\.(?:internal|local|lan)\b/i,
    /\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?|AKIA)[A-Za-z0-9_-]{16,}/,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
    /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
    /[?&](?:sig|token|key)=[^\s&)]+/i,
    /\b[A-Z]:[/\\]/,
    /\b(?:gpt|claude)-(?!web\b)[a-z][\w-]+/i,
  ];
  // Construct synthetic examples in memory so credential-shaped literals never enter the package.
  for (const example of [
    [8, 4, 4, 4, 12].map((n) => "a".repeat(n)).join("-"),
    [192, 168, 4, 8].join("."), ["build", "internal"].join("."),
    ["fd00", "", "1"].join(":"), "gh" + "p_" + "x".repeat(24),
    'Function("return 1")', 'new Function("return 1")', 'Function \n ("return 1")',
    'require("vm")', "require('vm')", 'require ( "node:vm" )', "require( 'node:vm' )",
    'vm.Script("1")', 'new vm.Script("1")', 'new vm . Script("1")',
    'eval("1")', 'vm.runInNewContext("1")', 'require("node:child_process")',
  ]) assert.ok(forbidden.some((pattern) => pattern.test(example)), "Public-content detector must reject its controls");
  for (const example of [
    "function format() {}", "formatFunction()", 'require("node:fs")', 'require("vm-tools")', "vm.ScriptRunner()",
  ]) assert.ok(!forbidden.some((pattern) => pattern.test(example)), "Public-content detector must allow harmless controls");
  const allFiles = await fs.readdir(path.join(root, "skills"), { recursive: true, withFileTypes: true });
  const files = allFiles.filter((entry) => entry.isFile());
  assert.ok(files.length >= expectedFiles.length);
  for (const entry of files) {
    const content = await fs.readFile(path.join(entry.parentPath, entry.name), "utf8");
    for (const pattern of forbidden) assert.doesNotMatch(content, pattern, entry.name);
    for (const match of content.matchAll(/https?:\/\/[^\s)`]+/g)) {
      assert.ok(["sentinelayer.com", "api.sentinelayer.com", "example.com"].includes(new URL(match[0]).hostname), "Only public documentation/example hosts belong in bundled skills");
    }
  }
  for (const name of names) {
    const content = await fs.readFile(path.join(root, "skills", name, "SKILL.md"), "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(content);
    assert.ok(frontmatter);
    const metadata = parse(frontmatter[1]);
    assert.equal(metadata.name, name);
    assert.equal(metadata.metadata.version, "1.0.0");
    assert.equal(typeof metadata.description, "string");
    for (const ref of content.matchAll(/\]\(([^):]+)\)/g)) {
      await fs.access(path.join(root, "skills", name, ref[1]));
    }
  }
});

test("skills: bundled classifier and receipt checks execute the shipped wrapper", () => {
  for (const name of ["test-classifier.js", "test-receipt.js"]) {
    const result = spawnSync(process.execPath, [path.join(root, "skills", "senti-room-notifications", name)], {
      cwd: os.tmpdir(), encoding: "utf8", timeout: 20000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /ALL PASS/);
  }
});

test("skills: importing the wrapper needs no configuration and starts no listener", async (t) => {
  const { home } = await fixture(t);
  const wrapper = path.join(root, "skills", "senti-room-notifications", "listen-wrapper.cjs");
  for (const configured of [false, true]) {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    for (const key of ["SENTI_AGENT_ID", "SENTI_SESSION_ID", "SENTI_CLI_PATH"]) delete env[key];
    if (configured) Object.assign(env, {
      SENTI_AGENT_ID: "agent-listener", SENTI_SESSION_ID: "example-room", SENTI_CLI_PATH: "missing-cli.js",
    });
    const result = spawnSync(process.execPath, ["-e", 'const api = require(process.argv[1]); require("node:assert/strict").equal(typeof api.createClassifier, "function"); console.log("imported");', wrapper], {
      cwd: home, env, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.equal(result.stdout, "imported\n");
    assert.equal(result.stderr, "");
    await missing(path.join(home, ".sentinelayer"));
  }
});

test("skills: self-tests reject missing factory and classifier exports", async (t) => {
  const { home } = await fixture(t);
  const wrapper = path.join(home, "incomplete-wrapper.cjs");
  const required = {
    "test-classifier.js": ["deliver", "addressedToMe", "isHuman", "mentionCount", "rememberMine", "flushBroadcasts", "bufLen"],
    "test-receipt.js": ["tsMs", "newerThanDelivered", "receipt", "observe", "writeState", "state"],
  };
  for (const [script, names] of Object.entries(required)) {
    for (const omitted of ["createClassifier", ...names]) {
      const methods = names.filter((name) => name !== omitted).map((name) => `${name}: () => {}`).join(",");
      await fs.writeFile(wrapper, omitted === "createClassifier" ? "module.exports = {};" : `module.exports = { createClassifier: () => ({${methods}}) };`);
      const result = spawnSync(process.execPath, [path.join(root, "skills", "senti-room-notifications", script), path.relative(home, wrapper)], {
        cwd: home, encoding: "utf8", timeout: 5000,
      });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(result.stderr.includes(`missing ${omitted} -- test would be vacuous`), result.stderr);
      assert.doesNotMatch(result.stdout, /ALL PASS/);
    }
  }
});

test("skills: direct wrapper preserves stream, poll, recovery, restart and shutdown behavior", async (t) => {
  const { home } = await fixture(t);
  const cliPath = path.join(root, "bin", "sentinelayer-cli.js");
  const alias = path.join(home, "cli-alias.js");
  await fs.symlink(cliPath, alias);
  const result = spawnSync(process.execPath, [
    "--require", path.join(root, "tests", "fixtures", "skills-listener-preload.cjs"),
    path.join(root, "skills", "senti-room-notifications", "listen-wrapper.cjs"),
  ], {
    cwd: home, encoding: "utf8", timeout: 5000,
    env: { ...process.env, HOME: home, USERPROFILE: home, SENTI_AGENT_ID: "agent-listener", SENTI_SESSION_ID: "example-room", SENTI_CLI_PATH: alias },
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /\[listener-started\]/);
  assert.match(result.stdout, /reply without mention/);
  assert.match(result.stdout, /recovered poll message/);
  assert.match(result.stdout, /\[room-digest\] 1 broadcast\(s\)/);
  assert.match(result.stdout, /CLIPPED/);
  assert.match(result.stdout, /PROBE PASS/);
  assert.equal(result.stdout.match(/reply without mention/g)?.length, 1);
  assert.doesNotMatch(result.stdout, /own post|old history/);
});

test("skills: direct wrapper refuses relative CLI paths before creating listener state", async (t) => {
  const { home } = await fixture(t);
  const wrapper = path.join(root, "skills", "senti-room-notifications", "listen-wrapper.cjs");
  for (const cliPath of ["sentinelayer-cli.js", "./sentinelayer-cli.js", "../sentinelayer-cli.js"]) {
    const result = spawnSync(process.execPath, [wrapper], {
      cwd: home, encoding: "utf8", timeout: 5000,
      env: { ...process.env, HOME: home, USERPROFILE: home, SENTI_AGENT_ID: "agent-listener", SENTI_SESSION_ID: "example-room", SENTI_CLI_PATH: cliPath },
    });
    assert.equal(result.status, 1, result.error?.message || result.stderr || result.stdout);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "SENTI_CLI_PATH must be an absolute path to sentinelayer-cli/bin/sentinelayer-cli.js.\n");
    await missing(path.join(home, ".sentinelayer"));
  }
});

test("skills: npm pack includes every skill and referenced helper", () => {
  // npm.cmd needs a shell on Windows; all arguments here are fixed literals, not caller input.
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root, encoding: "utf8", timeout: 30000, shell: process.platform === "win32",
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const files = JSON.parse(result.stdout)[0].files.map((file) => file.path);
  assert.ok(files.includes("src/skills/listener-runtime.cjs"), "Package missing listener runtime");
  for (const file of expectedFiles) assert.ok(files.includes(`skills/${file}`), `Package missing ${file}`);
});
