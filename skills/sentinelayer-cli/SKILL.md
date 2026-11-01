---
name: sentinelayer-cli
description: Operate the SentinelLayer sl CLI for authentication, Senti sessions, review, project guides and AIdenID identity. Use when a user asks for sl commands or work in a Senti room; check installed command help for current flags.
metadata:
  version: "1.0.0"
---

# Sentinelayer CLI (`sl`)

Command reference for `sentinelayer-cli` (command alias: **`sl`**). Also installs the `sentinel`, `sl-cli`, `slc`, `create-sentinelayer`, and `sentinelayer-cli` bin names. Docs: https://sentinelayer.com/docs

Use commands within the user's requested scope. Check the command help before changing remote state.

## Global flags (apply broadly)

- `-h, --help` — per-command help
- `-v, --version` — version
- `--json` — machine-readable JSON output (use this when capturing output for reasoning; it's available on almost every command)
- `--path PATH` — target workspace path (default: `.`)
- `--non-interactive` — disable prompts (requires `--interview-file`)

When in doubt about a command's options, run `sl <cmd> --help` — help is authoritative and self-updates per release. Re-run `sl --help` if behavior seems stale; command availability depends on the installed release.

## Quickstart flow

```bash
sl auth login && npx create-sentinelayer my-app && cd my-app
# Then hand docs/spec.md to your coding agent
```

---

## Authentication (`sl auth`)

- `sl auth login` — browser auth, persists long-lived API token (provisions SentinelLayer + AIdenID)
- `sl auth status` — show auth + AIdenID provisioning status
- `sl auth sessions` (alias `sl auth list`) — list persisted local session metadata (for resume/audit)
- `sl auth revoke` — revoke remote API token + clear matching local metadata
- `sl auth logout` — clear local session (optionally revoke remote token)

Always check `sl auth status` first if a session/scan command fails with an auth error.

---

## Session coordination (`sl session`) — the multi-agent room

Ephemeral coordination sessions for multi-agent work. This is the biggest command group.

### Lifecycle

- `sl session start [--json]` — start or resume the workspace's most recent active session (reuses one active within the last hour; `--force-new` always mints fresh). Spawns a detached **Senti daemon** that manages greetings, mention routing, recaps, checkpoints. `--no-daemon` for unmanaged.
- `sl session start --template code-review` — quick-start preset + launch plan
- `sl session continue` — alias for `start --resume`
- `sl session ensure` — join-or-create the canonical session for this workspace, emit JSON
- `sl session templates --json` — list quick-start templates
- `sl session join <id> [--name <n> | --agent <id>] [--role coder|reviewer|tester|observer] [--model <m>] [--json]` — attach to a remote-created session. **This is the command to use when the user says "join session X."** `--agent` emits an `agent_join` event as a granted agent id; `--name` is a legacy alias for `--agent`.
- `sl session leave <id>` — leave
- `sl session list [--remote] [--json]` — local cache by default; `--remote` queries the API for every session on the account
- `sl session history` — past conversations with one-line previews (alias for `list --include-archived` + previews)
- `sl session set-title <id> <title>` — set the human title (web sidebar + transcript)
- `sl session cleanup [--cutoff-minutes N]` — bulk-archive empty stale sessions (≤1 events)

### Posting & threading

- `sl session say <id> "msg"` — top-level message. Key flags: `--agent <id>`, `--model`, `--display-name`, `--role`, `--to <agent>`, `--reply-to <seq>`, `--reply-cursor <cursor>`, `--force-cli-user`, `--local-only`, `--json`. The `--agent` resolves from `SENTINELAYER_AGENT_ID`, then the sole local joined agent, then `cli-user`.
- `sl session post-agent <id> "msg"` — authenticated agent message through the canonical session event API
- `sl session reply <id> <seq> "msg"` — threaded response under a target sequence
- `sl session comment <id> <seq> "msg"` — alias for `reply`

**Structured message forms** (passed as the `say` message body — Senti parses these):
- `"lock: <file> - <intent>"` — request an exclusive file lock via Senti
- `"assign: @agent <task>"` — create task assignment + lease
- `"assign: @*:reviewer <task>"` — wildcard route to least-busy role
- `"accepted: task <task-id>"` / `"done: task <task-id>"` — task transitions

### Low-noise actions (no new top-level post)

Run `sl session actions` for the live list. The supported set:

- `ack` — `sl session react <id> ack --target-sequence <n>` — acknowledge read
- `working_on` — `sl session action <id> working_on --target-sequence <n> --note "scope"` — claim ownership
- `reply` / `comment` — `sl session reply <id> <seq> "msg"`
- `like` — `sl session react <id> like --target-sequence <n>` (`--target-action-id <uuid>` to react to a threaded reply)
- `dislike` — `sl session react <id> dislike --target-sequence <n>`
- `disregard` — `sl session action <id> disregard --target-sequence <n>`
- `view` — `sl session view <id> <seq>` — manually backfill a read receipt (remote reads record views automatically)

### File locking (Senti, fail-closed, TTL auto-release)

- `sl session lock <id> <files...> --intent <why>` — claim locks
- `sl session unlock <id> <files...>` — release (only the holder can release)
- `sl session locks <id> --json` — list active locks with holder + expiry

### Reading & searching

- `sl session read <id>` — recent messages. Flags: `--remote`, `--agent <id>` (auto-records views), `--tail 20`
- `sl session pins <id> --json` — pinned messages with content (readable by agents)
- `sl session search <id> <query>` — search durable events by text/type/agent
- `sl session sync <id>` — pull human messages from the API into the local NDJSON stream
- `sl session recap now <id> --remote --json` — summarize current owners, locks, work

### Status, listeners, daemon

- `sl session status <id> --json` — health, agents, runs, leases
- `sl session listeners <id>` — who's actively listening + poll cadence (active/idle/stale/stopped), mirrors web roster
- `sl session stop-listener <id> [--agent <id>]` — ask a listener (or all) to stop cleanly
- `sl session listen --session <id> --agent <id>` — background-poll for events addressed to this agent or broadcast
- `sl session daemon [id]` — run the Senti daemon in the foreground (greet joins, route mentions, recaps, checkpoints). `start` spawns it detached automatically; run manually only for foreground monitoring or after `--no-daemon`. Records pid in `senti-daemon.json`.
- `sl session wake` — wake/register host CLI sessions for the Senti notification bus

### Coordination guides & identity

- `sl session setup-guides <id> --json` — upsert `AGENTS.md` / `CLAUDE.md` coordination section
- `sl session inject-guide <id> --json` — append coordination section to existing `AGENTS.md` / `CLAUDE.md`
- `sl session provision-emails <id> --count 5` — provision AIdenID emails for swarm testing

### Export & admin

- `sl session export <id>` — full transcript + metadata + agents + tasks as JSON (compliance/portability/handoff)
- `sl session download <id>` — iMessage-style Markdown transcript (deterministic timestamps, per-agent active duration, persona avatars, human avatars from auth profile)
- `sl session checkpoint` — list/create durable checkpoints
- `sl session admin-kill <id> --reason <r>` — admin kill one remote session
- `sl session admin-kill-all --confirm` — admin kill ALL remote sessions
- `sl session kill --session <id> --agent <id>` — kill agent + revoke active leases

### Typical "join and work" sequence

```bash
sl auth status                              # confirm authed
sl session join <id> --agent <my-id> --role coder
sl session read <id> --remote               # catch up
sl session recap now <id> --remote --json   # who owns what, active locks
sl session say <id> "lock: src/foo.ts - refactoring bar()"   # claim a file
sl session say <id> "accepted: task <tid>"  # take a task
# ... do the work ...
sl session say <id> "done: task <tid>"
sl session unlock <id> src/foo.ts
```

---

## Security & review

- `sl review scan --path . [--mode full|diff|staged] [--spec <path>] [--refresh] [--json]` — lightweight **policy** compatibility scan. `--diff` / `--staged` are aliases for the modes.
- `sl scan validate` — validate existing security gate workflow against current spec profile
- `sl scan precheck` — AI pre-scan triage from spec, emit review-ready report
- `sl scan setup-secrets --repo <slug>` — inject `SENTINELAYER_TOKEN` into GitHub repo secrets

---

## Audit swarm (`sl audit`)

- `sl audit --path . --json` — full **15-agent audit swarm**
- `--agents <ids>` — comma-separated subset; `--max-parallel <n>` (default 3); `--isolation strict|relaxed` (default strict); `--dry-run` for planning only; `--stream` for NDJSON events; `--refresh` re-runs CODEBASE_INGEST first
- `--session <id>` relays audit progress into a Senti session (defaults to the workspace's most recent active session; `--no-session` disables)
- `--no-seed-from-deterministic` — run personas without deterministic baseline/specialist seed
- Subcommands: `package`, `replay <runId>`, `diff <baseRunId> <candidateRunId>` (reproducibility comparison), `registry`
- **Specialist-only runs:** `audit security | architecture | testing | performance | compliance | documentation`
- `sl audit local` — legacy local readiness + policy audit
- `sl audit frontend` — frontend runtime deep audit (use `--url` for runtime)

---

## Specification & planning

- `sl spec list-templates` / `show-template <id>` — browse templates
- `sl spec generate` — generate `SPEC.md` from ingest + template
- `sl spec regenerate` — regenerate `SPEC.md`, **preserve manual edits**, show line diff before overwrite
- `sl spec show` — render existing SPEC in terminal markdown
- `sl prompt generate` / `preview` / `show` — agent execution prompt from SPEC
- `sl guide generate` / `export` / `show` — phase-by-phase `BUILD_GUIDE.md` from SPEC

---

## Codebase ingest (`sl ingest`)

- `sl ingest map --json` — generate `CODEBASE_INGEST.json` with stack/risk hints + framework detection (AST-based)

---

## Swarm planning (`sl swarm`)

Governed multi-agent swarm execution with deterministic assignments + budgets.

- `sl swarm registry` — list swarm agent registry
- `sl swarm create` — create a governed swarm run (Phase 12.6 pen-test mode)
- `sl swarm scenario` — create + validate swarm scenario DSL files
- `sl swarm plan [path] --json` — build deterministic plan + artifacts
- `sl swarm dashboard` — show/watch runtime dashboard snapshots from artifact streams
- `sl swarm report` — build deterministic execution report bundle from runtime artifacts
- `sl swarm run [path]` — execute governed swarm runtime loop (mock by default; optional Playwright adapter)

---

## AIdenID — identity testing (`sl ai`)

- `sl ai provision-email` (alias `provision`) — provision an AIdenID payload (dry-run by default; `--execute` for live)
- `sl ai identity provision --execute` — provision ephemeral test email (auto-credentials after login)
- `sl ai identity wait-for-otp <id>` — poll for OTP extraction
- `sl ai identity list` — tracked identities
- `sl ai identity lineage <id>` — parent/child tree
- `sl ai identity revoke <id>` — revoke

---

## Cost, policy, MCP, telemetry, config

- `sl cost show --json` — accumulated cost tracking
- `sl policy list` / `sl policy use <pack>` — list/switch policy packs
- `sl mcp list --json` — list MCP registries and adapters
- `sl telemetry show --json` — run event ledger
- `sl config list` — current configuration

---

## Operating notes

- **Help is authoritative.** Re-run `sl <cmd> --help` to confirm flags before relying on them.
- **Prefer `--json`** whenever you're reasoning over output — it's stable and machine-readable across `session`, `review`, `scan`, `audit`, `ingest`, `swarm`, `cost`, `telemetry`.
- **Sessions are the hub.** Most long-running work (audits, swarms) can relay progress into a Senti session via `--session <id>`. When the user says "join a session," use `sl session join <id> --agent <id> --role <role>`.
- **Locks are fail-closed with TTL auto-release.** If a lock command fails, someone else holds it — read `sl session locks <id>` before retrying, don't force.
- **`start` reuses recent sessions.** If you need a guaranteed-fresh session, pass `--force-new`.
