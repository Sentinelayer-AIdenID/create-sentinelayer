const { spawn, execFile } = require("node:child_process");
const readline = require("node:readline");

// Process lifecycle for the bundled notification wrapper. Commands use argv, never a shell.
function runListener({ me: ME, sessionId: SID, cliPath: CLI, cwd: CWD, pollCwd: POLL_CWD, wake: WAKE = null, classifier }) {
  const { deliver, observe, rememberMine, newerThanDelivered, flushBroadcasts } = classifier;
  const { hadReceiptAtBoot } = classifier.state();
  let restarts = 0;
  let startedAt = 0;

  function wanted(who) {
    if (who === ME) return false;
    return WAKE === null || WAKE.has(who);
  }

  function handle(line) {
    let e;
    try { e = JSON.parse(line); } catch {
      if (/error|Error|refused|403|401|stopped|wedged/i.test(line)) console.log("[raw] " + line.slice(0, 300));
      return;
    }
    const ev = e.event || "";
    const who = (e.agent && e.agent.id) || e.agentId || "?";
    if (who !== ME && (ev === "session_message" || ev === "session_reply")) observe(e.ts);
    if (who === ME) rememberMine(e.sequenceId);
    if (!wanted(who)) return;
    const p = e.payload || {};
    if (ev === "session_message" || ev === "session_reply") {
      const text = (p.message || p.note || "").replace(/\s+/g, " ");
      deliver(ev, who, e.ts, e.sequenceId, p.replyToSequenceId || p.targetSequenceId, text);
    } else if (ev === "daemon_alert" && p.alert && /human|directive|mention|assign|lock|stuck/i.test(p.alert) && (!p.targetAgentId || p.targetAgentId === ME)) {
      console.log(`[alert] ${p.alert} ${p.targetAgentId || ""} ${(p.message || "").slice(0, 200)}`);
    }
  }

  function start() {
    startedAt = Date.now();
    const p = spawn(process.execPath, [CLI, "session", "listen", "--session", SID, "--agent", ME,
      "--active-interval", "15", "--active-window", "600", "--interval", "15", "--presence-interval", "60",
      "--display-name", ME, "--force", "--from-now"],
      { cwd: CWD, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    readline.createInterface({ input: p.stdout }).on("line", handle);
    readline.createInterface({ input: p.stderr }).on("line", (l) => {
      if (/error|Error|refused|403|401|wedged|circuit/i.test(l)) console.log("[listener-stderr] " + l.slice(0, 300));
    });
    p.on("exit", (code, sig) => {
      const wasHealthy = Date.now() - startedAt > 60000;
      if (wasHealthy) restarts = 0;
      restarts++;
      if (!wasHealthy && (restarts === 2 || restarts % 25 === 0)) console.log(`[listener-flapping] code=${code} sig=${sig} rapid-restarts=${restarts}`);
      if (restarts > 500) { console.log("[listener-giving-up] too many rapid restarts"); process.exit(1); }
      setTimeout(start, 5000);
    });
  }
  start();

  const seenReplies = new Set();
  let repliesPrimed = false;
  function pollReplies() {
    execFile(process.execPath, [CLI, "session", "read", SID, "--remote", "--agent", ME, "--tail", "40", "--json"],
      { cwd: POLL_CWD, env: process.env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) { console.log("[reply-poll-error] " + String(err.message).slice(0, 200)); return; }
        let j; try { j = JSON.parse(stdout); } catch { return; }
        const items = [];
        for (const e of j.events || []) if (e.event === "session_reply" || e.event === "session_message")
          items.push({ key: (e.ts || "") + "|" + ((e.payload && (e.payload.targetSequenceId || e.payload.replyToSequenceId)) || ""), who: (e.agent && e.agent.id) || "?", ts: e.ts, target: e.payload && (e.payload.targetSequenceId || e.payload.replyToSequenceId), text: (e.payload && (e.payload.message || e.payload.note)) || "" });
        for (const a of j.recentHumanActivity || [])
          items.push({ key: (a.createdAt || "") + "|" + (a.targetSequenceId || ""), who: a.actorId || "human", ts: a.createdAt, target: a.targetSequenceId, text: a.note || "" });
        for (const it of items) {
          if (seenReplies.has(it.key)) continue;
          seenReplies.add(it.key);
          if (it.who !== ME) observe(it.ts);
          if (!repliesPrimed && !(hadReceiptAtBoot && newerThanDelivered(it.ts))) continue;
          if (!wanted(it.who)) continue;
          deliver("session_reply", it.who, it.ts, null, it.target, String(it.text).replace(/\s+/g, " "));
        }
        repliesPrimed = true;
      });
  }
  pollReplies();
  setInterval(pollReplies, 20000);
  console.log(`[listener-started] ${ME} listening on ${SID.slice(0, 8)} (presence heartbeats on; reply-poll every 20s)`);

  function flushAndExit(sig) {
    try { flushBroadcasts(); } catch {}
    process.exit(sig === "SIGINT" ? 130 : 0);
  }
  process.on("SIGTERM", () => flushAndExit("SIGTERM"));
  process.on("SIGINT", () => flushAndExit("SIGINT"));
}

module.exports = { runListener };
