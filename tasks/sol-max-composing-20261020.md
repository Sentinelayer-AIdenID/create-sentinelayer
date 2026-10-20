# Explicit runtime composing

- [x] Plan: reuse message identity/mutation guards and room SSE. Declare actual reply lifecycle; never infer it from reads or listener presence.
- [x] Implement CLI commands, scoped transport, 15-second runtime heartbeat, 45-second server expiry, finally/abort cleanup, explicit runtime-bridge target and budget/manual-stop cleanup.
- [x] Prove transport guards, stale lease refusal, cleanup, no implicit composing, and actor/MCP classifications. 11 focused runtime tests and 93 transport/admission tests passed; full final unit suite 2514 passed, 3 skipped.
- [x] Syntax 406 files, docs validation and pack dry-run. Legacy audit PASS with three existing P2 findings.
- [x] Run required verify: E2E 134 passed, two unchanged baseline failures (old help URL and legacy join fixture). No overall verify success claimed.
- [x] Deterministic Omar: no P0/P1; one pre-existing P2 flags prose `injectSecret` description in bridge-inputs.js as a possible secret. Exact same text exists on origin/main; no credential literal introduced and no suppression added.
- [ ] Warden independent review/merge/release; real IDE and box adapters must call explicit execution hooks, followed by a live SSE canary. Source validation is not live acceptance.
