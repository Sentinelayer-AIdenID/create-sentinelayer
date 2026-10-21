# Omar deep coverage and budget limits

A requested AI review is complete only when every requested persona and every
partition finishes with call evidence. A failed partition, missing call evidence,
budget-stopped result, skipped persona, or failed orchestrator makes coverage
`incomplete`. The CLI preserves available findings, adds an orchestrator coverage
finding and exits nonzero. A minority of failed personas cannot be accepted as a
healthy full review.

JSON and review artifacts expose `coverage.status` and completed/requested persona
counts. Partition details include completed/requested counts. Explicit persona
filters and changed-file routing define the requested roster; they do not allow
silent failures within that roster. An explicit dry run is labeled `simulated`
and is not evidence of a completed live AI review. `--no-ai` remains an intentional
deterministic-only run and cannot satisfy a requirement for AI review.

## Monetary limit remains a stop threshold

`--max-cost` currently checks reported cost after completed work. It is **not a
hard spending ceiling**: nested partition calls and retries may already be in
flight, provider usage is not fully reconciled, and some models are unpriced.
Reducing concurrency, choosing a cheaper model, or killing the process does not
establish a hard dollar bound. The coverage repair does not change argument
parsing, provider/model selection, retries, token limits or TypeSafe's documented
evaluation-only zero-cap semantics.

The remaining dispatch repair must establish all of these before claiming a
hard dollar ceiling:

1. Share synchronous committed/reserved exposure across every outer persona and
   nested partition, reserving before provider I/O with no per-persona floor.
2. Require a supported complete request bound: applicable versioned rates,
   conservative input/framing accounting and an enforced ceiling for all billable
   output tokens. Refuse an unknown price or unsupported bound before sending.
3. Preserve authoritative provider usage and reconcile reservations without
   converting unknown cost to zero. Retain exposure for ambiguous accepted sends.
4. Account for every potentially billable retry, or avoid uncertain replay;
   verify server idempotency rather than assuming a header guarantees it.
5. Leave budget-denied work explicitly incomplete and blocking. A server-side
   per-run reservation/quote could supply this boundary, but its contract must
   first be established and tested.

Until that work is independently verified, a positive CLI cost threshold alone
is insufficient authorization to claim or rely on a bounded paid deep scan.
