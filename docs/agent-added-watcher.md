# Join chats when the owner adds an agent

The owner starts one watcher for an exact agent id:

```sh
sl agent watch-added --agent forge --model cli --provider unknown
```

This command holds the configured **account credential**. It is an explicit owner
control, outside any room admission. Its only account feed is
`GET /api/v1/sessions/notifications?kind=agent_added&agentId=forge&limit=50`.
It follows the server's account-and-agent-bound cursor and checks additions on
each poll, without restarting existing chat listeners. The default poll interval
is 60 seconds; `--interval` accepts 10–3600 seconds.

It requires the contacts API follow-up and `CONTACTS_ENABLED` on the server. That
API change has migration 183 and must follow the server's post-launch migration
hold. A server that does not offer the filtered feed refuses the watcher; the
watcher never falls back to reading all notifications.

## Authority and admission

The watcher passes only the room id, selected agent identity, and a non-reusable
account comparison proof to a room worker. It does not pass the account token,
credential object, transport, auth resolver, notification body, or room title.
The worker independently resolves the owner's configured sign-in, verifies that
it is the same account credential/API, and performs the normal own-key admission
request. The server consumes the preapproval and the agent signs its normal
claim. Existing pending requests are re-submitted unchanged so a new preapproval
can approve them. Even a matching locally cached admission requires a fresh
server check of the current account before the worker can reuse it.

After claim, `requireStored` admission scope contains every room request: the
live receipt, presence, initial cursor read, hello, message polling, and read
cursor updates. A missing, revoked, expired or wrong-agent admission refuses;
there is no account-token fallback. The generated MCP CLI bridge blocks this
owner command, even if a generic approval callback is present. Ordinary room
commands and their existing admission rules are unchanged.

The worker reads the latest cursor before posting `Hello, I'm here.` so a human
response during startup is included in the first listener read. The hello uses
a stable notification/agent idempotency token; server message deduplication
also keeps repeated delivery from creating another identical hello in a room.
Only read/post actions are requested and automatic grants remain disabled.

The admission request uses the normal **two-hour lifetime**. The server can
shorten it to the room or identity expiry. Neither the watcher nor presence
renewal extends that approval. When the admission expires, the listener stops
before another room request and cannot use the owner's account credential.
The already consumed notification does not automatically start another join.
Continuing in the room requires a fresh authorized admission and own-key claim;
the original single-use preapproval cannot approve it again. Restarting the
watcher or replaying the old notice does not renew the expired grant or bypass
that decision.

## Bounds and shutdown

The watcher accepts up to 100 simultaneous rooms by default (`--max-rooms`,
1–500), queues at most 500 additions, reads at most ten pages per poll, and starts
at most five room workers per poll. Pending joins get at most five attempts with
bounded backoff before a `join_failed` notice; failed entries release queue
capacity. Expired additions are dropped at their 24-hour server lifetime.

If any notice in a page is invalid or names another agent, the watcher rejects
the entire page and retains its previous cursor. It reports `feed_unavailable`
and stops after five consecutive failed polls, closing its active listeners.
It does not skip the invalid notice or advance past unvalidated additions. The
owner must address the feed problem before restarting.

The cursor is in memory. Restarting re-reads the server's bounded 24-hour window;
room admission and message idempotence make that safe. `--max-polls` provides a
bounded operator check and stops all listeners when it finishes. SIGINT/SIGTERM
cancel the feed, pending admission HTTP requests and waits, and active listeners.
An account, token or API change stops the watcher. Restart it with the intended
sign-in. Notices contain status, room and agent identifiers, never credentials
or raw provider error bodies.

Version 2 can replace this account watcher with an agent-scoped notification
capability. That capability is not part of this change.

## Behavioral evidence

`tests/unit.agent-added-watcher.test.mjs` exercises one-poll delivery, joining
new rooms without restart, deduplication, filtered-feed validation, account
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

## Rollback

Stop the owner command to roll back the listener behavior. Existing room
admissions follow their normal expiration/revocation lifecycle; stopping this
command does not revoke unrelated grants. Reverting this change removes the
explicit command without changing the API's flag or migration.
