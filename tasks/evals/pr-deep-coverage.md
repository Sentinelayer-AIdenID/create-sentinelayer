# Complete requested coverage: synthetic before/after evaluation

Base: `628f96c191640b03b4f6a167f0a5dc5299a8f338` (actual origin/main).
Input and expected outcomes: `tests/evals/omargate-coverage-cases.json`.
Executable consumer: `tests/unit.omargate-coverage.test.mjs`.

This is deterministic contract evidence with injected runner/provider responses.
No model-quality comparison, paid provider run, billing receipt or hard-dollar
guarantee is claimed.

Before the change, a successful minority could hide failed personas or partitions,
and budget-skipped personas did not prevent healthy success. A returned blocking
budget was ignored. One verified partition could also hide another partition
without call evidence. The CLI's exception fallback could report a clean run
after the entire requested orchestrator failed.

After the change, each of these conditions yields incomplete/blocking coverage.
Invalid or empty requested rosters also refuse before dispatch. Structured-review
validity is separate from legacy normalization: token-bearing error prose,
error/refusal envelopes and malformed findings cannot count as a complete review.
Successful partial findings survive normal aggregation. Complete runs retain
zero-priced token-bearing evidence compatibility, and explicit dry runs remain
usable while labeled simulated. Requested filters and existing monetary-limit
parsing remain unchanged.

## Observed evidence

- The original ten controls cover six orchestrator failure/budget cases, two
  complete or simulated compatibility cases, and two real legacy CLI cases.
- Successor controls exercise invalid/empty rosters at both the orchestrator and
  actual CLI boundaries, and actual CLI provider responses for error prose,
  malformed envelopes/findings, valid empty findings, legacy arrays and fenced
  JSON. Explicit no-ai remains deterministic-only.
- The eight defect-specific controls fail against untouched base production
  source, using the same new tests and fixture. Every failure is the old clean
  `blocking=false` result where the requested contract requires `true`.
- Eighteen additional roster/response controls fail against held revision
  `81784e527cfc01e324fbfb7e7be15d4bbb3ec0a8`: rejected requests were accepted or
  malformed responses were marked clean. The successor focused selection passes
  178 tests. Existing TypeSafe input, responses, expected
  outcomes and test bytes remain unchanged; its source bindings are refreshed
  with explicit maintenance provenance for the changed CLI/orchestrator/help.
- Full repository verification and required live deep scan are separate gates;
  this fixture never substitutes for them. Draft review receipts record their
  actual status.

The threat is a full-review success claim with unexamined requested work. The
behavior change deliberately makes these partial reports fail closed. Rolling
back the source change restores that false-success risk. No permission, provider
route, model, retry, authentication or billing setting is changed.

Remaining hard-dollar admission work and its proof requirements are documented in
`docs/OMARGATE_COVERAGE.md`; it is explicitly outside this repair.
