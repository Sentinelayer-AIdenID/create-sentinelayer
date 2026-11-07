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

The initial redacted Gitleaks delta scan reported one public source checksum:
the `secret-filter.js` entry in the frozen source-binding map. Two reviewers
independently recomputed SHA-256 from that module and confirmed the exact match.
It is not a credential; no scanner rule, exclusion or ignore entry was changed.

## Boundary review follow-up

The PR review found that replacing a short secret-shaped value with
`[REDACTED]` could grow a valid 48,000-codepoint description beyond the input
bound. A later sanitizer or quote then discarded the whole description.
Image fields now request nonexpanding replacements: matches shorter than the
normal marker use `[X]`, while longer matches keep `[REDACTED]`. The detector,
default string-redactor behavior and API input limits are unchanged. No
nonsensitive caption or OCR is truncated to make room for a marker.

Six boundary regressions failed before the correction and passed afterward.
They cover caption/OCR at exactly 48,000 combined Unicode code points, the
shortest recognized secret shape, a 120-character model field, a non-BMP suffix,
repeated sanitization, quoting, file/stream metadata and real poll-to-MCP raw and
summarized paths. The combined frozen-evaluation/redaction/image run passed
**123 tests, zero skipped**. All **18 actual mutants** were killed, including
restoring the expanding marker; the affected source was restored exactly.
These counts overlap the earlier runs. The canonical source bindings were
refreshed while preserving all frozen scenario inputs, expected outcomes and
historical records. Fresh hosted checks and review remain required for this
follow-up head.

The follow-up delta scan reported four occurrences of the previous/current
public `secret-filter.js` checksum: the replaced binding and the two historical
maintenance fields. Each occurrence was checked against the actual source
SHA-256; an independent reviewer also verified all canonical bindings and the
unchanged frozen scenarios. No credential or scanner exclusion was added.

## Attachment visibility follow-up

The API contract was checked against sentinelayer-api PR1207 at
`81c0896acafb3fabbea40884a9bb21d50337b0bd`. Its canonical
`_session_attachment_payload` emits `status` from the upload state. Human posts,
agent posts and replies resolve their pointers through that payload; event and
action hydration preserve it, and file get plus native MCP retain the same
field. Only `status: "uploaded"` is eligible. `summaryStatus: "ready"` is a
separate processing result and grants no access. The API currently filters
blocked sources from reads or returns not-found; it does not emit a blocked
attachment state.

The CLI now requires that positive uploaded state before exposing a description.
Missing, malformed, unknown, staged, failed, quarantined, released, purged and
blocked states fail closed. `removed`, `hidden`, `deleted` and `blocked` flags
must be absent or literal false; string booleans, nulls and other malformed
values are refused. Rejected description, trust and notice fields are also
removed from the raw stream before generic JSON serialization. Existing
attachment metadata and file operations retain their behavior.

Five new visibility tests failed on the prior implementation; the no-description
compatibility test already passed. After the correction, all six passed, then
all **50 image-description tests** passed. They cover direct poll/history/action
reads, every reply projection, raw and summarized MCP, actual on-disk stream
bytes, actual file metadata, poll/SSE listeners, wakes and valid uploaded
controls. The six explicit legacy fixtures are text-only events, empty file
lists, an uploaded image event, reply actions with a projection, file-get
metadata and a room-file list. Their entire no-description payload shape and
input values remain unchanged; this is the named repository fixture set, not a
claim about an undisclosed external review fixture. The image model fixture now
uses a synthetic name.

After merging main `7c94b4e301cf9d5d5a5478fdae4887173638fa6f`, the affected
regression passed **358 tests with zero failures** and one existing Windows-only
file-stream skip on Linux (`d-cli-visibility-regression.xml`). It includes the
unchanged frozen actual-caller evaluations, redaction, attachment/file outputs,
sync, MCP, listeners/wakes and the updated main metadata/cache/list behavior.
Syntax validation passed **442 files**, and documentation validation passed.
The six 48,000-codepoint boundary cases and their nonexpanding-redaction
mutation remain in the current proof.

All **25 actual mutants** were killed in `d-cli-mutants-visibility`: the prior
18 were rerun together with seven new cases for a non-uploaded state, each of
the four visibility/removal flags, malformed flags, and the raw-stream fallback.
In particular, removing `deleted` from the guard and retaining rejected OCR on
disk each failed its named behavioral test. The runner validates mutation
syntax first and requires failures from named image-description tests, so an
import or collection failure cannot count as a kill. TAP and JUnit evidence are
retained, and all eight affected source files were restored byte-for-byte.

The two changed implementation bindings were refreshed with an explicit
visibility-maintenance record. All ten canonical source/test bindings verify;
the seven frozen scenarios, inputs, mock responses, expected outcomes and every
historical maintenance record are unchanged. The complete actual-caller
evaluation ran in the passing regression. These scoped counts overlap earlier
proofs and do not change the disclosed full-verification limitations above.

## Controls

AI TOOLING GOVERNANCE: no additional model route, provider call, or authority.
AI INSTRUCTION TOPOLOGY: repository/MCP/eval instructions remain in force.
AI CHANGE PROVENANCE & ATTESTATION: AI-assisted implementation and deterministic proofs.
AI EVALS / CONTINUOUS EVALUATION: synthetic before/after cases above and deliberate mutants.
TOOL / MCP SECURITY: JSON-quoted data, typed metadata, unchanged auth and wake budget.
HITL OPERATIONS & CALIBRATION: maintainer review; server rollout stays behind its feature/consent gates.
