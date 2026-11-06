import "./setup-env.mjs";

import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  extractJudgeVerdictBlock,
  formatJudgeVerdictBlock,
  renderJudgeVerdictMessage,
  validateJudgeVerdict,
} from "../src/judge/verdict.js";
import { createSessionMcpToolHandlers, SESSION_MCP_TOOLS } from "../src/mcp/session-stdio-server.js";
import { postJudgeVerdictToApi } from "../src/session/sync.js";
import { buildCliProgram } from "../src/cli.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const casesFile = JSON.parse(await fs.readFile(path.join(root, "tests", "fixtures", "judge-verdict-cases.json"), "utf8"));
const caseDoc = (name) => structuredClone(casesFile.cases.find((item) => item.name === name).doc);

before(() => {
  delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
});

// ---------------------------------------------------------------------------------- schema

test("judge verdict: every shared agreement case validates exactly as the API contract says", () => {
  assert.equal(casesFile.schema, "judge-verdict-cases/v1");
  assert.ok(casesFile.cases.length >= 80);
  assert.ok(casesFile.cases.some((item) => item.valid) && casesFile.cases.some((item) => !item.valid));
  const disagreements = casesFile.cases
    .filter((item) => validateJudgeVerdict(item.doc).ok !== item.valid)
    .map((item) => item.name);
  assert.deepEqual(disagreements, []);
});

test("judge verdict: no identity field is accepted, whatever it is called", () => {
  for (const key of ["judge", "judgeAgentId", "agentId", "reviewer", "author"]) {
    const result = validateJudgeVerdict({ ...caseDoc("changes-pr-basic"), [key]: "judge-1" });
    assert.equal(result.ok, false, key);
    assert.ok(result.errors.some((error) => error.path === key), key);
  }
});

test("judge verdict: normalization trims ASCII edges, fills defaults and lowercases the sha", () => {
  const doc = caseDoc("changes-pr-basic");
  delete doc.maxRounds;
  doc.target.sha = "  9F2C1AB ";
  doc.coder = " coder-1 ";
  doc.summary = "\n  Needs one fix.  ";
  doc.comments[0].file = " src/api/orders.js ";
  const result = validateJudgeVerdict(doc);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.verdict.maxRounds, 3);
  assert.equal(result.verdict.target.sha, "9f2c1ab");
  assert.equal(result.verdict.coder, "coder-1");
  assert.equal(result.verdict.summary, "Needs one fix.");
  assert.equal(result.verdict.comments[0].file, "src/api/orders.js");
  assert.equal(result.verdict.escalate, false);
  assert.equal(result.verdict.doNotTrain, false);
  // Single-line fields refuse every control character, even one trimming would remove.
  assert.equal(validateJudgeVerdict({ ...caseDoc("changes-pr-basic"), coder: "coder-1\t" }).ok, false);
  // A control character is judged on the raw value, before trimming.
  assert.equal(validateJudgeVerdict({ ...caseDoc("changes-pr-basic"), summary: "\u000bok" }).ok, false);
  // Lengths are code points: 2000 astral characters fit, 2001 do not.
  assert.equal(validateJudgeVerdict({ ...caseDoc("changes-pr-basic"), summary: "\u{1F600}".repeat(2000) }).ok, true);
  assert.equal(validateJudgeVerdict({ ...caseDoc("changes-pr-basic"), summary: "\u{1F600}".repeat(2001) }).ok, false);
});

// ---------------------------------------------------------------------------------- message

