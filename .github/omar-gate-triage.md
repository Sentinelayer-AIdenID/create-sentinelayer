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
- Evidence: `git diff master...HEAD -- .github/workflows/rollback.yml` is empty.
  This file is unchanged by PR #861.

## P0 #2: npm dependency audit harness (unsafe_lockfile)

**Disposition: Resolved (cascaded from unsafe_lockfile root cause)**

- Root cause: `sentinelayer-v1-action@ebfcb813` rejected npm v3 `"peer": true` markers
  in `package-lock.json`, causing the audit harness to return indeterminate.
- Fix: bump action pin to `3af4d16` (removes `peer=True` rejection logic from
  `_load_npm_audit_input` in `dep_audit.py`).
- Evidence: lockfile audit test passes (no `peerOptional` or `link` markers),
  `npm audit --json` reports 0 high/critical advisories.

## P1: `src/legacy-cli.js:606` — Secret-shaped string in source

**Disposition: False positive (exports function names, not secrets)**

- Line 606: `export const __legacyCredentialFlowForTests = Object.freeze({...})`
- The finding triggers on the `__legacyCredential` prefix, but this is an export
  of function references at module scope — not a credential, key, or token.
- The exported object contains: `pollCliSession`, `generateArtifacts`,
  `issueBootstrapToken`, `requestJson` — all function names used in tests.
- Evidence: `git diff master...HEAD -- src/legacy-cli.js` is empty.
  This file is unchanged by PR #861.

## npm audit advisories (resolved via overrides)

The Jev action at `3af4d16` runs `npm audit` and classifies all reported
vulnerabilities as P1 (`HARNESS-NPM-AUDIT`). With `severity_gate: P1`, any
high or critical advisory blocks the gate. All such advisories have been
resolved through npm overrides that force patched versions without upgrading
lighthouse (which would require Node >=22.19 and drop Node 20 support).

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

- **npm audit output**: `npm audit --json` → 0 high, 0 critical, 1 moderate (ip-address)
- **Moderate advisories**: ip-address@10.7.3 (5 moderate advisories). Not gating at P1.
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

## Summary

- 2 P0: 1 false positive (pre-existing, `rollback.yml` line 67), 1 resolved (unsafe_lockfile root cause)
- 1 P1: false positive (function exports, `src/legacy-cli.js` line 606)
- 9 High npm advisories: **resolved** via npm overrides (basic-ftp, brace-expansion, @puppeteer/browsers)
- 5 Moderate npm advisories: below P1 gate threshold (ip-address transitive)
- Gate-visible findings at P1+: **0** (npm audit reports 0 high/critical)
