import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const require = createRequire(import.meta.url);
const { createDelivery, resolveCli, startListener } = require("../skills/senti-room-listen/listen-wrapper.cjs");
const AGENT = "example-agent";
const event = (who, ts, message, extra = {}) => ({
  event: "session_message", agentId: who, ts, payload: { message }, ...extra,
});
async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skills-listener-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("listener filters self/reactions, deduplicates timestamp formats and coalesces broadcasts", async (t) => {
  const stateDir = await temporary(t);
  const lines = [];
  const delivery = createDelivery({ agent: AGENT, stateDir, emit: (line) => lines.push(line) });
  t.after(delivery.stop);
  const ts = "2026-01-01T01:02:03.123Z";
  delivery.ingest(event(AGENT, ts, "mine", { sequenceId: 7 }));
  delivery.ingest(event("human-example", ts, "new message"));
  delivery.ingest(event("human-example", "2026-01-01T01:02:03.123000+00:00", "new message"));
  delivery.ingest(event("human-example", ts, "distinct message at the same time"));
  delivery.ingest(event("teammate", ts, "ack", { event: "session_action" }));
  delivery.ingest(event("teammate", ts, "answer", {
    event: "session_reply", payload: { note: "answer", targetSequenceId: 7 },
  }));
  assert.equal(lines.length, 3);
  delivery.ingest(event("teammate", ts, "@example-agent-extra broadcast"));
  assert.equal(lines.length, 3, "a prefix match is not a direct mention");
  delivery.flush();
  assert.equal(lines.length, 4);
  assert.match(lines[3], /1 broadcast/);
  delivery.flush();
  assert.equal(lines.length, 4, "an empty flush stays quiet");
  delivery.ingest(event("teammate", ts, `@${AGENT} ${"x".repeat(750)}`));
  assert.match(lines[4], /CLIPPED/);
});

test("listener recovers a pending broadcast even when a newer direct reply was delivered before restart", async (t) => {
  const stateDir = await temporary(t);
  const delivery = createDelivery({ agent: AGENT, stateDir, emit() {} });
  const pending = event("teammate", "2026-01-01T01:00:00Z", "buffered work");
  const direct = event("human-example", "2026-01-01T01:00:01Z", "direct work");
  delivery.ingest(pending);
  delivery.ingest(direct);
  const receipt = path.join(stateDir, "last-delivered.json");
  const atCrash = await readFile(receipt, "utf8");
  delivery.stop();
  // Restore only the actual receipt captured before cleanup to simulate a kill.
  await writeFile(receipt, atCrash);
  const lines = [];
  const restarted = createDelivery({ agent: AGENT, stateDir, emit: (line) => lines.push(line) });
  t.after(restarted.stop);
  restarted.ingest(direct, { history: true });
  restarted.ingest(pending, { history: true });
  restarted.flush();
  assert.equal(lines.length, 2);
  assert.match(lines[1], /buffered work/);
  assert.equal(JSON.parse(await readFile(receipt, "utf8")).pendingCount, 0);
});

test("listener resolves PATH executables and Windows npm slc without a shell", async (t) => {
  const dir = await temporary(t);
  const unix = path.join(dir, "sl");
  await writeFile(unix, "#!/bin/sh\nexit 0\n");
  await chmod(unix, 0o755);
  assert.deepEqual(resolveCli({ env: { PATH: dir }, platform: "linux" }), { command: unix, prefix: [] });
  assert.throws(() => resolveCli({ env: { PATH: ".:" }, platform: "linux" }), /Cannot find/);
  const binDir = path.join(dir, "node_modules/sentinelayer-cli/bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(dir, "slc.cmd"), "@rem npm shim fixture\n");
  const entry = path.join(binDir, "sentinelayer-cli.js");
  await writeFile(entry, "// executable fixture\n");
  assert.deepEqual(resolveCli({ env: { Path: dir }, platform: "win32" }), { command: process.execPath, prefix: [entry] });
});

test("real wrapper spawns CLI, catches replies, keeps stdin open, restarts and stops its children", async (t) => {
  const dir = await temporary(t);
  const fixture = path.join(dir, "sl");
  const calls = path.join(dir, "calls.ndjson");
  await writeFile(calls, "");
  const stamp = new Date(Date.now() + 1000).toISOString();
  await writeFile(path.join(dir, "fixture.json"), JSON.stringify({ stamp, calls }));
  await writeFile(fixture, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(config.calls, JSON.stringify({ args, cwd: process.cwd(), pid: process.pid }) + '\\n');
if (args[1] === 'listen') {
  const marker = path.join(__dirname, 'started');
  if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'yes'); process.exit(2); }
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(3));
  console.log(JSON.stringify({ event: 'session_message', agentId: 'human-example', ts: config.stamp, payload: { message: 'stream message' } }));
} else {
  console.log(JSON.stringify({ events: [
    { event: 'session_message', agentId: 'human-example', ts: config.stamp.replace('Z', '000+00:00'), payload: { message: 'stream message' } }
  ], recentHumanActivity: [
    { actionType: 'reply', actorId: 'human-example', createdAt: config.stamp, targetSequenceId: 8, note: 'reply action' },
    { actionType: 'like', actorId: 'human-example', createdAt: config.stamp, targetSequenceId: 8, note: 'reaction' }
  ] }));
}
`);
  await chmod(fixture, 0o755);
  // The Windows resolver follows an npm shim to this same executable fixture.
  const windowsBin = path.join(dir, "node_modules/sentinelayer-cli/bin");
  await mkdir(windowsBin, { recursive: true });
  await writeFile(path.join(dir, "slc.cmd"), "@rem npm shim fixture\n");
  await writeFile(path.join(windowsBin, "sentinelayer-cli.js"), `require(${JSON.stringify(fixture)});\n`);
  const oldPath = process.env.PATH;
  process.env.PATH = dir;
  t.after(() => { process.env.PATH = oldPath; });
  const lines = [];
  const listener = startListener({ session: "example-room", agent: AGENT,
    stateDir: path.join(dir, "state"), emit: (line) => lines.push(line), pollMs: 25, restartMs: 25 });
  t.after(listener.stop);
  let recorded = [];
  for (let attempt = 0; attempt < 250; attempt += 1) {
    await delay(20);
    recorded = (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    if (recorded.filter((call) => call.args[1] === "listen").length >= 2 && lines.some((line) => line.includes("reply action"))) break;
  }
  await delay(100);
  assert.equal(lines.filter((line) => line.includes("stream message")).length, 1);
  assert.equal(lines.filter((line) => line.includes("reply action")).length, 1);
  assert.equal(lines.filter((line) => line.includes("reaction")).length, 0);
  assert.equal(recorded.filter((call) => call.args[1] === "listen").length, 2);
  assert.notEqual(recorded.find((call) => call.args[1] === "listen").cwd,
    recorded.find((call) => call.args[1] === "read").cwd);
  const listenPid = recorded.filter((call) => call.args[1] === "listen").at(-1).pid;
  process.kill(listenPid, 0);
  listener.stop();
  await delay(150);
  assert.throws(() => process.kill(listenPid, 0), { code: "ESRCH" });
  const countAtStop = (await readFile(calls, "utf8")).length;
  await delay(100);
  assert.equal((await readFile(calls, "utf8")).length, countAtStop);
});
