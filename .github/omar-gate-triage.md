# Omar Gate (Jev) Finding Triage — PR #861

Ticket: e331abc7
Branch: warden/omar-gate-jev-20261023
Gate runs: 39941411025, 40023034211 (luna-judge review)

## P0 #1: `.github/workflows/rollback.yml:67` — Secret-shaped string in workflow

**Disposition: False positive (pre-existing, not in PR diff)**

- Line 67: `run: |` (start of multi-line shell script block)
- The finding flags `ROLLBACK` as secret-shaped, but it is a literal comparison string
  in a shell `if` guard (`if [ "${{ inputs.confirm }}" != "ROLLBACK" ]`) — a public
  workflow_dispatch input sentinel, not a credential.
- Evidence: `git diff master...HEAD -- .github/workflows/rollback.yml` is empty.
  This file is unchanged by PR #861.

## P0 #2: npm dependency audit harness (unsafe_lockfile)

**Disposition: Fixed in `8903be0` — removed legacy `"peer": true` marker**

- The Sentinelayer-AIdenID/sentinelayer-v1-action at `ebfcb813` rejects lockfiles
  containing npm v1/v2 `"peer": true` markers as `unsafe_lockfile`. The
  `node_modules/devtools-protocol` entry in `package-lock.json` carried one such
  legacy marker.
- Commit `8903be0` removes the single `"peer": true` line from the lockfile.
  The lockfile is otherwise identical to the restored main-bytes version.
- `npm audit --audit-level=critical` exits 0 (0 critical, 1 moderate, 11 high).
  `npm ci` and `npm install --package-lock-only` produce no changes.
- The lockfile validator fix in Action #125 (Sentinelayer-AIdenID/sentinelayer-v1-action)
  remains the long-term fix; this lockfile change is the surgical workaround so the
  gate can pass with the currently-pinned `ebfcb813` revision.

## P1: `src/legacy-cli.js:606` — Secret-shaped string in source

**Disposition: False positive (pre-existing, not in PR diff)**

- Line 606: `export const __legacyCredentialFlowForTests = Object.freeze({...})`
- The finding triggers on the `__legacyCredential` prefix, but this is an export
  of function references at module scope — not a credential, key, or token.
- The exported object contains: `pollCliSession`, `generateArtifacts`,
  `issueBootstrapToken`, `requestJson` — all function names used in tests.
- Evidence: `git diff master...HEAD -- src/legacy-cli.js` is empty.
  This file is unchanged by PR #861.

## npm audit advisories

The `Sentinelayer-AIdenID/sentinelayer-v1-action` `dep_audit` harness runs `npm audit
--audit-level=critical` and reports only **critical**-severity vulnerabilities
as `HARNESS-NPM-AUDIT` findings at P1 severity. High, moderate, and low
advisories do not produce gate findings from the dep audit suite.

Dependency audit coverage for non-Jev scans is provided by the main
`omar-gate.yml` workflow which uses the `mrrCarter` fork
(`8afb7dbb42a5e1c25233d422c4cabe401ba02380`).

## Workflow

The workflow uses `pull_request` trigger. `fork_policy: block` ensures the
action fails closed for fork PRs where secrets are absent.

## Action Pin Policy

`Sentinelayer-AIdenID/sentinelayer-v1-action@ebfcb813126ff64f21bb1fccfef8ab30609af67c`
is allowlisted in `.github/policies/actions-lock.json`. The pin policy check passes.

## Summary

- 2 P0: 1 false positive (pre-existing, `rollback.yml` line 67), 1 fixed
  (unsafe_lockfile — removed legacy `"peer": true` marker from lockfile in `8903be0`)
- 1 P1: false positive (function exports, `src/legacy-cli.js` line 606);
  pre-existing, not in PR diff
- npm audit: `npm audit --audit-level=critical` exits 0 (0 critical, 1 moderate, 11 high)
- Action pin policy: passes
- Gate-visible findings in PR diff at P1+: **0**
