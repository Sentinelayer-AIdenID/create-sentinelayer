// Run the wrapper as an entrypoint with fake child processes, never a real room connection.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const children = require("node:child_process");
const me = process.env.SENTI_AGENT_ID;
const sid = process.env.SENTI_SESSION_ID;
const cli = process.env.SENTI_CLI_PATH;
const cwd = path.join(os.homedir(), ".sentinelayer", "skill-listeners", sid, me);
const stamp = (seconds) => `2026-09-06T04:38:${seconds}.000Z`;
const event = (who, seconds, text, extra = {}) => ({
  event: "session_message", agent: { id: who }, ts: stamp(seconds), sequenceId: 7,
  payload: { message: text, ...extra },
});
const reply = event("agent-reviewer", "11", "reply without mention", { replyToSequenceId: 7 });
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(path.join(cwd, "last-delivered.json"), JSON.stringify({ deliveredMaxTs: stamp("10") }));
let spawns = 0;
let polls = 0;
let poll;
let listener;
const timers = new Set();
global.setTimeout = (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer; };
global.clearTimeout = (timer) => timers.delete(timer);
global.setInterval = (fn, ms) => { assert.equal(ms, 20000); poll = fn; };
children.spawn = (command, args, options) => {
  assert.equal(command, process.execPath);
  assert.deepEqual(args, [cli, "session", "listen", "--session", sid, "--agent", me,
    "--active-interval", "15", "--active-window", "600", "--interval", "15", "--presence-interval", "60",
    "--display-name", me, "--force", "--from-now"]);
  assert.equal(options.cwd, cwd);
  assert.equal(options.env, process.env);
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(options.shell, undefined);
  listener = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  spawns++;
  return listener;
};
children.execFile = (command, args, options, callback) => {
  assert.equal(command, process.execPath);
  assert.deepEqual(args, [cli, "session", "read", sid, "--remote", "--agent", me, "--tail", "40", "--json"]);
  assert.equal(options.cwd, path.join(cwd, "reply-poll"));
  assert.equal(options.maxBuffer, 16 * 1024 * 1024);
  assert.equal(options.env, process.env);
  assert.equal(options.shell, undefined);
  polls++;
  process.nextTick(() => callback(null, JSON.stringify({ events: [
    event("human", "09", "old history"), reply, event("human", "12", "recovered poll message"),
  ] })));
};
// Drive both ingestion paths after the entrypoint installs its handlers.
process.nextTick(() => {
  listener.stdout.write(JSON.stringify(event(me, "10", "own post")) + "\n");
  listener.stdout.write(JSON.stringify(reply) + "\n");
  listener.stdout.write(JSON.stringify(event("human", "11", "x".repeat(800))) + "\n");
  listener.stdout.write(JSON.stringify(event("agent-peer", "15", "buffer this broadcast")) + "\n");
});
setImmediate(() => {
  assert.equal(spawns, 1);
  assert.equal(polls, 1);
  listener.emit("exit", 0, null);
  const restart = [...timers].find((timer) => timer.ms === 5000 && timer.fn.name === "start");
  assert.ok(restart, "listener restart must be scheduled after five seconds");
  restart.fn();
  assert.equal(spawns, 2);
  poll();
  setImmediate(() => {
    assert.equal(polls, 2);
    process.emit("SIGTERM");
  });
});
process.on("exit", () => {
  const receipt = JSON.parse(fs.readFileSync(path.join(cwd, "last-delivered.json"), "utf8"));
  assert.equal(receipt.deliveredMaxTs, stamp("15"));
  assert.equal(receipt.observedMaxTs, stamp("15"));
  assert.equal(receipt.pendingCount, 0);
  assert.equal(receipt.oldestPendingTs, null);
  console.log("PROBE PASS");
});
