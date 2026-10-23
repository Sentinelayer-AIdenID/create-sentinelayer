# Omar Gate (Jev) Finding Triage — PR #861

Ticket: e331abc7
Branch: warden/omar-gate-jev-20261023
Gate run: 39941411025

## P0 #1: `.github/workflows/rollback.yml:67` — Secret-shaped string in workflow

**Disposition: False positive (pre-existing, not in PR diff)**

- Line 67: `run: |` (start of multi-line shell script block)
- The finding flags `ROLLBACK` as secret-shaped, but it is a literal comparison string
  in a shell `if` guard (`if [ "${{ inputs.confirm }}" != "ROLLBACK" ]`) — a public
  workflow_dispatch input sentinel, not a credential.
- Evidence: `git diff main...HEAD -- .github/workflows/rollback.yml` is empty.
  This file is unchanged by PR #861.

## P0 #2: npm dependency audit harness (unsafe_lockfile)

**Disposition: Action-side fix (not a repo change)**

- The original run (action pinned to `ebfcb813`) failed with `unsafe_lockfile` because
  the npm audit harness in Sentinelayer-AIdenID/sentinelayer-v1-action rejected
  npm v3 `"peer": true` markers in `package-lock.json`. These markers are legitimate
  npm v3 lockfile metadata; the lockfile validator is being repaired in Action #125.
- No changes to `package.json`, `package-lock.json`, or `.gitignore` are included
  in this PR. The lockfile is unchanged from main.

## P1: `src/legacy-cli.js:606` — Secret-shaped string in source

**Disposition: False positive (pre-existing, not in PR diff)**

- Line 606: `export const __legacyCredentialFlowForTests = Object.freeze({...})`
- The finding triggers on the `__legacyCredential` prefix, but this is an export
  of function references at module scope — not a credential, key, or token.
- The exported object contains: `pollCliSession`, `generateArtifacts`,
  `issueBootstrapToken`, `requestJson` — all function names used in tests.
- Evidence: `git diff main...HEAD -- src/legacy-cli.js` is empty.
  This file is unchanged by PR #861.

## npm audit advisories

The `mrrCarter/sentinelayer-v1-action` `dep_audit` harness runs `npm audit
--audit-level=critical` and reports only **critical**-severity vulnerabilities
as `HARNESS-NPM-AUDIT` findings at P1 severity. High, moderate, and low
advisories do not produce gate findings from the dep audit suite.

Dependency audit coverage for non-Jev scans is provided by the main
`omar-gate.yml` workflow which uses the `mrrCarter` fork
(`8afb7dbb42a5e1c25233d422c4cabe401ba02380`).

## Workflow

The workflow uses `pull_request` trigger. `fork_policy: block` ensures the
action fails closed for fork PRs where secrets are absent.

## Summary

- 2 P0: 1 false positive (pre-existing, `rollback.yml` line 67), 1 action-side fix
  (unsafe_lockfile — resolved in Action #125, no lockfile changes in this PR)
- 1 P1: false positive (function exports, `src/legacy-cli.js` line 606);
  pre-existing, not in PR diff
- npm audit: no changes to lockfile or overrides in this PR
- Gate-visible findings in PR diff at P1+: **0**
