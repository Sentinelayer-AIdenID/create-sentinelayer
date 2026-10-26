import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { resolveOutputContext } from "../src/config/service.js";
import { writeArtifact } from "../src/commands/ai/shared.js";
import { registerAiProvisionAndGovernanceCommands } from "../src/commands/ai/provision-governance.js";
import { registerAiIdentityLifecycleCommands } from "../src/commands/ai/identity-lifecycle.js";
import { recordProvisionedIdentity, updateIdentityStatus } from "../src/ai/identity-store.js";
import { recordDomainProofResponse, recordTargetProofResponse } from "../src/ai/domain-target-store.js";
import { recordTemporarySite } from "../src/ai/site-store.js";

const refusal = /Workspace artifact destination must resolve inside the workspace/;
const operations = [
  ["request artifact", "request.json", (c) => writeArtifact(path.join(c.outputRoot, "aidenid/request.json"), { safe: true }, c.outputFs)],
  ["identity provision", "identity-registry.json", (c) => recordProvisionedIdentity({ ...c, response: { id: "identity-fixture" } })],
  ["identity status", "identity-registry.json", (c) => updateIdentityStatus({ ...c, identityId: "identity-fixture", status: "REVOKED" })],
  ["domain proof", "domain-target-registry.json", (c) => recordDomainProofResponse({ ...c, domain: { id: "domain-fixture" } })],
  ["target proof", "domain-target-registry.json", (c) => recordTargetProofResponse({ ...c, target: { id: "target-fixture" } })],
  ["site record", "site-registry.json", (c) => recordTemporarySite({ ...c, site: { id: "site-fixture" } })],
];
const initial = {
  "request.json": JSON.stringify({ unchanged: true }),
  "identity-registry.json": JSON.stringify({ identities: [{ identityId: "identity-fixture", status: "ACTIVE" }] }),
  "domain-target-registry.json": JSON.stringify({ domains: [], targets: [] }),
  "site-registry.json": JSON.stringify({ sites: [] }),
};

async function fixture(t, project = ".") {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-ai-output-"));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace"), outside = path.join(root, "outside"), homeDir = path.join(root, "home");
  await Promise.all([cwd, outside, homeDir].map((p) => fsp.mkdir(p)));
  if (project !== null) await fsp.writeFile(path.join(cwd, ".sentinelayer.yml"), `outputDir: ${JSON.stringify(project)}\n`);
  return { cwd, outside, homeDir, options: { cwd, homeDir, env: {} } };
}

async function seed(dir) {
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(initial)) await fsp.writeFile(path.join(dir, name), body);
}

for (const [name, filename, operation] of operations) {
  for (const supplied of ["missing", "null", "raw filesystem"]) {
    test(`AI ${name} refuses ${supplied} output capability before changing files`, async (t) => {
      const f = await fixture(t);
      const target = path.join(f.cwd, "aidenid");
      await seed(target);
      const context = { outputRoot: f.cwd };
      if (supplied !== "missing") context.outputFs = supplied === "null" ? null : fsp;
      await assert.rejects(() => operation(context), { name: "TypeError" });
      assert.equal(await fsp.readFile(path.join(target, filename), "utf8"), initial[filename]);
      assert.deepEqual((await fsp.readdir(target)).sort(), Object.keys(initial).sort());
    });
  }
}

for (const [name, filename, operation] of operations) {
  test(`AI ${name} rejects a descendant directory link without changing external files`, async (t) => {
    const f = await fixture(t);
    await seed(f.outside);
    await fsp.symlink(f.outside, path.join(f.cwd, "aidenid"), "junction");
    const context = await resolveOutputContext(f.options);
    await assert.rejects(() => operation(context), refusal);
    assert.equal(await fsp.readFile(path.join(f.outside, filename), "utf8"), initial[filename]);
    assert.deepEqual((await fsp.readdir(f.outside)).sort(), Object.keys(initial).sort());
  });
}

test("AI registry rejects an existing final-file symlink", async (t) => {
  const f = await fixture(t);
  await fsp.mkdir(path.join(f.cwd, "aidenid"));
  const external = path.join(f.outside, "identity-registry.json");
  await fsp.writeFile(external, initial["identity-registry.json"]);
  try {
    await fsp.symlink(external, path.join(f.cwd, "aidenid/identity-registry.json"), "file");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.skip("Windows host does not grant file-symlink privilege; directory-junction cases run separately.");
      return;
    }
    throw error;
  }
  const context = await resolveOutputContext(f.options);
  await assert.rejects(() => updateIdentityStatus({ ...context, identityId: "identity-fixture", status: "REVOKED" }), refusal);
  assert.equal(await fsp.readFile(external, "utf8"), initial["identity-registry.json"]);
});

for (const mode of ["workspace", "explicit override", "global"]) {
  test(`AI artifacts and registries preserve ${mode} output behavior`, async (t) => {
    const f = await fixture(t, mode === "global" ? null : mode === "explicit override" ? "../unsafe" : ".");
    const expected = mode === "workspace" ? f.cwd : f.outside;
    if (mode === "global") {
      await fsp.mkdir(path.join(f.homeDir, ".sentinelayer"));
      await fsp.writeFile(path.join(f.homeDir, ".sentinelayer/config.yml"), `outputDir: ${JSON.stringify(f.outside)}\n`);
    }
    const context = await resolveOutputContext({ ...f.options, ...(mode === "explicit override" ? { outputDirOverride: f.outside } : {}) });
    assert.equal(context.outputRoot, expected);
    await seed(path.join(expected, "aidenid"));
    for (const [, , operation] of operations) await operation(context);
    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(expected, "aidenid/request.json"), "utf8")), { safe: true });
    assert.equal(JSON.parse(await fsp.readFile(path.join(expected, "aidenid/identity-registry.json"), "utf8")).identities[0].status, "REVOKED");
  });
}

for (const command of [["provision-email"], ["identity", "audit"]]) {
  test(`actual ai ${command.join(" ")} command carries the output policy before effects`, async (t) => {
    const f = await fixture(t);
    await fsp.symlink(f.outside, path.join(f.cwd, "aidenid"), "junction");
    const program = new Command().exitOverride();
    const ai = program.command("ai");
    const handles = registerAiProvisionAndGovernanceCommands(ai);
    registerAiIdentityLifecycleCommands(handles);
    let fetches = 0;
    t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("Unexpected external effect"); });
    await assert.rejects(() => program.parseAsync(["ai", ...command, "--path", f.cwd, "--json"], { from: "user" }), refusal);
    assert.equal(fetches, 0);
    assert.deepEqual(await fsp.readdir(f.outside), []);
  });
}
