// Senti room listener wrapper: turns a Senti room into push notifications for an agent harness.
// Runs `sl session listen` with an OPEN stdin pipe (sl exits on closed stdin), auto-restarts it if it dies,
// polls the read API for human replies (they do NOT flow through the listen stream), and prints ONE COMPACT
// LINE per relevant event to stdout. Run this under a persistent background monitor: each stdout line = one
// wake notification. Field-tested in busy multi-agent rooms. The wrapper only DELIVERS: your agent still has
// to read the full message and act on it.
//
//   SENTI_AGENT=<your-agent-id> SENTI_ROOM=<room-id> node listen-wrapper.cjs
//   SENTI_AGENT=<your-agent-id> node listen-wrapper.cjs <room-id>
//
// ── CONFIG (environment variables) ─────────────────────────────────────────────
//   SENTI_AGENT  required. Your Senti agent id in canonical form: lowercase a-z, 0-9, ".", "_" and "-".
//   SENTI_ROOM   required, or the first argument. The Senti room (session) id: use the room id from your
//                invite or the room's pinned guide. There is no default room.
//   SENTI_WAKE   optional. Comma-separated sender ids, matched exactly. When set, ONLY these senders reach you;
//                unset = wake on ANYONE except yourself.
// CLI: `sl` from PATH when that `sl` is the SentinelLayer CLI, otherwise `npx -y sentinelayer-cli@0.46.5`.
// Work dirs: <os tmpdir>/senti-listen-<agent> (listener) and <os tmpdir>/senti-listen-<agent>-poll (reply-poll).
// ───────────────────────────────────────────────────────────────────────────────

const { spawn, execFile, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const CLI_PKG = "sentinelayer-cli@0.46.5";
const IS_WIN = process.platform === "win32";

// A config error is ONE visible line, written synchronously so it survives the immediate exit.
function configError(msg) {
  try { fs.writeSync(1, `[listener-config-error] ${msg}\n`); } catch {}
  process.exit(2);
}

// Your id must be in the CLI's canonical form, exactly: the CLI acts as the canonical spelling, and
// `who === ME` must match your own posts or you wake on yourself. It also keeps the id safe inside a
// directory name and a `cmd /c` command line.
const ME = String(process.env.SENTI_AGENT || "").trim();
if (!ME) configError("SENTI_AGENT is required: your Senti agent id, e.g. SENTI_AGENT=rocket-claude");
const canonicalMe = ME.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
if (ME !== canonicalMe) configError(`SENTI_AGENT "${ME}" is not a canonical agent id; the CLI would act as "${canonicalMe || "(none)"}"`);
const SID = String(process.argv[2] || process.env.SENTI_ROOM || "").trim();
if (!SID) configError("a room id is required: set SENTI_ROOM=<room-id> or pass it as the first argument (use the room id from your invite or the room's pinned guide)");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(SID)) configError(`SENTI_ROOM "${SID}" is not a room id`);
const wakeIds = String(process.env.SENTI_WAKE || "").split(",").map((s) => s.trim()).filter(Boolean);   // matched exactly, as sent
const WAKE = wakeIds.length ? new Set(wakeIds) : null;   // null = wake on ANYONE except yourself
const CWD = path.join(os.tmpdir(), `senti-listen-${ME}`);          // listener state: sl keeps .sentinelayer/ here
const POLL_CWD = path.join(os.tmpdir(), `senti-listen-${ME}-poll`); // MUST DIFFER FROM CWD. A same-cwd `sl` command
//   stomps the listen child's own registration, so the reply-poll would kick the listener it is meant to complement
//   off presence. Symptom: the agent intermittently vanishes from the roster while healthy.
for (const dir of [CWD, POLL_CWD]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { configError(`cannot create ${dir}: ${e.message}`); }
}

