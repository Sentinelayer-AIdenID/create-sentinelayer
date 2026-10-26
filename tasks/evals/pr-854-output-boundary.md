# PR 854: workspace artifact write boundary

## Contract and scope

AI change class D: local artifact filesystem security boundary. Workspace YAML
`outputDir` values remain relative and confined to the workspace. Default roots
and every CLI/global root lexically inside the workspace are confined as well;
relative escapes are refused regardless of source. A valid root
does not authorize an existing descendant link to an external directory or file.
Each actual mutation now validates its complete destination using a per-operation
filesystem capability returned by `resolveOutputContext`. Paths passed to IO are
the same normalized paths that were validated. No process-global policy registry
is used.

Constrained file writes, appends, and writable opens refuse final-component
symlinks, including links to another file inside the workspace, and pre-existing
regular files with more than one hard link. They add native
`O_NOFOLLOW` when the platform provides it. Safe parent directory links inside the
real workspace remain supported. The boundary does not promise protection from
concurrent replacement of a parent directory or creation of a new hard link
between validation and IO.

Only explicit absolute CLI/global output paths outside the workspace retain
unrestricted behavior. An absolute workspace-local override does not disable
containment. The current environment mapping has no outputDir variable; no new
environment option is introduced. Read-only operations remain read-only and
unrestricted; copying an external input into an allowed destination remains valid.

## Writer inventory

| Family | Root resolution and propagation | Protected artifact mutations |
| --- | --- | --- |
| Telemetry and cost | `telemetry/ledger.js`, `cost/history.js` | Event append and queued history rewrite; inherited persona telemetry capability |
| Ingest and command reports | `ingest/engine.js`, `legacy-cli.js`, `commands/chat.js`, `commands/scan.js`, `commands/watch.js` | Ingest JSON, report Markdown, transcript append, watch events and summaries |
| Review | `review/local-review.js`, `ai-review.js`, `report.js`, `replay.js`, `omargate-cache.js`, `commands/review.js` | Deterministic checks/logs, AI artifacts, unified reports, decisions/exports, replay/context and cache files |
| Audit and memory | `audit/orchestrator.js`, `package.js`, `replay.js`, `persona-loop.js`, `commands/audit.js`, `memory/blackboard.js`, `agents/shared-tools/dispatch-core.js` | Agent reports, shared-memory reports, package/comparison files, tool-result persistence and derived telemetry |
| Swarm and browser | `swarm/factory.js`, `runtime.js`, `report.js`, `pentest.js`, `scenario-dsl.js`, `agents/devtestbot/tool.js`, `runner.js` | Plans, scenario templates, runtime logs/reports, screenshot buffers, pentest files, browser JSON/MP4 files; destination validation before delegated video/Lighthouse writes |
| Identity and domain artifacts | `commands/ai/shared.js`, `identity-lifecycle.js`, `provision-governance.js`, `commands/session.js`, `ai/identity-store.js`, `domain-target-store.js`, `site-store.js` | Identity/site/target registry rewrites and related JSON artifacts, including session email provisioning |
| Daemon | `daemon/error-worker.js`, `scope-engine.js`, `assignment-ledger.js`, `budget-governor.js`, `jira-lifecycle.js`, `operator-control.js`, `hybrid-mapper.js`, `reliability-lane.js`, `watchdog.js`, `artifact-lineage.js`, `ast-drift.js`, `fix-cycle.js` | Intake/queue/state JSON, event appends, derived run records, atomic AST snapshot replacement, fix-cycle and closeout/lineage artifacts |
| MCP and plugins | `mcp/registry.js`, `commands/mcp.js`, `plugin/manifest.js`, `commands/plugin.js` | All eight configured MCP JSON destinations plus plugin initialization |
| Investor DD | `review/investor-dd-orchestrator.js`, `investor-dd-devtestbot.js` | Stream, metrics, plans, findings, reports, browser-phase output and identity-registry propagation |

Storage objects carry the executable capability as a nonenumerable property;
serialized JSON shapes remain stable. Derived storage and explicit child paths
receive the capability explicitly instead of reclassifying an inherited output
root as a trusted CLI override.

Low-level exported artifact writers require an explicit factory capability and
throw TypeError before effects when it is omitted, null, native fs/promises, or a
copied/forged interface. A module-private WeakSet checks capability identity;
it stores no path policy. Root-owning entry points resolve their own scoped
capability and forward it through all lower-level calls. No native filesystem
fallback remains for these artifact writes.

Read-only `resolveOutputRoot` uses remain in report lookup, watch history,
swarm dashboard and session analytics. Generated source documents and unrelated
auth/session persistence are outside this artifact-root change.

## Initial candidate verification (b85394d, superseded after first review)

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

## First-review follow-up verification

Warden requested default/local trusted-layer containment and removal of native
writer fallbacks. The revised tests exercise both directly. Loading the actual
b85394d resolver in the new P1 suite produces 16 expected failures; loading its
actual writer modules produces failures in all 40 missing/null/native/forged
capability cases. Source is substituted only by a test loader, without editing
the candidate. Test payloads use isolated temporary files and no live model calls.

The central Windows regression selection passes 127 tests with five native
file-symlink privilege skips. The four central native Linux suites pass 115/115,
without skips, including the final-file link and no-follow witnesses.
Daemon/persona/watch/AST integration passes 69/69 on native Linux; MCP/plugin
passes 88/88 on native Linux; the original 11 daemon suites pass 29/29 on Windows.
Six direct-writer compatibility suites, including browser capture, pass 16/16.
Investor-DD boundary and existing compatibility suites pass 37/37 on Windows
and native Linux. Syntax checks pass for 420 files and documentation validation
passes. The test expectations now require absolute workspace-local overrides
to stay guarded; only absolute outside paths retain the unrestricted control.
Full revised-candidate verification and hosted CI are separate gates; these
focused results do not imply they have passed.

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
