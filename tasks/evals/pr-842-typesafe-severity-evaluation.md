# PR842 TypeSafe severity evaluation: deterministic contract evidence

> Current privacy correction over `22b8553073bb72cfccd71fb1c06217c3e6844ff4`: the historical receipts below remain historical. The adjacent JSON now binds the corrected worktree source/test overlay, adds the unchanged central detector dependency, and consumes a seventh `secret-like-content` comparison. The explicitly named `originalImplementationRevision`/`originalImplementationTree`/`originalImplementationAiReviewBlob` fields identify the original `3e12` introduction only. `privacyCorrectionBaseRevision` identifies the assigned `22b85530` base, and the current source/test hashes identify this uncommitted overlay without claiming an uncreated commit or a fresh old-Git/provider run.

## Impact and provenance

The published baseline is `6f21f9718d344157e75f83f1a3100fcc8a316112`.
The reviewed implementation is `3e12b628b6a64c69aee643d327c4df0f03a9dbac`,
tree `a7710cb9f81018fb483ae72a98fd574f2d99269b`. This follow-up changes evaluation
fixtures/tests/documentation only; the six application files remain byte-bound to
that implementation. This evidence does not claim a model-accuracy comparison.

The first hosted Quality Gates run `38846201117`, Eval Impact job
`116797177729`, correctly rejected the implementation at 2026-10-16T03:34:37Z:
`src/review/ai-review.js` changed without a changed file under an accepted eval
evidence prefix. The prior mocked tests existed outside those prefixes. Neither
`scripts/eval/eval-check.sh` nor the workflow/gate policy is modified here.
Adding a recognized evidence path is not itself a semantic or model-quality pass.

## Shared input and baseline meaning

The adjacent `pr-842-typesafe-severity-evaluation.json` contains the complete
synthetic input and six-case acceptance matrix, provider labels, source/dictionary
provenance, original-field invariants and canonical source/test SHA256 bindings.
The test loads that artifact and exercises actual `runAiReviewLayer` calls.
The base revision is a source/contract anchor: no independent baseline model or
provider run is claimed. Candidate off mode exercises the original generation-only
contract on the same input used by the opt-in comparisons.

Both generated findings use a fictional unbound release-artifact example at
`.github/workflows/release.yml:17`. Their source severities are P1 and P2, with
explicit evidence, rationale, root cause, user impact and fix text. They are
synthetic examples, not findings against a real merchant or repository.
Generator-assigned severity stays local for comparison and is omitted from the
TypeSafe request projection. The shared mocked generation response is fixed;
no provider, credential, environment contents or live repository corpus is used.

## Observed contract deltas

The following observations were emitted by the passing actual-caller tests.
Classification requests count only mocked TypeSafe requests. The generation call
is also mocked and occurs once in every case.

| Comparison | Classification requests | Evaluation status / reason | Candidate severities |
| --- | ---: | --- | --- |
| off-compatibility | 0 | absent / absent | null, null |
| on-schema-valid-disagreement | 1 | verified / response_validated | P3, P3 |
| positive-cap-skip | 0 | unverified / monetary_cap_unsupported | null, null |
| provider-outage | 1 | unverified / provider_error | null, null |
| malformed-response | 1 | unverified / malformed_response | null, null |
| insufficient-evidence | 1 | unverified / finding_unverified | null, null |

In **every** row, the original severities remain `[P1, P2]`, summary remains
`P0=0, P1=1, P2=1, P3=0, blocking=true`, original fields/fixes are preserved, primary
generation usage counts one request, and original cost history contains exactly
one generation row and zero classifier rows. The successful mock deliberately
answers P3 for both findings to detect an accidental gate-severity overwrite.
P3 here is controlled test input, not a gold label or measured model judgment.

The `verified` result means response-schema validation only. Outage, malformed
JSON and insufficient evidence stay explicitly unverified and retain original
blocking findings. Positive monetary caps skip before classification dispatch;
explicit zero is the intentionally uncapped evaluation path. Known reported
classifier usage remains separate; missing usage is unknown, never a free call.

## Verification and acceptance

The expanded deterministic selection passed **137/137**, with **56** tests from
`tests/unit.typesafe-severity.test.mjs`. It includes the six actual-caller cases and
a fixture completeness/source-binding test; the existing parser, CLI, deadline,
resource-accounting and original caller/report/budget regressions remain covered.
Observed mock records are emitted as `mock_contract_observation` diagnostics in
the TAP log so a rerun can retain actual values rather than rely on this prose.

Focused command:

```sh
node --import ./tests/setup-env.mjs --test tests/unit.typesafe-severity.test.mjs
```

Expanded selection:

