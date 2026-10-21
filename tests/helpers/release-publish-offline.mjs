// Child harness: real owned Git/SSH operations, with every gh/fetch/push replaced.
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const [root, mode, expected, previous, publicKey, receipt] = process.argv.slice(2);
const nativeSpawn = cp.spawnSync;
const calls = [];
let pushed = false;
const result = (stdout = "", status = 0) => ({ status, stdout, stderr: "" });
const git = (args) => {
  const value = nativeSpawn("git", args, { cwd: root, encoding: "utf8", env: process.env });
  if (value.status !== 0) throw new Error(`Owned Git failed: ${args.join(" ")}`);
  return value.stdout.trim();
};
globalThis.fetch = async () => { throw new Error("Fixture refuses network"); };
cp.spawnSync = (command, args, options) => {
  calls.push({ command, args });
  if (command === "git") {
    if (args[0] === "fetch") return result();
    if (args[0] === "push") { pushed = true; return result(); }
    if (mode === "malformed-expected" && args[0] === "rev-parse" && ["HEAD", "origin/main"].includes(args[1])) return result("not-a-sha\n");
    if (mode === "missing-expected" && args[0] === "rev-parse" && ["HEAD", "origin/main"].includes(args[1])) return result("\n");
    const allowed = new Set(["status", "rev-parse", "cat-file", "config", "tag"]);
    if (!allowed.has(args[0])) throw new Error("Unexpected Git command refused");
    if (options.cwd !== root) throw new Error("Unexpected Git worktree refused");
    return nativeSpawn(command, args, options);
  }
  if (command !== "gh") throw new Error("Unexpected subprocess refused");
  if (args[0] === "api") {
    const endpoint = args[1];
    if (endpoint === "user") return result("fixture-actor\n");
    if (endpoint === "users/fixture-actor/ssh_signing_keys") return result(JSON.stringify([publicKey]));
    if (endpoint.startsWith("repos/fixture/repository/actions/workflows/release-please.yml/runs?")) {
      if (mode === "moving-head") git(["update-ref", "HEAD", previous]);
      return result(JSON.stringify({ workflow_runs: [{ id: 1, run_number: 1, run_attempt: 1, conclusion: "success", event: "push", head_branch: "main", head_sha: mode === "malformed-expected" ? "not-a-sha" : expected, path: ".github/workflows/release-please.yml", name: "Release Please", actor: { login: "fixture-actor" } }] }));
    }
    if (endpoint === "repos/fixture/repository/git/ref/tags/v1.0.0") {
      return pushed ? result(JSON.stringify({ object: { type: "tag", sha: git(["rev-parse", "refs/tags/v1.0.0"]) } })) : result("", 1);
    }
    if (endpoint.startsWith("repos/fixture/repository/git/tags/")) {
      return result(JSON.stringify({ verification: { verified: true }, tagger: { email: "fixture@example.invalid" }, object: { sha: git(["rev-parse", "refs/tags/v1.0.0^{commit}"]) } }));
    }
    throw new Error("Unexpected GitHub API request refused");
  }
  if (args[0] === "release" && args[1] === "create") return result();
  if (args[0] === "pr" && args[1] === "list") return result("[]");
  throw new Error("Unexpected GitHub operation refused");
};
syncBuiltinESMExports();
let error = null;
try {
  const { main } = await import(pathToFileURL(path.join(root, "scripts/release-publish.mjs")).href);
  main(["--repo", "fixture/repository", "--tag", "v1.0.0", "--generate-notes"]);
} catch (value) { error = value.message; }
fs.writeFileSync(receipt, JSON.stringify({ error, calls, pushed, target: nativeSpawn("git", ["rev-parse", "--verify", "refs/tags/v1.0.0^{commit}"], { cwd: root, encoding: "utf8" }).stdout.trim() }, null, 2));
