// Actual scoped mutations, one test command at a time. Reserve this checkout
// before running: source is temporarily changed and restored byte for byte.
// Usage: node scripts/check-agent-added-mutants.mjs --evidence-dir /absolute/path
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--evidence-dir" || !args[1]) {
  throw new Error("Usage: node scripts/check-agent-added-mutants.mjs --evidence-dir PATH");
}
const directory = path.resolve(args[1]);
fs.mkdirSync(directory, { recursive: true });
const watcherTests = "tests/unit.agent-added-watcher.test.mjs";
const admissionTests = "tests/unit.session-admission.test.mjs";
const httpTests = "tests/unit.auth-http.test.mjs";
const edit = (before, after, count = 1) => ({ before, after, count });
const mutants = [
  {
    name: "accept_another_agents_notification",
    file: "src/session/agent-added-watcher.js",
    edits: [edit(' || item.payload?.agentId !== agentId', "")],
    testFile: watcherTests,
    test: "malformed or another agent's addition never starts a worker or advances its cursor",
  },
  {
    name: "continue_after_owner_account_changes",
    file: "src/session/agent-added-watcher.js",
    edits: [edit("if (current.binding !== owner.binding)", "if (false)")],
    testFile: watcherTests,
    test: "account change stops the watcher and every active room before another feed read",
  },
  {
    name: "advance_cursor_before_validating_notification_page",
    file: "src/session/agent-added-watcher.js",
    edits: [edit("          const additions = page.notifications.map((item) => checkedAddition(item, agentId, _now()));",
      "          cursor = page.nextCursor;\n          const additions = page.notifications.map((item) => checkedAddition(item, agentId, _now()));")],
    testFile: watcherTests,
    test: "five invalid notification pages stop the watcher while retaining its cursor and closing active rooms",
  },
  {
    name: "fall_back_to_owner_after_admission_expiry",
    file: "src/auth/admission-scope.js",
    edits: [edit("if (!(credential.expiresAt * 1000 > Date.now())) return null;",
      "if (!(credential.expiresAt * 1000 > Date.now())) return undefined;")],
    testFile: watcherTests,
    test: "a running added-room listener stops at admission expiry without falling back to the owner account",
  },
  {
    name: "retain_exhausted_pending_additions",
    file: "src/session/agent-added-watcher.js",
    edits: [
      edit("if (entry.attempts >= MAX_ATTEMPTS) { pending.delete(id); continue; }",
        "if (entry.attempts >= MAX_ATTEMPTS) { continue; }"),
      edit("if (entry.attempts >= MAX_ATTEMPTS) pending.delete(id);", "", 2),
    ],
    testFile: watcherTests,
    test: "an exhausted pending join frees capacity and reports failure after five attempts",
  },
  {
    name: "allow_room_fallback_without_stored_admission",
    file: "src/session/added-room-listener.js",
    edits: [edit("}, { requireStored: true });", "}, { requireStored: false });")],
    testFile: watcherTests,
    test: "a missing stored admission cannot fall back after bootstrap reports success",
  },
  {
    name: "reuse_cached_admission_without_owner_check",
    file: "src/session/admission.js",
    edits: [edit('if (!requireAccountCheck && !recoverActive && held.state === "live"',
      'if (!recoverActive && held.state === "live"')],
    testFile: admissionTests,
    test: "owner bootstrap cannot reuse a locally live admission without checking the current account",
  },
  {
    name: "skip_pending_preapproval_refresh",
    file: "src/session/admission.js",
    edits: [edit("if (!resumable || requireAccountCheck) {", "if (!resumable) {")],
    testFile: admissionTests,
    // This fixture advances a fake clock: no refresh reaches the bounded wait
    // deadline and fails its refresh assertion, rather than timing out the runner.
    test: "an owner addition refreshes the same pending own-key request and claims its preapproval",
  },
  {
    name: "lose_cursor_from_before_hello",
    file: "src/session/added-room-listener.js",
    edits: [edit("since: latest.cursor || null, replay: true, onEvent,",
      "since: null, replay: true, onEvent,")],
    testFile: watcherTests,
    test: "every real room request uses its admission and a reply arriving after hello remains visible",
  },
  {
    name: "claim_after_owner_cancels_approval_wait",
    file: "src/session/admission.js",
    edits: [edit("if (signal) {\n    const cancellable =", "if (false) {\n    const cancellable =")],
    testFile: admissionTests,
    test: "cancellation after approval is returned prevents its own-key claim",
  },
  {
    name: "transport_an_already_cancelled_request",
    file: "src/auth/http.js",
    edits: [edit("signal?.throwIfAborted();", "", 2)],
    testFile: httpTests,
    test: "an already cancelled request makes zero transport calls",
  },
  {
    name: "omit_receipt_transport_cancellation",
    file: "src/session/admission.js",
    edits: [edit("credential: await credentialFor(auth),\n    signal,",
      "credential: await credentialFor(auth),\n    signal: undefined,")],
    testFile: watcherTests,
    test: "cancellation closes each stalled startup HTTP request without starting the next step",
  },
  {
    name: "omit_initial_cursor_transport_cancellation",
    file: "src/session/sync.js",
    edits: [edit('method: "GET",\n        credential: await credentialFor(session),\n        signal,',
      'method: "GET",\n        credential: await credentialFor(session),\n        signal: undefined,')],
    testFile: watcherTests,
    test: "cancellation closes each stalled startup HTTP request without starting the next step",
  },
  {
    name: "omit_hello_transport_cancellation",
    file: "src/session/sync.js",
    edits: [edit("body: requestBody,\n    signal,", "body: requestBody,\n    signal: undefined,")],
    testFile: watcherTests,
    test: "cancellation closes each stalled startup HTTP request without starting the next step",
  },
];

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const escapePattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const originals = new Map(mutants.map(({ file }) => [file, fs.readFileSync(path.join(root, file))]));
const altered = new Map();
for (const mutant of mutants) {
  let source = originals.get(mutant.file).toString("utf8");
  for (const { before, after, count } of mutant.edits) {
    if (!before || before === after || source.split(before).length - 1 !== count) {
      throw new Error(`${mutant.name}: expected ${count} exact source anchor(s); checkout has drifted`);
    }
    source = source.split(before).join(after);
  }
  const declaration = `test(${JSON.stringify(mutant.test)},`;
  const testSource = fs.readFileSync(path.join(root, mutant.testFile), "utf8");
  if (testSource.split(declaration).length !== 2) {
    throw new Error(`${mutant.name}: expected one exact named behavioral test`);
  }
  altered.set(mutant.name, Buffer.from(source));
}

