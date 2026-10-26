import "./setup-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = process.env.RELEASE_TARGET_SOURCE || fileURLToPath(new URL("../scripts/release-publish.mjs", import.meta.url));
const harness = fileURLToPath(new URL("./helpers/release-publish-offline.mjs", import.meta.url));

async function runFixture(mode) {
  const owned = await mkdtemp(path.join(os.tmpdir(), "sl-release-target-"));
  const root = path.join(owned, "repo");
  const env = Object.fromEntries(["PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "WINDIR", "ComSpec", "ProgramData", "USERNAME", "USERDOMAIN"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: owned, USERPROFILE: owned, APPDATA: path.join(owned, "appdata"), LOCALAPPDATA: path.join(owned, "localappdata"), TEMP: owned, TMP: owned, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(owned, "empty-gitconfig"), GIT_TERMINAL_PROMPT: "0", SSH_AUTH_SOCK: "" });
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", timeout:15000 });
    assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.stdout || result.error?.code || "no diagnostic"}`);
    return result.stdout.trim();
  };
  try {
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await mkdir(path.join(root, ".github/policies"), { recursive: true });
    await writeFile(path.join(owned, "empty-gitconfig"), "");
    await copyFile(source, path.join(root, "scripts/release-publish.mjs"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name:"fixture",version:"1.0.0",type:"module" }));
    await writeFile(path.join(root, ".github/policies/release-tag-policy.json"), JSON.stringify({ allowed_tag_actors:["fixture-actor"],allowed_tag_signer_emails:["fixture@example.invalid"],required_release_workflow_path:".github/workflows/release-please.yml",required_release_workflow_name:"Release Please",required_release_workflow_actors:["fixture-actor"] }));
    const key = path.join(owned, "fixture-key");
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    const publicKey = (await readFile(`${key}.pub`, "utf8")).trim();
    const signers = path.join(owned, "allowed-signers");
    await writeFile(signers, `fixture@example.invalid ${publicKey}\n`);
    run("git", ["init", "-q"]);
    for (const [name,value] of [["user.name","Fixture"],["user.email","fixture@example.invalid"],["gpg.format","ssh"],["user.signingkey",key],["gpg.ssh.allowedSignersFile",signers]]) run("git", ["config",name,value]);
    run("git", ["add", "."]);run("git", ["commit", "-qm", "initial"]);
    const previous = run("git", ["rev-parse", "HEAD"]);
    run("git", ["commit", "--allow-empty", "-qm", "expected"]);
    const expected = run("git", ["rev-parse", "HEAD"]);
    run("git", ["update-ref", "refs/remotes/origin/main", expected]);
    if (["wrong-existing", "right-existing"].includes(mode)) run("git", ["tag", "-s", "v1.0.0", mode === "wrong-existing" ? previous : expected, "-m", "owned fixture"]);
    if (mode === "unsigned-existing") run("git", ["tag", "-a", "v1.0.0", expected, "-m", "owned unsigned fixture"]);
    if (mode === "lightweight-existing") run("git", ["tag", "v1.0.0", expected]);
    if (mode === "nested-signed-tag") {
      run("git", ["tag", "-s", "inner", expected, "-m", "owned inner"]);
      run("git", ["tag", "-s", "v1.0.0", "refs/tags/inner", "-m", "owned outer"]);
    }
    if (mode === "replacement-object") {
      run("git", ["tag", "-s", "v1.0.0", previous, "-m", "owned original"]);
      run("git", ["tag", "-s", "replacement", expected, "-m", "owned replacement"]);
      run("git", ["replace", run("git", ["rev-parse", "refs/tags/v1.0.0"]), run("git", ["rev-parse", "refs/tags/replacement"])]);
    }
    const receipt = path.join(owned, "receipt.json");
    run(process.execPath, [harness, root, mode, expected, previous, publicKey, receipt]);
    return { ...JSON.parse(await readFile(receipt, "utf8")), expected, previous };
  } finally { await rm(owned, { recursive: true, force: true }); }
}

test("release helper refuses a valid signed local tag at the wrong commit before push", async () => {
  const result = await runFixture("wrong-existing");
  assert.equal(result.pushed, false);
  assert.match(result.error, /not expected release commit/);
  assert.equal(result.target, result.previous);
  assert.equal(result.calls.some(c => c.command === "gh" && c.args[0] === "release"), false);
});

test("release helper accepts the existing signed tag at the captured expected commit", async () => {
  const result = await runFixture("right-existing");
  assert.equal(result.error, null);assert.equal(result.pushed, true);assert.equal(result.target, result.expected);
});

test("release helper pins a new signed tag despite HEAD moving after release approval", async () => {
  const result = await runFixture("moving-head");
  assert.equal(result.error, null);assert.equal(result.pushed, true);assert.equal(result.target, result.expected);
});

test("release helper refuses malformed captured target before creating a tag or pushing", async () => {
  const result = await runFixture("malformed-expected");
  assert.equal(result.pushed, false);assert.ok(result.error);assert.equal(result.target, "");
});

test("release helper refuses a full-length non-commit target (a tree) before creating any tag", async () => {
  const result = await runFixture("tree-expected");
  assert.equal(result.pushed, false);
  assert.ok(result.error, "a tree OID must be refused");
  assert.equal(result.calls.some(c => c.command === "git" && c.args.includes("tag") && c.args.includes("-s")), false, "no tag may be created");
  assert.equal(result.calls.some(c => c.command === "gh" && c.args[0] === "release"), false);
});

test("release helper still refuses missing captured target, unsigned tags and lightweight tags before push", async () => {
  for (const mode of ["missing-expected", "unsigned-existing", "lightweight-existing"]) {
    const result = await runFixture(mode);
    assert.equal(result.pushed, false);assert.ok(result.error);
    assert.equal(result.calls.some(c => c.command === "gh" && c.args[0] === "release"), false);
  }
});

test("release helper refuses a signed nested tag before push using direct object semantics", async () => {
  const result = await runFixture("nested-signed-tag");
  assert.equal(result.pushed, false);assert.match(result.error, /directly target a commit/);
});

test("release helper pushes the verified immutable tag object when its local ref moves", async () => {
  const result = await runFixture("move-tag-after-check");
  assert.equal(result.error, null);assert.equal(result.pushedTarget, result.expected);assert.equal(result.target, result.previous);
  assert.ok(result.calls.some(c => c.command === "git" && c.args[0] === "--no-replace-objects" && c.args[1] === "verify-tag" && c.args[2] === result.pushedObject));
});

test("release helper refuses a wrong raw tag hidden by a valid signed replacement object", async () => {
  const result = await runFixture("replacement-object");
  assert.equal(result.pushed, false);assert.match(result.error, /not expected release commit/);
});
