import "./setup-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Command } from "commander";
import { registerSessionCommand } from "../src/commands/session.js";
import { admittedAgentScope } from "../src/auth/admission-scope.js";
import { SESSION_AGENT_PRINCIPAL } from "../src/session/admission-auth.js";
import { sessionRouteClass } from "../src/session/route-classes.js";

const API = "https://api.fixture.invalid";
const SID = "sample-session";
const NOW = "2026-06-03T12:00:00.000Z";
process.env.SENTINELAYER_API_URL = API;
process.env.SENTINELAYER_API_ALLOWED_HOSTS = "api.fixture.invalid";
process.env.SENTINELAYER_TOKEN = "fixture-only";

function record(id, overrides = {}) {
  return { id, title: `Work ${id}`, status: "open", updatedAt: NOW,
    createdAt: "2026-06-01T12:00:00Z", unaccepted: false, ...overrides };
}

async function standup(items, args = ["--json"], { body = { items }, status = 200 } = {}) {
  const originalFetch = globalThis.fetch, originalLog = console.log;
  const requests = [], lines = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init.method, authorization: new Headers(init.headers).get("authorization") });
    assert.equal(String(url), `${API}/api/v1/sessions/${SID}/tickets`);
    assert.equal(init.method, "GET");
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  console.log = (...parts) => lines.push(parts.join(" "));
  const program = new Command().exitOverride().configureOutput({ writeOut() {}, writeErr() {} });
  registerSessionCommand(program);
  try {
    await program.parseAsync(["session", "standup", SID, ...args], { from: "user" });
    const text = lines.join("\n");
    return { text, json: args.includes("--json") ? JSON.parse(text) : null, requests };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
}

test("standup accepts only done records with a verdict kind and reference; text matches JSON", async () => {
  const items = [record("verified", { status: "done", hasDoneVerdict: true,
    acceptedBy: "reviewer", lastVerdict: { kind: "merged_pr", ref: "https://example.com/pull/7" } })];
  const { json, requests } = await standup(items);
  assert.equal(json.accepted.length, 1);
  assert.deepEqual(json.accepted[0].verdict, { kind: "merged_pr", reference: "https://example.com/pull/7" });
  assert.equal(json.accepted[0].acceptedBy, "reviewer");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, "Bearer fixture-only");
  const { text } = await standup(items, []);
  for (const heading of ["Accepted", "Reported but unverified", "In progress", "Needs an owner decision", "Unknown"]) {
    assert.ok(text.includes(heading), heading);
  }
  assert.match(text, /merged_pr.*https:\/\/example.com\/pull\/7/);
  assert.match(text, /verified.*Work verified/);
});

test("standup keeps manual completion and verdicts without references unverified", async () => {
  const { json } = await standup([
    record("manual", { status: "done", hasDoneVerdict: false, completion: { verified: false } }),
    record("flag-only", { status: "done", hasDoneVerdict: true, lastVerdict: { kind: "merged_pr" } }),
    record("completion-only", { status: "done", completion: { verified: true } }),
    record("no-done-verdict", { status: "done", hasDoneVerdict: false, lastVerdict: { kind: "review", ref: "review-2" } }),
  ]);
  assert.equal(json.accepted.length, 0);
  assert.deepEqual(json.reportedButUnverified.map((t) => t.id), ["completion-only", "flag-only", "manual", "no-done-verdict"]);
  assert.ok(json.reportedButUnverified.find((t) => t.id === "flag-only").unknown.includes("verdict.reference"));
});

test("standup reports assignee, claim time and stale claims without inventing missing evidence", async () => {
  const items = [record("active", { status: "working", assignee: "worker", claimedAt: "2026-06-02T10:00:00Z", staleClaim: true }),
    record("incomplete", { status: "in_progress" })];
  const { json } = await standup(items);
  assert.equal(json.inProgress.length, 2);
  assert.equal(json.inProgress[0].assignee, "worker");
  assert.equal(json.inProgress[0].claimedAt, "2026-06-02T10:00:00.000Z");
  assert.equal(json.inProgress[0].staleClaim, true);
  assert.equal(json.inProgress[1].assignee, null);
  assert.equal(json.inProgress[1].claimedAt, null);
  assert.equal(json.inProgress[1].staleClaim, null);
  const { text } = await standup(items, []);
  assert.match(text, /worker.*2026-06-02T10:00:00.000Z.*STALE/);
  assert.match(text, /assignee: unknown.*since: unknown/);
});

test("standup lists unaccepted tickets oldest first, placing unknown ages last", async () => {
  const { json } = await standup([
    record("recent", { unaccepted: true, createdAt: "2026-06-02T00:00:00Z" }),
    record("undated", { unaccepted: true, createdAt: null }),
    record("oldest", { unaccepted: true, createdAt: "2026-05-01T00:00:00Z" }),
  ]);
  assert.deepEqual(json.needsOwnerDecision.map((t) => t.id), ["oldest", "recent", "undated"]);
  assert.ok(json.needsOwnerDecision[2].unknown.includes("createdAt"));
});

test("standup retains unknown records and never derives completion from titles or assignment", async () => {
  const { json } = await standup([
    record("missing", { status: null, title: "Done: release", assignee: "worker" }),
    record("malformed", { status: {}, hasDoneVerdict: "true", unaccepted: "true" }),
    { status: "done", hasDoneVerdict: true, lastVerdict: { kind: "review", ref: "review-1" } },
  ]);
  assert.equal(json.unknown.length, 3);
  assert.equal(json.accepted.length, 0);
  assert.equal(json.inProgress.length, 0);
  assert.equal(json.needsOwnerDecision.length, 0);
  assert.ok(json.unknown.find((t) => t.id === null).unknown.includes("id"));
});

