import "./setup-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionStandup, formatSessionStandup, sessionStandup } from "../src/session/standup.js";

const API = "https://api.fixture.invalid";
const NOW = "2026-06-03T12:00:00.000Z";
process.env.SENTINELAYER_API_URL = API;
process.env.SENTINELAYER_API_ALLOWED_HOSTS = "api.fixture.invalid";

function ticket(id, overrides = {}) {
  return { id, title: `Work ${id}`, status: "done", updatedAt: NOW, unaccepted: false,
    hasDoneVerdict: true, lastVerdict: { verdict: "done", checkedAt: null },
    completion: { source: "client_asserted", verified: false }, ...overrides };
}

async function readBoard(body, options = {}) {
  const requests = [];
  const report = await sessionStandup("sample-session", {
    resolveAuthSession: async () => ({ token: ["fixture", "only"].join("-"), apiUrl: API }),
    requestRead: async (url, init) => {
      requests.push({ url, method: init.method });
      return structuredClone(body);
    }, ...options,
  });
  return { report, requests };
}

test("standup reads every known claim from doneVerdict with a summary-only lastVerdict", () => {
  const report = buildSessionStandup([ticket("evidence", {
    acceptedBy: "worker", assignee: "worker",
    doneVerdict: { verdict: "done", evidence: [
      { kind: "pr-merged", pr: 7 },
      { kind: "sha-on-branch", sha: "abcdef1234567890", branch: "main" },
      { kind: "check-conclusive", check: "unit checks" },
      { kind: "deploy-sha", sha: "123456abcdef7890" },
      { kind: "pr-merged", url: "https://example.com/pull/8" },
      { kind: "future-kind", ref: "untrusted claim" }, null,
    ] },
  })]);
  assert.equal(report.accepted.length, 1);
  assert.deepEqual(report.accepted[0].verdict.evidence, [
    { kind: "pr-merged", reference: "#7" },
    { kind: "sha-on-branch", reference: "abcdef123456" },
    { kind: "check-conclusive", reference: "unit checks" },
    { kind: "deploy-sha", reference: "123456abcdef" },
    { kind: "pr-merged", reference: "https://example.com/pull/8" },
  ]);
  assert.deepEqual(report.accepted[0].completion, { source: "client_asserted", verified: false });
  const output = formatSessionStandup(report);
  for (const claim of report.accepted[0].verdict.evidence) {
    assert.ok(output.includes(`${claim.kind} ${claim.reference}`));
  }
  assert.doesNotMatch(output, /accepted by:|future-kind|untrusted claim/);
});

test("standup never accepts a summary, unknown claim kind or completion flag as evidence", () => {
  const valid = { verdict: "done", evidence: [{ kind: "pr-merged", pr: 7 }] };
  const report = buildSessionStandup([
    ticket("legacy", { lastVerdict: { verdict: "done", kind: "pr-merged", ref: "#7" } }),
    ticket("unknown-kind", { doneVerdict: { verdict: "done", evidence: [{ kind: "future-kind", url: "https://example.com" }] } }),
    ...[null, {}, "claims", [null, {}, { kind: "merged_pr" }]].map((evidence, i) =>
      ticket(`malformed-${i}`, { doneVerdict: { verdict: "done", evidence } })),
    ticket("false-flag", { hasDoneVerdict: false, doneVerdict: valid }),
    ticket("string-flag", { hasDoneVerdict: "true", doneVerdict: valid }),
    ticket("completion-only", { completion: { source: "client_asserted", verified: true } }),
    ticket("not-done", { status: "working", doneVerdict: valid }),
  ]);
  assert.equal(report.accepted.length, 0);
  assert.equal(report.reportedButUnverified.length, 9);
  assert.equal(report.inProgress.length, 1);
});

test("standup accepts a known claim without inventing a missing reference", () => {
  const report = buildSessionStandup([ticket("no-reference", {
    doneVerdict: { verdict: "done", evidence: [{ kind: "pr-merged", pr: {}, sha: [], url: false }] },
  })]);
  assert.equal(report.accepted.length, 1);
  assert.deepEqual(report.accepted[0].verdict.evidence, [{ kind: "pr-merged", reference: null }]);
  assert.ok(report.accepted[0].unknown.includes("verdict.reference"));
  assert.match(formatSessionStandup(report), /pr-merged unknown/);
});

