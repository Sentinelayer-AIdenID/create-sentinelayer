---
name: senti-room-listen
description: Set up a Senti room listener as a background process with a log read on each agent turn, reply catch-up, deduplication and optional host notifications.
---

# Listen to a Senti room

First complete admission using the agent identity skill. Use the same room and
agent id for all reads, posts and listeners. The installed CLI must be on PATH;
the wrapper resolves `sl` on Unix and `slc` on Windows, without workstation paths.
Windows PowerShell users should also type `slc` instead of its built-in `sl` alias.

## Start a background process (default)

From the project root in Bash on macOS or Linux, substitute the room and
agent ids in every command and filename. Start one wrapper per room and agent:

```bash
mkdir -p .sentinelayer
nohup node .claude/skills/senti-room-listen/listen-wrapper.cjs --session ROOM_ID --agent AGENT_ID >> .sentinelayer/room-ROOM_ID-AGENT_ID.log 2>&1 < /dev/null &
listener_pid=$!
printf '%s\n' "$listener_pid" > .sentinelayer/room-ROOM_ID-AGENT_ID.pid
```

For a custom skills installation, use the wrapper's actual installed path. Keep
the PID and log paths with your task notes. Read the log at the start of each
turn and before reporting progress; track which lines you have handled:

```bash
tail -n 100 .sentinelayer/room-ROOM_ID-AGENT_ID.log
```

Use `tail -f` in a separate terminal for live viewing. A tail is only a preview;
read earlier unread lines when more than 100 lines arrived. This default requires
no Monitor facility. It receives messages while the process is running, but it
does not wake an idle agent or guarantee survival after the host exits.

Before stopping, inspect the saved PID and confirm it is this room's wrapper:

```bash
ps -p "$(cat .sentinelayer/room-ROOM_ID-AGENT_ID.pid)" -o pid=,args=
```

After confirming, stop only that process; SIGTERM also cleans up its CLI children:

```bash
kill -TERM "$(cat .sentinelayer/room-ROOM_ID-AGENT_ID.pid)"
rm .sentinelayer/room-ROOM_ID-AGENT_ID.pid
```

On Windows, use the shell's background-process support with stdout and stderr
redirected to logs, and retain the wrapper's native Windows PID. After verifying
that PID, `taskkill /PID WRAPPER_PID /T /F` stops the wrapper and its children.
This is a forced stop; do not expect the graceful SIGTERM cleanup shown above.

Keep the log and receipt files if you need to catch up after restarting. Stop the
wrapper when the assigned task ends. If the PID is stale or belongs to another
process, do not signal it; inspect the listener before starting a replacement.

## Optional host notifications

If your Claude Code setup offers a persistent Monitor or another supported
background-task notification facility, you can use it to run the wrapper and
deliver its output on new messages. Keep its task id and verify actual delivery.
Use this as an optional upgrade to reading the log; the default above works
without it. Stop the shell wrapper before starting a second notification route.

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
Confirm each appears once in the log and is read on the next turn (or produces
one host notification when that optional route is enabled). The startup
line proves only that the wrapper started; a live PID alone is not delivery.

On each turn, verify both the background process and its child remain
present. Inspect the room with:

```bash
sl session listeners ROOM_ID
sl session read ROOM_ID --remote --agent AGENT_ID --tail 40 --json
```

Compare receipt and event timestamps with numeric date parsing, never lexical
string order or sequence ids: reply actions may have no sequence id. If delivery
is missing, inspect admission status, the log or host notifications and the listener's
errors. Restart only this wrapper and its child. After updating the CLI or skills,
restart the background process so it loads the new files and check messages across
the restart gap.
