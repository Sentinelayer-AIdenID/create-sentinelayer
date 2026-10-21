import "./setup-env.mjs";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunAdmission, parseExposureUsd } from "../src/cost/run-admission.js";
import { BoundedReviewClient, exposurePolicy } from "../src/ai/bounded-review-client.js";
import { runLegacyCli } from "../src/legacy-cli.js";
import { runOmarGateOrchestrator } from "../src/review/omargate-orchestrator.js";
import { runAiReviewLayer } from "../src/review/ai-review.js";
const now = () => Date.parse("2026-10-21T12:00:00Z");
const roots = [];
async function root(files = 1) {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-review-")); roots.push(p);
  for (let n = 0; n < files; n++) await fs.writeFile(path.join(p, `file${n}.js`), `export const value${n} = ${n};\n`);
  return p;
}
afterEach(async () => { for (const p of roots.splice(0)) await fs.rm(p, { recursive: true, force: true }); });
function reply(provider = "openai", overrides = {}) {
  return provider === "openai" ? {
    model: "gpt-5.3-codex", service_tier: "default", status: "completed",
    output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: '{"findings":[]}' }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2 } }, ...overrides,
  } : {
    model: "claude-sonnet-4-6", stop_reason: "end_turn", content: [{ type: "text", text: '{"findings":[]}' }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, service_tier: "standard", inference_geo: "global", speed: "standard" }, ...overrides,
  };
}
function client({ provider = "openai", maximumUsd = "5", fetchImpl, clock = now } = {}) {
  return new BoundedReviewClient({ provider, model: provider === "openai" ? "gpt-5.3-codex" : "claude-sonnet-4-6", apiKey: "synthetic-unused-key", maximumUsd, fetchImpl, now: clock });
}
const ok = payload => ({ ok: true, json: async () => payload });

test("exposure decimal validation never rounds upward budget or accepts partial numbers", () => {
  assert.equal(parseExposureUsd("0.000000001"), 1n);
  for (const x of [0, -1, "NaN", "Infinity", "5junk", " 5", "1e3", "0.0000000001", "10000000", null, undefined]) assert.throws(() => parseExposureUsd(x));
});
test("shared reservations queue and release exact unused capacity; double settlement refuses", async () => {
  const budget = new RunAdmission("1");
  const first = await budget.reserve(600000000n, {}); budget.sent(first);
  let granted = false;
  const next = budget.reserve(600000000n, {}).then(id => { granted = true; return id; });
  await new Promise(setImmediate); assert.equal(granted, false);
  budget.settle(first, 100000000n);
  const second = await next; budget.sent(second); budget.settle(second, 100000000n);
  assert.equal(budget.snapshot().settledUsd, "0.200000000");
  assert.throws(() => budget.settle(second, 1n));
});
test("uncertain reservations wake and refuse waiters without releasing exposure", async () => {
  const budget = new RunAdmission("1"); const first = await budget.reserve(800000000n, {}); budget.sent(first);
  const waiting = assert.rejects(budget.reserve(800000000n, {}), /blocked/);
  budget.uncertain(first, "timeout"); await waiting;
  assert.equal(budget.snapshot().reservedUsd, "0.800000000");
});
test("sixteen competing lanes never duplicate reserved funds", async () => {
  const budget = new RunAdmission("5");
  await Promise.all(Array.from({ length: 16 }, async () => {
    const hold = await budget.reserve(1000000000n, {}); budget.sent(hold);
    const snapshot = budget.snapshot();
    assert.ok(BigInt(snapshot.settledUsd.replace(".", "")) + BigInt(snapshot.reservedUsd.replace(".", "")) <= 5000000000n);
    await new Promise(setImmediate); budget.settle(hold, 100000000n);
  }));
  assert.equal(budget.snapshot().settledUsd, "1.600000000");
});
test("rate policy fails closed for unknown route and expired/future verification", () => {
  assert.throws(() => exposurePolicy("sentinelayer", "gpt-5.3-codex", now()), /unavailable/);
  assert.throws(() => exposurePolicy("openai", "unknown", now()), /unavailable/);
  for (const date of ["2026-10-20", "2026-10-28"]) assert.throws(() => exposurePolicy("openai", "gpt-5.3-codex", Date.parse(date)), /expired/);
});
for (const provider of ["openai", "anthropic"]) {
  test(`bounded ${provider}: native shape, no redirects, exact authoritative usage, one attempt`, async () => {
    let calls = 0;
    const c = client({ provider, fetchImpl: async (url, options) => {
      calls++; assert.equal(options.redirect, "error"); const body = JSON.parse(options.body);
      assert.equal(body.stream, false);
      assert.equal(body.model, provider === "openai" ? "gpt-5.3-codex" : "claude-sonnet-4-6");
      assert.equal(body.max_output_tokens || body.max_tokens, provider === "openai" ? 4096 : 2048);
      assert.ok(url.endsWith(provider === "openai" ? "/responses" : "/messages"));
      return ok(reply(provider));
    } });
    const result = await c.invoke("review source"); assert.equal(result.completed, true); assert.equal(calls, 1);
    assert.equal(result.usage.outputTokens, 5); assert.equal(result.usage.costUsd, provider === "openai" ? 0.0000875 : 0.000105);
    assert.equal(c.snapshot().reservedUsd, "0.000000000");
  });
}
test("insufficient coarse allowance refuses before the first transport call", async () => {
  let calls = 0; const c = client({ maximumUsd: "0.5", fetchImpl: async () => { calls++; return ok(reply()); } });
  await assert.rejects(c.invoke("review"), /exhausted/); assert.equal(calls, 0);
});