```sh
node --import ./tests/setup-env.mjs --test tests/unit.typesafe-severity.test.mjs tests/unit.review-ai.test.mjs tests/unit.omargate-orchestrator.test.mjs tests/unit.ai-client.test.mjs tests/unit.review-report.test.mjs tests/unit.commands-contracts.test.mjs tests/unit.legacy-args-persona-flags.test.mjs tests/unit.cost-history.test.mjs tests/unit.telemetry.test.mjs
```

Acceptance requires all six comparisons and original-generation invariants to
pass. The JSON binds the exact reviewed application and test source as canonical
UTF-8/LF; only checkout CRLF conversion is normalized for comparison. A source
change requires deliberate refreshed evidence. A green eval-impact path-presence
check remains separate from these semantic assertions and hosted test execution.

## Limits and rollback

This evidence establishes deterministic integration/error handling, not that Jev
is correct or better than another model. The pinned model is `jev-1.13.0`, dictionary
`omar-severity-evaluation/1`: coarse P0 Critical / P1 High / P2 Medium / P3 Low plus
insufficient evidence, and a separate engineering category choice including CI/CD.
No calibrated detailed severity policy, live provider/billing readiness, default
activation or security-authority adoption follows from these tests. Actual finding
text still requires privacy review before live use. Request/runtime accounting is
sequential, not an atomic budget across parallel generation or processes; timers
are cooperative and monotonic late-response checks reject late success.

Keep `--severity-classifier off` (the default) to retain generation-only behavior.
This evidence correction changes no runtime setting, financial limit or workflow
policy. Reverting only this follow-up removes the evidence/tests, not the reviewed
implementation; it would legitimately make the original eval-impact gate fail
again for that implementation range.


## Hosted unit boundary inventories: follow-up over c2375ed

The later hosted unit job `116800367671` in Quality run `38847153736` exercised
head `c2375ed77f2ff050bff05101590e6fd719a969a5` and reported 2479 tests:
2468 passed, five failed, six skipped. All five failures were explicit inventories:
two credential-census assertions for the new sender, two MCP input-catalog/withheld
assertions for the new optional flag, and one generic concat-call path census for
`Buffer.concat(chunks)`. They were not evidence-hash, provider or time failures.

The narrow repair records the existing TypeSafe-specific Bearer site in the
reviewed credential census and bounded response-byte aggregation in the non-URL
path census. Generic detection rules, stale-entry checks and planted negative
controls are retained. A behavior control proves only `TYPESAFE_API_KEY` can reach
the fixed HTTPS System One endpoint with redirects refused: SentinelLayer tokens
alone cannot dispatch, alternate endpoint environment values cannot redirect the
request, and no SentinelLayer token enters the mocked outbound request.

`severityClassifier` is now explicitly documented in the existing MCP DENIED
inventory. The bridge already withheld this unlisted option; its allowed-input
set and runtime handler are unchanged. A focused control, even with a trusted test
approval callback, refuses the field, its CLI-style alias and a dash-leading flag
smuggled into another option before any CLI subprocess; a normal deep command
still reaches the execution stub without the classifier flag. This keeps the
external evaluation an operator CLI opt-in, not an MCP exposure.

The complete affected inventory selection plus the previous 137 regressions
passes **189/189**, with no skips. Normal syntax passes **405** files. The original
six TypeSafe implementation files and the self-bound JSON/main evaluation test
remain unchanged; their 3e12 implementation/source anchor is still accurate.
This follow-up is integration/inventory coverage, not a fresh model-quality,
provider-authenticity or full hosted-unit-suite pass. Root owns the canonical
commit and subsequent full hosted run.

## Current secret-like input refusal correction

The complete constructed TypeSafe request is checked using the existing recursive
`containsSecret` export from `src/session/redact.js`. Any detected text, including
`file` paths and strings in a later finding, rejects the whole batch before request
reservation/fetch with `unverified / secret_like_content`. Original evidence is
unchanged; no partial sanitized judgment or clean severity is substituted.

The consumed seventh actual-caller comparison assembles a synthetic access-key
shape at runtime in the second finding's evidence. Expected observations: one
mocked generation request, zero classification requests, null candidate severity,
unknown classification usage and the same original P1/P2 blocking summary/history.
Additional focused controls cover every transmitted finding string with synthetic
access-key/JWT shapes, other existing detector families, no partial batch, and
excluded-field/plain-text controls. No real credential or provider is used.

Current correction proof: 81/81 focused tests pass, with zero skips/errors;
replacing only the runtime with exact `22b85530` fails all 16 selected refusal
controls at their assertions. Syntax checking passes 405 files. Raw commands,
TAP/JUnit, guard observations and exact source hashes are in the independent
review packet. The earlier 137/189 counts above remain historical receipts.
Default off, explicit-zero cap boundary, endpoint, deadline, byte limits, retry
policy and original generation/gate accounting are unchanged. Reverting only this
correction restores the prior input-disclosure gap; this paragraph is not a new
activation or provider/privacy approval.
