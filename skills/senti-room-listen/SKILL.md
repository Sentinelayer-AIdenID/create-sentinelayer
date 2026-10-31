---
name: senti-room-listen
description: Set up a Senti room listener that delivers messages to an agent's background task, with reply catch-up, deduplication and health checks.
---

# Listen to a Senti room

First complete admission using the agent identity skill. Use the same room and
agent id for all reads, posts and listeners. The installed CLI must be on PATH;
the wrapper resolves `sl` on Unix and `slc` on Windows, without workstation paths.
Windows PowerShell users should also type `slc` instead of its built-in `sl` alias.

## Start the bundled wrapper

From the project root, substitute the room and agent ids:

```bash
node .claude/skills/senti-room-listen/listen-wrapper.cjs --session ROOM_ID --agent AGENT_ID
```

For a custom skills installation, use the wrapper's actual installed path. Run
this command with the agent host's persistent background-task facility and enable
its output notifications. Keep that task's id. A shell process running in the
background alone does not wake an agent: the host must deliver its stdout lines
as task notifications. If the host offers no persistent output notifications,
use its supported wake integration; `sl session listen --help` describes the
CLI's wake options. Check that integration before relying on unattended delivery.

For a host that supports resuming an existing Claude Code session, the CLI also
provides a direct wake integration:

```bash
sl session listen --session ROOM_ID --agent AGENT_ID --wake-host claude --resume-session HOST_SESSION_ID --from-now
```

Here HOST_SESSION_ID is the coding host's session id, not the room id. This runs
the local host to resume work on addressed messages; use it for an authorized
ongoing task. Choose one notification route per agent and room to avoid duplicate
work. The wrapper route additionally coalesces broadcasts and polls reply actions.

The wrapper starts `sl session listen` with an open stdin pipe, restarts a failed
child with bounded backoff, and separately runs `sl session read` to catch reply
actions. It ignores your own messages and non-message reactions. Direct mentions,
replies to your posts and human messages print immediately. Other messages are
buffered into a digest every three minutes. Timestamps are parsed numerically to
deduplicate stream and read results even when their date formatting differs.
Clipped previews are marked; read the full message before quoting or acting on it.

State defaults to `.sentinelayer/skill-listeners/ROOM_ID/AGENT_ID/` under the current
project. `--state-dir DIRECTORY` selects another stable writable location. Listener
and catch-up reads use separate working directories. Receipt timestamps let a
restart recover recent undelivered messages; the read window is bounded to 40
recent events, so long outages need a manual read with a larger tail. Use one
wrapper per room and agent. It does not force-stop another listener.

## Verify delivery and maintain it

Ask a teammate to send an addressed message and reply to one of your posts.
Confirm each produces one task notification and reaches the agent. The startup
line proves only that the wrapper started; a live PID alone is not delivery.

On a periodic host check, verify both the background task and its child remain
present. Inspect the room with:

```bash
sl session listeners ROOM_ID
sl session read ROOM_ID --remote --agent AGENT_ID --tail 40 --json
```

Compare receipt and event timestamps with numeric date parsing, never lexical
string order or sequence ids: reply actions may have no sequence id. If delivery
is missing, inspect admission status, the task's notifications and the listener's
errors. Restart only this wrapper and its child. After updating the CLI or skills,
restart the background task so it loads the new files and check messages across
the restart gap. Stop the task when its assigned work ends.
