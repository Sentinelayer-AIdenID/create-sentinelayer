import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Command } from "commander";
import { registerOmarGateCommand } from "../src/commands/omargate.js";
import { runAiReviewLayer } from "../src/review/ai-review.js";
import { runOmarGateOrchestrator } from "../src/review/omargate-orchestrator.js";
import { TYPESAFE_SEVERITY_MODEL, SEVERITY_CRITERIA, CATEGORY_CRITERIA, buildSeverityRequest, parseSeverityResponse, evaluateSeverityClassification, parseSeverityEvaluationMaxCost, severityResourceTotals } from "../src/review/typesafe-severity.js";
import { containsSecret } from "../src/session/redact.js";

const evalEvidence = JSON.parse(await fsp.readFile(new URL("../tasks/evals/pr-842-typesafe-severity-evaluation.json", import.meta.url), "utf8"));

const finding = (overrides = {}) => ({ severity: "P1", file: ".github/workflows/release.yml", line: 17, message: "Unbound release artifact", evidence: "deploy consumes the latest artifact without checking its source revision", rationale: "Artifact provenance is missing", suggestedFix: "Bind the artifact to the reviewed revision", rootCause: "Unbound artifact lookup", userImpact: "A different build can be deployed", ...overrides });
const env = { TYPESAFE_API_KEY: "fixture-typesafe-only" };
const uncapped = { limits: { maxCostUsd: 0, maxOutputTokens: 0, maxRuntimeMs: 0, maxToolCalls: 0 }, usage: { toolCalls: 1, runtimeMs: 2 }, blocking: false };
function choice(criteria, selected) { return { type: "choice", choice: selected, probabilities: Object.fromEntries(Object.keys(criteria).map((k) => [k, k === selected ? 1 : 0])), confidence: 1 }; }
function response(request, tier = "P2") {
  return { model: TYPESAFE_SEVERITY_MODEL, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, choice(q.criteria, id.endsWith("severity") ? tier : "cicd")])), usage: { input_tokens: 101, output_tokens: 21 } };
}
const evaluate = (options = {}) => evaluateSeverityClassification({ mode: "typesafe", findings: [finding()], env, budget: uncapped, ...options });

