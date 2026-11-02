# Session edit rendering regression evidence

An edit notification carries its own delivery sequence and a revised message or
reply snapshot. CLI read, listen and history must display the target sequence
and revised text. MCP read_history and poll_inbox add the same `editSummary` while
preserving the payload. Text precedence is `payload.message` (including an empty
string), `payload.reply.note`, then `payload.event.payload.message`.

Baseline source: `58a23ff143925387594a2a38678c0a38badbcaa2`.
The supplied snapshot is tagged `base` at
`29636c3c28b2574d302aaff5213910abf629c4af`. The new test file was copied into a
detached worktree at that tag, leaving all baseline source files unchanged.

```sh
node --import ./tests/setup-env.mjs --test --test-concurrency=2 tests/unit.session-edit-rendering.test.mjs
```

Baseline: **12 tests, 0 pass, 12 fail**. All failures are behavioral assertions,
not import failures. Candidate: all 12 pass in the focused run below.

| Regression | Baseline | Candidate |
| --- | --- | --- |
| CLI read text | FAIL | PASS |
| CLI read JSON | FAIL | PASS |
| CLI history text | FAIL | PASS |
| CLI history JSON | FAIL | PASS |
| CLI listen text | FAIL | PASS |
| CLI listen NDJSON | FAIL | PASS |
| MCP read_history summary | FAIL | PASS |
| MCP read_history raw | FAIL | PASS |
| MCP poll_inbox summary | FAIL | PASS |
| MCP poll_inbox raw | FAIL | PASS |
| Message edit mentions and one wake per notification | FAIL | PASS |
| Reply edit mentions and one wake per notification | FAIL | PASS |

```sh
node --import ./tests/setup-env.mjs --test --test-concurrency=2 tests/unit.session-edit-rendering.test.mjs tests/unit.session-message-edits.test.mjs tests/unit.session-mentions.test.mjs tests/unit.session-wake-resolve-target.test.mjs tests/unit.session-attachment-visibility.test.mjs
```

Focused candidate result: **65 tests, 65 pass, 0 fail**. Fixtures exercise both
edit kinds, explicit text precedence, empty edits, nested sequence fallback,
unchanged raw payloads, duplicate listener delivery, and newly mentioned agents
when parent recipients already exist. Existing tests retain coverage for
snapshot validation, stale revisions, self-wake suppression, broadcast routing
and attachment summaries. All API fixtures use loopback; no live model is needed.

The intended wake behavior change is that an edit adding `@reviewer` reaches that
agent, including when the parent addressed another agent. The notification's
sequence remains the delivery/deduplication key. Rollback is a revert of this
change; stored notification payloads require no migration.
