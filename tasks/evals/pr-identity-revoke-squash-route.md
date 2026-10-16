# Eval Evidence: Identity Revoke Calls the Squash Route

Date: 2026-10-16

## Scope

`sl ai identity revoke` and the live path of `sl ai identity kill-all` revoke one AIdenID identity through
`revokeIdentity` in `src/ai/aidenid.js`. They posted to `/v1/identities/{id}/revoke`, a route the AIdenID API
does not have. The API's single-identity revoke is `POST /v1/identities/{identity_id}/squash`
(`apps/api/app/routes/identities.py` on AIdenID main), which records the identity as `SQUASHED` and schedules
cleanup. The cascade `POST /v1/identities/{identity_id}/revoke-children` is a separate route and is unchanged.
Successor of #798 (Verity's exact-head review: valid fix, current-main successor required).

Touched AI-impacting files:

- `src/ai/aidenid.js`

Also touched: `src/commands/ai/identity-lifecycle.js` (the dry-run curl preview), `tests/e2e.test.mjs`,
`tests/unit.ai-aidenid.test.mjs`.

## Baseline

`revokeIdentity` sent `POST <api>/v1/identities/<id>/revoke`. Against the real API that request has no route,
so a live revoke or a credentialed kill-all failed and the identity stayed active. The e2e AIdenID mock
answered the nonexistent `/revoke` route, so the suite passed while the command could not work.

## Candidate

- `revokeIdentity` sends `POST <api>/v1/identities/<id>/squash` with the same headers (API key, org, project,
  idempotency key) and no body, exactly as before; the error message names "squash (revoke)".
- The dry-run preview prints the `/squash` curl.
- The local lifecycle status after a live revoke is the server's response status, now `SQUASHED`, which is the
  identity store's terminal status (`TERMINAL_IDENTITY_STATUSES`), so kill-all no longer re-targets it.

Prompt text, model selection, provider routing, request headers, retries, tool permissions and response parsing
are unchanged. No model is called by these commands.

## Risk Assessment

- Prompt-output behavior risk: none. No prompts, parsers or model parameters changed.
- Provider-routing risk: none. The AIdenID base URL and headers are unchanged; only the path segment differs.
- Behavior risk: revoke now actually squashes the identity on the server. That is the command's documented
  intent; before, it failed. `--execute` is still required for any live call.

## Verification

- `tests/e2e.test.mjs`: the AIdenID mock now models the real server (squash answers `SQUASHED`; a `/revoke` call
  falls through to the mock's 404). New tests: the dry-run preview names `/squash` and calls nothing; kill-all
  with credentials squashes each non-held identity exactly once and never calls revoke-children. The existing
  execute-mode test now exercises the real route.
- `tests/unit.ai-aidenid.test.mjs`: the helper's URL is `/squash`.
- Control: with the source reverted to main and these tests kept, the unit helper test and all three revoke e2e
  tests fail (receipt kept by the author: respawn/tasks/cli-798-receipts-20261016/control-reverted-source.txt).
- With the change: unit.ai-aidenid 10/10, identity e2e 14/14.
