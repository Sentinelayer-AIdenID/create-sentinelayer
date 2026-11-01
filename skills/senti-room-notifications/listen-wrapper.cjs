const path = require("path");
const os = require("os");
const ME = process.env.SENTI_AGENT_ID;
const SID = process.env.SENTI_SESSION_ID;
const CLI = process.env.SENTI_CLI_PATH;
if (!ME || !SID || !CLI || !/^[a-zA-Z0-9_-]+$/.test(ME) || !/^[a-zA-Z0-9_-]+$/.test(SID)) {
  console.error("Set SENTI_AGENT_ID, SENTI_SESSION_ID and SENTI_CLI_PATH before starting the listener.");
  process.exit(1);
}
const CWD = path.join(os.homedir(), ".sentinelayer", "skill-listeners", SID, ME);
const POLL_CWD = path.join(CWD, "reply-poll");
const WAKE = null;

const { spawn, execFile } = require("child_process");
const fs = require("fs");
fs.mkdirSync(POLL_CWD, { recursive: true });
const readline = require("readline");
let restarts = 0;
let startedAt = 0;


function clip(s, n) {
  const t = String(s);
  return t.length <= n ? t : t.slice(0, n) + ` …[CLIPPED +${t.length - n} chars — READ FULL BEFORE ACTING/QUOTING]`;
}

// ── RECEIPT BLOCK START (sliced verbatim by test-receipt.js) ──
const RECEIPT = CWD + "/last-delivered.json";
let deliveredMaxTs = "";
let observedMaxTs = "";
let hadReceiptAtBoot = false;
try {
  const prior = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
  if (prior && prior.deliveredMaxTs) { deliveredMaxTs = String(prior.deliveredMaxTs); hadReceiptAtBoot = true; }
  if (prior && prior.observedMaxTs) observedMaxTs = String(prior.observedMaxTs);
} catch {}
function tsMs(ts) { const ms = Date.parse(String(ts || "")); return Number.isNaN(ms) ? -1 : ms; }
function newerThanDelivered(ts) { return tsMs(ts) > tsMs(deliveredMaxTs); }
let lastStateWrite = 0;
let stateTimer = null;
function writeState(force) {
  const now = Date.now();
  if (!force && now - lastStateWrite < 5000) {
    if (!stateTimer) stateTimer = setTimeout(() => { stateTimer = null; writeState(true); }, 5000);
    return;
  }
  if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
  lastStateWrite = now;
  const pending = broadcastBuf.length ? broadcastBuf : [];
  try {
    fs.writeFileSync(RECEIPT, JSON.stringify({
      deliveredMaxTs, observedMaxTs,
      pendingCount: pending.length,
      oldestPendingTs: pending.length ? pending[0].ts : null,
      wroteAt: new Date().toISOString(),
    }));
  } catch {}
}
function observe(ts) {
  const v = String(ts || "");
  if (tsMs(v) <= tsMs(observedMaxTs)) return;
  observedMaxTs = v;
  writeState(false);
}
function receipt(ts) {
  const v = String(ts || "");
  if (!newerThanDelivered(v)) return;
  deliveredMaxTs = v;
  if (tsMs(v) > tsMs(observedMaxTs)) observedMaxTs = v;
  writeState(true);
}

// ── RECEIPT BLOCK END ──
const BROADCAST_FLUSH_MS = 180000;
const ADDRESSED_MAX_MENTIONS = 2;
let broadcastBuf = [];
let broadcastTimer = null;
const mySeqs = new Set();

function rememberMine(seq) {
  if (!seq) return;
  mySeqs.add(String(seq));
  if (mySeqs.size > 200) mySeqs.delete(mySeqs.values().next().value);
}
function repliesToMe(target) { return !!target && mySeqs.has(String(target)); }
function mentionCount(text) {
  const m = String(text || "").match(/@[A-Za-z][A-Za-z0-9._-]{2,}/g);
  return m ? new Set(m.map((x) => x.toLowerCase())).size : 0;
}
function isHuman(who) { return /^human([-_]|$)/i.test(String(who || "")); }
function addressedToMe(text) {
  return String(text || "").toLowerCase().includes(ME.toLowerCase())
    && mentionCount(text) <= ADDRESSED_MAX_MENTIONS;
}
function flushBroadcasts() {
  broadcastTimer = null;
  if (!broadcastBuf.length) return;
  const items = broadcastBuf; broadcastBuf = [];
  const senders = [...new Set(items.map((i) => i.who))].join(",");
  const manifest = items.map((i) => `${i.who}@${String(i.ts || "").slice(11, 19)}`).slice(0, 14).join(" ");
  const newest = items[items.length - 1];
  console.log(`[room-digest] ${items.length} broadcast(s) from ${senders} in ${BROADCAST_FLUSH_MS / 1000}s; newest ${newest.who} ${newest.ts} :: ${clip(newest.text, 500)} — READ THE ROOM for the others | batched: ${manifest}${items.length > 14 ? " +" + (items.length - 14) + " more" : ""}`);
  receipt(newest.ts);
}
const deliveredKeys = new Set();
function normTs(ts) {
  const ms = Date.parse(String(ts || ""));
  return Number.isNaN(ms) ? String(ts || "") : String(ms);
}
function alreadyDelivered(who, ts) {
  const k = String(who) + "|" + normTs(ts);
  if (deliveredKeys.has(k)) return true;
  deliveredKeys.add(k);
  if (deliveredKeys.size > 500) deliveredKeys.delete(deliveredKeys.values().next().value);
  return false;
}

function deliver(kind, who, ts, seq, target, text) {
  if (alreadyDelivered(who, ts)) return;
  if (isHuman(who) || addressedToMe(text) || repliesToMe(target)) {
    console.log(`[${kind}] seq=${seq ?? "-"} ${who} ${ts || ""} replyTo=${target || "-"} :: ${clip(text, 700)}`);
    receipt(ts);
    return;
  }
  broadcastBuf.push({ who, ts, text });
  if (!broadcastTimer) broadcastTimer = setTimeout(flushBroadcasts, BROADCAST_FLUSH_MS);
}

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
