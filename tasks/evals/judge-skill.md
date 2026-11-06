# Judge loop skill, verdict command and Omar Gate setup skill: evaluation

AI change class: B (new skill instructions that steer a judging model, and a setup guide an
agent follows). Auth change class: D (only the offline `sl judge check` is exempt from login;
`sl judge verdict` sends and stays gated; both judge commands are blocked from the MCP CLI
bridge because the native `judge_verdict` tool covers MCP and the commands read caller-chosen
files).

Baseline: no judge skill, no structured way to send a review verdict back to a coding agent,
and no setup skill for Omar Gate. Agents improvise reviews in free text, so the coder cannot
tell blocking comments from notes and nothing machine-readable reaches training data. Omar
Gate setup is learned from scattered help text; `sl scan init --spec-file` failed with a type
error since the checked-artifact refactor.

Candidate:

- `skills/senti-judge/SKILL.md`: what to check (correctness, tests that can fail, security,
  request ids, error handling, a preview of the work), severity P0-P3, comment shape
  (file:line, evidence, one-line fix), the verdict document, how to send it, re-judging, and
  stopping (ACCEPT, last round escalates to the human, early escalation triggers).
- `src/judge/verdict.js`: one validator for judge-verdict v1, a renderer for the room message,
  and the fenced-block extractor.
- `judge_verdict` MCP tool and `sl judge check|verdict`: one implementation. Auto transport
  uses the room's judge-verdicts API route when the server has it and falls back to a room
  message only when the route is absent (a 404 without a room or target code); every other
  refusal is reported, never retried as a message.
- `skills/omar-gate-setup/SKILL.md`: `sl scan init`, `sl scan setup-secrets` (token over stdin
  to gh, never through chat), first-run verification and an error table.

Deterministic input set and acceptance criteria (tests/unit.judge-verdict.test.mjs):

- The shared agreement file tests/fixtures/judge-verdict-cases.json (84 cases, 18 valid) is
  byte-identical to the server's copy; every case's validity matches. Identity-shaped fields
  (judge, judgeAgentId, agentId, reviewer, author) are refused.
- Normalization: ASCII-edge trimming, defaults, lowercased sha; control characters judged on
  the raw value; lengths in code points.
- Rendering wakes the coder (`@coder`, `payload.to`), numbers comments, mentions escalation
  handles only when escalating, and round-trips the block through the extractor. The
  extractor takes exactly one block and ignores mid-line fences, other languages, invalid
  JSON, other kinds, and messages with two blocks.
- Tool: invalid and self-judging verdicts send nothing; dry run sends nothing; room posts are
  idempotent per (room, judge, target, round); long verdicts are posted whole; auto prefers the
  API and falls back only on route-absent 404s; `via=api` never falls back.
- API transport posts only the document to `/api/v1/sessions/{id}/judge-verdicts`.
- CLI: `judge check` works without login and exits 1 on invalid input; `judge verdict`
  requires login; help lists both.
- `sl scan init --spec-file` reads the named spec (regression from the checked-artifact
  refactor).
- Skills: install, list, pack and the public-content check cover both new skills.

Not exercised: a live judging model following the skill, live room delivery, or the server
route (it ships separately behind a flag that is off by default). Human review should assess
instruction quality. Rollback: revert the change; installed copies of the two skill
directories can be removed by hand.