test("standup applies an inclusive ISO window to updatedAt and marks missing time unknown", async () => {
  const { json } = await standup([
    record("before", { status: "working", updatedAt: "2026-06-02T11:59:59Z" }),
    record("boundary", { status: "working", updatedAt: "2026-06-02T12:00:00Z" }),
    record("later", { status: "working" }),
    record("undated", { status: "working", updatedAt: null }),
  ], ["--since", "2026-06-02T14:00:00+02:00", "--json"]);
  assert.equal(json.since, "2026-06-02T12:00:00.000Z");
  assert.deepEqual(json.inProgress.map((t) => t.id), ["boundary", "later"]);
  assert.deepEqual(json.unknown.map((t) => t.id), ["undated"]);
  assert.ok(json.unknown[0].unknown.includes("updatedAt"));
});

test("standup resolves 24h once and has no implicit window when since is omitted", async (t) => {
  t.mock.method(Date, "now", () => Date.parse(NOW));
  const items = [record("old", { unaccepted: true, updatedAt: "2026-05-01T00:00:00Z" }),
    record("boundary", { unaccepted: true, updatedAt: "2026-06-02T12:00:00Z" })];
  const windowed = await standup(items, ["--since", "24h", "--json"]);
  assert.equal(windowed.json.since, "2026-06-02T12:00:00.000Z");
  assert.deepEqual(windowed.json.needsOwnerDecision.map((t) => t.id), ["boundary"]);
  const all = await standup(items);
  assert.equal(all.json.since, null);
  assert.equal(all.json.needsOwnerDecision.length, 2);
});

test("standup coalesces by id using the newest whole record, independently of input order", async () => {
  const old = record("same", { status: "done", updatedAt: "2026-06-01T00:00:00Z", hasDoneVerdict: true,
    lastVerdict: { kind: "merged_pr", ref: "https://example.com/pull/1" } });
  const current = record("same", { status: "done", hasDoneVerdict: true });
  const items = [old, current, { ...current }];
  const first = await standup(items);
  const second = await standup(items.toReversed());
  assert.deepEqual(first.json, second.json);
  assert.equal(first.json.accepted.length, 0);
  assert.equal(first.json.reportedButUnverified.length, 1);
  assert.equal(first.json.reportedButUnverified[0].verdict.reference, null);
});

test("standup treats conflicting duplicate evidence at equal or unknown times as unknown", async () => {
  const first = record("conflict", { status: "done", hasDoneVerdict: true, lastVerdict: { kind: "review", ref: "review-1" } });
  for (const updatedAt of [NOW, null]) {
    const items = [first, record("conflict", { status: "working", updatedAt })];
    const { json } = await standup(items);
    assert.equal(json.accepted.length, 0);
    assert.equal(json.unknown.length, 1);
    assert.match(json.unknown[0].unknown.join(" "), /conflicting duplicate/);
    assert.deepEqual(json, (await standup(items.toReversed())).json);
  }
});

test("standup refuses invalid windows and malformed board responses", async () => {
  for (const since of ["yesterday", "12h", "2026-02-30T00:00:00Z", "2026-06-03", "2026-06-03T00:00:00"]) {
    await assert.rejects(standup([], ["--since", since, "--json"]), /since.*24h.*ISO/);
  }
  await assert.rejects(standup([], ["--json"], { body: {} }), /ticket.*response.*items/i);
});

for (const status of [403, 404]) {
  test(`standup refuses HTTP ${status} with a clear error and a nonzero CLI exit`, async () => {
    await assert.rejects(standup([], ["--json"], { status }), new RegExp(`Standup refused.*${status}`));
    const script = `
      process.env.SENTINELAYER_API_URL = ${JSON.stringify(API)};
      process.env.SENTINELAYER_API_ALLOWED_HOSTS = "api.fixture.invalid";
      process.env.SENTINELAYER_TOKEN = "fixture-only";
      await import('./src/commands/session.js');
      globalThis.fetch = async () => new Response('{}', { status: ${status} });
      process.argv = [process.execPath, 'bin/sl.js', 'session', 'standup', ${JSON.stringify(SID)}, '--json'];
      await import('./bin/sl.js');
    `;
    const child = spawnSync(process.execPath, ["--import", "./tests/setup-env.mjs", "--input-type=module", "--eval", script],
      { cwd: new URL("..", import.meta.url), env: { ...process.env, SENTINELAYER_AGENT_ID: "" }, encoding: "utf8", timeout: 20000 });
    // The real entrypoint reads its arguments from process.argv.
    assert.equal(child.error, undefined);
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, new RegExp(`Standup refused.*${status}`));
  });
}

test("standup preserves admitted caller authority and is classified like ticket reads", async () => {
  assert.equal(SESSION_AGENT_PRINCIPAL.standup, "actor");
  assert.equal(sessionRouteClass("cli:session standup"), "control");
  const result = await admittedAgentScope.run({ sessionId: SID, agentId: "worker", admissionId: "fixture-admission",
    apiUrl: API, token: "admitted-fixture-only", expiresAt: Date.now() / 1000 + 60 }, () => standup([]));
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].authorization, "Bearer admitted-fixture-only");
});
