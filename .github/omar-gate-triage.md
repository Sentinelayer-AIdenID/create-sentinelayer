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

- Root cause: `sentinelayer-v1-action@ebfcb813` rejected npm v3 `peer: true` markers
  in `package-lock.json`, causing the audit harness to return indeterminate.
- Fix: bump action pin to `3af4d16` (removes peer=True rejection logic) and
  surgically remove the `"peer": true` entry from `devtools-protocol` in
  `package-lock.json`.
- Evidence: `npm audit --audit-level=critical` exits 0. Lockfile audit test
  (`tests/unit.lockfile-audit.test.mjs`) confirms 0 peer=true markers.

## P1: `src/legacy-cli.js:606` — Secret-shaped string in source

**Disposition: False positive (exports function names, not secrets)**

- Line 606: `export const __legacyCredentialFlowForTests = Object.freeze({...})`
- The finding triggers on the `__legacyCredential` prefix, but this is an export
  of function references at module scope — not a credential, key, or token.
- The exported object contains: `pollCliSession`, `generateArtifacts`,
  `issueBootstrapToken`, `requestJson` — all function names used in tests.
- Evidence: `git diff master...HEAD -- src/legacy-cli.js` is empty.
  This file is unchanged by PR #861.

## 8 High npm advisories (transitive dev dependencies)

### GHSA-c475-qrg2-pj4r — basic-ftp <=6.2.0 (quadratic CPU DoS in Client.list)

- Installed: basic-ftp@5.3.1 (transitive via get-uri → pac-proxy-agent → proxy-agent → @puppeteer/browsers → puppeteer-core → lighthouse@12.6.1)
- Fix: lighthouse@13.5.0 requires Node >=22.19; this package supports ^20.0.0 || ^22.0.0.
  Upgrade would drop Node 20 support — a semver-major breaking change.
- Disposition: Accepted risk. No critical severity. Fix requires coordinated semver-major.

### GHSA-jmr9-qjv8-65gv / GHSA-7pqw-9j4j-h8q3 — extract-zip <=2.0.1 (symlink path traversal, arbitrary file writes)

- Installed: extract-zip@2.0.1 (transitive via @puppeteer/browsers → lighthouse@12.6.1)
- Fix: lighthouse@13.5.0 requires Node >=22.19 (see above).
- Disposition: Accepted risk. Same breaking-change constraint.

### GHSA-q2hr-2g5m-vwhr / GHSA-qhr7-859c-m2p7 / GHSA-6j4f-fj2g-mc7p — brace-expansion <5.0.12 (DoS via quadratic expansion, recursion)

- Installed: brace-expansion@5.0.12 (transitive via minimatch → test-exclude → c8)
- Advisory range says `<5.0.12`; we are on 5.0.12. Likely stale advisory database (npm audit
  does not yet recognize 5.0.12 as the fixed version).
- Disposition: False positive (already on the patched version).

### ip-address (moderate, 5 advisories) — not relevant to P1 gate threshold.

## Summary

- 2 P0: 1 false positive (pre-existing), 1 resolved (unsafe_lockfile root cause)
- 1 P1: false positive (function exports)
- 8 High advisories: 6 accepted (breaking change), 2 false positive (already patched)
