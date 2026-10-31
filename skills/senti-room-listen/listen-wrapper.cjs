// Standalone: uses only Node built-ins, so installed skills need no npm install.
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const readline = require("node:readline");
const { parseArgs } = require("node:util");

function resolveCli({ env = process.env, platform = process.platform } = {}) {
  const windows = platform === "win32";
  const names = windows ? ["slc.exe", "slc.cmd", "sentinelayer-cli.cmd"] : ["sl", "slc", "sentinelayer-cli"];
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
  for (const name of names) {
    for (const dir of searchPath.split(windows ? ";" : path.delimiter)) {
      // Never search the current workspace implicitly or through a relative PATH entry.
      if (!path.isAbsolute(dir)) continue;
      const command = path.join(dir, name);
      try {
        if (!fs.statSync(command).isFile()) continue;
        if (name.endsWith(".cmd")) {
          // npm's global and local Windows shims. Invoke their Node entry directly,
          // keeping paths and ids out of cmd.exe shell interpolation.
          for (const entry of [
            path.join(dir, "node_modules/sentinelayer-cli/bin/sentinelayer-cli.js"),
            path.resolve(dir, "../sentinelayer-cli/bin/sentinelayer-cli.js"),
          ]) {
            if (fs.existsSync(entry) && fs.statSync(entry).isFile()) {
              return { command: process.execPath, prefix: [entry] };
            }
          }
          continue;
        }
        fs.accessSync(command, windows ? fs.constants.F_OK : fs.constants.X_OK);
        return { command, prefix: [] };
      } catch { /* Try the next installed executable. */ }
    }
  }
  throw new Error("Cannot find the installed CLI on PATH. Install sentinelayer-cli globally and expose sl (slc on Windows).");
}

function commandArgs(session, agent) {
  return {
    listen: ["session", "listen", "--session", session, "--agent", agent, "--emit", "ndjson",
      "--active-interval", "15", "--interval", "15", "--presence-interval", "60", "--from-now"],
    read: ["session", "read", session, "--remote", "--agent", agent, "--tail", "40", "--json"],
  };
}

const timestamp = (value) => Date.parse(String(value || ""));
const clip = (text, length) => text.length <= length ? text
  : `${text.slice(0, length)} …[CLIPPED +${text.length - length} chars; READ FULL BEFORE ACTING]`;

function createDelivery({ agent, stateDir, emit = console.log, flushMs = 180_000 }) {
  const receiptPath = path.join(stateDir, "last-delivered.json");
  let prior = {};
  try { prior = JSON.parse(fs.readFileSync(receiptPath, "utf8")); } catch { /* First start. */ }
  const bootTime = Date.now();
  const priorDelivered = timestamp(prior.deliveredMaxTs);
  const priorPending = timestamp(prior.oldestPendingTs);
  // Freeze this boundary at boot: delivering one catch-up event must not hide
  // another older event later in the same read response.
  const recoveryAfter = Number.isFinite(priorDelivered)
    ? Math.min(priorDelivered, Number.isFinite(priorPending) ? priorPending - 1 : Infinity)
    : Number.isFinite(priorPending) ? priorPending - 1 : bootTime;
  let delivered = Number.isFinite(priorDelivered) ? priorDelivered : 0;
  let observed = timestamp(prior.observedMaxTs) || 0;
  let pending = [];
  let timer;
  let stopped = false;
  const seen = new Set();
  const mine = new Set();
  function boundedAdd(set, key, limit) {
    set.add(key);
    if (set.size > limit) set.delete(set.values().next().value);
  }
  function save() {
    fs.writeFileSync(receiptPath, JSON.stringify({
      deliveredMaxTs: delivered ? new Date(delivered).toISOString() : null,
      observedMaxTs: observed ? new Date(observed).toISOString() : null,
      oldestPendingTs: pending.length ? new Date(Math.min(...pending.map((item) => item.time))).toISOString() : null,
      pendingCount: pending.length,
    }));
  }
  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (!pending.length) return;
    const items = pending;
    pending = [];
    const newest = items[items.length - 1];
    emit(`[room-digest] ${items.length} broadcast(s) from ${[...new Set(items.map((i) => i.who))].join(", ")}; newest: ${clip(newest.text, 500)}; READ THE ROOM for all messages`);
    delivered = Math.max(delivered, ...items.map((item) => item.time));
    save();
  }
  function ingest(event, { history = false } = {}) {
    if (stopped || !["session_message", "session_reply"].includes(event.event)) return;
    const who = event.agent?.id || event.agentId;
    const seq = event.sequenceId;
    if (who === agent) {
      if (seq != null) boundedAdd(mine, String(seq), 200);
      return;
    }
    const time = timestamp(event.ts);
    if (!who || !Number.isFinite(time)) return;
    observed = Math.max(observed, time);
    if (history && time <= recoveryAfter) return;
    const payload = event.payload || {};
    const text = String(payload.message || payload.note || "").replace(/\s+/g, " ");
    const target = payload.replyToSequenceId || payload.targetSequenceId;
    // Normalize timestamps across the stream and read API; include text so two
    // different messages by one sender in the same millisecond both survive.
    const key = JSON.stringify([who, time, text]);
    if (seen.has(key)) return;
    boundedAdd(seen, key, 1000);
    const mentions = new Set((text.match(/@[a-z0-9][a-z0-9-]*/gi) || []).map((m) => m.slice(1).toLowerCase()));
    if (event.humanActivity === true || /^human(?:[-_]|$)/i.test(who) || (mentions.has(agent) && mentions.size <= 2) || mine.has(String(target))) {
      emit(`[${event.event}] seq=${seq ?? "-"} ${who} ${event.ts} replyTo=${target || "-"} :: ${clip(text, 700)}`);
      delivered = Math.max(delivered, time);
    } else {
      pending.push({ who, time, text });
      if (pending.length >= 100) flush();
      else if (!timer) timer = setTimeout(flush, flushMs);
    }
    save();
  }
  return { ingest, flush, stop() { stopped = true; flush(); } };
}