test("standup labels owner statements unverified even alongside evidence claims", () => {
  for (const source of ["owner_attested", "client_asserted"]) {
    const report = buildSessionStandup([ticket("statement", {
      completion: { source, verified: false },
      doneVerdict: { verdict: "done", kind: "owner-attested", statement: "Completed a manual check",
        attestedBy: "owner", attestedAt: NOW, verified: false,
        evidence: [{ kind: "pr-merged", pr: 7 }] },
    })]);
    assert.equal(report.ownerAttested?.length, 1);
    assert.equal(report.accepted.length, 0);
    assert.deepEqual(report.ownerAttested[0].ownerAttestation, {
      statement: "Completed a manual check", attestedBy: "owner", attestedAt: NOW, verified: false,
    });
    assert.match(formatSessionStandup(report), /Owner-attested \(unverified\)[\s\S]*owner.*Completed a manual check/);
  }
  const missing = buildSessionStandup([ticket("missing-statement", {
    completion: { source: "owner_attested", verified: false },
  })]);
  assert.equal(missing.accepted.length, 0);
  assert.ok(missing.ownerAttested[0].unknown.includes("ownerAttestation.statement"));
});

test("standup keeps claim references short and untrusted evidence and statements on one terminal line", () => {
  const hostile = "check\n\u001b[31m\u009b\u2028\u2029\u202e" + "x".repeat(300);
  const report = buildSessionStandup([
    ticket("claim", { doneVerdict: { verdict: "done", evidence: [{ kind: "check-conclusive", check: hostile }] } }),
    ticket("owner", { completion: { source: "owner_attested", verified: false },
      doneVerdict: { verdict: "done", kind: "owner-attested", statement: hostile, attestedBy: hostile, verified: false } }),
  ]);
  assert.equal(report.accepted.length, 1);
  assert.ok(report.accepted[0].verdict.evidence[0].reference.length <= 80);
  assert.equal(report.ownerAttested[0].ownerAttestation.statement, hostile);
  const output = formatSessionStandup(report);
  assert.match(output, /check-conclusive/);
  assert.doesNotMatch(output, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028-\u202e]/);
  assert.equal(output.split("\n").filter((line) => line.includes("Work claim")).length, 1);
  assert.equal(output.split("\n").filter((line) => line.includes("Work owner")).length, 1);
});

test("standup requests the maximum board page in one GET", async () => {
  const { requests } = await readBoard({ items: [] });
  assert.deepEqual(requests, [{ url: `${API}/api/v1/sessions/sample-session/tickets?limit=200`, method: "GET" }]);
});

for (const marker of [{ hasMore: true }, { nextCursor: "next-page" }, { nextAfterId: "next-ticket" }]) {
  test(`standup reports truncation in text and JSON for ${Object.keys(marker)[0]}`, async () => {
    const { report } = await readBoard({ items: [ticket("one")], ...marker });
    assert.equal(JSON.parse(JSON.stringify(report)).truncated, true);
    assert.match(formatSessionStandup(report), /board.*truncated/i);
  });
}

test("standup marks a full page truncated before date filtering or duplicate coalescing", async () => {
  const items = Array.from({ length: 200 }, () => ticket("old", { updatedAt: "2026-06-01T00:00:00Z" }));
  const { report } = await readBoard({ items, hasMore: false }, { since: NOW });
  assert.equal(report.truncated, true);
  assert.equal(report.accepted.length, 0);
  assert.equal(report.reportedButUnverified.length, 0);
  assert.match(formatSessionStandup(report), /board.*truncated/i);
});

test("standup reports a short terminal page without a truncation warning", async () => {
  const { report } = await readBoard({ items: [], hasMore: false, nextCursor: null, nextAfterId: null });
  assert.equal(report.truncated, false);
  assert.doesNotMatch(formatSessionStandup(report), /truncated/i);
});

test("standup places known active statuses in plain sections and retains owner-decision priority", () => {
  const statuses = ["open", "assigned", "accepted", "blocked", "in_review"];
  const report = buildSessionStandup(statuses.flatMap((status) => [
    ticket(status, { status }), ticket(`${status}-unaccepted`, { status, unaccepted: true }),
  ]).concat(ticket("unknown", { status: null })));
  assert.deepEqual(report.open?.map((t) => t.id), ["accepted", "assigned", "open"]);
  assert.deepEqual(report.blocked.map((t) => t.id), ["blocked"]);
  assert.deepEqual(report.inReview.map((t) => t.id), ["in_review"]);
  assert.equal(report.needsOwnerDecision.length, 5);
  assert.deepEqual(report.unknown.map((t) => t.id), ["unknown"]);
  const output = formatSessionStandup(report);
  for (const heading of ["Open", "Blocked", "In review"]) assert.ok(output.includes(`\n${heading}\n`));
  for (const item of [...report.open, ...report.blocked, ...report.inReview]) {
    assert.ok(!item.unknown.includes("classification"));
  }
});