test("queued work rechecks expiry before send and releases only its unsent hold", async () => {
  let clock = now(), finish, calls = 0;
  const c = client({ maximumUsd: "0.76", clock: () => clock, fetchImpl: async () => {
    calls++; await new Promise(resolve => { finish = resolve; }); return ok(reply());
  } });
  const first = c.invoke("first"); await new Promise(setImmediate);
  const second = assert.rejects(c.invoke("queued"), /expired/);
  clock = Date.parse("2026-10-28T00:00:00Z"); finish();
  await first; await second;
  assert.equal(calls, 1); assert.equal(c.snapshot().reservedUsd, "0.000000000");
  assert.deepEqual(c.snapshot().attempts.map(a => a.status), ["settled", "not_sent"]);
});
for (const scenario of ["timeout", "http", "usage", "tier", "model", "overrun", "cache", "tool"]) {
  test(`bounded failure ${scenario} retains exposure and prevents replay`, async () => {
    let calls = 0;
    const c = client({ fetchImpl: async () => {
      calls++;
      if (scenario === "timeout") throw new Error("synthetic lost response");
      if (scenario === "http") return { ok: false, status: 503 };
      const p = reply();
      if (scenario === "usage") delete p.usage;
      if (scenario === "tier") p.service_tier = "priority";
      if (scenario === "model") p.model = "different";
      if (scenario === "overrun") p.usage.output_tokens = 4097;
      if (scenario === "cache") p.usage.input_tokens_details.cache_write_tokens = 3;
      if (scenario === "tool") p.output.push({ type: "web_search_call" });
      return ok(p);
    } });
    await assert.rejects(c.invoke("review"), /exposure retained; no retry/);
    await assert.rejects(c.invoke("review"), /blocked/);
    assert.equal(calls, 1); assert.equal(c.snapshot().reservedUsd, "0.757344000");
    assert.equal(c.snapshot().attempts[0].status, "uncertain");
    assert.equal(c.snapshot().assuranceStatus, ["model", "tier", "overrun", "cache", "tool"].includes(scenario) ? "violated" : "uncertain");
  });
}