test("judge verdict: the message wakes the coder, numbers each comment and round-trips the block", () => {
  const { verdict } = validateJudgeVerdict(caseDoc("changes-pr-basic"));
  const message = renderJudgeVerdictMessage(verdict);
  assert.match(message, /^@coder-1 Judge verdict: CHANGES \(round 1 of 3\) on acme\/app#41 @ 9f2c1ab\n/);
  assert.match(message, /\n1\. \[P1\] src\/api\/orders\.js:88 - An empty cart returns 500\.\n   Fix: Return 422 EMPTY_CART before pricing\.\n/);
  assert.ok(message.endsWith(formatJudgeVerdictBlock(verdict)));
  const extracted = extractJudgeVerdictBlock(message);
  assert.equal(extracted.status, "one");
  assert.deepEqual(validateJudgeVerdict(extracted.document).verdict, verdict);
});

test("judge verdict: escalation mentions the human; ACCEPT and whole-file comments read plainly", () => {
  const escalated = validateJudgeVerdict(caseDoc("changes-final-round-escalated")).verdict;
  const message = renderJudgeVerdictMessage(escalated, { escalateTo: ["human-owner"] });
  assert.match(message, /^@coder-1 @human-owner Judge verdict: CHANGES \(round 3 of 3\)/);
  assert.match(message, /Round limit reached/);
  // Escalation handles are only mentioned when the verdict escalates.
  const ordinary = validateJudgeVerdict(caseDoc("changes-pr-basic")).verdict;
  assert.doesNotMatch(renderJudgeVerdictMessage(ordinary, { escalateTo: ["human-owner"] }), /@human-owner/);
  const accepted = renderJudgeVerdictMessage(validateJudgeVerdict(caseDoc("accept-no-comments")).verdict);
  assert.match(accepted, /Judge verdict: ACCEPT/);
  assert.match(accepted, /Accepted\. No further rounds\./);
  const wholeFile = renderJudgeVerdictMessage(validateJudgeVerdict(caseDoc("line-zero-whole-file")).verdict);
  assert.match(wholeFile, /\n1\. \[P1\] src\/a\.js - /);
  const ticket = renderJudgeVerdictMessage(validateJudgeVerdict(caseDoc("ticket-target-no-sha")).verdict);
  assert.match(ticket, /on ticket TKT-2041\n/);
});

test("judge verdict: block extraction takes exactly one block and ignores everything else", () => {
  const doc = caseDoc("changes-pr-basic");
  const fence = (info, body) => `\`\`\`${info}\n${body}\n\`\`\``;
  assert.equal(extractJudgeVerdictBlock("no block here").status, "none");
  assert.equal(extractJudgeVerdictBlock(fence("judge-verdict", "{not json")).status, "none");
  assert.equal(extractJudgeVerdictBlock(fence("json", JSON.stringify({ kind: "other" }))).status, "none");
  assert.equal(extractJudgeVerdictBlock(fence("python", JSON.stringify(doc))).status, "none");
  assert.equal(extractJudgeVerdictBlock(`text ${fence("judge-verdict", JSON.stringify(doc))}`).status, "none",
    "a fence must open at the start of a line");
  const asJson = extractJudgeVerdictBlock(`See below\n${fence("json", JSON.stringify(doc, null, 2))}\nthanks`);
  assert.equal(asJson.status, "one");
  assert.deepEqual(asJson.document, doc);
  const crlf = extractJudgeVerdictBlock(`hi\r\n\`\`\`judge-verdict\r\n${JSON.stringify(doc)}\r\n\`\`\`\r\n`);
  assert.equal(crlf.status, "one");
  const twice = `${fence("judge-verdict", JSON.stringify(doc))}\n${fence("json", JSON.stringify(doc))}`;
  assert.deepEqual(extractJudgeVerdictBlock(twice), { status: "ambiguous", document: null });
});

test("judge verdict: the block scanner agrees with every shared vector", async () => {
  const blocks = JSON.parse(await fs.readFile(path.join(root, "tests", "fixtures", "judge-verdict-block-cases.json"), "utf8"));
  assert.equal(blocks.schema, "judge-verdict-block-cases/v1");
  const disagreements = blocks.cases.filter((item) => {
    const found = extractJudgeVerdictBlock(item.message);
    return found.status !== item.status || (item.status === "one" && found.document.round !== item.round);
  }).map((item) => item.name);
  assert.deepEqual(disagreements, []);
});

test("judge verdict: a block over 64 KiB is skipped unparsed; one just under is read", () => {
  const filler = (bytes) => ({ ...caseDoc("accept-no-comments"), summary: "s".repeat(bytes) });
  const message = (doc) => `\`\`\`judge-verdict\n${JSON.stringify(doc)}\n\`\`\``;
  const under = filler(65_536 - JSON.stringify(filler(0)).length);
  assert.equal(JSON.stringify(under).length, 65_536);
  assert.equal(extractJudgeVerdictBlock(message(under)).status, "one");
  assert.equal(extractJudgeVerdictBlock(message(filler(65_537 - JSON.stringify(filler(0)).length))).status, "none");
  // Whitespace after a valid document is still valid JSON; the cap, not a parse error, is what refuses it.
  const padded = `\`\`\`judge-verdict\n${JSON.stringify(caseDoc("accept-no-comments"))}\n${" ".repeat(70_000)}\n\`\`\``;
  assert.equal(extractJudgeVerdictBlock(padded).status, "none");
});

test("judge verdict: scanning a maximum-size hostile post stays linear (unclosed and many fences)", async () => {
  const limit = 128_000;
  const hostile = [
    ("judge-verdict\n" + "```json\n".repeat(20_000)).slice(0, limit),
    ("judge-verdict\n" + "```json\n{ \"a\": [1,\n".repeat(20_000)).slice(0, limit),
    ("judge-verdict\n" + "```json\n{bad\n```\n".repeat(20_000)).slice(0, limit),
    ("judge-verdict\n```json\n" + "x".repeat(limit)).slice(0, limit),
    ("```json\n" + "{".repeat(limit)).slice(0, limit),
  ];
  for (const text of hostile) {
    const started = performance.now();
    assert.notEqual(extractJudgeVerdictBlock(text).status, "one");
    assert.ok(performance.now() - started < 250, `scan took ${performance.now() - started} ms`);
  }
  // The coder's inbox reads five such posts in one poll.
  const events = hostile.slice(0, 5).map((text, index) => evt(`c${index}`, "judge-1", { message: text, to: ["coder-1"] }));
  const handlers = createSessionMcpToolHandlers({
    targetPath: "workspace",
    pollSessionEventsFn: async () => ({ ok: true, cursor: "c9", events }),
    listSessionMessageActionsFn: async () => ({ ok: true, actions: [], projection: { recentActivity: [] } }),
    updateSessionReadCursorFn: async () => ({ ok: true, updated: true }),
  });
  const started = performance.now();
  const inbox = await handlers.poll_inbox({ sessionId: "sess-1", agentId: "coder-1", cursor: "c0" });
  assert.equal(inbox.ok, true);
  assert.ok(performance.now() - started < 1000, `poll took ${performance.now() - started} ms`);
});

// ---------------------------------------------------------------------------------- MCP tool

function evt(cursor, agentId, payload) {
  return { event: "session_message", cursor, sessionId: "sess-1", ts: "2026-11-06T00:00:00.000Z", agent: { id: agentId }, payload };
}

// `admitted` stands for the admission scope the tool runs in (null: the person's own token). A harness
// with an API stub runs as judge-1's own admission unless told otherwise.
function judgeHarness({ api = null, admitted = api ? { sessionId: "sess-1", agentId: "judge-1" } : null } = {}) {
  const calls = [];
  const synced = [];
  const handlers = createSessionMcpToolHandlers({
    targetPath: "workspace",
    currentAdmittedAgentFn: () => admitted,
    uuidFn: () => "uuid-1",
    now: () => "2026-11-06T00:00:00.000Z",
    postJudgeVerdictToApiFn: async (sessionId, verdict) => {
      calls.push("api");
      if (!api) throw new Error("the API route must not be called");
      return api(sessionId, verdict);
    },
    pollSessionEventsBeforeFn: async () => {
      calls.push("anchor");
      return { ok: true, cursor: "cursor-anchor", events: [evt("cursor-anchor", "coder-1", { message: "ready for review" })] };
    },
    syncSessionEventToApiFn: async (sessionId, event) => {
      calls.push("sync");
      synced.push({ sessionId, event });
      return { synced: true, status: 202 };
    },
    pollSessionEventsFn: async () => {
      calls.push("confirm");
      const last = synced.at(-1)?.event;
      return { ok: true, cursor: "cursor-post", events: last ? [evt("cursor-post", last.agent.id, last.payload)] : [] };
    },
    appendToStreamFn: async (sessionId, event) => {
      calls.push("cache");
      return { ...event, cursor: "cursor-post", sequenceId: 12 };
    },
  });
  return { handlers, calls, synced };
}

test("judge_verdict tool: is listed with a strict input schema", () => {
  const tool = SESSION_MCP_TOOLS.find((item) => item.name === "judge_verdict");
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ["sessionId", "agentId", "verdict"]);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.properties.via.enum, ["auto", "api", "room"]);
});

