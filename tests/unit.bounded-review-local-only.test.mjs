import "./setup-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Only the public bin interface: copy these controls unchanged to a held source
// tree to demonstrate the old remote write. Every transport is mocked/refused.
const bin = fileURLToPath(new URL("../bin/sl.js", import.meta.url));
const preload = new URL("./fixtures/bounded-review-transport.mjs", import.meta.url).href;
const cases = [
  { name: "bounded complete with explicit local session", cap: "0.76", calls: 1, exit: 0, notify: true },
  { name: "bounded unaffordable with authenticated session", cap: "0.5", calls: 0, exit: 2 },
  { name: "bounded uncertain send with local session", cap: "0.76", calls: 1, exit: 2, uncertain: true, notify: true },
  { name: "bounded required remote ledger refuses", cap: "0.76", calls: 0, exit: 2, required: true, notify: true },
  { name: "ordinary review retains dashboard sync", calls: 1, exit: 0, legacy: true },
];
for (const scenario of cases) {
  test(`actual bin: ${scenario.name}`, async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "exposure-local-only-"));
    try {
      await fs.writeFile(path.join(target, "index.js"), "export const x = 1;\n");
      const receiptPath = path.join(target, "transport.json");
      // Whitelist OS execution essentials; no inherited real credentials/state.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|SYSTEMDRIVE)$/i.test(key)));
      Object.assign(env, { OPENAI_API_KEY: "synthetic-unused-key", EXPOSURE_FIXTURE_RECEIPT: receiptPath, EXPOSURE_FIXTURE_UNCERTAIN: scenario.uncertain ? "1" : "0", NO_COLOR: "1" });
      const args = ["--import", preload, bin, "omargate", "deep", "--path", target, "--provider", "openai", "--model", "gpt-5.3-codex", "--persona", "security", "--json"];
      if (scenario.cap) args.push("--max-model-token-exposure", scenario.cap);
      if (scenario.notify) args.push("--notify-session", "synthetic-local-session");
      if (scenario.required) args.push("--require-usage-ledger");
      const child = spawnSync(process.execPath, args, { cwd: target, env, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
      assert.equal(child.error, undefined);
      assert.equal(child.status, scenario.exit, child.stderr);
      const report = JSON.parse(child.stdout);
      const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
      assert.equal(receipt.providerCalls, scenario.calls);
      assert.equal(receipt.nativeAttempts, 0);
      if (scenario.legacy) {
        assert.equal(receipt.otherRoutes.length, 2);
        assert.deepEqual(receipt.otherRoutes.map(route => [route.origin, route.method]), [
          ["https://api.sentinelayer.com", "POST"], ["https://api.sentinelayer.com", "POST"],
        ]);
        assert.match(receipt.otherRoutes[0].path, /^\/api\/v1\/sessions\/omargate-[a-z0-9-]+-security-ai\/events$/);
        assert.equal(receipt.otherRoutes[1].path, "/api/v1/telemetry");
      } else assert.deepEqual(receipt.otherRoutes, []);
      assert.equal(report.coverage.status, scenario.exit === 0 ? "complete" : "incomplete");
      if (scenario.legacy) assert.equal(report.modelTokenExposure, null);
      else if (!scenario.required) assert.equal(report.modelTokenExposure.requestCounts.attempted, scenario.calls);
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });
}