async function cli(t, { files = 1, provider = "openai", personas = "security", maximum = "5", response = () => reply(provider), extra = [] } = {}) {
  const targetPath = await root(files), output = []; let calls = 0, active = 0, peak = 0;
  const previousExit = process.exitCode, keyName = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY", oldKey = process.env[keyName];
  process.env[keyName] = "synthetic-unused-key";
  t.mock.method(Date, "now", now);
  t.mock.method(console, "log", text => output.push(String(text)));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.redirect, "error"); calls++; active++; peak = Math.max(peak, active);
    try { await new Promise(setImmediate); return ok(await response(calls)); } finally { active--; }
  });
  try {
    process.exitCode = 0;
    await runLegacyCli(["/omargate", "deep", "--path", targetPath, "--scope-mode", "full", "--provider", provider, "--model", provider === "anthropic" ? "claude-sonnet-4-6" : "gpt-5.3-codex", "--persona", personas, "--max-model-token-exposure", maximum, "--json", ...extra]);
    return { report: JSON.parse(output.at(-1)), calls, peak, exitCode: process.exitCode };
  } finally { process.exitCode = previousExit; if (oldKey === undefined) delete process.env[keyName]; else process.env[keyName] = oldKey; }
}
test("actual CLI: nested concurrency shares one cap and waits for released holds", async t => {
  const r = await cli(t, { files: 72, personas: "security,backend,testing,reliability", maximum: "0.76" });
  assert.equal(r.calls, 24); assert.equal(r.peak, 1); assert.equal(r.report.coverage.status, "complete");
  assert.equal(r.report.modelTokenExposure.attempts.length, 24);
  const personaArtifact = JSON.parse(await fs.readFile(r.report.artifacts.personas, "utf8"));
  for (const persona of personaArtifact.personas) {
    assert.equal(persona.aiCallEvidence.providerCostUsd, null);
    assert.equal(persona.aiCallEvidence.pricedCalls, 0);
    assert.equal(persona.aiCallEvidence.accounting.costBasis, "pinned_rate_conservative_exposure");
  }
  assert.equal(r.report.modelTokenExposure.reservedUsd, "0.000000000"); assert.equal(r.exitCode, 0);
});
test("actual CLI: settlement exhausts capacity for the next complete reservation", async t => {
  const r = await cli(t, { files: 72, personas: "security,backend,testing,reliability", maximum: "0.7575" });
  assert.equal(r.calls, 2); assert.equal(r.report.coverage.status, "incomplete"); assert.equal(r.exitCode, 2);
  assert.equal(r.report.modelTokenExposure.settledUsd, "0.000175000");
  assert.equal(r.report.modelTokenExposure.reservedUsd, "0.000000000");
  assert.equal(r.report.modelTokenExposure.requestCounts.attempted, 2);
  assert.equal(r.report.modelTokenExposure.requestCounts.refused, 22);
});
test("actual CLI: ambiguous first send stops remaining nested partitions and blocks", async t => {
  const r = await cli(t, { files: 72, personas: "security,backend,testing,reliability", maximum: "0.76", response: () => { throw new Error("lost response"); } });
  assert.equal(r.calls, 1); assert.equal(r.report.coverage.status, "incomplete"); assert.equal(r.exitCode, 2);
  assert.equal(r.report.modelTokenExposure.reservedUsd, "0.757344000");
  assert.equal(r.report.modelTokenExposure.assuranceStatus, "uncertain");
  assert.equal(r.report.modelTokenExposure.assuranceValid, null);
  assert.equal(r.report.modelTokenExposure.attempts[0].reason, "provider_outcome_uncertain");
  assert.equal(r.report.modelTokenExposure.requestCounts.uncertain, 1);
});
for (const counter of ["input_tokens", "output_tokens"]) {
  test(`actual CLI: known ${counter} overrun invalidates assurance and stops admission`, async t => {
    const r = await cli(t, { files: 72, personas: "security,backend,testing,reliability", maximum: "0.76", response: () => {
      const p = reply();
      p.usage[counter] = counter === "input_tokens" ? 500000 : 60000;
      p.usage.total_tokens = p.usage.input_tokens + p.usage.output_tokens;
      p.usage.untrusted_error = "provider-secret-must-not-appear";
      return p;
    } });
    assert.equal(r.calls, 1); assert.equal(r.exitCode, 2); assert.equal(r.report.coverage.status, "incomplete");
    const exposure = r.report.modelTokenExposure, attempt = exposure.attempts[0];
    assert.equal(exposure.assuranceValid, false); assert.equal(exposure.assuranceStatus, "violated");
    assert.equal(exposure.blockedReason, "provider_bound_violation");
    assert.equal(attempt.reason, "provider_bound_violation"); assert.deepEqual(attempt.exceededCounters, [counter]);
    assert.equal(attempt.providerUsage[counter], counter === "input_tokens" ? 500000 : 60000);
    assert.equal(attempt.observedPolicyCostUsd, counter === "input_tokens" ? "0.875070000" : "0.840017500");
    assert.equal(attempt.observedExcessUsd, counter === "input_tokens" ? "0.117726000" : "0.082673500");
    assert.equal(exposure.reservedUsd, "0.757344000");
    assert.equal(JSON.stringify(r.report).includes("provider-secret-must-not-appear"), false);
    const artifact = JSON.parse(await fs.readFile(r.report.artifacts.personas, "utf8"));
    assert.deepEqual(artifact.modelTokenExposure, exposure);
    assert.match(await fs.readFile(r.report.reportPath, "utf8"), /assurance=violated/);
  });
}
for (const provider of ["openai", "anthropic"]) {
  test(`actual CLI: ${provider} truncated but valid JSON is incomplete`, async t => {
    const r = await cli(t, { provider, response: () => reply(provider, provider === "openai" ? { status: "incomplete" } : { stop_reason: "max_tokens" }) });
    assert.equal(r.calls, 1); assert.equal(r.report.coverage.status, "incomplete"); assert.equal(r.exitCode, 2);
    assert.equal(r.report.modelTokenExposure.reservedUsd, "0.000000000");
  });
  test(`actual CLI: ${provider} completed empty findings remains valid`, async t => {
    const r = await cli(t, { provider }); assert.equal(r.calls, 1); assert.equal(r.report.coverage.status, "complete"); assert.equal(r.exitCode, 0);
  });
}
test("actual CLI: unsupported managed route refuses without send", async t => {
  const r = await cli(t, { provider: "sentinelayer" }); assert.equal(r.calls, 0); assert.equal(r.exitCode, 2); assert.equal(r.report.modelTokenExposure.status, "refused");
});