// Synthetic detector examples assembled at runtime; never credentials or provider calls.
const syntheticAccessKey = () => ["AK", "IA", "A".repeat(16)].join("");
const syntheticJwt = () => ["eyJ" + "A".repeat(12), "B".repeat(12), "C".repeat(8)].join(".");
for (const field of ["file", "message", "evidence", "rationale", "rootCause", "userImpact"]) {
  for (const [kind, fake] of [["access-key", syntheticAccessKey], ["jwt", syntheticJwt]]) {
    test(`TypeSafe refuses secret-like ${kind} in transmitted ${field} before dispatch`, async () => {
      const source = finding({ [field]: `synthetic ${fake()} fixture` });
      const before = structuredClone(source); let fetchCalls = 0; let reservations = 0;
      assert.throws(() => buildSeverityRequest([source]), /secret_like_content/);
      const r = await evaluate({ findings: [source], beforeRequest: async () => { reservations++; }, fetchImpl: async () => { fetchCalls++; assert.fail("secret dispatch"); } });
      assert.equal(fetchCalls, 0); assert.equal(reservations, 0); assert.equal(r.attempted, false);
      assert.equal(r.status, "unverified"); assert.equal(r.reason, "secret_like_content"); assert.equal(r.usage, null);
      assert.equal(r.findings[0].severity, null); assert.deepEqual(source, before);
    });
  }
}
for (const [kind, fake] of [
  ["github", () => ["gh", "p_", "A".repeat(24)].join("")],
  ["github-pat", () => ["github", "_pat_", "A".repeat(24)].join("")],
  ["sk", () => ["s", "k-", "A".repeat(24)].join("")],
  ["private-key-header", () => ["-----BEGIN ", "RSA ", "PRIVATE KEY-----"].join("")],
  ["slack", () => ["xox", "b-", "a".repeat(12)].join("")],
  ["google", () => ["AI", "za", "A".repeat(35)].join("")],
  ["known-token-name", () => ["SENTINELAYER", "_TOKEN"].join("")],
]) test(`TypeSafe reuses central detector semantics for ${kind}`, async () => {
  let calls = 0;
  const r = await evaluate({ findings: [finding({ evidence: fake() })], fetchImpl: async () => { calls++; assert.fail("secret dispatch"); } });
  assert.equal(calls, 0); assert.equal(r.reason, "secret_like_content"); assert.equal(r.attempted, false);
});
test("TypeSafe secret in a later nested finding refuses the entire batch without partial dispatch", async () => {
  const sources = [finding(), finding({ rootCause: syntheticJwt() })]; const before = structuredClone(sources);
  let calls = 0; const r = await evaluate({ findings: sources, fetchImpl: async () => { calls++; } });
  assert.equal(calls, 0); assert.equal(r.reason, "secret_like_content"); assert.equal(r.findings.length, 2);
  assert.ok(r.findings.every((f) => f.status === "unverified" && f.severity === null)); assert.deepEqual(sources, before);
});
test("TypeSafe scans secret-like content beyond the display redactor truncation boundary", async () => {
  const prefix = "x".repeat(17000); const fake = syntheticAccessKey();
  const safe = buildSeverityRequest([finding({ evidence: prefix + "a".repeat(fake.length) })]);
  assert.ok(Buffer.byteLength(JSON.stringify(safe), "utf8") < 24 * 1024);
  let calls = 0; let reservations = 0;
  const r = await evaluate({ findings: [finding({ evidence: prefix + fake })], beforeRequest: async () => { reservations++; }, fetchImpl: async () => { calls++; } });
  assert.equal(r.reason, "secret_like_content"); assert.equal(r.attempted, false); assert.equal(calls, 0); assert.equal(reservations, 0);
});
test("Central secret detector sees nested constructed request values", () => {
  const request = buildSeverityRequest([finding(), finding()]);
  assert.equal(containsSecret(request), false);
  request.state.findings[1].file = `src/${syntheticJwt()}.js`;
  assert.equal(containsSecret(request), true);
});
test("TypeSafe excludes non-transmitted secret fields while allowing ordinary projected text unchanged", () => {
  const source = finding({ suggestedFix: syntheticAccessKey(), metadata: { nested: { value: syntheticJwt() } }, env: { value: syntheticAccessKey() } });
  const before = structuredClone(source); const request = buildSeverityRequest([source]);
  assert.equal(request.state.findings[0].evidence, source.evidence); assert.equal(request.state.findings[0].file, source.file);
  assert.equal(JSON.stringify(request).includes(syntheticAccessKey()), false); assert.equal(JSON.stringify(request).includes(syntheticJwt()), false);
  assert.deepEqual(source, before);
});


