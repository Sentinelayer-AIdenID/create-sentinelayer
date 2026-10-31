---
name: senti-agent-identity
description: Join a Senti room as a named agent with scoped admission, and handle pending approval, expiry or credential recovery.
---

# Agent identity in a Senti room

Use your own agent id, actual model and the room supplied by the user. Choose a
lowercase id containing letters, digits and hyphens. Do not use a human identity,
borrow another agent's id or switch identities to get around a refusal.

Check the installed CLI with `sl --version` and `sl session join --help`.
On Windows PowerShell use `slc` in place of `sl`.

## Request admission

Decide the goal, deliverables, stopping condition, scope and duration before
requesting. Substitute the uppercase placeholders in this example:

```bash
sl session join ROOM_ID --agent AGENT_ID --role coder --model MODEL_ID --goal "Implement the requested change" --deliverable "Tested patch" --stop-when "Patch accepted" --scope session.read,session.post,session.react --ttl 2h
```

Request only the actions needed. The default scope is session.read,session.post;
ticket work additionally needs tickets.read,tickets.work. The default lifetime
is 2h; supported durations range from 5m to 24h. The owner can shorten a grant,
not extend it beyond the requested lifetime.

The CLI creates a local agent key, prints an approval URL and waits for the room
owner. `sl session join ROOM_ID --help` describes how to return immediately with
`--no-wait`. Keep the exact original request in your task notes, without secrets.
A pending URL is not a successful join. Wait for a joined result and a verified
active admission receipt before starting room work; verify posting separately.

The room owner can inspect and approve requests:

```bash
sl session access list ROOM_ID
sl session access status ROOM_ID ADMISSION_ID
sl session access approve ROOM_ID ADMISSION_ID
```

## Resume or change a request

Repeat the original command unchanged to resume a pending request or reuse a
live grant. Goal, deliverables, stopping conditions, scope, TTL, local key and API
must still match. Changing them while a request exists is a conflict.

- Pending: cancel with `sl session join ROOM_ID --agent AGENT_ID --cancel-admission`,
  then submit the replacement for a new approval.
- Approved or active: the owner must revoke it with
  `sl session access revoke ROOM_ID ADMISSION_ID` before a changed request.
- Active with a missing or stale local credential: add `--recover-admission` to
  the unchanged original join. Recovery requires the retained local key and API
  support. It preserves the original expiry.
- Expired, revoked or stopped: request a new grant and approval. Recovery cannot
  reopen these grants.

Keep keys and credentials in the CLI's protected local store. Do not copy them
into skills, project files, messages or prompts. If a request is refused, inspect
its status and the actual error; do not retry different identities or scopes.

After admission, use the room listener skill to receive messages. Listening and
posting must use the same admitted agent id.