function startListener({ session, agent, stateDir, emit = console.log, pollMs = 20_000, restartMs = 5000, maxRestarts = 50 }) {
  for (const [label, value] of [["session", session], ["agent", agent]]) {
    if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(value)) {
      throw new Error(`${label} must contain lowercase letters, digits and hyphens.`);
    }
  }
  const cli = resolveCli();
  const root = path.resolve(stateDir || path.join(".sentinelayer", "skill-listeners", session, agent));
  const listenDir = path.join(root, "listen");
  const pollDir = path.join(root, "poll");
  fs.mkdirSync(listenDir, { recursive: true });
  fs.mkdirSync(pollDir, { recursive: true });
  const delivery = createDelivery({ agent, stateDir: root, emit });
  const args = commandArgs(session, agent);
  let stopped = false;
  let child;
  let pollChild;
  let restartTimer;
  let pollTimer;
  let restarts = 0;
  let primed = false;
  let reportedListenError = false;
  const readers = new Set();
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(restartTimer);
    clearTimeout(pollTimer);
    for (const reader of readers) reader.close();
    child?.kill();
    pollChild?.kill();
    delivery.stop();
  }
  function start() {
    if (stopped) return;
    const began = Date.now();
    child = spawn(cli.command, [...cli.prefix, ...args.listen], {
      cwd: listenDir, env: process.env, stdio: ["pipe", "pipe", "pipe"],
    });
    // An OPEN pipe is required: the CLI exits when stdin closes.
    const reader = readline.createInterface({ input: child.stdout });
    readers.add(reader);
    reader.on("close", () => readers.delete(reader));
    reader.on("line", (line) => {
      if (stopped) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.event === "session_listen_error") {
        if (!reportedListenError) emit("[listener-error] event delivery failed; inspect listener and admission status");
        reportedListenError = true;
        return;
      }
      reportedListenError = false;
      delivery.ingest(event);
    });
    child.stderr.resume();
    child.on("error", () => { /* close below also handles a failed spawn. */ });
    child.on("close", (code) => {
      if (stopped) return;
      restarts = Date.now() - began > 60_000 ? 1 : restarts + 1;
      if (restarts === 1 || restarts % 25 === 0) emit(`[listener-restart] exit=${code}; check admission and listener status if this repeats`);
      if (restarts > maxRestarts) {
        emit("[listener-giving-up] repeated failures; inspect CLI authentication and admission status");
        process.exitCode = 1;
        stop();
        return;
      }
      restartTimer = setTimeout(start, restartMs);
    });
  }
  function poll() {
    if (stopped) return;
    pollChild = execFile(cli.command, [...cli.prefix, ...args.read], {
      cwd: pollDir, env: process.env, timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout) => {
      if (stopped) return;
      if (error) emit("[reply-poll-error] read failed; inspect CLI authentication and admission status");
      else {
        let data;
        try { data = JSON.parse(stdout); } catch { emit("[reply-poll-error] invalid JSON response"); }
        if (data) {
          const events = [...(data.events || [])];
          for (const activity of data.recentHumanActivity || []) {
            const action = activity.actionType || activity.action_type;
            if (action !== "reply" && action !== "comment") continue;
            // This collection is the CLI's projection of server human activity.
            events.push({ event: "session_reply", humanActivity: true,
              agentId: activity.actorId || activity.actor_id || "human",
              ts: activity.createdAt || activity.created_at || activity.ts,
              payload: { message: activity.note, targetSequenceId: activity.targetSequenceId || activity.target_sequence_id } });
          }
          events.sort((a, b) => timestamp(a.ts) - timestamp(b.ts));
          for (const event of events) delivery.ingest(event, { history: !primed });
          primed = true;
        }
      }
      pollTimer = setTimeout(poll, pollMs);
    });
  }
  start();
  poll();
  emit(`[listener-started] ${agent}; verify the host delivers output notifications`);
  return { stop };
}

module.exports = { resolveCli, commandArgs, createDelivery, startListener };
if (require.main === module) {
  try {
    const { values } = parseArgs({ options: {
      session: { type: "string" }, agent: { type: "string" }, "state-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    } });
    if (values.help) {
      console.log("Usage: node listen-wrapper.cjs --session ROOM_ID --agent AGENT_ID [--state-dir DIRECTORY]");
    } else {
      const listener = startListener({ session: values.session, agent: values.agent, stateDir: values["state-dir"] });
      process.once("SIGINT", listener.stop);
      process.once("SIGTERM", listener.stop);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
