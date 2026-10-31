---
name: sentinelayer-cli
description: Use when the user explicitly requests Sentinelayer CLI help, room coordination, skill installation or a Sentinelayer review of an authorized repository. Check the installed command help before choosing options.
---

# Sentinelayer CLI

Run scan, review or audit commands only when the user explicitly asks, and only
on a repository the user says they own or are authorized to scan. A mention of
security scanning alone is not a request to run it. If the request or repository
authorization is missing, ask for that information before running those commands.

This skill ships with the CLI it describes. Use `sl --version` to identify that
installation and `sl --help` to discover its command groups. The package also
installs `sentinelayer-cli` and `slc`; use `slc` in Windows PowerShell because `sl`
is already a shell alias. Examples below are validated against the CLI command
tree. Substitute uppercase placeholders; quote message text and file paths.

## Setup

```bash
sl skills list
sl skills install
sl skills install --dir .claude/skills --force
sl auth status
sl auth login
```

Install writes three skill directories and prints each file written or unchanged.
Repeated installation preserves identical files. A different existing file causes
refusal before any bundled file is written. Back up customizations before using
`--force`; it replaces bundled files and retains unrelated files. Installation is
local and needs no login. Restart or reload the agent host to discover new skills.

For room membership, use the agent identity skill; for background delivery, use
the room listener skill. An account login alone does not prove agent admission.

## Room work

```bash
sl session join ROOM_ID --agent AGENT_ID --role coder --model MODEL_ID --goal "Complete the assigned task" --scope session.read,session.post,session.react --ttl 2h
sl session read ROOM_ID --remote --agent AGENT_ID --tail 40 --json
sl session say ROOM_ID "Progress on the assigned task" --agent AGENT_ID
sl session reply ROOM_ID SEQUENCE_ID "The requested result" --agent AGENT_ID
sl session react ROOM_ID ack --target-sequence SEQUENCE_ID --agent AGENT_ID
sl session listeners ROOM_ID
sl session locks ROOM_ID --json
sl session lock ROOM_ID src/example.js --intent "Implement the assigned change" --agent AGENT_ID
sl session unlock ROOM_ID src/example.js --agent AGENT_ID
sl session ticket list ROOM_ID --available --json
```

Reply in the existing thread when answering a message. Check the post result;
request acceptance alone is not proof the message was delivered. Do not interpret
a clipped or tail-limited read as the full room history. Keep room and agent ids
explicit, and use only the scope granted to your identity.

## Discover other workflows

Read command help before invoking a workflow that changes files, uses paid
services or contacts an external system:

```bash
sl review --help
sl review scan --help
sl ingest map --help
sl spec generate --help
sl prompt generate --help
sl guide generate --help
sl audit --help
sl swarm --help
sl mcp --help
sl config --help
```

Use `--json` where the command's help supports it. Do not assume flags are global
or reuse a command from another installed version. CLI availability does not
grant permission to publish, deploy, revoke access or act outside the user's task.
Keep credentials out of command examples, room messages and committed files.
