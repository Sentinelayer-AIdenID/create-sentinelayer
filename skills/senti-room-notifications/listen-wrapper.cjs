const path = require("path");
const os = require("os");
const fs = require("fs");

function clip(s, n) {
  const t = String(s);
  return t.length <= n ? t : t.slice(0, n) + ` …[CLIPPED +${t.length - n} chars — READ FULL BEFORE ACTING/QUOTING]`;
}

// Shared by the listener and its offline self-tests. Each instance owns its state.
function createClassifier({
  me: ME, cwd: CWD, fs = require("fs"), now = Date.now,
  setTimeout = global.setTimeout, clearTimeout = global.clearTimeout, log = console.log,
}) {
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
    const currentTime = now();
    if (!force && currentTime - lastStateWrite < 5000) {
      if (!stateTimer) stateTimer = setTimeout(() => { stateTimer = null; writeState(true); }, 5000);
      return;
    }
    if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
    lastStateWrite = currentTime;
    const pending = broadcastBuf.length ? broadcastBuf : [];
    try {
      fs.writeFileSync(RECEIPT, JSON.stringify({
        deliveredMaxTs, observedMaxTs,
        pendingCount: pending.length,
        oldestPendingTs: pending.length ? pending[0].ts : null,
        wroteAt: new Date(now()).toISOString(),
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
    log(`[room-digest] ${items.length} broadcast(s) from ${senders} in ${BROADCAST_FLUSH_MS / 1000}s; newest ${newest.who} ${newest.ts} :: ${clip(newest.text, 500)} — READ THE ROOM for the others | batched: ${manifest}${items.length > 14 ? " +" + (items.length - 14) + " more" : ""}`);
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
      log(`[${kind}] seq=${seq ?? "-"} ${who} ${ts || ""} replyTo=${target || "-"} :: ${clip(text, 700)}`);
      receipt(ts);
      return;
    }
    broadcastBuf.push({ who, ts, text });
    if (!broadcastTimer) broadcastTimer = setTimeout(flushBroadcasts, BROADCAST_FLUSH_MS);
  }

  return {
    deliver, addressedToMe, isHuman, mentionCount, rememberMine, flushBroadcasts,
    tsMs, newerThanDelivered, receipt, observe, writeState,
    bufLen: () => broadcastBuf.length,
    state: () => ({ deliveredMaxTs, observedMaxTs, hadReceiptAtBoot }),
  };
}

function main() {
  const ME = process.env.SENTI_AGENT_ID;
  const SID = process.env.SENTI_SESSION_ID;
  const CLI = process.env.SENTI_CLI_PATH;
  if (!ME || !SID || !CLI || !/^[a-zA-Z0-9_-]+$/.test(ME) || !/^[a-zA-Z0-9_-]+$/.test(SID)) {
    console.error("Set SENTI_AGENT_ID, SENTI_SESSION_ID and SENTI_CLI_PATH before starting the listener.");
    process.exit(1);
  }
  if (!path.isAbsolute(CLI)) {
    console.error("SENTI_CLI_PATH must be an absolute path to sentinelayer-cli/bin/sentinelayer-cli.js.");
    process.exit(1);
  }
  const CWD = path.join(os.homedir(), ".sentinelayer", "skill-listeners", SID, ME);
  const POLL_CWD = path.join(CWD, "reply-poll");
  const WAKE = null;

  fs.mkdirSync(POLL_CWD, { recursive: true });
  // The installed CLI owns subprocess orchestration; importing this file stays offline.
  const runtime = path.join(path.dirname(fs.realpathSync(CLI)), "..", "src", "skills", "listener-runtime.cjs");
  const { runListener } = require(runtime);
  runListener({
    me: ME, sessionId: SID, cliPath: CLI, cwd: CWD, pollCwd: POLL_CWD, wake: WAKE,
    classifier: createClassifier({ me: ME, cwd: CWD }),
  });
}

module.exports = { createClassifier };
if (require.main === module) main();
