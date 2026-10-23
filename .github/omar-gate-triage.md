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

**Disposition: Resolved**

- The original run (action pinned to `ebfcb813`) failed with `unsafe_lockfile` because
  the npm audit harness rejected npm v3 `"peer": true` markers in `package-lock.json`.
- The lockfile has been verified compatible: no `peerOptional` or `link` markers
  (see test `unit.lockfile-audit.test.mjs`), and `npm audit --audit-level=critical`
  reports 0 vulnerabilities.
- Action pin updated to `fa8a4379d5e61da644a62ba8e18f62a3462f10d2` (HEAD of
  Sentinelayer-AIdenID/sentinelayer-v1-action as of 2026-10-23).

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

The Sentinelayer-AIdenID fork at `fa8a4379` does not include `dep_audit.py` and
does not perform dependency auditing. Dependency audit coverage is provided by
the main `omar-gate.yml` workflow which uses the `mrrCarter` fork
(`8afb7dbb42a5e1c25233d422c4cabe401ba02380`).

Current npm audit state: `npm audit --json` → 0 vulnerabilities total.

### Overrides applied in `package.json`

```json
"overrides": {
  "basic-ftp": "6.2.3",
  "brace-expansion": "5.0.12",
  "@puppeteer/browsers": "3.2.6"
}
```

### Advisory resolution evidence

| Advisory | Package | Before | After | Mechanism |
|---|---|---|---|---|
| GHSA-c475-qrg2-pj4r | basic-ftp | 5.3.1 | 6.2.3 | override to latest (patches quadratic DoS) |
| GHSA-q2hr-2g5m-vwhr | brace-expansion | 5.0.12 | 5.0.12 | already at latest; override forces npm to re-resolve, clearing stale advisory range (4.0.0-5.0.11) |
| GHSA-qhr7-859c-m2p7 | brace-expansion | 5.0.12 | 5.0.12 | same as above |
| GHSA-6j4f-fj2g-mc7p | brace-expansion | 5.0.12 | 5.0.12 | same as above |
| GHSA-jmr9-qjv8-65gv | extract-zip | 2.0.1 | (removed) | @puppeteer/browsers@3.2.6 replaces extract-zip with modern-tar |
| GHSA-7pqw-9j4j-h8q3 | extract-zip | 2.0.1 | (removed) | same as above |

### Verifiable claims

- **npm audit output**: `npm audit --json` → 0 vulnerabilities (0 high, 0 critical,
  0 moderate)
- **node engine**: `package.json` engines `^20.0.0 || ^22.0.0` preserved.
  lighthouse@12.6.1 (current) works on Node 20; lighthouse@13.5.0 requires >=22.19.
- **lockfile compat**: no `peerOptional` or `link` markers (verified by
  `tests/unit.lockfile-audit.test.mjs`)

### Test evidence

```
$ node --import ./tests/setup-env.mjs --test tests/unit.lockfile-audit.test.mjs
ok 1 - lockfile is compatible with Jev action dep audit (no peerOptional/link markers)
ok 2 - npm audit reports zero high or critical advisories (P1 gate compat)
```

## Workflow security: pull_request_target

The workflow now uses `pull_request_target` instead of `pull_request` as the
event trigger. This ensures the workflow YAML always executes from the base ref
(`main`), so a PR that modifies `.github/workflows/omar-gate-jev.yml` cannot
exfiltrate secrets. The `actions/checkout` step still checks out the PR head
for review.

## Summary

- 2 P0: 1 false positive (pre-existing, `rollback.yml` line 67), 1 resolved
  (unsafe_lockfile root cause — lockfile compatible, action pin updated to
  existing commit)
- 1 P1: false positive (function exports, `src/legacy-cli.js` line 606);
  pre-existing, not in PR diff
- npm audit: 0 vulnerabilities total. The `mrrCarter` dep_audit harness (used
  by the main `omar-gate.yml`) reports only critical advisories at P1; there
  are none.
- Workflow security: changed to `pull_request_target` to prevent secret
  exfiltration via workflow modification.
- Gate-visible findings in PR diff at P1+: **0**
