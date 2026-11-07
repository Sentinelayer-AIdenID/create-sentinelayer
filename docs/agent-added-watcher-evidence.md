# Agent watcher implementation and review evidence

This document preserves historical implementation and review notes from the
[watcher user guide](agent-added-watcher.md). Each result applies only to the
source, environment and attempt named in its section. Statements about a pending
review or publication describe that original observation, not current release
status. Repeated or overlapping scopes must not be added together.

## Behavioral evidence

`tests/unit.agent-added-watcher.test.mjs` exercises delivery of an already-returned
notice within one cycle, joining new rooms without restart, deduplication, filtered-feed validation, account
change, bounded retry exhaustion, admission refusal, cancellation, bridge
blocking, and a real loopback HTTP server. The loopback test rejects every room
request carrying anything except the room admission and delivers a human reply
that arrived during startup.

`tests/unit.session-admission.test.mjs` verifies the normal signed claim after
refreshing a pending request and proves a cached admission cannot bypass the
current account check. HTTP cancellation and credential-census regressions
cover the shared helpers.

The recorded local verification used Node 24.22.1 on 2026-11-07, against base
commit `e27c3a2c93fb2dffefb7a6b686f0725d9efb8c79`. Test commands ran serially
for the full end-to-end and coverage suites with `--test-concurrency=1`;
the mutation driver also ran its test processes serially.

| Check | Recorded result |
| --- | --- |
| Focused watcher, admission, admission-auth, HTTP and credential-census tests | 120 passed; no failures or skips |
| Review follow-up: watcher, admission, HTTP and session sync tests | 153 passed; no failures or skips |
| `npm run check` | Passed; 442 files checked |
| `npm run docs:build` | Passed |
| End-to-end tests | 148 passed; no failures or skips |
| Full unit coverage command | 4,032 passed, 2 failed, 7 skipped; exit 1 |
| Cancellation review actual mutation proof | Ten named baseline tests passed; twelve mutants killed by behavioral assertions; zero invalid failures or cancellations |
| Cancellation review mutation restoration | All five changed source files restored byte for byte, with matching SHA-256 hashes |
| `npm pack --dry-run --json` | Passed; `sentinelayer-cli@0.48.0`, 449 package entries |
| Local `/omargate deep` and `/audit` | Both exited 1 before scanning: CLI authentication was required |
| Initial redacted Gitleaks scan of all 15 complete intended files | One reviewed finding: an unchanged public-key thumbprint in the existing cross-language fixture; no added credential |
| Redacted Gitleaks scan of the staged diff | Passed; no findings |

Local verification is **not fully green**. The coverage failures were
`devTestBot runner records browser capture lanes against a local fixture`
(`DEVTESTBOT_BROWSER_MISSING`, no installed Playwright Chromium) and
`(b2) NAT64 with public embedded address passes vetting` (a TLS
`setServername` TypeError, followed by asynchronous `ENETUNREACH`). Both failures
were reproduced on the pristine base commit in the same environment. Their
test and implementation files are unchanged by this PR. The deep Omar and audit
commands did not perform a review; authenticated remote Omar review remains
required before handoff.

The full-file secret scan's existing finding is the SHA-256 fingerprint of the
public fixture key in `tests/unit.session-admission.test.mjs`, not a private key
or bearer credential. That fixture is identical to the base commit and remains
unchanged; no scanner rule or ignore entry was added.

The review follow-up fixes cancellation through the receipt, initial history
read and hello transports. A real loopback server stalls each of those requests
and the presence request in turn. Stopping the worker must close the socket and
settle startup before the HTTP timeout, without a retry or any later startup
request. Three additional actual mutants remove the receipt, cursor or hello
transport signal and each fails that same wire-level assertion. Cancelled writes
and cursor reads do not count as remote failures in the shared circuit breaker.
The 153-test follow-up includes `tests/unit.session-sync.test.mjs`; these counts
overlap the initial checks and are not additive.

### Admission expiry and current-main follow-up

The later follow-up integrates main
`7c94b4e301cf9d5d5a5478fdae4887173638fa6f` (room titles and metadata cache).
Those thirteen incoming paths retain main's behavior. The watcher follow-up
adds help, documentation, two behavioral tests, and two mutation cases; it does
not change the admission lifetime, approval rules, or runtime expiry behavior.