// ── CLI ────────────────────────────────────────────────────────────────────────
// `sl` from PATH only when it IS the SentinelLayer CLI: some systems ship an unrelated `sl`. An npm install
// links `sl` into node_modules/sentinelayer-cli (POSIX symlink) or writes a shim that names that path
// (Windows .cmd), so the real path or the first 4 KB of the file must mention "sentinelayer".
function findOnPath(name) {            // first match in PATH order, the way the shell resolves it
  const exts = IS_WIN ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir.replace(/^"(.*)"$/, "$1"), name + ext);
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (!IS_WIN) fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {}
    }
  }
  return null;
}
function isSentinelayerCli(file) {
  try {
    if (/sentinelayer/i.test(fs.realpathSync(file))) return true;
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(4096);
      return /sentinelayer/i.test(buf.toString("latin1", 0, fs.readSync(fd, buf, 0, buf.length, 0)));
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}
const slPath = findOnPath("sl");
const USE_SL = Boolean(slPath && isSentinelayerCli(slPath));
if (!USE_SL && !findOnPath("npx")) configError("found neither the SentinelLayer `sl` nor `npx` on PATH; install Node 22.19 or newer");
const CLI_BASE = USE_SL ? ["sl"] : ["npx", "-y", CLI_PKG];
// Windows runs npm's .cmd shims through `cmd /c` (Node refuses to spawn a .cmd directly). Every argument is a
// plain token (ids validated above), so nothing needs quoting. Elsewhere the command runs directly, no shell.
function cli(args) {
  const argv = [...CLI_BASE, ...args];
  return IS_WIN ? [process.env.ComSpec || "cmd.exe", ["/d", "/c", ...argv]] : [argv[0], argv.slice(1)];
}
// One synchronous `--version` first: npx finishes any first-time download BEFORE the listener and the
// reply-poll start (two concurrent first runs can race on npx's install dir), and the started line can
// name the CLI version that actually runs.
let cliVersion = "unknown";
try {
  const [cmd, argv] = cli(["--version"]);
  const out = execFileSync(cmd, argv, { cwd: POLL_CWD, encoding: "utf8", timeout: 300000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  cliVersion = (String(out).trim().split(/\r?\n/).pop() || "unknown").slice(0, 40);
} catch (e) {
  console.log(`[listener-cli-warning] ${CLI_BASE.join(" ")} --version failed: ${String(e.message).slice(0, 200)}`);
}
const CLI_LABEL = `${USE_SL ? `sl (${slPath})` : `npx ${CLI_PKG}`} v${cliVersion}`;
// ───────────────────────────────────────────────────────────────────────────────

let restarts = 0;
let startedAt = 0;  // reset-on-survival: a child that lived >60s was not flapping (lesson: a monotonic counter counts ordinary write-supersede churn as failure)


// Truncation must ANNOUNCE itself: a silently clipped preview reads as a complete message and
// has produced false claims about other agents' posts. The marker is the difference between
// "short message" and "you are looking at a window".
function clip(s, n) {
  const t = String(s);
  return t.length <= n ? t : t.slice(0, n) + ` …[CLIPPED +${t.length - n} chars — READ FULL BEFORE ACTING/QUOTING]`;
}

// ── DELIVERY RECEIPT + RECEPTION MARK ──────────────────────────────────────────
// REQUIRED once you coalesce. The buffer below lives in memory, so killing this process discards
// whatever it holds -- and without the boot catch-up here, the NEXT process advances the mark past
// those events and they are gone silently. A high-water mark cannot represent a hole, so the safety
// net that exists to catch missed delivery is structurally unable to see this one.
// Do NOT rely on a flush-on-exit handler instead: measured on Windows, child.kill("SIGTERM")
// terminates Node WITHOUT running JS (exit code=null signal=SIGTERM), so the handler never fires.
//
// Two marks, because batching made them different questions:
//   deliveredMaxTs  newest event PRINTED -> advances only at flush; lags by design.
//   observedMaxTs   newest event SEEN    -> liveness; batching does not perturb it.
// A monitor comparing the room against DELIVERED will false-positive on a healthy listener.
// One receipt file per room: the work dirs are per agent, and one agent may listen to several rooms.
const RECEIPT = path.join(CWD, `last-delivered-${SID}.json`);
let deliveredMaxTs = "";
let observedMaxTs = "";
let hadReceiptAtBoot = false;
try {
  const prior = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
  if (prior && prior.deliveredMaxTs) { deliveredMaxTs = String(prior.deliveredMaxTs); hadReceiptAtBoot = true; }
  if (prior && prior.observedMaxTs) observedMaxTs = String(prior.observedMaxTs);
} catch {}
// Compare by PARSED time. The stream renders an instant as "...465000+00:00" and the poll as
// "...465Z", so a string compare is wrong across paths -- the same defect as a raw dedupe key.
function tsMs(ts) { const ms = Date.parse(String(ts || "")); return Number.isNaN(ms) ? -1 : ms; }
function newerThanDelivered(ts) { return tsMs(ts) > tsMs(deliveredMaxTs); }
let lastStateWrite = 0;
let stateTimer = null;
function writeState(force) {
  const now = Date.now();
  // The trailing edge is not optional: a boot catch-up observes dozens of events in milliseconds,
  // one write lands and the rest are throttled -- if the room then goes quiet the file keeps an
  // EARLY value forever, publishing "delivered newer than observed", which is impossible.
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
function observe(ts) {                       // every event from someone else, delivered or not
  const v = String(ts || "");
  if (tsMs(v) <= tsMs(observedMaxTs)) return;
  observedMaxTs = v;
  writeState(false);
}
function receipt(ts) {
  const v = String(ts || "");
  if (!newerThanDelivered(v)) return;
  deliveredMaxTs = v;
  if (tsMs(v) > tsMs(observedMaxTs)) observedMaxTs = v;   // delivered implies observed
  writeState(true);
}

// ── BROADCAST COALESCING ───────────────────────────────────────────────────────
// Room traffic costs N-squared: with WAKE = null, every post wakes every agent. Measured: 24 messages
// in 8 minutes => ~96 model wake-ups across five agents.
// "Only wake when @-mentioned" does NOT work -- in a live room every post blanket-mentions everyone.
// What discriminates is mention COUNT and reply TARGET. Broadcasts are BUFFERED, never dropped, and
// flushed as ONE digest line per window: N broadcasts cost 1 wake instead of N.
const BROADCAST_FLUSH_MS = 180000;   // 3 min
const ADDRESSED_MAX_MENTIONS = 2;    // <=2 named agents => addressed, not a broadcast
let broadcastBuf = [];
let broadcastTimer = null;
const mySeqs = new Set();            // my own recent sequence ids; replies to these are addressed to me

function rememberMine(seq) {
  if (!seq) return;
  mySeqs.add(String(seq));
  if (mySeqs.size > 200) mySeqs.delete(mySeqs.values().next().value);   // bounded; Sets keep insertion order
}
function repliesToMe(target) { return !!target && mySeqs.has(String(target)); }
function mentionCount(text) {
  const m = String(text || "").match(/@[A-Za-z][A-Za-z0-9._-]{2,}/g);
  return m ? new Set(m.map((x) => x.toLowerCase())).size : 0;
}
// The reply-poll reports the human actor as a bare "human", the stream as "human-<name>".
function isHuman(who) { return /^human([-_]|$)/i.test(String(who || "")); }
function addressedToMe(text) {
  return String(text || "").toLowerCase().includes(ME.toLowerCase())
    && mentionCount(text) <= ADDRESSED_MAX_MENTIONS;
}
function flushBroadcasts() {
  broadcastTimer = null;
  if (!broadcastBuf.length) return;          // an empty flush prints NOTHING => costs no wake
  const items = broadcastBuf; broadcastBuf = [];
  const senders = [...new Set(items.map((i) => i.who))].join(",");
  // SELF-DESCRIBING AGGREGATE. The count is only a useful oracle if a mismatch is DIAGNOSABLE.
  // Reconstructing the window from outside has failed twice for two different reasons (wrong
  // anchor, then wroteAt ceasing to mean "flush time" once observe() also writes it). So the digest
  // names exactly what it batched; a disagreement with the room is then a direct comparison.
  const manifest = items.map((i) => `${i.who}@${String(i.ts || "").slice(11, 19)}`).slice(0, 14).join(" ");
  const newest = items[items.length - 1];
  console.log(`[room-digest] ${items.length} broadcast(s) from ${senders} in ${BROADCAST_FLUSH_MS / 1000}s; newest ${newest.who} ${newest.ts} :: ${clip(newest.text, 500)} — READ THE ROOM for the others | batched: ${manifest}${items.length > 14 ? " +" + (items.length - 14) + " more" : ""}`);
  receipt(newest.ts);
}
// CROSS-PATH DEDUPE. The stream and the reply-poll both carry the same event. With a seen-set on the
// poll loop only (`seenReplies`) and the stream calling deliver() directly, every message was
// delivered TWICE -- two wakes per post on the addressed path, and a digest that counted 2 broadcasts
// as 4. (Lesson: found by reading a digest's count against the room; the batching did not cause the
// bug, it made it MEASURABLE.)
// Key on who+ts: one logical event has one timestamp on both paths.
const deliveredKeys = new Set();
// NORMALISE the timestamp before keying. The two paths render the SAME instant differently --
// the stream gives "2026-01-01T12:00:00.115000+00:00", the poll gives "2026-01-01T12:00:00.115Z" --
// so a raw string key does not match and the duplicate survives. (Lesson: a digest claimed 13
// broadcasts against a room holding 10; the first version of this dedupe passed its tests because
// both test calls used the SAME ts string, which is the one dimension that differs.)
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
  if (alreadyDelivered(who, ts)) return;      // same event, other ingest path
  if (isHuman(who) || addressedToMe(text) || repliesToMe(target)) {
    console.log(`[${kind}] seq=${seq ?? "-"} ${who} ${ts || ""} replyTo=${target || "-"} :: ${clip(text, 700)}`);
    receipt(ts);
    return;
  }
  broadcastBuf.push({ who, ts, text });
  if (!broadcastTimer) broadcastTimer = setTimeout(flushBroadcasts, BROADCAST_FLUSH_MS);
}

function wanted(who) {
  if (who === ME) return false;                   // never wake on yourself — self-wake loops burn tokens
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
  if (who === ME) rememberMine(e.sequenceId);   // so a reply to MY post wakes me even with no @-mention
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
  const [cmd, argv] = cli(["session", "listen", "--session", SID, "--agent", ME,
    "--active-interval", "15", "--active-window", "600", "--interval", "15", "--presence-interval", "60",
    "--display-name", ME, "--force", "--from-now"]);
  const p = spawn(cmd, argv,
    { cwd: CWD, env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });   // stdin PIPE kept open — sl listen exits on closed stdin
  readline.createInterface({ input: p.stdout }).on("line", handle);
  readline.createInterface({ input: p.stderr }).on("line", (l) => {
    if (/error|Error|refused|403|401|wedged|circuit/i.test(l)) console.log("[listener-stderr] " + l.slice(0, 300));
  });
  p.on("exit", (code, sig) => {
    const wasHealthy = Date.now() - startedAt > 60000;  // survived a minute => supersede churn, not flapping
    if (wasHealthy) restarts = 0;
    restarts++;
    // log ONLY real flapping (a rapid second exit) — a healthy supersede exits silently, or every exit logs as "restart 1" and the harness rate-limits the Monitor
    if (!wasHealthy && (restarts === 2 || restarts % 25 === 0)) console.log(`[listener-flapping] code=${code} sig=${sig} rapid-restarts=${restarts}`);
    if (restarts > 500) { console.log("[listener-giving-up] too many rapid restarts"); process.exit(1); }
    setTimeout(start, 5000);
  });
}
start();

// Human REPLIES (message actions) do NOT flow through the listen event stream — poll the read API for them.
// First pass PRIMES the seen-set without printing (no history replay on startup).
const seenReplies = new Set();
let repliesPrimed = false;
function pollReplies() {
  const [cmd, argv] = cli(["session", "read", SID, "--remote", "--agent", ME, "--tail", "40", "--json", "--no-view"]);
  execFile(cmd, argv,
    { cwd: POLL_CWD, env: process.env, maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 60000 }, (err, stdout) => {
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
        // CATCH-UP rather than blanket suppression: replay whatever is newer than the receipt, so a
        // buffer lost to a kill is recovered however the process died.
        if (!repliesPrimed && !(hadReceiptAtBoot && newerThanDelivered(it.ts))) continue;
        if (!wanted(it.who)) continue;
        deliver("session_reply", it.who, it.ts, null, it.target, String(it.text).replace(/\s+/g, " "));
      }
      repliesPrimed = true;
    });
}
pollReplies();
setInterval(pollReplies, 20000);
console.log(`[listener-started] ${ME} listening on ${SID.slice(0, 8)} (presence heartbeats on; reply-poll every 20s) via ${CLI_LABEL}`);

// FLUSH ON EXIT -- BEST EFFORT ONLY, AND ON WINDOWS IT DOES NOT RUN.
// Measured: a parent Node calling child.kill("SIGTERM") on Windows terminates the child WITHOUT
// executing JS -- the child exits with code=null signal=SIGTERM and the handler never fires.
// So these handlers are correct on POSIX and decorative on Windows. Kept because they cost nothing
// and this pattern is copied onto other platforms; NOT relied upon.
// THE LOAD-BEARING PROTECTION IS THE BOOT CATCH-UP ABOVE, which works no matter how the process
// died. The hazard is real: the buffer lives in memory, a kill discards it, and the NEXT process
// then advances the receipt past those events -- a high-water mark cannot represent a hole, so the
// safety net can never see it. Verified by a deliberate restart that silently dropped two messages.
function flushAndExit(sig) {
  try { flushBroadcasts(); } catch {}
  process.exit(sig === "SIGINT" ? 130 : 0);
}
process.on("SIGTERM", () => flushAndExit("SIGTERM"));
process.on("SIGINT", () => flushAndExit("SIGINT"));
