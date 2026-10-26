# PR 854: workspace artifact write boundary

## Contract and scope

AI change class D: local artifact filesystem security boundary. Workspace YAML
`outputDir` values remain relative and confined to the workspace. A valid root
does not authorize an existing descendant link to an external directory or file.
Each actual mutation now validates its complete destination using a per-operation
filesystem capability returned by `resolveOutputContext`. Paths passed to IO are
the same normalized paths that were validated. No process-global policy registry
is used.

Constrained file writes, appends, and writable opens refuse final-component
symlinks, including links to another file inside the workspace. They add native
`O_NOFOLLOW` when the platform provides it. Safe parent directory links inside the
real workspace remain supported. The boundary does not promise protection from
concurrent replacement of a parent directory between validation and IO.

Explicit CLI output directories/files and global output configuration retain
their existing trusted behavior. Default output when no project output setting
exists retains its existing behavior. Read-only operations remain read-only and
unrestricted; copying an external input into an allowed destination remains valid.

## Writer inventory

| Family | Root resolution and propagation | Protected artifact mutations |
| --- | --- | --- |
| Telemetry and cost | `telemetry/ledger.js`, `cost/history.js` | Event append and queued history rewrite; inherited persona telemetry capability |
| Ingest and command reports | `ingest/engine.js`, `legacy-cli.js`, `commands/chat.js`, `commands/scan.js`, `commands/watch.js` | Ingest JSON, report Markdown, transcript append, watch events and summaries |
| Review | `review/local-review.js`, `ai-review.js`, `report.js`, `replay.js`, `omargate-cache.js`, `commands/review.js` | Deterministic checks/logs, AI artifacts, unified reports, decisions/exports, replay/context and cache files |
| Audit and memory | `audit/orchestrator.js`, `package.js`, `replay.js`, `persona-loop.js`, `commands/audit.js`, `memory/blackboard.js`, `agents/shared-tools/dispatch-core.js` | Agent reports, shared-memory reports, package/comparison files, tool-result persistence and derived telemetry |
| Swarm and browser | `swarm/factory.js`, `runtime.js`, `report.js`, `pentest.js`, `agents/devtestbot/tool.js`, `runner.js` | Plans, runtime logs/reports, screenshot buffers, pentest files, browser JSON/MP4 files; destination validation before delegated video/Lighthouse writes |
| Identity and domain artifacts | `commands/ai/shared.js`, `identity-lifecycle.js`, `provision-governance.js`, `commands/session.js`, `ai/identity-store.js`, `domain-target-store.js`, `site-store.js` | Identity/site/target registry rewrites and related JSON artifacts, including session email provisioning |
| Daemon | `daemon/error-worker.js`, `scope-engine.js`, `assignment-ledger.js`, `budget-governor.js`, `jira-lifecycle.js`, `operator-control.js`, `hybrid-mapper.js`, `reliability-lane.js`, `watchdog.js`, `artifact-lineage.js` | Intake/queue/state JSON, event appends, derived run records and closeout/lineage artifacts |
| MCP and plugins | `mcp/registry.js`, `commands/mcp.js`, `plugin/manifest.js`, `commands/plugin.js` | All eight configured MCP JSON destinations plus plugin initialization |

Storage objects carry the executable capability as a nonenumerable property;
serialized JSON shapes remain stable. Derived storage and explicit child paths
receive the capability explicitly instead of reclassifying an inherited output
root as a trusted CLI override.

Read-only `resolveOutputRoot` uses remain in report/ingest lookup, watch history,
swarm dashboard and session analytics. Fixed workspace destinations in
`daemon/ast-drift.js`, `daemon/fix-cycle.js`, investor-DD and scenario templates do
not consume workspace-configured output roots and were not moved into this policy.

## Verification

- Actual baseline writer controls reproduced external writes or missing rejection
  in daemon, AI, and all nine MCP/plugin command cases before the repair.
- Five new boundary suites passed 95/95 on native Linux Node 24.17, without skips.
  Coverage includes real final-file symlinks, directory links, dangling links,
  inherited paths, safe internal parent links, CLI/global overrides, concurrent
  contexts, POSIX dot-segment normalization and a final symlink inserted after
  validation and refused by native `O_NOFOLLOW`.
- Native-versus-guarded flag probes matched for 36 write/append combinations.
  Encoding, file mode, exclusive flags, flush and pre-aborted writes are tested.
- Windows browser capture passed against installed Chromium/ffmpeg. Windows
  native file-link privilege skips are covered by the Linux run.
- Initial `npm run verify`: syntax 420 files, documentation build and 141 E2E
  tests passed. Unit coverage reported 2,955 passes, eight failures, 13 skips.
  One failure was the expected immutable evaluation source binding updated below;
  the other seven require separate baseline/environment classification. Full
  verification is not recorded as green.
- Local `/audit` passed with zero P1 and three nonblocking P2 findings.
  Local `/omargate deep` failed closed because all four dispatched AI personas
  received proxy 503 denials. Its deterministic scan had zero P0/P1 and 15 P2
  scope/credential-name heuristics. Remote sync and daemon autostart were disabled
  for these local commands. These are not hosted-gate acceptance results.

## Evaluation binding maintenance

The two bound modules `src/review/ai-review.js` and `src/legacy-cli.js` now use the
artifact write capability. Prompt/model routing, classification, cost/usage
contracts, seven synthetic cases, expected outputs and evaluation tests are
unchanged. The active fixture retains all eight source/test bindings and updates
only those two source hashes, with a separate `outputBoundaryMaintenance` record.
`pr-854-output-boundary/baseline-265b6510.json` preserves the previous complete
fixture. The evaluation and session-provision suites passed 82/82 after this
refresh. This remains mocked contract evidence, not model-accuracy evidence.

## Review and shipping gate

This local repair requires Warden's first review of the exact final candidate,
independent second review, and required hosted checks before publication/merge.
No approval, package release, or merge is represented by these local results.