The new long-listener test uses the real listener, admission scope, auth
resolution and HTTP transport against a loopback server. After a message arrives
with a live admission, a fake clock crosses its normal two-hour expiry. The
listener refuses before another room HTTP request, reports the refusal, stops,
and does not request or claim another admission. Changing the expired scope to
allow account fallback produces a real captured owner-token request and fails
the credential-boundary assertion. The fixture restores its clock, environment,
stored credential, temporary workspace, worker and server connections.

The notification test starts an active room, then receives five pages containing
an invalid notice beside a valid one. All five reads keep the last accepted
cursor, none starts the later room, and the fifth failure closes the active
listener. Its mutation moves the cursor update before page validation and fails
the exact retained-cursor assertion.

| Follow-up check | Recorded result |
| --- | --- |
| Watcher, admission, admission-auth, HTTP, credential-census, sync, metadata-cache, remote-list and attachment-visibility suites | 236 passed in nine fresh, serial Node processes; no failures or skips |
| Actual mutation proof | Twelve named baseline tests passed; fourteen mutants killed by behavioral assertions; zero invalid failures or cancellations |
| Mutation restoration | All six source files restored byte for byte, with matching SHA-256 hashes |
| Syntax checks, rendered command help, and whitespace checks | Passed |
| Redacted Gitleaks scans of the complete seventeen staged files and the staged diff | Passed; no findings |
| Combined shared-process attempt | 178 passed and 58 failed after later files inherited fixture state; this invocation disabled the repository runner's normal file isolation |

The failed combined attempt is retained in the evidence. It was not reproduced
on pristine main and is not claimed as a baseline failure. The applicable
follow-up result runs each of the nine files in a fresh process, matching the
file isolation used by the repository's `test:unit` script. The inherited
four-reader metadata-cache subprocess test was not rerun locally, to preserve
the two-test-process limit; its unchanged main test remains in hosted CI. These
follow-up counts overlap earlier checks and do not replace the disclosed full
coverage and local-authentication limitations above.

The focused regression command is:

```sh
node --import ./tests/setup-env.mjs --test --test-concurrency=1 \
  tests/unit.agent-added-watcher.test.mjs \
  tests/unit.session-admission.test.mjs \
  tests/unit.session-admission-auth.test.mjs \
  tests/unit.auth-http.test.mjs \
  tests/unit.credential-census.test.mjs
```

The reproducible mutation driver checks wrong-agent feed acceptance, an owner
account change, page validation before cursor advancement, no account fallback
at live-listener expiry, exhausted pending capacity, missing stored admission, cached
admission account checks, pending preapproval refresh, the pre-hello cursor,
cancellation after approval, an already-cancelled HTTP request, and cancellation
of each receipt/cursor/hello HTTP transport:

```sh
node scripts/check-agent-added-mutants.mjs --evidence-dir /tmp/sl-agent-added-mutants
```

Reserve the checkout while this driver runs. It launches one fresh Node process
at a time, requires a passing unmodified baseline and the named test's assertion
failure for every mutant, rejects setup failures and timeouts, and restores
source in `finally`. The evidence directory contains the exact commands, TAP
logs, `summary.json`, and `restoration.json`. No authentication is needed for
these deterministic tests.

### One-cycle settlement follow-up

The isolated acceptance correction starts at published CLI head
`3cf6d6ac6a52af447eb6f4b8ff7ff9cec39a3ba0` (local exact-source mapping
`3f14ba78051d97e0870662536d71a0076e09584e`). It changes only the watcher loop,
adds `tests/unit.agent-added-cycle.test.mjs`, and updates this documentation.
It remains a local review candidate under the author-push hold; current main and
the existing PR were not changed by this verification.

The accepted unit of delivery is **one polling cycle**, which can include one
bounded delayed follow-up HTTP request. It is not a single-read guarantee. The
API companion returns promptly with an optional hint only for committed,
matching notices inside settlement. Its separate real-PostgreSQL proof creates
the Add through the production writer, observes it one second after the writer's
timestamp, receives the 9,000 ms hint, and retrieves it through the returned
cursor in one subsequent account-authenticated request. The server does not
hold the first request open.

The CLI loopback proof observes two real HTTP requests separated by the actual
nine-second advisory wait, then a single plain hello before normal cadence.
It uses real watcher/listener orchestration with injected admission and room
operations. This is complementary transport/control-flow evidence, not live
end-to-end admission or a live user acceptance receipt. Actual launch acceptance
remains pending the paired deployment and approved live check.

The `aa1` position remains strict Base64 JSON validated for the account and
agent. The client treats it as opaque. Its protocol and authorization rules
are unchanged; no cursor-signature claim is made.

