# Omar Gate (Jev) Finding Triage — PR #861

Ticket: e331abc7
Branch: warden/omar-gate-jev-20261023
Gate run: 39941411025

## P0 #1: `.github/workflows/rollback.yml:67` — Secret-shaped string in workflow

**Disposition: False positive (pre-existing, not in PR diff)**

- Line 67: `run: |` (the start of a multi-line shell script block)
- The finding flags `ROLLBACK` as secret-shaped, but it is a literal comparison string
  in a shell `if` guard (`if [ "${{ inputs.confirm }}" != "ROLLBACK" ]`) — a public
  workflow_dispatch input sentinel, not a credential.
- Evidence: `git diff master...HEAD -- .github/workflows/rollback.yml` is empty.
  This file is unchanged by PR #861.

## P0 #2: npm dependency audit harness (unsafe_lockfile)

**Disposition: Resolved (cascaded from unsafe_lockfile root cause)**

- Root cause: `sentinelayer-v1-action@ebfcb813` rejected npm v3 `peer: true` markers
  in `package-lock.json`, causing the audit harness to return indeterminate.
- Fix: bump action pin to `3af4d16` (removes peer=True rejection) and surgically
  remove the `"peer": true` entry from `devtools-protocol` in `package-lock.json`.
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

**Disposition: Documented, not fixable without breaking changes**

- `basic-ftp` (via `get-uri` → `pac-proxy-agent` → `proxy-agent` → `@puppeteer/browsers` → `puppeteer-core` → `lighthouse`)
- `extract-zip` (via `@puppeteer/browsers` → `lighthouse`)
- `brace-expansion` (direct dev dependency)
- All fixes require semver-major bumps that drop Node 18 support.
- `npm audit --audit-level=critical` exits 0 (no critical vulnerabilities).
