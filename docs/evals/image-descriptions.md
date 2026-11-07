# Image descriptions in agent reads

Spec D companion to the sentinelayer-api image-description PR. The server owns
consent, generation, visibility, the cache and cost caps. This CLI change makes no
model call and performs no new network operation.

## Expected behavior change

| Synthetic input | Baseline | Candidate |
|---|---|---|
| Image pointer with server description | Metadata/fetch marker only | Full JSON-quoted description and OCR, labelled untrusted data |
| Screenshot text containing closing tags or instructions | No OCR summary | Escaped JSON data inside a quote; cannot supply the trust notice |
| OCR longer than 16,384 characters, within the server's 48k combined bound | Generic stream string cap truncates it | Complete OCR retained; secret redaction remains active |
| File metadata returned by list/get | Description discarded | Contract fields preserved next to the file |
| Image exists only in a thread reply | Local MCP activity drops attachment fields | Pointer, complete quoted description and fetch hint survive the reply projection |
| Caption/OCR contains credential-shaped strings | Stored streams filter secrets; direct raw outputs bypass the stream sink | The same bounded filter covers direct event/action reads, projections, file metadata, listen and wake outputs |
| No description, invalid marker, removed/hidden or oversized metadata | Legacy metadata | Legacy metadata; no quoted description is fabricated |
| Host wake beyond existing 16k prompt budget | Truncated summary | Bounded fetch hint; full data remains in MCP history/file reads |

## Deterministic proofs

`tests/unit.session-image-descriptions.test.mjs` verifies exact round-trip OCR,
complete quotes, injected delimiters, the server-owned notice, field validation,
stream limits/redaction, direct API poll/history/actions, MCP history/poll (raw
and summarized), reply-only images with actions enabled, actual file download
metadata, listener callbacks, and bounded host wakes. Existing attachment visibility, room-file, secret
redaction and wake suites cover unchanged behavior. No live screenshot or
personal data is used.

Executed locally: **206 passed, zero failed**, with one existing Windows-only
file-stream test skipped on Linux. Repository syntax check: **441 files passed**.
`scripts/check-image-description-mutants.mjs` ran 17 actual mutants; all 17
were killed by their named behavioral test: drop quoted summary, drop file
description, truncate stream OCR, trust caller marker, allow closing tags, cut a
wake quote in half, stop redacting OCR secrets, accept oversized OCR, bypass
poll/history/raw MCP/summarized MCP/listen/action/projection filtering, and drop
the reply image pointer or its quote. Source bytes were restored after every run.

The expanded test command covers the four attachment/image-description suites,
redaction, wake, listener, sync and MCP stdio suites, with Node's test concurrency
set to one. Mutants also run strictly sequentially. Full repository verification
and local deep Omar/audit attempts are reported separately; these focused proofs
do not claim those gates are green.

## Full verification and bound evaluation

The full local verification stages ran on Node 24.22.1 with one test worker.
Syntax (441 files), documentation validation, all 148 end-to-end tests and the
447-entry package dry run passed. The unit coverage command reported 4,033
passed, three failed and seven skipped. Two failures reproduce on unchanged
main in this environment: missing Playwright Chromium for the devtestbot fixture
and a Node TLS error in the NAT64 safe-reader fixture.

The third failure was caused by this change: the frozen severity evaluation
still bound the old `redact.js` bytes. Its source record now also binds the
extracted secret filter and image-description module, with an explicit assertion
that both dependencies remain covered. Historical provenance, all seven
synthetic scenarios and all expected outcomes are unchanged. The actual caller
evaluation, secret-redaction and image suites then passed **117 tests**. This
corrects the source binding and reruns its behavior; it does not replace the
frozen expected results with new ones. These counts overlap the earlier runs.

Both local `/omargate deep` and `/audit` were attempted and stopped before any
scan because CLI authentication was required. The full local verification is
therefore not claimed green. Fresh hosted quality, security and Omar checks are
required on the PR head before handoff. No live model call was made by these
evaluations.

The final redacted Gitleaks delta scan reported one public source checksum:
the `secret-filter.js` entry in the frozen source-binding map. Two reviewers
independently recomputed SHA-256 from that module and confirmed the exact match.
It is not a credential; no scanner rule, exclusion or ignore entry was changed.

## Controls

AI TOOLING GOVERNANCE: no additional model route, provider call, or authority.
AI INSTRUCTION TOPOLOGY: repository/MCP/eval instructions remain in force.
AI CHANGE PROVENANCE & ATTESTATION: AI-assisted implementation and deterministic proofs.
AI EVALS / CONTINUOUS EVALUATION: synthetic before/after cases above and deliberate mutants.
TOOL / MCP SECURITY: JSON-quoted data, typed metadata, unchanged auth and wake budget.
HITL OPERATIONS & CALIBRATION: Warden reviews; server rollout stays behind its feature/consent gates.
