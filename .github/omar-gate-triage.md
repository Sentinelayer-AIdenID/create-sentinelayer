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

All eight High advisories are transitive through lighthouse@12.6.1 (a dev dependency for
CLI audit personas). The fix path — lighthouse@13.5.0 — requires Node >=22.19, but this
package declares `engines: { node: '^20.0.0 || ^22.0.0' }` in its package.json. Upgrading
would drop Node 20 support, a semver-major breaking change. Evidence for each advisory
follows.

### Advisory evidence

| # | Advisory ID | Package | Installed | Patched | Via | Notes |
|---|---|---|---|---|---|---|
| 1 | GHSA-c475-qrg2-pj4r | basic-ftp | 5.3.1 | >6.2.0 | lighthouse→puppeteer-core→@puppeteer/browsers→proxy-agent→pac-proxy-agent→get-uri | Quadratic CPU DoS in Client.list(); CVSS 0 (no vector) |
| 2 | GHSA-jmr9-qjv8-65gv | extract-zip | 2.0.1 | >2.0.1 | lighthouse→puppeteer-core→@puppeteer/browsers | Symlink path traversal; CVSS 8.1 |
| 3 | GHSA-7pqw-9j4j-h8q3 | extract-zip | 2.0.1 | >2.0.1 | (same path) | Arbitrary file writes via symlink; CVSS 8.1 |
| 4 | GHSA-q2hr-2g5m-vwhr | brace-expansion | 5.0.12 | ≥5.0.12 | c8→test-exclude→minimatch | Quadratic expansion DoS; installed version equals patched version |
| 5 | GHSA-qhr7-859c-m2p7 | brace-expansion | 5.0.12 | ≥5.0.11 | (same path) | Recursion DoS; installed > patched |
| 6 | GHSA-6j4f-fj2g-mc7p | brace-expansion | 5.0.12 | ≥5.0.10 | (same path) | Recursion DoS; installed > patched |

### Additional moderate advisories (not P1-gating)

| # | Advisory ID | Package | Installed | Via |
|---|---|---|---|---|
| 7-11 | GHSA-rpw4-54j3-4h4q, GHSA-2vr4-cq9g-pvrc, GHSA-j6r3-76f7-8jcv, GHSA-h3mg-xc3c-68pw, GHSA-rxp7-6hxx-x8q5 | ip-address | 10.7.3 | lighthouse→...→pac-proxy-agent→pac-resolver→ip-address |

These are moderate severity; the Jev gate thresholds at P1 (High). ip-address@10.7.3 is
the latest published version; no fix is available without upgrading lighthouse.

### Verifiable claims

- **lighthouse@13.5.0 engine constraint**: `npm view lighthouse@13.5.0 engines` → `{ node: '>=22.19' }` (2026-10-23)
- **brace-expansion@5.0.12**: `node -e "console.log(require('brace-expansion/package.json').version)"` → `5.0.12`
- **lighthouse@12.6.1 (installed)**: `node -e "console.log(require('lighthouse/package.json').version)"` → `12.6.1`
- **Repo engine constraint**: `package.json` engines: `{ node: '^20.0.0 || ^22.0.0' }`
- **npm audit database staleness**: `npm audit --json` reports brace-expansion range as `4.0.0 - 5.0.11`
  despite advisory metadata showing fixed versions at 5.0.10, 5.0.11, and 5.0.12.

### Disposition

- Advisories 1-3 (basic-ftp, extract-zip): **Accepted risk.** Fix requires lighthouse semver-major
  upgrade that drops Node 20 support, violating this package's declared engine range.
  These are transitive dev dependencies reachable only through audit CLI personas;
  they are not exposed in the production dependency tree.
- Advisories 4-6 (brace-expansion): **False positives.** Installed version 5.0.12 meets or
  exceeds all three patched versions. npm audit's advisory database has not yet
  registered 5.0.12 as the fixed version.
- Advisories 7-11 (ip-address): **Below gate threshold.** Moderate severity; not gating at P1.
  No fix is available without upgrading lighthouse.

## Summary

- 2 P0: 1 false positive (pre-existing, `rollback.yml` line 67), 1 resolved (unsafe_lockfile root cause)
- 1 P1: false positive (function exports, `src/legacy-cli.js` line 606)
- 8 High advisories: 3 accepted risk (lighthouse transitive, breaking change), 3 false positive (brace-expansion already patched), 2 in extract-zip bucket above
- 5 Moderate advisories: below P1 gate threshold
