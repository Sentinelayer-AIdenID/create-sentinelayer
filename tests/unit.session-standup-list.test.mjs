import "./setup-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { formatSessionStandup, sessionStandup } from "../src/session/standup.js";

const API = "https://api.fixture.invalid";
const NOW = "2026-06-03T12:00:00.000Z";
process.env.SENTINELAYER_API_URL = API;
process.env.SENTINELAYER_API_ALLOWED_HOSTS = "api.fixture.invalid";

function ticket(overrides = {}) {
  return { id: "sample-ticket", title: "Sample work", status: "done", updatedAt: NOW,
    hasDoneVerdict: true, lastVerdict: { verdict: "done", checkedAt: NOW },
    completion: { source: "client_asserted", verified: false }, ...overrides };
}

async function readList(items, pagination = {}) {
  const body = { items, count: items.length, hasMore: false, staleClaimAfterSeconds: 900,
    nextBeforeId: null, ...pagination };
  return sessionStandup("sample-session", {
    resolveAuthSession: async () => ({ token: ["fixture", "only"].join("-"), apiUrl: API }),
    requestRead: async (url, init) => {
      assert.equal(url, `${API}/api/v1/sessions/sample-session/tickets?limit=200`);
      assert.equal(init.method, "GET");
      return structuredClone(body);
    },
  });
}

test("standup accepts a live list verdict without inventing evidence details", async () => {
  const report = await readList([ticket()]);
  assert.equal(report.accepted.length, 1);
  assert.equal(report.reportedButUnverified.length, 0);
  assert.deepEqual(report.accepted[0].verdict.evidence, []);
  assert.deepEqual(report.accepted[0].completion, { source: "client_asserted", verified: false });
  assert.ok(formatSessionStandup(report).includes(
    `re-checkable verdict on record (details not in this read; checked ${NOW})`));
});

test("standup accepts a live list verdict with an unknown check time", async () => {
  for (const lastVerdict of [{ verdict: "done", checkedAt: null }, { verdict: "done" },
    { verdict: "done", checkedAt: "invalid" }, null]) {
    const report = await readList([ticket({ lastVerdict })]);
    assert.equal(report.accepted.length, 1);
    assert.ok(formatSessionStandup(report).includes(
      "re-checkable verdict on record (details not in this read; checked unknown)"));
  }
});

test("standup labels an omitted owner statement in a live list read", async () => {
  const owner = ticket({ completion: { source: "owner_attested", verified: false } });
  const report = await readList([owner]);
  assert.equal(report.ownerAttested.length, 1);
  assert.equal(report.accepted.length, 0);
  assert.equal(report.ownerAttested[0].ownerAttestation.statement, null);
  assert.match(formatSessionStandup(report), /Owner-attested \(unverified\)[\s\S]*statement not in this read/);

  const detailed = await readList([{ ...owner, doneVerdict: {
    kind: "owner-attested", statement: "Completed a manual check", attestedBy: "owner", attestedAt: NOW,
  } }]);
  assert.match(formatSessionStandup(detailed), /Completed a manual check/);
  assert.doesNotMatch(formatSessionStandup(detailed), /statement not in this read/);
});

test("standup requires a recorded verdict for either live list completion source", async () => {
  for (const source of ["client_asserted", "owner_attested"]) {
    for (const hasDoneVerdict of [false, null]) {
      const report = await readList([ticket({ hasDoneVerdict, completion: { source, verified: false } })]);
      assert.equal(report.reportedButUnverified.length, 1, `${source}: ${hasDoneVerdict}`);
      assert.equal(report.accepted.length, 0);
      assert.equal(report.ownerAttested.length, 0);
    }
  }
});

test("standup detects a live list nextBeforeId on a short page", async () => {
  const report = await readList([ticket()], { nextBeforeId: "older-ticket" });
  assert.equal(JSON.parse(JSON.stringify(report)).truncated, true);
  assert.match(formatSessionStandup(report), /board.*truncated/i);
  const more = await readList([ticket()], { hasMore: true });
  assert.equal(more.truncated, true);
  const terminal = await readList([ticket()]);
  assert.equal(terminal.truncated, false);
  assert.doesNotMatch(formatSessionStandup(terminal), /truncated/i);
});