| Acceptance-correction check | Recorded result |
| --- | --- |
| Original-source new-contract before run | 12 cases: 11 intended assertions and 1 existing-transport pass; no errors, cancellations or skips |
| Initial new-design regression | 33 passed; no failures, cancellations or skips |
| Independent-review failure-counter before proof | 13 cases: 1 intended assertion and 12 passes; no errors, cancellations or skips |
| Corrected combined regression | 34 passed; no failures, cancellations or skips; exit 0 |
| Final mutation baseline | 13 passed; no failures, cancellations or skips; exit 0 |
| Actual one-cycle mutations | 12 of 12 killed at behavioral assertions; no setup failures, runner timeouts, cancellations or skips |
| Source restoration | Watcher SHA256 `8831d6c41d9ec2a6822c598a614348da335084dcb1298cfedbaf6e570afe66e5` restored exactly after every mutation |
| Final restored combined regression | 34 passed; no failures, cancellations or skips; exit 0 |

The review-discovered failure counter mattered: resetting it after the first
successful read could hide a consistently bad follow-up. The correction resets
it only after a complete successful cycle. A real loopback test proves five
poisoned follow-ups stop after ten reads, retain the last accepted cursor, emit
five failures and close the already active room. An eleventh-request fixture
refusal bounds the broken implementation and produces an explicit assertion
instead of an infinite loop. Independent review checked this correction and
every final mutation failure/restoration receipt.

The mutations remove hint handling, allow a third request, accept malformed
hints, skip the delay, discard the confirmed cursor, remove delay cancellation,
skip the refreshed owner check, enable HTTP retries, reset the five-start
budget, erase failed-cycle counts, remove HTTP cancellation, and withhold
settled rows behind the delay. Their named behavioral witnesses are in the new
test file. An independent fixture teardown abort keeps the missing-delay-signal
mutation bounded without making owner cancellation pass. Every failure was
checked for its actual `AssertionError` cause.

The earlier held-response experiment used a twenty-second request timeout and
had 26 passing tests. It was superseded when the launch contract changed to a
prompt advisory response. Its two initial assertion failures and 26-pass result
are retained as historical diagnostics only; the timeout change was restored,
and no mutation of that superseded design was run. Those receipts do not prove
the final contract.

The focused final command deliberately runs one actual Node test process, with
no inherited subprocess fixtures:

```sh
node --test --test-isolation=none --test-concurrency=1 \
  tests/unit.agent-added-cycle.test.mjs \
  tests/unit.agent-added-watcher.test.mjs
```

Mutation apply, Node execution and result/restoration inspection ran as separate
commands, so a Python supervisor was never alive beside the Node runner. The
handoff retains `a-cli-cycle-before`, `a-cli-cycle-failure-budget-before`,
`a-cli-cycle-corrected`, `a-cli-cycle-baseline`, `a-cli-cycle-restored` XML/log
receipts and all twelve `a-cli-cycle-mutants/` result pairs, aggregate results
and restoration hashes. These scoped checks do not replace the required hosted
verification and review after an authorized integration/publication, or the
earlier disclosed full-verification limitations.

## Active-room cancellation review follow-up

The review of `6e463638a78e4b65bbdd7d98c4367ac7975236cf` found that a joined
listener dropped its worker signal before ongoing event reads and read-cursor
updates. Startup cancellation was covered, but stopping an active room could
still wait for the HTTP timeout. The correction forwards the existing worker
signal through both calls and retains the existing request timeout, credential
scope, admission lifetime and polling cadence.

Caller cancellation is not a circuit failure or a circuit recovery: it neither
increments failure counts nor clears earlier real failures. Late responses are
discarded before delivering controls, events or cursor progress. Cancellation
during a callback stops the remaining batch and prevents a new cursor write or
heartbeat. A local write already started before cancellation may finish; it
cannot start a later remote update. Aborting an HTTP request does not assert
that a server operation already received was rolled back.

`tests/unit.agent-added-active-cancellation.test.mjs` uses the real room worker,
listener and HTTP helpers after `ready` resolves. Four loopback cases stall the
events GET or read-cursor PUT, either before headers or during JSON consumption.
They require socket closure and bounded cleanup, admission-bound room requests,
no later callback/request/cursor write, and no failure notice, heartbeat or
successful cursor acknowledgment. Admission establishment is injected into the
real credential store; this is not a live room acceptance run.

