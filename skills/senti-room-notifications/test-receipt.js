// Exercises the REAL receipt/reception code exported by the shipped wrapper.
// This code is the recovery path: if it is wrong, a lost buffer stays lost and the safety net
// cannot see the hole. It had two defects already (string compare, throttle with no trailing edge).
const path = require("path");
const { createClassifier } = require(path.resolve(process.argv[2] || path.join(__dirname, "listen-wrapper.cjs")));
if (typeof createClassifier !== "function") throw new Error("wrapper is missing createClassifier -- test would be vacuous");

let written = [];
let timers = [];
const fakeFs = {
  readFileSync: () => { throw new Error("no prior receipt"); },
  writeFileSync: (_p, body) => written.push(JSON.parse(body)),
};
const api = createClassifier({
  me: "agent-listener", cwd: "fake-cwd", fs: fakeFs,
  now: () => 10000,
  setTimeout: (fn) => { timers.push(fn); return timers.length; },
  clearTimeout: () => {}, log: () => {},
});
for (const name of ["tsMs", "newerThanDelivered", "receipt", "observe", "writeState", "state"]) {
  if (typeof api?.[name] !== "function") throw new Error("classifier is missing " + name + " -- test would be vacuous");
}

let fails = 0;
const check = (n, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok?"PASS":"FAIL"}  ${n}  (got ${got}, want ${want})`); };

const STREAM = "2026-09-06T04:38:14.115000+00:00";
const POLL   = "2026-09-06T04:38:14.115Z";
check("the two wire formats parse to the SAME instant", api.tsMs(STREAM), api.tsMs(POLL));
check("unparseable ts does not become 'newest'", api.tsMs("not-a-date"), -1);

api.receipt(POLL);
check("receipt advances delivered", api.state().deliveredMaxTs, POLL);
check("INVARIANT delivered implies observed", api.tsMs(api.state().observedMaxTs) >= api.tsMs(POLL), true);
check("same instant in the OTHER format is not 'newer'", api.newerThanDelivered(STREAM), false);
check("one ms later IS newer", api.newerThanDelivered("2026-09-06T04:38:14.116Z"), true);

// The throttle's trailing edge: the LAST observation of a burst must still reach disk.
written = []; timers = [];
api.observe("2026-09-06T04:39:00.000Z");          // lands (forced by receipt's earlier write? no: first observe)
const afterFirst = written.length;
api.observe("2026-09-06T04:39:01.000Z");          // throttled -> must SCHEDULE a trailing write
api.observe("2026-09-06T04:39:02.000Z");          // throttled, already scheduled
check("a throttled burst schedules a trailing write", timers.length >= 1, true);
const beforeTrailing = written.length;
timers.forEach((fn) => fn());                      // fire the trailing timer
check("the trailing write actually lands", written.length > beforeTrailing, true);
const last = written[written.length - 1];
check("and it carries the NEWEST observation, not the first",
  last.observedMaxTs, "2026-09-06T04:39:02.000Z");
check("published state is self-consistent",
  api.tsMs(last.observedMaxTs) >= api.tsMs(last.deliveredMaxTs), true);
console.log(fails ? (fails + " FAILING") : "ALL PASS");
process.exit(fails ? 1 : 0);
