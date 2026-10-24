import "./setup-env.mjs";
// The local Lighthouse fallback takes a URL the repository can choose (package.json homepage,
// vercel.json, .env files). It runs the installed CLI without a shell, so nothing in the URL is
// expanded or run, no package is downloaded, and credentials are removed from its environment.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { __frontendAnalyzeForTests } from "../src/agents/jules/tools/frontend-analyze.js";
import { __runtimeAuditForTests } from "../src/agents/jules/tools/runtime-audit.js";

const { lighthouseInvocation, detectDeployedUrl } = __runtimeAuditForTests;
const HOMEPAGE = "https://203.0.113.10/%OPENAI_API_KEY%/$SENTINELAYER_TOKEN/$(echo%20x)&echo%20y|z;w";
const ENV = { ...process.env, SENTINELAYER_TOKEN: "audit-user-token-0000", OPENAI_API_KEY: "audit-provider-key-0000" };

test("the repository's URL reaches pinned local Lighthouse without a download, shell, or credentials", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-runtime-audit-"));
  try {
    await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ homepage: HOMEPAGE }));
    const url = new URL(detectDeployedUrl({ path: root }).primary).toString();
    assert.ok(url.includes("%OPENAI_API_KEY%") && url.includes("$SENTINELAYER_TOKEN"), "the URL keeps its text");

    const invocation = lighthouseInvocation(url, path.join(root, "out.json"), { env: ENV });
    const lighthousePackage = JSON.parse(await fsp.readFile(fileURLToPath(import.meta.resolve("lighthouse/package.json")), "utf8"));
    assert.equal(lighthousePackage.version, "13.5.0", "the installed dependency is the pinned version");
    assert.equal(invocation.file, process.execPath, "the CLI runs directly through Node on every platform");
    assert.equal(invocation.args[0], fileURLToPath(import.meta.resolve("lighthouse/cli/index.js")));
    assert.equal(invocation.args.filter((arg) => arg === url).length, 1, "the URL is one argument");
    assert.equal("shell" in invocation.options, false);
    assert.equal(invocation.args.includes("--yes"), false);
    assert.equal(invocation.args.some((arg) => arg.startsWith("lighthouse@")), false);
    assert.equal(invocation.options.env.SENTINELAYER_TOKEN, undefined);
    assert.equal(invocation.options.env.OPENAI_API_KEY, undefined);
    assert.equal(
      lighthouseInvocation(url, "out.json", { exists: () => false, env: ENV }),
      null,
      "without the installed CLI, the fallback does not run",
    );
    assert.equal(
      lighthouseInvocation(url, "out.json", { resolve: () => { throw new Error("missing package"); }, env: ENV }),
      null,
      "an unresolved dependency does not trigger a package download",
    );

    // Run the same direct-Node invocation with a recorder in place of Lighthouse.
    const stub = path.join(root, "record.cjs");
    const seen = path.join(root, "seen.json");
    await fsp.writeFile(
      stub,
      "require('fs').writeFileSync(process.env.RECORD_TO, JSON.stringify({ argv: process.argv.slice(2), token: process.env.SENTINELAYER_TOKEN || null, key: process.env.OPENAI_API_KEY || null }));\n",
    );
    const recordedInvocation = lighthouseInvocation(url, path.join(root, "out.json"), {
      resolve: () => pathToFileURL(stub).href,
      env: { ...ENV, RECORD_TO: seen },
    });
    execFileSync(recordedInvocation.file, recordedInvocation.args, recordedInvocation.options);
    const recorded = JSON.parse(await fsp.readFile(seen, "utf8"));
    assert.deepEqual(recorded.argv, recordedInvocation.args.slice(1), "all arguments remain literal and separate");
    assert.equal(recorded.argv[0], url);
    assert.deepEqual([recorded.token, recorded.key], [null, null]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("npm audit runs in the repository without credentials in its environment", () => {
  const invocation = __frontendAnalyzeForTests.npmAuditInvocation("/repo", ENV);
  assert.equal("shell" in invocation.options, false);
  assert.equal(invocation.options.cwd, "/repo");
  assert.equal(invocation.options.env.SENTINELAYER_TOKEN, undefined);
  assert.equal(invocation.options.env.OPENAI_API_KEY, undefined);
  assert.equal(invocation.options.env.PATH ?? invocation.options.env.Path, process.env.PATH ?? process.env.Path, "the rest is kept");
});