| Scoped check | Observed result |
| --- | --- |
| Original-source regression | 16 cases: 14 intended assertion failures and 2 genuine-timeout controls passing; exit 1; no errors or skips |
| First after-run diagnostic | 13 passes and 4 fixture assertion failures: the new test expected `stop`, while the existing lifecycle is `stopped`; this is not a product failure or mutant kill |
| Corrected new regression | 17 passes; exit 0; no failures, errors or skips; includes the added final-event cursor boundary |
| Existing watcher, cycle, listener and sync scopes | 21 + 13 + 37 + 56 = 127 passes in four separate fresh Node processes; no failures, errors or skips |
| Actual mutation proof | 17 of 17 killed by named `AssertionError` witnesses; no setup, TypeError, runner-timeout or skipped-test kills |
| Source restoration | Both changed production files exactly match their recorded candidate SHA-256 values |
| Clean restored new regression | 17 passes; exit 0; no failures, errors or skips |

The 144 distinct focused cases comprise the 17 new cases and the 127 existing
cases. Repeated 17-case and mutation runs overlap and are not added to that
count. Mutants remove each HTTP signal, accept cancelled or late responses,
alter circuit history on cancellation, continue a stopped batch, advance its
cursor, or emit a heartbeat after the aborted read. Apply, direct single-process
Node execution, and result/restoration collection run in separate commands; no
Python mutation supervisor or inherited subprocess fixture runs beside Node.

The retained receipts are `a-active-cancel-before`, `a-active-cancel-after`
(the fixture diagnostic), `a-active-cancel-after-corrected`, four
`a-active-cancel-regression-*` scopes, `a-active-cancel-restored`, and
`a-active-cancel-mutants/` raw result pairs and restoration metadata. Quality,
Omar and Build Attestation succeeded on attempt 1 for the earlier `6e463638`
head, whose Codex review raised this finding. Those hosted results do not prove
this correction; fresh exact-head gates and review remain required. This
follow-up remains Class D and makes no prompt or model-routing change.

## Heartbeat cancellation coverage on the merged source

The reviewer of head `94feb4f01d7c093a7b1f2ab0f24e0c1f081e9902` recorded a
surviving mutation that removed the active heartbeat's presence-request signal
([review 6707643544](https://github.com/Sentinelayer-AIdenID/create-sentinelayer/pull/899#issuecomment-6707643544)).
That original survivor remains a coverage gap in the historical record. The
follow-up below adds a witness; it does not relabel the earlier result.

The follow-up starts from merged main
`7a47e62fdd481da44f6cc370a6ca8dafcca3a8e1`, whose complete tree is
`e78c3284a03f3c01f7688f3f39daa36471b78920`. Production files are unchanged.
Two cases extend the existing loopback fixture to stall the second presence
request, after startup, a successful poll and a completed read-cursor update.
The header case aborts the caller's signal; the partial-body case calls the
room worker's `stop()` method. Both require early socket closure, fulfilled
worker cleanup, unchanged post-stop effects, and admission-bound room traffic.
They distinguish the already-started heartbeat from an additional heartbeat.
Admission establishment is injected into the credential store; subsequent
listener and HTTP operations are real loopback requests, not a live-room check.

| Narrow check | Observed result |
| --- | --- |
| Unmodified production with the expanded test file | 19 passed; exit 0; no failures, errors or skips |
| Remove only the active heartbeat's presence-request signal | Two named `ERR_ASSERTION` failures and 17 passes; exit 1; no errors or skips |
| Production source restoration | `added-room-listener.js` restored exactly to SHA256 `dfb2ef4cf54b9fc953634e525e6429b2c808ad227c045429eea43b6cee46e74b` |
| Clean restored test file | 19 passed; exit 0; no failures, errors or skips |

The mutation fails the 1.5-second cleanup assertion in each new case. These are
bounded behavior assertions, not test-runner timeouts. Each fixture independently
aborts, closes all sockets, awaits termination, removes its unique stored
credential and workspace, and restores environment and sync state. Mutation
application, direct Node execution and restoration run as separate commands.
No supervisor or inherited subprocess fixture runs beside the test process.
The 19-case runs overlap; this follow-up adds two cases to the existing 17.

The receipts are `a-heartbeat-baseline`, `a-heartbeat-mutant`,
`a-heartbeat-mutant-results`, `a-heartbeat-mutant-restoration`, and
`a-heartbeat-restored`. This local test-and-documentation follow-up makes no
new hosted-CI, published-release, provider-action or live-acceptance claim.

