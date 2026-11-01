const path = require("path");
const { createClassifier } = require(path.resolve(process.argv[2] || path.join(__dirname, "listen-wrapper.cjs")));
if (typeof createClassifier !== "function") throw new Error("wrapper is missing createClassifier -- test would be vacuous");

const printed = [];
const api = createClassifier({
  me: "agent-listener", cwd: "fake-cwd",
  fs: { readFileSync: () => { throw new Error("no prior receipt"); }, writeFileSync: () => {} },
  now: () => 10000,
  log: (line) => printed.push(line),
  setTimeout: () => 1, // never actually fire the timer; flush manually
  clearTimeout: () => {},
});
// Fail before any assertions if the shipped factory stops exposing the code under test.
for (const name of ["deliver", "addressedToMe", "isHuman", "mentionCount", "rememberMine", "flushBroadcasts", "bufLen"]) {
  if (typeof api?.[name] !== "function") throw new Error("classifier is missing " + name + " -- test would be vacuous");
}

function immediate(fn) { const before = printed.length; fn(); return printed.length > before; }
let fails = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (got ${got}, want ${want})`);
}

const TESTER = "@human-user @agent-reviewer @agent-builder @agent-peer @agent-listener one measurement, then I stop talking";
const BUILDER  = "@agent-reviewer @agent-tester @agent-peer @agent-listener — I just generated a FALSE POSITIVE on the checker";
const REVIEWER_REPLY = "reply #99: please verify the example";
const ADDRESSED = "@agent-listener can you confirm the api sha flipped?";

check("tester blanket broadcast is BUFFERED",
  immediate(() => api.deliver("session_message", "agent-tester", "t1", 1, null, TESTER)), false);
check("builder blanket broadcast is BUFFERED",
  immediate(() => api.deliver("session_message", "agent-builder", "t2", 2, null, BUILDER)), false);
check("post naming ONLY me wakes IMMEDIATELY",
  immediate(() => api.deliver("session_message", "agent-reviewer", "t3", 3, null, ADDRESSED)), true);
check("human-user wakes IMMEDIATELY",
  immediate(() => api.deliver("session_message", "human-user", "t4", 4, null, "go on the migration")), true);
check('poll-path actor "human" wakes IMMEDIATELY',
  immediate(() => api.deliver("session_reply", "human", "t5", null, 99, "looks good")), true);
check("unmentioned broadcast reply is BUFFERED",
  immediate(() => api.deliver("session_reply", "agent-reviewer", "t6", null, 99, REVIEWER_REPLY)), false);

// A reply to this agent's post wakes it even without an @-mention.
api.rememberMine(555);
check("reply to MY OWN post wakes IMMEDIATELY even with no mention",
  immediate(() => api.deliver("session_reply", "agent-reviewer", "t7", null, 555, REVIEWER_REPLY)), true);
check("reply to SOMEONE ELSE's post stays BUFFERED",
  immediate(() => api.deliver("session_reply", "agent-reviewer", "t8", null, 99, REVIEWER_REPLY)), false);

// Nothing was dropped: every buffered item is still there and one flush emits one line.
check("buffered count is 4 (nothing dropped)", api.bufLen(), 4);
const before = printed.length;
api.flushBroadcasts();
check("4 broadcasts cost exactly ONE wake", printed.length - before, 1);
check("digest names all senders", /agent-tester/.test(printed[printed.length - 1]) && /agent-reviewer/.test(printed[printed.length - 1]), true);
check("empty flush prints NOTHING", (() => { const n = printed.length; api.flushBroadcasts(); return printed.length - n; })(), 0);


// Cross-path deduplication counts each event once.
// The same event reaches deliver() twice: once from the listen stream, once from the reply-poll.
// Two distinct broadcasts must produce two digest entries even when each arrives twice.
const DUP_A = "@agent-one @agent-two @agent-three three-mention broadcast from builder";
const DUP_B = "@agent-one @agent-two @agent-three @agent-four four-mention broadcast from tester";
api.deliver("session_message", "agent-builder", "dup-ts-1", 11, null, DUP_A);   // stream
api.deliver("session_reply",   "agent-builder", "dup-ts-1", null, null, DUP_A); // poll: SAME event
api.deliver("session_message", "agent-tester",  "dup-ts-2", 12, null, DUP_B);   // stream
api.deliver("session_reply",   "agent-tester",  "dup-ts-2", null, null, DUP_B); // poll: SAME event
check("2 broadcasts on BOTH paths buffer as 2, not 4", api.bufLen(), 2);
const b4 = printed.length;
api.flushBroadcasts();
check("digest says 2 broadcast(s), not 4", /2 broadcast/.test(printed[printed.length - 1]), true);
check("that digest is still ONE wake", printed.length - b4, 1);

// Duplicate addressed events must also produce only one wake.
const before2 = printed.length;
api.deliver("session_message", "agent-reviewer", "dup-ts-3", 13, null, "@agent-listener ping");
api.deliver("session_reply",   "agent-reviewer", "dup-ts-3", null, null, "@agent-listener ping");
check("addressed message on both paths wakes ONCE", printed.length - before2, 1);

// Equivalent stream and poll timestamps must deduplicate despite different string formats.
const STREAM_TS = "2000-01-01T00:00:01.115000+00:00";
const POLL_TS   = "2000-01-01T00:00:01.115Z";
const beforeFmt = printed.length;
api.deliver("session_message", "agent-tester", STREAM_TS, 21, null, "@agent-listener real-format ping");
api.deliver("session_reply",   "agent-tester", POLL_TS,   null, null, "@agent-listener real-format ping");
check("same instant in the TWO REAL ts formats wakes ONCE", printed.length - beforeFmt, 1);

const beforeFmt2 = printed.length;
api.deliver("session_message", "agent-builder", "2000-01-01T00:00:02.500000+00:00", 22, null, "@agent-one @agent-two @agent-three broadcast");
api.deliver("session_reply",   "agent-builder", "2000-01-01T00:00:02.500Z",         null, null, "@agent-one @agent-two @agent-three broadcast");
check("cross-format broadcast buffers ONCE", api.bufLen(), 1);
api.flushBroadcasts();
check("digest says 1 broadcast(s), not 2", /1 broadcast/.test(printed[printed.length - 1]), true);

// A genuinely different instant one millisecond away must still get through.
const beforeMs = printed.length;
api.deliver("session_message", "agent-tester", "2000-01-01T00:00:01.116Z", 23, null, "@agent-listener one ms later");
check("an event 1ms apart is NOT deduped", printed.length - beforeMs, 1);

// Guard the guard: distinct events from one sender must NOT be swallowed by the dedupe.
const before3 = printed.length;
api.deliver("session_message", "agent-reviewer", "distinct-ts-1", 14, null, "@agent-listener first");
api.deliver("session_message", "agent-reviewer", "distinct-ts-2", 15, null, "@agent-listener second");
check("two DISTINCT messages still wake twice", printed.length - before3, 2);

console.log(fails ? (fails + " FAILING") : "ALL PASS");
process.exit(fails ? 1 : 0);