for (const tier of ["P0", "P1", "P2", "P3"]) test(`TypeSafe accepts schema-valid ${tier} without replacing original evidence`, () => {
  const source = finding(); const request = buildSeverityRequest([source]); const parsed = parseSeverityResponse(response(request, tier), request);
  assert.equal(parsed[0].severity, tier); assert.equal(parsed[0].category, "cicd"); assert.equal(parsed[0].status, "verified"); assert.equal(source.severity, "P1");
});
test("TypeSafe projection omits prior severity/confidence, fix text, environment and unrelated metadata", () => {
  const source = finding({ confidence: 0.98, env: { secret: "not-for-model" }, prompt: "not-for-model", metadata: { key: "not-for-model" } });
  const request = buildSeverityRequest([source]);
  assert.deepEqual(Object.keys(request.state.findings[0]).sort(), ["evidence", "file", "line", "message", "rationale", "rootCause", "userImpact"].sort());
  assert.equal(request.model, "jev-1.13.0"); assert.equal(request.questions.f0_severity.criteria.insufficient_evidence.startsWith("The supplied evidence"), true);
  assert.equal(JSON.stringify(request).includes("not-for-model"), false); assert.equal(JSON.stringify(request.state).includes(source.suggestedFix), false);
  assert.match(request.questions.f0_severity.instructions, /state.findings\[0\]/);
});
test("TypeSafe request has bounded finding/question/byte counts and never silently truncates evidence", () => {
  assert.equal(Object.keys(buildSeverityRequest(Array.from({ length: 8 }, () => finding())).questions).length, 16);
  assert.throws(() => buildSeverityRequest(Array.from({ length: 9 }, () => finding())), /finding_limit/);
  assert.throws(() => buildSeverityRequest([finding({ evidence: "x".repeat(25000) })]), /input_limit/);
  assert.throws(() => buildSeverityRequest([finding({ evidence: "" })]), /evidence_insufficient/);
});
test("TypeSafe insufficient evidence is an unverified null candidate, not P3 or a dropped finding", () => {
  const q = buildSeverityRequest([finding()]); const x = parseSeverityResponse(response(q, "insufficient_evidence"), q);
  assert.equal(x.length, 1); assert.equal(x[0].status, "unverified"); assert.equal(x[0].severity, null); assert.equal(x[0].reason, "insufficient");
});
for (const [name, mutate] of [
  ["sum", (p) => { p.answers.f0_severity.probabilities.P0 = 0.2; }],
  ["missing probability", (p) => { delete p.answers.f0_severity.probabilities.P0; }],
  ["nonfinite", (p) => { p.answers.f0_severity.probabilities.P0 = Infinity; }],
  ["negative", (p) => { p.answers.f0_severity.probabilities.P0 = -1; }],
  ["wrong selected option", (p) => { p.answers.f0_severity.choice = "P0"; }],
  ["confidence mismatch", (p) => { p.answers.f0_severity.confidence = 0.2; }],
  ["wrong type", (p) => { p.answers.f0_severity.type = "score"; }],
  ["unexpected answer", (p) => { p.answers.f9_severity = p.answers.f0_severity; }],
  ["model mismatch", (p) => { p.model = "jev-latest"; }],
  ["missing usage", (p) => { delete p.usage; }],
]) test(`TypeSafe rejects malformed ${name}`, () => {
  const q = buildSeverityRequest([finding()]); const p = response(q); mutate(p); assert.throws(() => parseSeverityResponse(p, q), /malformed_response/);
});
test("TypeSafe tied argmax is retained as ambiguous/unverified", () => {
  const q = buildSeverityRequest([finding()]); const p = response(q); p.answers.f0_severity.probabilities = { P0: .5, P1: .5, P2: 0, P3: 0, insufficient_evidence: 0 }; p.answers.f0_severity.choice = "P0"; p.answers.f0_severity.confidence = .375;
  const [a] = parseSeverityResponse(p, q); assert.equal(a.reason, "ambiguous_distribution"); assert.equal(a.severity, null);
});
test("TypeSafe makes one bounded POST and reports separate actual API usage", async () => {
  let calls = 0; const r = await evaluate({ fetchImpl: async (url, init) => { calls++; assert.equal(url, "https://api.typesafe.ai/v1/systemone"); assert.equal(init.method, "POST"); assert.equal(init.redirect, "error"); assert.equal(init.headers.Authorization, "Bearer fixture-typesafe-only"); return Response.json(response(JSON.parse(init.body))); } });
  assert.equal(calls, 1); assert.equal(r.status, "verified"); assert.equal(r.usage.inputTokens, 101); assert.equal(r.authority, "evaluation_only");
});
for (const [reason, options] of [
  ["missing_key", { env: {} }], ["dry_run", { dryRun: true }], ["no_findings", { findings: [] }],
  ["required_ledger_unsupported", { requireUsageLedger: true }],
  ["monetary_cap_unsupported", { budget: { ...uncapped, limits: { ...uncapped.limits, maxCostUsd: 5 } } }],
  ["output_cap_unsupported", { budget: { ...uncapped, limits: { ...uncapped.limits, maxOutputTokens: 500 } } }],
  ["generation_budget_blocked", { budget: { ...uncapped, blocking: true } }],
]) test(`TypeSafe preflight ${reason} does not dispatch`, async () => {
  let calls = 0; const r = await evaluate({ fetchImpl: () => { calls++; throw new Error("must not dispatch"); }, ...options }); assert.equal(calls, 0); assert.equal(r.attempted, false); assert.equal(r.status, "unverified"); assert.equal(r.reason, reason);
});
test("TypeSafe off mode has no result or I/O", async () => { assert.equal(await evaluate({ mode: "off", fetchImpl: () => assert.fail("off dispatch") }), null); });
test("TypeSafe 429 is unavailable/unverified with no retry or fabricated zero usage", async () => {
  let calls = 0; const r = await evaluate({ fetchImpl: async () => { calls++; return new Response("ignored upstream text", { status: 429 }); } }); assert.equal(calls, 1); assert.equal(r.reason, "provider_error"); assert.equal(r.usage, null); assert.equal(r.findings[0].severity, null);
});
test("TypeSafe timeout includes a stalled response body", async () => {
  const r = await evaluate({ timeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream({ start() {} })) }); assert.equal(r.reason, "timeout"); assert.equal(r.attempted, true); assert.equal(r.usage, null);
});
test("TypeSafe response stream limit is enforced before JSON parsing", async () => {
  const r = await evaluate({ fetchImpl: async () => new Response("x".repeat(65537)) }); assert.equal(r.reason, "response_limit");
});
test("TypeSafe malformed JSON is explicitly unverified", async () => { const r = await evaluate({ fetchImpl: async () => new Response("{broken") }); assert.equal(r.reason, "malformed_response"); });
test("Only explicit finite zero disables the opt-in monetary cap", () => {
  assert.equal(parseSeverityEvaluationMaxCost(undefined), 5); assert.equal(parseSeverityEvaluationMaxCost("0"), 0); assert.equal(parseSeverityEvaluationMaxCost("2.5"), 2.5);
  for (const x of ["NaN", "-1", "Infinity", " ", false]) assert.throws(() => parseSeverityEvaluationMaxCost(x));
});
test("Commander forwards the explicit evaluation flag and zero without auth/provider work", async () => {
  const program = new Command(); let args; registerOmarGateCommand(program, (x) => { args = x; }); await program.parseAsync(["node", "sl", "omargate", "deep", "--severity-classifier", "typesafe", "--max-cost", "0"]);
  assert.equal(args[args.indexOf("--severity-classifier") + 1], "typesafe"); assert.equal(args[args.indexOf("--max-cost") + 1], "0");
});
async function fixture(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-typesafe-eval-")); const saved = globalThis.fetch;
  try { await fn(dir); } finally { globalThis.fetch = saved; assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); await fsp.rm(dir, { recursive: true, force: true }); }
}
async function actualCaller(dir, { classifier = "typesafe", cap = 0, malformed = false, withKey = true, limits = {}, callLog = [], sourceFindings, mockOutcome = "valid" } = {}) {
  const original = sourceFindings || [finding(), finding({ severity: "P2", message: "Second finding" })]; const calls = callLog;
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    if (url === "https://api.openai.com/v1/chat/completions") return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: { highLevel: "fixture" }, findings: original }) } }] });
    assert.equal(url, "https://api.typesafe.ai/v1/systemone"); const q = JSON.parse(init.body); assert.equal(Object.hasOwn(q.state.findings[0], "severity"), false);
    if (malformed || mockOutcome === "malformed") return new Response("{invalid");
    if (mockOutcome === "outage") return new Response("mock provider outage", { status: 429 });
    return Response.json(response(q, mockOutcome === "insufficient" ? "insufficient_evidence" : "P3"));
  };
  const r = await runAiReviewLayer({ targetPath: dir, runDirectory: path.join(dir, "run"), outputDir: path.join(dir, "out"), runId: "fixture", mode: "full", provider: "openai", model: "gpt-5.3-codex", apiKey: "fixture-openai-only", env: withKey ? env : {}, maxCostUsd: cap, severityClassifier: classifier, deterministic: { summary: { P0: 0, P1: 0, P2: 0, P3: 0 } }, usageRecorder: async () => ({ ok: true }), ...limits });
  return { r, calls, original };
}
test("Actual AI-review caller persists/renders classification while retaining original findings, severity, fixes and counts", async () => fixture(async (dir) => {
  const { r, calls } = await actualCaller(dir); assert.equal(calls.length, 2); assert.equal(r.severityClassification.status, "verified"); assert.deepEqual(r.aiSummary, { P0: 0, P1: 1, P2: 1, P3: 0, blocking: true });
  assert.equal(r.findings[0].severity, "P1"); assert.equal(r.findings[0].evidence, finding().evidence); assert.equal(r.findings[0].suggestedFix, finding().suggestedFix); assert.equal(r.findings[0].severityClassification.severity, "P3"); assert.equal(r.usage.toolCalls, 1);
  const j = JSON.parse(await fsp.readFile(r.artifacts.reportJsonPath, "utf8")); const md = await fsp.readFile(r.artifacts.reportMarkdownPath, "utf8"); assert.equal(j.severityClassification.authority, "evaluation_only"); assert.match(md, /classification evaluation: verified/); assert.match(md, /candidate=P3; category=cicd/);
  const history = JSON.parse(await fsp.readFile(r.cost.filePath, "utf8")); assert.equal(history.entries.filter((e) => e.provider === "typesafe").length, 0);
  const events = (await fsp.readFile(r.telemetry.filePath, "utf8")).trim().split(/\r?\n/).map(JSON.parse); const completed = events.find((e) => e.metadata.layer === "severity_classification_evaluation" && e.metadata.phase === "completed"); assert.equal(completed.metadata.reportedUsage.inputTokens, 101); assert.equal(completed.metadata.costKnown, false);
}));
test("Actual caller's malformed evaluation preserves findings and reports unknown usage rather than a verified clean result", async () => fixture(async (dir) => {
  const { r } = await actualCaller(dir, { malformed: true }); assert.equal(r.severityClassification.status, "unverified"); assert.equal(r.severityClassification.usage, null); assert.equal(r.findings.length, 2); assert.equal(r.findings[0].severity, "P1"); assert.equal(r.findings[0].severityClassification.severity, null);
}));
test("Actual caller secret refusal preserves original findings and never calls the secondary provider", async () => fixture(async (dir) => {
  const sources = [finding(), finding({ severity: "P2", file: `src/${syntheticAccessKey()}.js`, evidence: syntheticJwt() })];
  const before = structuredClone(sources); const { r, calls } = await actualCaller(dir, { sourceFindings: sources });
  assert.deepEqual(calls, ["https://api.openai.com/v1/chat/completions"]);
  assert.equal(r.severityClassification.status, "unverified"); assert.equal(r.severityClassification.reason, "secret_like_content");
  assert.equal(r.severityClassification.attempted, false); assert.equal(r.severityClassification.usage, null);
  assert.deepEqual(r.aiSummary, { P0: 0, P1: 1, P2: 1, P3: 0, blocking: true });
  assert.equal(r.findings[1].file, before[1].file); assert.equal(r.findings[1].evidence, before[1].evidence); assert.deepEqual(sources, before);
  const history = JSON.parse(await fsp.readFile(r.cost.filePath, "utf8")); assert.equal(history.entries.length, 1);
  const events = (await fsp.readFile(r.telemetry.filePath, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(events.filter((e) => e.metadata.layer === "severity_classification_evaluation" && e.metadata.phase === "reserved").length, 0);
}));

test("Actual caller off is unchanged and positive monetary cap cannot dispatch TypeSafe", async () => fixture(async (dir) => {
  const off = await actualCaller(path.join(dir, "off"), { classifier: "off" }); assert.equal(off.calls.length, 1); assert.equal(Object.hasOwn(off.r, "severityClassification"), false); assert.equal(Object.hasOwn(off.r.findings[0], "severityClassification"), false);
  const cap = await actualCaller(path.join(dir, "cap"), { cap: 5 }); assert.equal(cap.calls.length, 1); assert.equal(cap.r.severityClassification.reason, "monetary_cap_unsupported");
}));
test("Actual orchestrator reaches the evaluation caller with explicit zero and aggregates its status", async () => fixture(async (dir) => {
  for (const maxCostUsd of [0, "0"]) {
    const seen = [];
    const r = await runOmarGateOrchestrator({ targetPath: dir, scanMode: "baseline", maxCostUsd, severityClassifier: "typesafe", deterministic: { findings: [], summary: { P0: 0, P1: 0, P2: 0, P3: 0 } }, aiReviewRunner: async (options) => { seen.push(options); return { findings: [], usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 }, severityClassification: { status: "unverified", reason: "fixture", findings: [] } }; } });
    assert.ok(seen.length > 0);
    assert.ok(seen.every((s) => s.severityClassifier === "typesafe" && s.maxCostUsd === 0));
    assert.equal(r.severityClassification.status, "unverified");
  }
}));

test("TypeSafe locally enforces finite remaining request and runtime budgets", async () => {
  let calls = 0; const fetchImpl = async (_url, init) => { calls++; return Response.json(response(JSON.parse(init.body))); };
  const exhausted = await evaluate({ fetchImpl, budget: { ...uncapped, limits: { ...uncapped.limits, maxToolCalls: 1 } } }); assert.equal(exhausted.reason, "tool_budget"); assert.equal(calls, 0);
  const allowed = await evaluate({ fetchImpl, budget: { ...uncapped, limits: { ...uncapped.limits, maxToolCalls: 2, maxRuntimeMs: 500 } } }); assert.equal(allowed.status, "verified"); assert.equal(calls, 1);
  const timeout = await evaluate({ fetchImpl: async () => new Response(new ReadableStream({ start() {} })), budget: { ...uncapped, limits: { ...uncapped.limits, maxRuntimeMs: 25 } } }); assert.equal(timeout.reason, "timeout");
});
test("TypeSafe refuses dispatch if its attempt reservation cannot persist", async () => {
  let calls = 0; const r = await evaluate({ beforeRequest: async () => { throw new Error("fixture persistence failure"); }, fetchImpl: async () => { calls++; } }); assert.equal(calls, 0); assert.equal(r.attempted, false); assert.equal(r.reason, "accounting_unavailable");
});
test("TypeSafe missing impact/context is unverified without making a judgment", async () => {
  let calls = 0; const r = await evaluate({ findings: [finding({ userImpact: "" })], fetchImpl: async () => { calls++; } }); assert.equal(r.reason, "context_insufficient"); assert.equal(calls, 0);
});
test("Sidecar resource accounting retains known/unknown-usage and unfinished reservations independently of generation history", () => {
  const event = (sessionId, attemptId, phase, extra = {}) => ({ sessionId, metadata: { layer: "severity_classification_evaluation", version: 1, attemptId, phase, ...extra } });
  const rows = [event("s", "known", "reserved"), event("s", "known", "completed", { durationMs: 5 }), event("s", "unknown", "reserved"), event("s", "unknown", "completed", { durationMs: 17 }), event("other", "foreign", "reserved")];
  assert.deepEqual(severityResourceTotals(rows, "s"), { toolCalls: 2, durationMs: 22, unknownRuntime: false });
  rows.push(event("s", "unfinished", "reserved")); assert.deepEqual(severityResourceTotals(rows, "s"), { toolCalls: 3, durationMs: 22, unknownRuntime: true });
});
test("Actual caller persists unknown provider cost as unknown and accounts its attempted request/time", async () => fixture(async (dir) => {
  const { r } = await actualCaller(dir, { malformed: true }); const events = (await fsp.readFile(r.telemetry.filePath, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  const markers = events.filter((e) => e.metadata.layer === "severity_classification_evaluation"); assert.equal(markers.length, 2); assert.equal(markers[0].metadata.phase, "reserved"); assert.equal(markers[1].metadata.costKnown, false); assert.equal(markers[1].metadata.actualRequests, 1);
  assert.equal(r.budget.usage.toolCalls, 2); assert.equal(r.budget.classificationUsageUnknown, true); assert.equal(r.usage.toolCalls, 1); assert.equal(r.severityClassification.usage, null);
}));

test("Actual sequential caller re-counts known classifier requests without changing generation history/progress", async () => fixture(async (dir) => {
  const first = await actualCaller(dir); assert.equal(first.r.budget.usage.toolCalls, 2);
  const second = await actualCaller(dir, { limits: { maxToolCalls: 3 } }); assert.equal(second.calls.length, 1); assert.equal(second.r.severityClassification.reason, "tool_budget");
  const history = JSON.parse(await fsp.readFile(second.r.cost.filePath, "utf8")); assert.equal(history.entries.length, 2); assert.ok(history.entries.every((e) => e.provider === "openai" && e.progressScore === 1));
}));
test("TypeSafe refuses malformed resource budgets before dispatch", async () => {
  for (const [key, value] of [["maxToolCalls", NaN], ["maxRuntimeMs", -1], ["maxOutputTokens", "0"]]) {
    let calls = 0; const r = await evaluate({ budget: { ...uncapped, limits: { ...uncapped.limits, [key]: value } }, fetchImpl: async () => { calls++; } }); assert.equal(r.reason, "invalid_budget"); assert.equal(calls, 0);
  }
});

test("TypeSafe rejects nested or invalid line metadata without provider dispatch", async () => {
  for (const line of [{ hidden: { arbitrary: "not-for-model" } }, [1], "1", 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    let calls = 0;
    const r = await evaluate({ findings: [finding({ line })], fetchImpl: async () => { calls++; } });
    assert.equal(r.reason, "location_invalid"); assert.equal(r.attempted, false); assert.equal(calls, 0);
  }
  assert.equal(buildSeverityRequest([finding({ line: 1 })]).state.findings[0].line, 1);
});
test("TypeSafe rejects late valid answers after a synchronous event-loop stall", async () => {
  const r = await evaluate({ timeoutMs: 5, fetchImpl: async (_url, init) => {
    const until = performance.now() + 35;
    while (performance.now() < until) { /* Synthetic event-loop stall; no I/O. */ }
    return Response.json(response(JSON.parse(init.body)));
  } });
  assert.equal(r.reason, "timeout"); assert.equal(r.status, "unverified"); assert.equal(r.attempted, true);
  assert.equal(r.findings[0].severity, null); assert.equal(r.usage.inputTokens, 101);
});
test("Actual opt-in review rejects invalid monetary caps before any provider call", async () => fixture(async (dir) => {
  for (const [i, cap] of [NaN, false, -1, Infinity].entries()) {
    const calls = [];
    await assert.rejects(actualCaller(path.join(dir, String(i)), { cap, callLog: calls }), /max-cost must be a finite non-negative number/);
    assert.equal(calls.length, 0);
  }
}));
test("Actual opt-in review missing, blank and null caps retain positive defaults", async () => fixture(async (dir) => {
  for (const [i, cap] of [undefined, "", null].entries()) {
    const { r, calls } = await actualCaller(path.join(dir, String(i)), { limits: { maxCostUsd: cap } });
    assert.equal(calls.length, 1); assert.equal(r.severityClassification.reason, "monetary_cap_unsupported");
    assert.equal(r.budget.limits.maxCostUsd, 1);
  }
  const explicit = await actualCaller(path.join(dir, "string-zero"), { cap: "0" });
  assert.equal(explicit.calls.length, 2); assert.equal(explicit.r.severityClassification.status, "verified");
}));
test("Actual orchestrator validates opt-in monetary caps before starting personas", async () => fixture(async (dir) => {
  for (const maxCostUsd of [NaN, false, -1, Infinity]) {
    let calls = 0;
    await assert.rejects(runOmarGateOrchestrator({ targetPath: dir, severityClassifier: "typesafe", maxCostUsd, aiReviewRunner: async () => { calls++; } }), /max-cost must be a finite non-negative number/);
    assert.equal(calls, 0);
  }
}));


test("Frozen eval evidence binds the complete synthetic comparison and canonical implementation/test source", async () => {
  assert.equal(evalEvidence.schemaVersion, 1);
  assert.equal(evalEvidence.evidenceKind, "deterministic_mock_contract_comparison");
  assert.equal(evalEvidence.modelAccuracyEvidence, false);
  assert.equal(evalEvidence.sourceBinding.baselineRevision, "6f21f9718d344157e75f83f1a3100fcc8a316112");
  assert.equal(evalEvidence.sourceBinding.originalImplementationRevision, "3e12b628b6a64c69aee643d327c4df0f03a9dbac");
  assert.equal(evalEvidence.sourceBinding.privacyCorrectionBaseRevision, "22b8553073bb72cfccd71fb1c06217c3e6844ff4");
  assert.deepEqual(evalEvidence.cases.map((c) => c.id), ["off-compatibility", "on-schema-valid-disagreement", "positive-cap-skip", "provider-outage", "malformed-response", "insufficient-evidence", "secret-like-content"]);
  const sourceHashes = { ...evalEvidence.sourceBinding.sourceSha256, [evalEvidence.sourceBinding.testPath]: evalEvidence.sourceBinding.testSha256 };
  assert.equal(Object.keys(sourceHashes).length, 8);
  for (const [file, expected] of Object.entries(sourceHashes)) {
    const canonical = (await fsp.readFile(new URL(`../${file}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
    assert.equal(createHash("sha256").update(canonical).digest("hex"), expected, `canonical source binding: ${file}`);
  }
});
for (const scenario of evalEvidence.cases) test(`Frozen actual-caller eval comparison: ${scenario.id}`, async (t) => fixture(async (dir) => {
  const before = structuredClone(evalEvidence.input.findings);
  if (scenario.options.syntheticSecretField) before[1][scenario.options.syntheticSecretField] = syntheticAccessKey();
  const { r, calls, original } = await actualCaller(dir, {
    sourceFindings: structuredClone(before), classifier: scenario.options.classifier,
    cap: scenario.options.maxCostUsd, mockOutcome: scenario.options.mockOutcome,
  });
  const expected = scenario.expected;
  assert.equal(calls.filter((url) => url === "https://api.openai.com/v1/chat/completions").length, expected.primaryGenerationRequests);
  assert.equal(calls.filter((url) => url === "https://api.typesafe.ai/v1/systemone").length, expected.classificationRequests);
  assert.deepEqual(r.aiSummary, evalEvidence.invariants.originalSummary);
  assert.deepEqual(original, before);
  assert.equal(r.usage.toolCalls, evalEvidence.invariants.generationUsageToolCalls);
  assert.equal(r.findings.length, before.length);
  r.findings.forEach((f, i) => {
    for (const field of evalEvidence.invariants.preservedFields) assert.equal(f[field], before[i][field], `${scenario.id}: original ${field}`);
    assert.equal(Object.hasOwn(f, "severityClassification"), expected.classificationPresent);
    if (expected.classificationPresent) assert.equal(f.severityClassification.severity, expected.candidateSeverity);
  });
  assert.equal(Object.hasOwn(r, "severityClassification"), expected.classificationPresent);
  if (expected.classificationPresent) {
    assert.equal(r.severityClassification.requestedModel, evalEvidence.mockClassification.model);
    assert.equal(r.severityClassification.dictionaryVersion, evalEvidence.sourceBinding.dictionaryVersion);
    assert.equal(r.severityClassification.status, expected.status);
    assert.equal(r.severityClassification.reason, expected.reason);
    assert.equal(r.severityClassification.authority, evalEvidence.invariants.classificationAuthority);
    assert.equal(r.severityClassification.usage !== null, expected.usageKnown);
    if (expected.usageKnown) assert.equal(r.severityClassification.usage.inputTokens, evalEvidence.mockClassification.usage.input_tokens);
  }
  const report = JSON.parse(await fsp.readFile(r.artifacts.reportJsonPath, "utf8"));
  assert.deepEqual(report.aiSummary, evalEvidence.invariants.originalSummary);
  assert.equal(Object.hasOwn(report, "severityClassification"), expected.classificationPresent);
  const history = JSON.parse(await fsp.readFile(r.cost.filePath, "utf8"));
  assert.equal(history.entries.filter((e) => e.provider === "openai").length, evalEvidence.invariants.generationHistoryEntries);
  assert.equal(history.entries.filter((e) => e.provider === "typesafe").length, evalEvidence.invariants.classifierCostHistoryEntries);
  t.diagnostic(JSON.stringify({ evidenceKind: "mock_contract_observation", scenario: scenario.id,
    generationRequests: calls.filter((url) => url === "https://api.openai.com/v1/chat/completions").length,
    classificationRequests: calls.filter((url) => url === "https://api.typesafe.ai/v1/systemone").length,
    originalSeverities: r.findings.map((f) => f.severity), originalSummary: r.aiSummary,
    status: r.severityClassification?.status || null, reason: r.severityClassification?.reason || null,
    candidates: r.findings.map((f) => f.severityClassification?.severity || null),
    generationHistoryEntries: history.entries.filter((e) => e.provider === "openai").length,
    classifierCostHistoryEntries: history.entries.filter((e) => e.provider === "typesafe").length }));
}));