test("judge_verdict tool: an invalid verdict or a self-judgement sends nothing", async () => {
  const { handlers, calls } = judgeHarness();
  const invalid = await handlers.judge_verdict({ sessionId: "sess-1", agentId: "judge-1", verdict: caseDoc("changes-without-comments") });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "invalid_verdict");
  assert.ok(invalid.errors.some((error) => error.path === "comments"));
  const self = await handlers.judge_verdict({ sessionId: "sess-1", agentId: "Coder-1", verdict: caseDoc("changes-pr-basic") });
  assert.equal(self.reason, "self_judgement");
  await assert.rejects(handlers.judge_verdict({ sessionId: "sess-1", agentId: "judge-1", verdict: caseDoc("changes-pr-basic"), via: "email" }), /via must be/);
  await assert.rejects(handlers.judge_verdict({ sessionId: "sess-1", agentId: "human-owner", verdict: caseDoc("changes-pr-basic") }), /non-human agent id/);
  assert.deepEqual(calls, []);
});

test("judge_verdict tool: dry run returns the rendered message and sends nothing", async () => {
  const { handlers, calls } = judgeHarness();
  const result = await handlers.judge_verdict({ sessionId: "sess-1", agentId: "judge-1", verdict: caseDoc("changes-pr-basic"), dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.message, renderJudgeVerdictMessage(result.verdict));
  assert.deepEqual(calls, []);
});

test("judge_verdict tool: via room posts one message that mentions and addresses the coder", async () => {
  const { handlers, calls, synced } = judgeHarness();
  const input = { sessionId: "sess-1", agentId: "judge-1", verdict: caseDoc("changes-pr-basic"), via: "room" };
  const result = await handlers.judge_verdict(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.transport, "room");
  assert.deepEqual(calls, ["anchor", "sync", "confirm", "cache"]);
  const { event } = synced[0];
  assert.equal(event.event, "session_message");
  assert.equal(event.agent.id, "judge-1");
  assert.equal(event.agent.role, "reviewer");
  assert.deepEqual(event.payload.to, ["coder-1"]);
  assert.equal(event.payload.message, renderJudgeVerdictMessage(result.verdict));
  assert.equal(extractJudgeVerdictBlock(event.payload.message).status, "one");
  assert.match(event.eventId, /^judge-[0-9a-f]{32}$/);
  // The same verdict for the same round resolves to the same idempotency key, so a retry dedupes.
  const again = judgeHarness();
  await again.handlers.judge_verdict(input);
  assert.equal(again.synced[0].event.eventId, event.eventId);
  const nextRound = judgeHarness();
  await nextRound.handlers.judge_verdict({ ...input, verdict: { ...caseDoc("changes-pr-basic"), round: 2 } });
  assert.notEqual(nextRound.synced[0].event.eventId, event.eventId);
});

test("judge_verdict tool: a long verdict is posted whole, never cut through its block", async () => {
  const { handlers, synced } = judgeHarness();
  const verdict = caseDoc("changes-pr-basic");
  verdict.comments = Array.from({ length: 12 }, (_, index) => ({
    file: `src/module-${index}.js`, line: index + 1, severity: "P2", text: "x".repeat(1500), fix: "y".repeat(400),
  }));
  const result = await handlers.judge_verdict({ sessionId: "sess-1", agentId: "judge-1", verdict, via: "room" });
  assert.equal(result.ok, true);
  const { message, truncated } = synced[0].event.payload;
  assert.ok(message.length > 16_000, "this verdict is longer than an ordinary post");
  assert.equal(truncated, undefined);
  assert.equal(extractJudgeVerdictBlock(message).status, "one");
});

test("judge verdict: the coder's inbox and history keep a long verdict whole; other long posts are still cut", async () => {
  const doc = caseDoc("changes-pr-basic");
  doc.comments = Array.from({ length: 15 }, (_, index) => ({
    file: `src/module-${index}.js`, line: index + 1, severity: "P2", text: "x".repeat(1500), fix: "y".repeat(400),
  }));
  const verdictMessage = renderJudgeVerdictMessage(validateJudgeVerdict(doc).verdict);
  const serverDelivery = `@coder-1 Judge verdict from judge-1: CHANGES\n${"z".repeat(30_000)}`;
  const ordinary = "w".repeat(20_000);
  assert.ok(verdictMessage.length > 40_000);
  const events = [
    evt("c1", "judge-1", { message: verdictMessage, to: ["coder-1"] }),
    evt("c2", "senti", { message: serverDelivery, to: ["coder-1"], judgeVerdict: { id: "v-1", verdict: "CHANGES" } }),
    evt("c3", "judge-1", { message: ordinary, to: ["coder-1"] }),
  ];
  const handlers = createSessionMcpToolHandlers({
    targetPath: "workspace",
    pollSessionEventsFn: async () => ({ ok: true, cursor: "c3", events }),
    pollSessionEventsBeforeFn: async () => ({ ok: true, cursor: "c3", events }),
    listSessionMessageActionsFn: async () => ({ ok: true, actions: [], projection: { recentActivity: [] } }),
    updateSessionReadCursorFn: async () => ({ ok: true, updated: true }),
  });
  const inbox = await handlers.poll_inbox({ sessionId: "sess-1", agentId: "coder-1", cursor: "c0" });
  const history = await handlers.read_history({ sessionId: "sess-1", agentId: "coder-1" });
  for (const result of [inbox, history]) {
    assert.equal(result.ok, true, result.reason);
    const [judged, delivered, other] = result.events;
    assert.equal(judged.payload.message, verdictMessage);
    assert.equal(judged.payload.truncated, undefined);
    assert.deepEqual(validateJudgeVerdict(extractJudgeVerdictBlock(judged.payload.message).document).verdict.comments.length, 15);
    assert.equal(delivered.payload.message, serverDelivery);
    assert.equal(other.payload.message.length, 16_000);
    assert.equal(other.payload.truncated, true);
  }
});

test("judge_verdict tool: an escalation to named people goes as a room message, never through the route", async () => {
  const verdict = caseDoc("changes-final-round-escalated");
  const auto = judgeHarness({ api: async () => ({ ok: true, status: 201, code: "", body: {}, reason: "" }) });
  const sent = await auto.handlers.judge_verdict({ sessionId: "sess-1", agentId: "judge-1", verdict, escalateTo: ["human-owner"] });
  assert.equal(sent.ok, true);
  assert.equal(sent.transport, "room");
  assert.equal(sent.roomBecause, "escalate_to_named_handles");
  assert.deepEqual(auto.calls, ["anchor", "sync", "confirm", "cache"], "the route is not called");
  assert.match(auto.synced[0].event.payload.message, /^@coder-1 @human-owner /);

  const forced = judgeHarness();
  const refused = await forced.handlers.judge_verdict({ sessionId: "sess-1", agentId: "judge-1", verdict, escalateTo: "human-owner", via: "api" });
  assert.deepEqual([refused.ok, refused.reason], [false, "escalate_to_needs_room_transport"]);
  assert.deepEqual(forced.calls, []);

  // Without named people the route is used; the server mentions the room owner itself.
  const ownerOnly = judgeHarness({ api: async () => ({ ok: true, status: 201, code: "", body: {}, reason: "" }) });
  const viaApi = await ownerOnly.handlers.judge_verdict({ sessionId: "sess-1", agentId: "judge-1", verdict });
  assert.equal(viaApi.transport, "api");
  assert.deepEqual(ownerOnly.calls, ["api"]);
});

test("judge_verdict tool: without the agent's own admission the verdict goes as a room message, never the route", async () => {
  const apiOk = async () => ({ ok: true, status: 201, code: "", body: {}, reason: "" });
  const input = { sessionId: "sess-1", agentId: "judge-1", verdict: caseDoc("changes-pr-basic") };
  // The person's own token (no admission scope), another agent's admission, another room's admission.
  for (const admitted of [null, { sessionId: "sess-1", agentId: "coder-1" }, { sessionId: "sess-2", agentId: "judge-1" }]) {
    const harness = judgeHarness({ api: apiOk, admitted });
    const result = await harness.handlers.judge_verdict(input);
    assert.equal(result.ok, true, JSON.stringify(admitted));
    assert.equal(result.transport, "room");
    assert.equal(result.roomBecause, "no_agent_credential");
    assert.deepEqual(harness.calls, ["anchor", "sync", "confirm", "cache"], "the route is never called");
    assert.equal(harness.synced[0].event.agent.id, "judge-1", "the post is the agent's, checked against its grant");

    const forced = judgeHarness({ api: apiOk, admitted });
    const refused = await forced.handlers.judge_verdict({ ...input, via: "api" });
    assert.deepEqual([refused.ok, refused.reason], [false, "api_needs_agent_credential"]);
    assert.deepEqual(forced.calls, [], "refused before any request");
  }
});

test("judge_verdict tool: auto uses the API route when the server has it", async () => {
  const seen = [];
  const { handlers, calls } = judgeHarness({
    api: async (sessionId, verdict) => {
      seen.push({ sessionId, verdict });
      return { ok: true, status: 201, code: "", body: { verdict: { id: "v-1" } }, reason: "" };
    },
  });
  const result = await handlers.judge_verdict({ sessionId: "sess-1", agentId: "judge-1", verdict: caseDoc("changes-pr-basic") });
  assert.equal(result.ok, true);
  assert.equal(result.transport, "api");
  assert.deepEqual(calls, ["api"]);
  assert.deepEqual(seen[0].verdict, validateJudgeVerdict(caseDoc("changes-pr-basic")).verdict);
  assert.equal(result.api.body.verdict.id, "v-1");
});

test("judge_verdict tool: auto falls back to the room only when the route is absent", async () => {
  const absent = judgeHarness({ api: async () => ({ ok: false, status: 404, code: "", body: { detail: "Not Found" }, reason: "api_404" }) });
  const fellBack = await absent.handlers.judge_verdict({ sessionId: "sess-1", agentId: "judge-1", verdict: caseDoc("changes-pr-basic") });
  assert.equal(fellBack.ok, true);
  assert.equal(fellBack.transport, "room");
  assert.equal(fellBack.fellBackFrom, "api_route_absent");
  assert.deepEqual(absent.calls, ["api", "anchor", "sync", "confirm", "cache"]);

  for (const refusal of [
    { status: 404, code: "SESSION_NOT_FOUND" },
    { status: 404, code: "TARGET_NOT_FOUND" },
    { status: 422, code: "JUDGE_VERDICT_INVALID" },
    { status: 409, code: "VERDICT_CONFLICT" },
    { status: 403, code: "FORBIDDEN" },
    { status: 0, code: "" },
  ]) {
    const harness = judgeHarness({ api: async () => ({ ok: false, ...refusal, body: null, reason: `api_${refusal.status}` }) });
    const result = await harness.handlers.judge_verdict({ sessionId: "sess-1", agentId: "judge-1", verdict: caseDoc("changes-pr-basic") });
    assert.equal(result.ok, false, JSON.stringify(refusal));
    assert.equal(result.transport, "api");
    assert.deepEqual(harness.calls, ["api"], `no room post after ${JSON.stringify(refusal)}`);
  }

  const forced = judgeHarness({ api: async () => ({ ok: false, status: 404, code: "", body: null, reason: "api_404" }) });
  const viaApi = await forced.handlers.judge_verdict({ sessionId: "sess-1", agentId: "judge-1", verdict: caseDoc("changes-pr-basic"), via: "api" });
  assert.equal(viaApi.ok, false);
  assert.deepEqual(forced.calls, ["api"]);
});

// ---------------------------------------------------------------------------------- API transport

test("judge verdict API transport: posts only the document to the room's judge-verdicts route", async () => {
  const requests = [];
  const respond = (status, body) => ({ ok: status < 300, status, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body), body: null });
  const session = { ["to" + "ken"]: "placeholder-not-a-credential", apiUrl: "https://api.sentinelayer.com" };
  const verdict = validateJudgeVerdict(caseDoc("changes-pr-basic")).verdict;
  let reply = respond(201, { verdict: { id: "v-1" } });
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return reply;
  };
  const ok = await postJudgeVerdictToApi("room 1", verdict, { resolveAuthSession: async () => session, fetchImpl });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 201);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "https://api.sentinelayer.com/api/v1/sessions/room%201/judge-verdicts");
  assert.deepEqual(requests[0].body, verdict, "the body is the verdict document and nothing else");
  assert.ok(requests[0].headers.get("authorization"));

  reply = respond(404, { error: { code: "SESSION_NOT_FOUND", message: "Session not found.", request_id: "req-1" } });
  const missing = await postJudgeVerdictToApi("room-1", verdict, { resolveAuthSession: async () => session, fetchImpl });
  assert.deepEqual([missing.ok, missing.status, missing.code], [false, 404, "SESSION_NOT_FOUND"]);

  const signedOut = await postJudgeVerdictToApi("room-1", verdict, { resolveAuthSession: async () => ({}), fetchImpl });
  assert.equal(signedOut.reason, "not_authenticated");
  const pathEscape = await postJudgeVerdictToApi("room/../admin", verdict, { resolveAuthSession: async () => session, fetchImpl });
  assert.equal(pathEscape.reason, "invalid_input");
  assert.equal(requests.length, 2);
});