test("bounded direct usage retains local cache/provenance evidence and never invokes the remote recorder", async () => {
  const targetPath = await root(); let modelCalls = 0, ledgerCalls = 0;
  const c = client({ fetchImpl: async () => { modelCalls++; const p = reply(); p.usage.input_tokens_details.cached_tokens = 6; return ok(p); } });
  const options = { targetPath, runDirectory: path.join(targetPath, "run"), provider: c.provider, model: c.model, boundedReview: c,
    usageRecorder: async () => { ledgerCalls++; return { ok: true }; }, sessionId: "explicit-notify-session" };
  const result = await runAiReviewLayer(options);
  assert.equal(modelCalls, 1); assert.equal(ledgerCalls, 0);
  assert.equal(result.billing.reason, "bounded_direct_usage_local_only");
  assert.equal(result.usage.cacheReadTokens, 6); assert.equal(result.usage.costUsd, 0.0000875);
  assert.deepEqual(result.usage.accounting, { tokenBasis: "provider_reported", costBasis: "pinned_rate_conservative_exposure", policySha256: c.snapshot().policySha256 });
  const history = JSON.parse(await fs.readFile(result.cost.filePath, "utf8"));
  assert.equal(history.entries[0].cacheReadTokens, 6); assert.deepEqual(history.entries[0].accounting, result.usage.accounting);
  const event = (await fs.readFile(result.telemetry.filePath, "utf8")).trim().split("\n").map(JSON.parse).find(e => e.eventType === "usage");
  assert.equal(event.usage.cacheReadTokens, 6); assert.deepEqual(event.metadata.accounting, result.usage.accounting);
  const artifact = JSON.parse(await fs.readFile(result.artifacts.reportJsonPath, "utf8"));
  assert.equal(artifact.providerUsage.input_tokens_details.cached_tokens, 6);
  assert.deepEqual(artifact.usage.accounting, result.usage.accounting);
  await assert.rejects(runAiReviewLayer({ ...options, requireUsageLedger: true }), /remote billing ledger/);
  assert.equal(modelCalls, 1); assert.equal(ledgerCalls, 0);
});

test("actual CLI: required remote ledger refuses before direct provider transport", async t => {
  const r = await cli(t, { extra: ["--require-usage-ledger", "--notify-session", "explicit-session"] });
  assert.equal(r.calls, 0); assert.equal(r.exitCode, 2); assert.match(r.report.modelTokenExposure.reason, /remote billing ledger/);
});
test("full 923-request synthetic scheduling control is not a live review receipt", async t => {
  const targetPath = await root(), files = Array.from({ length: 847 }, (_, n) => `src/f${n}.js`);
  t.mock.method(Date, "now", now); const oldKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "synthetic-unused-key";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; await new Promise(setImmediate); return ok(reply()); });
  try {
    const result = await runOmarGateOrchestrator({ targetPath, provider: "openai", model: "gpt-5.3-codex", maxModelTokenExposureUsd: "5", deterministic: { summary: { P0: 0, P1: 0, P2: 0, P3: 0 }, findings: [], scope: { scannedRelativeFiles: files } }, aiReviewRunner: async ({ boundedReview }) => {
      const r = await boundedReview.invoke("synthetic scheduling only"); return { findings: [], reviewValidity: { valid: true }, usage: r.usage, budget: { blocking: false } };
    } });
    assert.equal(calls, 923); assert.equal(result.coverage.completedPersonas, 13);
    assert.equal(result.modelTokenExposure.attempts.length, 923);
    assert.equal(result.modelTokenExposure.settledUsd, "0.080762500");
  } finally { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; }
});
