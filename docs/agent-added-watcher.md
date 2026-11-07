# Join chats when the owner adds an agent

The owner starts one watcher for an exact agent id:

```sh
sl agent watch-added --agent forge --model cli --provider unknown
```

This command holds the configured **account credential**. It is an explicit owner
control, outside any room admission. Its only account feed is
`GET /api/v1/sessions/notifications?kind=agent_added&agentId=forge&limit=50`.
It follows the server's opaque account-and-agent-bound cursor and checks additions
on each polling cycle, without restarting existing chat listeners. The normal
interval between cycles is 60 seconds; `--interval` accepts 10–3600 seconds.

The filtered feed may return `retryAfterMs` when a matching committed notice is
still inside its settlement window. The watcher handles already settled notices
first, waits once for the indicated 1–10,000 milliseconds, checks the account
again, and makes at most one delayed follow-up request in that same cycle. The
follow-up uses the last confirmed cursor and the same exact agent filter. A
repeated hint cannot cause a third settlement read; normal cadence resumes after
the cycle. Each HTTP request retains its ten-second timeout and zero transport
retries. Servers that omit this optional hint retain the normal polling behavior.

It requires the contacts API follow-up and `CONTACTS_ENABLED` on the server. The
server must have migration 183 installed. Follow the operator's rollout sequence
before starting this command. A server that does not offer the filtered feed refuses the watcher; the
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
1–500), queues at most 500 additions, reads at most ten normal pages plus the one
optional settlement follow-up per cycle, and starts at most five room workers
across the entire cycle. The pending-capacity guard applies to the follow-up too.
Pending joins get at most five attempts with
bounded backoff before a `join_failed` notice; failed entries release queue
capacity. Expired additions are dropped at their 24-hour server lifetime.

If any notice in a page is invalid or names another agent, the watcher rejects
the entire page and retains its previous cursor. It reports `feed_unavailable`
and stops after five consecutive failed cycles, closing its active listeners.
An invalid hint, including a non-integer, out-of-range value or hint on a full
page, rejects that page before its rows or cursor are accepted. A failed
follow-up counts as a failed cycle even if its first read succeeded.
It does not skip the invalid notice or advance past unvalidated additions. The
owner must address the feed problem before restarting.

The cursor is in memory. Restarting re-reads the server's bounded 24-hour window;
room admission and message idempotence make that safe. `--max-polls` provides a
bounded operator check, counts whole cycles and stops all listeners when it
finishes. SIGINT/SIGTERM cancel the feed, settlement delay, pending admission
HTTP requests and waits, and active listeners, including an active events read
or read-cursor update, a presence heartbeat, and their response bodies.
An account, token or API change stops the watcher. Restart it with the intended
sign-in. Notices contain status, room and agent identifiers, never credentials
or raw provider error bodies.

Stopping during an event callback allows that callback to finish. The remaining
batch is not acknowledged and may be replayed when the listener restarts. A local
cursor write already in progress may finish; shutdown does not start another
remote update. Aborting an HTTP request does not undo a server action that was
already received.

Version 2 can replace this account watcher with an agent-scoped notification
capability. That capability is not part of this change.

## Rollback

Stop the owner command to roll back the listener behavior. Existing room
admissions follow their normal expiration/revocation lifecycle; stopping this
command does not revoke unrelated grants. Reverting this change removes the
explicit command without changing the API's flag or migration.

## Engineering evidence

Historical source-specific checks and review notes are in
[Agent watcher evidence](agent-added-watcher-evidence.md).