// ---------------------------------------------------------------------------------- CLI

function sl(home, args, input) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.SENTINELAYER_CLI_SKIP_AUTH;
  delete env.SENTINELAYER_AGENT_ID;
  return spawnSync(process.execPath, [path.join(root, "bin", "sl.js"), ...args], {
    cwd: home, env, input, encoding: "utf8", timeout: 20000,
  });
}

test("sl judge check: validates offline, without login, and prints what the coder receives", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sl-judge-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const good = path.join(home, "verdict.json");
  await fs.writeFile(good, JSON.stringify(caseDoc("changes-final-round-escalated")));
  const checked = sl(home, ["judge", "check", "--file", good, "--escalate-to", "human-owner", "--json"]);
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  const payload = JSON.parse(checked.stdout);
  assert.equal(payload.ok, true);
  assert.match(payload.message, /^@coder-1 @human-owner Judge verdict: CHANGES/);
  assert.equal(extractJudgeVerdictBlock(payload.message).status, "one");

  const text = sl(home, ["judge", "check", "--stdin"], JSON.stringify(caseDoc("accept-no-comments")));
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Judge verdict: ACCEPT/);

  const bad = path.join(home, "bad.json");
  await fs.writeFile(bad, JSON.stringify(caseDoc("judge-field-in-body")));
  const refused = sl(home, ["judge", "check", "--file", bad, "--json"]);
  assert.equal(refused.status, 1);
  assert.ok(JSON.parse(refused.stdout).errors.some((error) => error.path === "judge"));

  await fs.writeFile(bad, "{nope");
  const notJson = sl(home, ["judge", "check", "--file", bad]);
  assert.equal(notJson.status, 1);
  assert.match(notJson.stderr, /not valid JSON/);
});