function runTests(name, names, files) {
  // Each invocation already gets a fresh Node process. Avoid the test runner's
  // second process boundary, which loses ERR_ASSERTION when an assertion's
  // actual value contains a Promise or another non-serializable object.
  const command = ["--import", "./tests/setup-env.mjs", "--test", "--test-concurrency=1",
    "--test-isolation=none", "--test-reporter=tap", "--test-name-pattern", `^(?:${names.map(escapePattern).join("|")})$`, ...files];
  const result = spawnSync(process.execPath, command, {
    cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
  const output = (result.stdout || "") + (result.stderr || "");
  fs.writeFileSync(path.join(directory, `${name}.log`), output);
  const count = (key) => Number(output.match(new RegExp(`^# ${key} (\\d+)\\s*$`, "m"))?.[1] ?? NaN);
  return { result, output, command, counts: {
    tests: count("tests"), pass: count("pass"), fail: count("fail"),
    cancelled: count("cancelled"), skipped: count("skipped"),
  } };
}

let activeFile = null;
function restoreActive() {
  if (activeFile !== null) {
    fs.writeFileSync(path.join(root, activeFile), originals.get(activeFile));
    activeFile = null;
  }
}
const onInterrupt = () => { restoreActive(); process.exit(130); };
const onTerminate = () => { restoreActive(); process.exit(143); };
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onTerminate);
const summary = { baseline: null, mutants: [] };
const saveSummary = () => fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
try {
  const names = [...new Set(mutants.map(({ test }) => test))];
  const files = [...new Set(mutants.map(({ testFile }) => testFile))];
  summary.baseline = { pass: 0, runs: [] };
  for (const file of files) {
    const selected = [...new Set(mutants.filter(({ testFile }) => testFile === file).map(({ test }) => test))];
    const logName = `baseline-${path.basename(file, ".test.mjs")}`;
    const baseline = runTests(logName, selected, [file]);
    summary.baseline.runs.push({
      command: [process.execPath, ...baseline.command], status: baseline.result.status,
      signal: baseline.result.signal, error: baseline.result.error?.message ?? null,
      ...baseline.counts,
    });
    summary.baseline.pass += baseline.counts.pass;
    saveSummary();
    if (baseline.result.error || baseline.result.signal || baseline.result.status !== 0
        || baseline.counts.pass !== selected.length || baseline.counts.fail !== 0 || baseline.counts.cancelled !== 0) {
      throw new Error(`Unmodified behavioral baseline did not pass; no mutant is valid. See ${logName}.log.`);
    }
  }
  console.log(`Baseline: ${names.length} named behavioral tests passed.`);

  for (const mutant of mutants) {
    for (const [file, original] of originals) {
      if (!fs.readFileSync(path.join(root, file)).equals(original)) {
        throw new Error(`Checkout changed during proof: ${file}. Reserve the checkout before running this driver.`);
      }
    }
    const changed = altered.get(mutant.name);
    activeFile = mutant.file;
    fs.writeFileSync(path.join(root, mutant.file), changed);
    try {
      const { result, output, command, counts } = runTests(mutant.name, [mutant.test], [mutant.testFile]);
      const namedFailure = new RegExp(`^not ok \\d+ - ${escapePattern(mutant.test)}\\s*$`, "m").test(output);
      const assertion = /\bcode: ['"]ERR_ASSERTION['"]/.test(output)
        && /\bfailureType: ['"]testCodeFailure['"]/.test(output);
      const invalid = /SyntaxError|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|testTimeoutFailure|cancelledByParent/.test(output);
      const killed = !result.error && !result.signal && result.status === 1
        && counts.fail === 1 && counts.cancelled === 0 && namedFailure && assertion && !invalid;
      summary.mutants.push({
        name: mutant.name, file: mutant.file, test: mutant.test, testFile: mutant.testFile,
        command: [process.execPath, ...command], status: result.status, signal: result.signal,
        error: result.error?.message ?? null, ...counts, namedFailure, assertion, invalid, killed,
        originalSha256: digest(originals.get(mutant.file)), mutatedSha256: digest(changed),
      });
      saveSummary();
      console.log(`${mutant.name}: ${killed ? "KILLED by assertion" : "SURVIVED/INVALID"} (exit ${result.status})`);
      if (!killed) throw new Error(`${mutant.name} survived or did not fail the named assertion; see its log.`);
    } finally {
      restoreActive();
    }
  }
} finally {
  restoreActive();
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);
  const restoration = [...originals].map(([file, original]) => {
    const actual = fs.readFileSync(path.join(root, file));
    return { file, restored: actual.equals(original), originalSha256: digest(original), actualSha256: digest(actual) };
  });
  fs.writeFileSync(path.join(directory, "restoration.json"), JSON.stringify(restoration, null, 2) + "\n");
  if (restoration.some(({ restored }) => !restored)) throw new Error("Source restoration failed; inspect restoration.json.");
}
