---
name: omar-gate-setup
description: Connect Omar Gate (the SentinelLayer pull-request security check) to a GitHub repository with the fewest steps - generate the workflow with `sl scan init`, put the SentinelLayer token into the repo's secrets with `sl scan setup-secrets` (never through chat), and verify the first run. Use when asked to add, connect, install or repair Omar Gate on a repo, or when an Omar Gate check is missing, skipped, or fails before it scans.
metadata:
  version: "1.0.0"
---

# Omar Gate setup

Goal: every pull request on the repo runs an "Omar Gate" check that blocks merging on P0 and P1 findings. Five steps, all from the repo's root.

## 0. Check the tools (do not assume)

```bash
sl --version                                          # sentinelayer-cli 0.47.0 or newer
sl auth status                                        # not signed in? the person runs: sl auth login
gh auth status                                        # GitHub CLI signed in
gh repo view --json nameWithOwner,viewerPermission    # setting secrets needs ADMIN
```

If `viewerPermission` is not `ADMIN`, you can still do steps 1, 2 and 4; ask a repo admin to run step 3 from their own machine.

## 1. Give the gate a spec

`sl scan init` reads `SPEC.md` or `docs/spec.md` to choose the scan profile.

```bash
ls SPEC.md docs/spec.md 2>/dev/null || sl spec generate --path .
```

`sl spec generate` writes `SPEC.md` from the codebase. Read it before you commit it. A spec somewhere else works too: add `--spec-file <path>` to the next two commands.

## 2. Generate the workflow

```bash
sl scan init --path . --non-interactive
sl scan validate --path .
```

This writes `.github/workflows/omar-gate.yml` (or refreshes an existing `security-review.yml`). `validate` exits 0 when the workflow matches the spec's profile. Do not hand-edit the pinned action references.

## 3. Put the SentinelLayer token in the repo's secrets

```bash
sl scan setup-secrets --path .
# or, outside the clone:
sl scan setup-secrets --repo owner/repo
```

The command takes the token from the person's `sl` login, hands it to `gh secret set SENTINELAYER_TOKEN` on stdin, then confirms the name appears in `gh secret list`. The token is never printed. `--dry-run` shows the steps without setting anything.

With the SentinelLayer token in place, Omar Gate runs on SentinelLayer's managed model, so nobody has to copy their own model key into the repo. If the person prefers their own model key, they set it themselves with `gh secret set <SECRET_NAME> --repo owner/repo` and paste the key at gh's prompt; the workflow file lists the secret names it reads.

Rules for this step:

- Never ask the person to paste a token or key into chat, a PR, an issue, a commit or a file.
- If they already have a token from the spec sheet page on sentinelayer.com, ask them to run `gh secret set SENTINELAYER_TOKEN --repo owner/repo` themselves and paste it at gh's prompt.
- The token in the repo acts for the person who set it. Anyone who can change workflows on the repo can use it, so set it only on repos that person controls.

## 4. Commit and open a pull request

```bash
git checkout -b ci/omar-gate
git add .github/workflows/omar-gate.yml SPEC.md
git commit -m "Add Omar Gate pull-request check"
git push -u origin ci/omar-gate
gh pr create --title "Add Omar Gate" --body "Adds the Omar Gate security check to pull requests."
```

Leave `SPEC.md` out of `git add` if it already existed and did not change. The pull request itself triggers the first run.

## 5. Verify the first run

```bash
gh pr checks --watch
gh run list --workflow omar-gate.yml --limit 1
gh run view <run-id> --log
```

It worked when the "Omar Gate" check ran its scan and the run summary shows a gate status with P0/P1/P2/P3 counts.

It did NOT work if the log says `SENTINELAYER_TOKEN not set` and the job finished in seconds: the gate skipped. Go back to step 3.

After merge, start a run by hand with `gh workflow run omar-gate.yml --ref main`. Making "Omar Gate" a required check in branch protection is the repo owner's decision; tell them it is ready.

## Common errors

| What you see | Why | Fix |
|---|---|---|
| `No SentinelLayer token found` from `setup-secrets` | Not signed in to `sl` | The person runs `sl auth login`; run step 3 again |
| `Could not detect repo slug` | Not in a GitHub clone, or gh is not signed in | Add `--repo owner/repo` |
| `GitHub CLI (gh) is not installed` | gh missing | Install gh, then `gh auth login` |
| `gh secret set` fails with 403 or 404 | No admin rights on the repo | A repo admin runs step 3 |
| `No spec file found` | No `SPEC.md` or `docs/spec.md` | `sl spec generate --path .`, or pass `--spec-file` |
| `sl scan validate` exits 2 | The workflow drifted from the spec's profile | Run `sl scan init --path . --non-interactive` again and commit |
| Check passes in seconds with a "not set" warning | Secret missing or misnamed, or the PR comes from a fork (forks get no secrets) | Run step 3 again; open the PR from a branch in the repo |
| Action "is not allowed to be used" | The organization restricts Actions | An org admin allows the SentinelLayer action in the Actions settings |
| Token rejected (401) at the scan step | The token was revoked or rotated | `sl auth login`, then step 3 again |
| Gate blocked on P0/P1 | Real findings | Read the run summary and fix them; never lower `severity_gate` to get a pass |

## Before you push (optional)

`sl /omargate deep --path .` runs the same analysis locally, so the first pull request is not the first time the findings appear.