test("sl judge verdict: sending needs a login; the help lists the judge commands", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sl-judge-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const file = path.join(home, "verdict.json");
  await fs.writeFile(file, JSON.stringify(caseDoc("changes-pr-basic")));
  const result = sl(home, ["judge", "verdict", "example-room", "--agent", "judge-1", "--file", file]);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /Authentication required/);
  const help = sl(home, ["--help"]);
  assert.match(help.stdout, /sl judge check/);
  assert.match(help.stdout, /sl judge verdict/);
});

test("sl judge: both commands stay off the MCP CLI bridge; MCP clients use judge_verdict", async () => {
  const { buildCliCommandMcpTools } = await import("../src/mcp/cli-command-tools.js");
  const tools = await buildCliCommandMcpTools({ buildProgramFn: async () => buildCliProgram({ invokeLegacy: async () => {} }) });
  for (const name of ["sl.judge.check", "sl.judge.verdict"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `expected bridge tool ${name} to exist`);
    assert.equal(tool.security.runtime_blocked, true, name);
    assert.equal(tool.security.runtime_block_reason, "blocked_sensitive_cli_command", name);
  }
});

// ---------------------------------------------------------------------------------- scan --spec-file

test("sl scan init: an explicit --spec-file is read (setup regression)", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sl-scan-spec-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, "docs"), { recursive: true });
  await fs.writeFile(path.join(home, "docs", "product.md"), "# Spec\n\n## Goal\nHarden auth and payment flows.\n");
  const output = [];
  const log = console.log;
  console.log = (...args) => output.push(args.join(" "));
  try {
    const program = await buildCliProgram({ invokeLegacy: async () => {}, onlyCommand: "scan" });
    await program.parseAsync(["node", "sl", "scan", "init", "--path", home, "--spec-file", "docs/product.md", "--non-interactive", "--json"]);
  } finally {
    console.log = log;
  }
  const payload = JSON.parse(output.join("\n"));
  assert.equal(payload.command, "scan init");
  assert.equal(payload.specPath, path.join(home, "docs", "product.md"));
  const workflow = await fs.readFile(path.join(home, ".github", "workflows", "omar-gate.yml"), "utf8");
  assert.match(workflow, /SENTINELAYER_TOKEN/);
});
