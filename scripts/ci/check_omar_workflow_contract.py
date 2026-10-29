from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


class OmarWorkflowContractError(ValueError):
    pass


# Reviewed PR135 security-fix release. Advance the workflow, artifact and contract together.
ACTION_SHA = "2d5a8edd485595148254926c9fb318e0adae416a"
ACTION_REF = f"mrrCarter/sentinelayer-v1-action@{ACTION_SHA}"
OPENAI_MODEL = "gpt-6.1-sol"
EXPECTED_ACTION_INPUTS = {
    "openai_api_key": "${{ secrets.OPENAI_API_KEY }}",
    "llm_provider": "openai",
    "sentinelayer_managed_llm": '"false"',
    "review_routing": "legacy",
    "scan_mode": "${{ github.event_name == 'workflow_dispatch' && inputs.scan_mode || 'deep' }}",
    "model": OPENAI_MODEL,
    "codex_model": OPENAI_MODEL,
    "model_fallback": OPENAI_MODEL,
    "use_codex": '"false"',
    "codex_only": '"false"',
    "llm_failure_policy": "block",
}
# One retry, and only this shape: after a billing or quota 429 on every LLM attempt of the first attempt, the same
# Action, model and inputs run once more on the backup endpoint. The dispatch drill and the org's Azure route
# (vars.OMAR_ROUTE is azure) skip the first attempt and run only that one. Only the key and the endpoint differ, and
# both are secrets.
QUOTA_RETRY_KEY = "${{ secrets.AZURE_SOL61_API_KEY }}"
QUOTA_RETRY_SECRET_LINES = (
    "          AZURE_SOL61_API_KEY: ${{ secrets.AZURE_SOL61_API_KEY }}",
    "          AZURE_SOL61_BASE_URL: ${{ secrets.AZURE_SOL61_BASE_URL }}",
)
QUOTA_RETRY_ENDPOINT_LINE = "          OPENAI_BASE_URL: ${{ secrets.AZURE_SOL61_BASE_URL }}"
FIRST_ATTEMPT_IF_LINE = (
    "        if: steps.trust_boundary.outputs.trusted_context == 'true'"
    " && !(github.event_name == 'workflow_dispatch' && inputs.quota_retry_drill)"
    " && vars.OMAR_ROUTE != 'azure'"
)
QUOTA_RETRY_IF_LINE = (
    "        if: steps.trust_boundary.outputs.trusted_context == 'true'"
    " && steps.classify.outputs.retry == 'true'"
)
QUOTA_RETRY_STEP_ORDER = (
    "Run Omar Gate",
    "Classify Omar provider failure",
    "Validate the quota retry route",
    "Run Omar Gate (quota retry)",
    "Select Omar Gate result",
)
# The classifier reads the route from GitHub's own comparison, the same case-insensitive one the first attempt's if:
# makes, and takes it only on that exact value.
CLASSIFY_ROUTE_LINE = "          ROUTE: ${{ vars.OMAR_ROUTE == 'azure' && 'azure' || '' }}"
CLASSIFY_ROUTE_TEST_LINE = '          if [ "${ROUTE}" = "azure" ]; then'
CLASSIFY_REQUIRED_LINES = (
    "        id: classify",
    CLASSIFY_ROUTE_LINE,
    CLASSIFY_ROUTE_TEST_LINE,
    "            reason=azure_route",
    "          DRILL: ${{ github.event_name == 'workflow_dispatch' && inputs.quota_retry_drill && 'true' || 'false' }}",
    '          elif [ "${FIRST_OUTCOME}" = "failure" ] && [ "${FIRST_FAILURE_CLASS}" = "provider_failure" ]; then',
    '              && python3 .github/scripts/omar_quota_failure.py "${findings}"; then',
    "              reason=billing_quota_429",
)
_RESULT_OUTPUTS = ("run_id", "gate_status", "p0_count", "p1_count", "p2_count", "p3_count")
SELECT_REQUIRED_LINES = (
    "          QUOTA_RETRIED: ${{ steps.classify.outputs.retry || 'false' }}",
    "          QUOTA_OUTCOME: ${{ steps.omar_retry.outcome || '' }}",
    *(
        f"          QUOTA_{name.upper()}: ${{{{ steps.omar_retry.outputs.{name} || "
        + ("''" if name in {"run_id", "gate_status"} else "'0'")
        + " }}"
        for name in _RESULT_OUTPUTS
    ),
    '          if [ "${QUOTA_RETRIED}" = "true" ]; then',
    "            route=quota_retry",
    '            outcome="${QUOTA_OUTCOME}"',
    *(f'            {name}="${{QUOTA_{name.upper()}}}"' for name in _RESULT_OUTPUTS),
    '          if [ "${outcome}" != "success" ]; then',
    "            echo \"::error::Direct OpenAI Omar scan did not succeed (route=${route}, outcome='${outcome}').\"",
    "            exit 1",
)
FORBIDDEN_ROUTE_MARKERS = (
    "GOOGLE_GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "google_api_key:",
    "typesafe_api_key:",
    "intent_model_pin:",
    "intent_policy:",
    "anthropic_api_key:",
    "xai_api_key:",
    "gemini-",
    "gpt-5.3-codex",
    "gpt-4.1-mini",
    "provider_outage_break_glass",
    "classify_omar_provider_outage.py",
    "llm_failure_policy: deterministic_only",
    "Run deterministic Omar Gate fallback",
    "Wait for authoritative Omar Gate review surface",
    "wait_for_" + "authoritative_omar_review.py",
    "sentinelayer-omar-" + "summary",
    "--summary-out",
    "--upsert" + "-comment",
    "GitHub App bridge",
    "thin GitHub App bridge",
    "Playwright + SBOM + model policy",
    "721bc7efe1402fcce416becea3d247b838119ed2",
    "fc444dee5bab4c79136775eb6930f1dea020d07c",
    "c82f840313be35fd74f88c7b0c62e7769f806042",
)


def _require(text: str, fragment: str) -> None:
    if fragment not in text:
        raise OmarWorkflowContractError(f"omar-gate.yml is missing: {fragment}")


def _job_lines(text: str, name: str) -> list[str]:
    lines = text.splitlines()
    target = f"  {name}:"
    if target not in lines:
        raise OmarWorkflowContractError(f"omar-gate.yml is missing jobs.{name}")
    start = lines.index(target)
    end = next(
        (i for i in range(start + 1, len(lines)) if re.match(r"^  [a-z_]+:$", lines[i])),
        len(lines),
    )
    return lines[start:end]


def _step_lines(job: list[str], name: str) -> list[str]:
    target = f"      - name: {name}"
    if job.count(target) != 1:
        raise OmarWorkflowContractError(f"expected exactly one step named {name}")
    start = job.index(target)
    end = next(
        (i for i in range(start + 1, len(job)) if job[i].startswith("      - name: ")),
        len(job),
    )
    return job[start:end]


def _action_inputs(step: list[str]) -> dict[str, str]:
    if "        with:" not in step:
        raise OmarWorkflowContractError("Run Omar Gate has no action inputs")
    start = step.index("        with:")
    inputs: dict[str, str] = {}
    for line in step[start + 1 :]:
        if not line.startswith("          "):
            break
        match = re.fullmatch(r"          ([a-z_]+):\s*(.*?)\s*", line)
        if not match:
            continue
        key, value = match.groups()
        if key in inputs:
            raise OmarWorkflowContractError(f"duplicate Omar action input: {key}")
        inputs[key] = value
    return inputs


def _block_lines(step: list[str], header: str) -> list[str]:
    if header not in step:
        return []
    block = []
    for line in step[step.index(header) + 1 :]:
        if not line.startswith("          "):
            break
        block.append(line)
    return block


def _require_lines(step: list[str], required: tuple[str, ...], message: str) -> None:
    missing = [line for line in required if line not in step]
    if missing:
        raise OmarWorkflowContractError(f"{message}; missing: {missing[0].strip()}")


def _validate_quota_retry(
    workflow_text: str, trusted: list[str], first_inputs: dict[str, str]
) -> None:
    if "vars.AZURE_SOL61_BASE_URL" in workflow_text:
        raise OmarWorkflowContractError(
            "the quota retry endpoint must come from secrets.AZURE_SOL61_BASE_URL: a variable is printed in step logs"
        )
    if "      quota_retry_drill:" not in workflow_text or workflow_text.count(
        "inputs.quota_retry_drill"
    ) != workflow_text.count("github.event_name == 'workflow_dispatch' && inputs.quota_retry_drill"):
        raise OmarWorkflowContractError("the quota retry drill must be reachable only from workflow_dispatch")
    steps = {name: _step_lines(trusted, name) for name in QUOTA_RETRY_STEP_ORDER}
    positions = [trusted.index(f"      - name: {name}") for name in QUOTA_RETRY_STEP_ORDER]
    if positions != sorted(positions):
        raise OmarWorkflowContractError(
            "the first attempt must be classified, and its retry route checked, before the retry and the selection"
        )
    _require_lines(
        steps["Classify Omar provider failure"],
        CLASSIFY_REQUIRED_LINES,
        "only a billing or quota 429 on the first attempt, the dispatch drill, or the org's Azure route may take the quota retry",
    )
    _require_lines(
        steps["Validate the quota retry route"],
        (QUOTA_RETRY_IF_LINE, *QUOTA_RETRY_SECRET_LINES),
        "the quota retry route must be checked before the retry",
    )
    retry = steps["Run Omar Gate (quota retry)"]
    _require_lines(
        retry,
        (QUOTA_RETRY_IF_LINE, "        id: omar_retry", f"        uses: {ACTION_REF}"),
        "the quota retry must run the reviewed Action pin, and only when the classifier allows it",
    )
    if _block_lines(retry, "        env:") != [QUOTA_RETRY_ENDPOINT_LINE]:
        raise OmarWorkflowContractError(
            "the quota retry's only environment must be OPENAI_BASE_URL from secrets.AZURE_SOL61_BASE_URL"
        )
    retry_inputs = _action_inputs(retry)
    expected_inputs = {**first_inputs, "openai_api_key": QUOTA_RETRY_KEY}
    drift = sorted(
        key
        for key in expected_inputs.keys() | retry_inputs.keys()
        if retry_inputs.get(key) != expected_inputs.get(key)
    )
    if drift:
        raise OmarWorkflowContractError(
            "the quota retry must repeat the first attempt's inputs with only its own key; drift in: "
            + ", ".join(drift)
        )
    _require_lines(
        steps["Select Omar Gate result"],
        SELECT_REQUIRED_LINES,
        "Select Omar Gate result must count only the retry after a quota retry, and fail closed",
    )
    _require_lines(
        _step_lines(trusted, "Scan staged artifacts for secrets"),
        ("          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}", *QUOTA_RETRY_SECRET_LINES),
        "the artifact secret scan must refuse the review key and the quota retry's key and endpoint",
    )
    for name in ("AZURE_SOL61_API_KEY", "AZURE_SOL61_BASE_URL"):
        if workflow_text.count(f"secrets.{name}") != 3:
            raise OmarWorkflowContractError(
                f"secrets.{name} may be read only by the route check, the quota retry and the artifact secret scan"
            )


def validate_omar_contract(workflow_text: str) -> None:
    for marker in FORBIDDEN_ROUTE_MARKERS:
        if marker.casefold() in workflow_text.casefold():
            raise OmarWorkflowContractError(f"alternate/broken Omar route in workflow: {marker}")

    if "./.github/actions/omar-gate" in workflow_text:
        raise OmarWorkflowContractError("Omar workflow must call the pinned Action directly")
    action_uses = re.findall(
        r"(?m)^\s*uses:\s*(mrrCarter/sentinelayer-v1-action@\S+)", workflow_text
    )
    if action_uses != [ACTION_REF, ACTION_REF]:
        raise OmarWorkflowContractError(
            f"Omar workflow requires one reviewed Action pin ({ACTION_REF}), "
            "invoked only by the first attempt and its quota retry"
        )

    for fragment in (
        "name: Omar Gate",
        "  id-token: write",
        "  omar_untrusted_scan:",
        "    name: Omar Gate Untrusted Scan",
        "github.event.pull_request.head.repo.full_name != github.repository",
        "Run deterministic untrusted scan",
        "  omar_scan:",
        "    name: Omar Gate (Deep Scan)",
        "github.event.pull_request.head.repo.full_name == github.repository",
        "Resolve Omar credential mode",
        "OMAR_TOKEN_EXCHANGE_URL",
        "OMAR_REQUIRE_OIDC_ON_PROTECTED_REF",
        "Validate Omar configuration invariants",
        "Validate Omar workflow contract",
        "check_omar_workflow_contract.py --self-test",
        "check_forbidden_omar_surface.py --self-test",
        "check_forbidden_omar_surface.py",
        "Require direct OpenAI key",
        'bash .github/scripts/require-secret.sh "OPENAI_API_KEY" "${OPENAI_API_KEY}"',
        "Select Omar Gate result",
        "Direct OpenAI Omar scan did not succeed",
        "selected_source=openai",
        "Assert Omar LLM contract is active",
        "Omar Gate did not pass",
        "Validate Omar output contract",
        "Stage Omar artifacts",
        '"llm_route": "openai_api_key"',
        '"review_routing": "legacy"',
        '"llm_scope": "legacy_bounded_context"',
        '"source_wide_llm_coverage": False',
        '"managed_llm": False',
        '"llm_failure_policy": "block"',
        '"selected_source": env("OMAR_SELECTED_SOURCE")',
        f'"action_ref": "{ACTION_REF}"',
        "Scan staged artifacts for secrets",
        "Upload Omar artifacts",
        "actions/upload-artifact",
        "omar-artifacts/**",
        "  omar_enforce:",
        "    name: Omar Gate",
        "    if: ${{ always() }}",
        "Require selected Omar scan success",
        "Trusted Omar scan did not succeed",
        "Untrusted Omar scan did not succeed",
    ):
        _require(workflow_text, fragment)

    trusted = _job_lines(workflow_text, "omar_scan")
    if "      id-token: write" not in trusted:
        raise OmarWorkflowContractError("trusted Omar job must retain OIDC permission")
    run_step = _step_lines(trusted, "Run Omar Gate")
    if f"        uses: {ACTION_REF}" not in run_step:
        raise OmarWorkflowContractError("Run Omar Gate must invoke reviewed Action pin")
    if "        continue-on-error: true" not in run_step:
        raise OmarWorkflowContractError("Omar result selection must observe action outcome")
    if FIRST_ATTEMPT_IF_LINE not in run_step:
        raise OmarWorkflowContractError(
            "Run Omar Gate may be skipped only by the dispatch quota retry drill or the org's Azure route"
        )
    if any("OPENAI_BASE_URL" in line for line in run_step):
        raise OmarWorkflowContractError("the first Omar attempt must use the primary endpoint")
    if sum(line.strip().startswith("continue-on-error") for line in trusted) != 1:
        raise OmarWorkflowContractError(
            "only the first Omar attempt may continue on error: a failed quota retry or selection must fail the job"
        )
    inputs = _action_inputs(run_step)
    for key, expected in EXPECTED_ACTION_INPUTS.items():
        if inputs.get(key) != expected:
            raise OmarWorkflowContractError(
                f"Omar input {key} must be {expected}; got {inputs.get(key)!r}"
            )
    for key in inputs:
        if key in {
            "google_api_key", "typesafe_api_key", "anthropic_api_key", "xai_api_key",
            "typesafe_fallback", "intent_policy", "intent_model_pin",
        }:
            raise OmarWorkflowContractError(f"Omar input {key} enables an alternate route")
    _validate_quota_retry(workflow_text, trusted, inputs)

    positions = [
        workflow_text.index(name)
        for name in (
            "Validate Omar configuration invariants",
            "Validate Omar workflow contract",
            "Require direct OpenAI key",
            "Run Omar Gate",
        )
    ]
    if positions != sorted(positions) or len(set(positions)) != len(positions):
        raise OmarWorkflowContractError("Omar preflight must run before the model call")
    if '"source_wide_llm_coverage": True' in workflow_text:
        raise OmarWorkflowContractError("legacy deep must not claim source-wide LLM coverage")


def _assert_fails(text: str) -> None:
    try:
        validate_omar_contract(text)
    except OmarWorkflowContractError:
        return
    raise AssertionError("invalid Omar workflow should fail validation")


def _replace_once(text: str, old: str, new: str) -> str:
    if text.count(old) != 1:
        raise AssertionError(f"self-test fixture must contain exactly one {old!r}")
    return text.replace(old, new, 1)


def _step_span(text: str, name: str) -> tuple[int, int]:
    start = text.index(f"      - name: {name}\n")
    end = text.find("\n      - name: ", start + 1)
    return start, len(text) if end == -1 else end + 1


def _replace_in_step(text: str, name: str, old: str, new: str) -> str:
    start, end = _step_span(text, name)
    return text[:start] + _replace_once(text[start:end], old, new) + text[end:]


def _without_step(text: str, name: str) -> str:
    start, end = _step_span(text, name)
    return text[:start] + text[end:]


def _run_self_tests(workflow_text: str) -> None:
    validate_omar_contract(workflow_text)
    action_input_mutations = (
        (f"uses: {ACTION_REF}", "uses: mrrCarter/sentinelayer-v1-action@8afb7dbb42a5e1c25233d422c4cabe401ba02380"),
        ("llm_provider: openai", "llm_provider: google"),
        ("          model: gpt-6.1-sol", "          model: gpt-5.3-codex"),
        ("          model_fallback: gpt-6.1-sol", "          model_fallback: gpt-4.1-mini"),
        ("          codex_model: gpt-6.1-sol", "          codex_model: gpt-6.2"),
        ('use_codex: "false"', 'use_codex: "true"'),
        ('sentinelayer_managed_llm: "false"', 'sentinelayer_managed_llm: "true"'),
        ("review_routing: legacy", "review_routing: intent-cascade-v1"),
        ("llm_provider: openai", "llm_provider: openai\n          google_api_key: ${{ secrets.GOOGLE_API_KEY }}"),
        ("rate_limit_fail_mode: closed", "rate_limit_fail_mode: open"),
    )
    for step in ("Run Omar Gate", "Run Omar Gate (quota retry)"):
        for old, new in action_input_mutations:
            _assert_fails(_replace_in_step(workflow_text, step, old, new))
    mutations = (
        ("      - name: Require direct OpenAI key", "      - name: OpenAI key check removed"),
        ('"llm_scope": "legacy_bounded_context"', '"llm_scope": "full_source"'),
        ('"source_wide_llm_coverage": False', '"source_wide_llm_coverage": True'),
        ("    if: ${{ always() }}", "    if: ${{ needs.omar_scan.result == 'success' }}"),
        ("    name: Omar Gate (Deep Scan)", "    name: Omar Gate Scan"),
        ("actions/upload-artifact", "actions/cache"),
    )
    for old, new in mutations:
        _assert_fails(_replace_once(workflow_text, old, new))
    _run_quota_retry_self_tests(workflow_text)


def _run_quota_retry_self_tests(valid: str) -> None:
    retry = "Run Omar Gate (quota retry)"
    retry_start, retry_end = _step_span(valid, retry)
    # A copy of the retry on the primary key and endpoint: a third invocation that reads no backup secret.
    second_retry = (
        valid[retry_start:retry_end]
        .replace(retry, "Run Omar Gate (second retry)")
        .replace("        id: omar_retry\n", "        id: omar_second_retry\n")
        .replace("        env:\n" + QUOTA_RETRY_ENDPOINT_LINE + "\n", "")
        .replace("openai_api_key: " + QUOTA_RETRY_KEY, "openai_api_key: ${{ secrets.OPENAI_API_KEY }}")
    )
    weakened = {
        "the primary key on the retry": _replace_in_step(
            valid, retry, "openai_api_key: " + QUOTA_RETRY_KEY, "openai_api_key: ${{ secrets.OPENAI_API_KEY }}"
        ),
        "the retry key on the first attempt": _replace_in_step(
            valid, "Run Omar Gate", "openai_api_key: ${{ secrets.OPENAI_API_KEY }}", "openai_api_key: " + QUOTA_RETRY_KEY
        ),
        "the retry endpoint from a variable": _replace_once(
            valid, QUOTA_RETRY_ENDPOINT_LINE, QUOTA_RETRY_ENDPOINT_LINE.replace("secrets.", "vars.")
        ),
        "the endpoint variable in any step": _replace_in_step(
            valid,
            "Classify Omar provider failure",
            "        env:\n",
            "        env:\n          RETRY_ENDPOINT: ${{ vars.AZURE_SOL61_BASE_URL }}\n",
        ),
        "a retry with more environment than its endpoint": _replace_once(
            valid, QUOTA_RETRY_ENDPOINT_LINE + "\n", QUOTA_RETRY_ENDPOINT_LINE + "\n          OPENAI_LOG: debug\n"
        ),
        "a route check after the retry": _replace_once(
            _without_step(valid, "Validate the quota retry route"),
            "      - name: Select Omar Gate result\n",
            valid[slice(*_step_span(valid, "Validate the quota retry route"))] + "      - name: Select Omar Gate result\n",
        ),
        "another endpoint on the first attempt": _replace_in_step(
            valid,
            "Run Omar Gate",
            "        continue-on-error: true\n",
            "        continue-on-error: true\n        env:\n          OPENAI_BASE_URL: https://proxy.example.test/v1\n",
        ),
        "a retry that may fail without failing the job": _replace_in_step(
            valid, retry, "        id: omar_retry\n", "        id: omar_retry\n        continue-on-error: ${{ true }}\n"
        ),
        "a selection that may fail without failing the job": _replace_in_step(
            valid, "Select Omar Gate result", "        id: omar_result\n", "        id: omar_result\n        continue-on-error: true\n"
        ),
        "a third Action invocation": _replace_once(
            valid, "      - name: Select Omar Gate result\n", second_retry + "      - name: Select Omar Gate result\n"
        ),
        "an ungated drill reference": _replace_in_step(
            valid,
            "Select Omar Gate result",
            "          QUOTA_RETRIED: ${{ steps.classify.outputs.retry || 'false' }}\n",
            "          QUOTA_RETRIED: ${{ steps.classify.outputs.retry || 'false' }}\n"
            "          DRILL_REQUESTED: ${{ inputs.quota_retry_drill }}\n",
        ),
        "a retry any event can switch on": _replace_in_step(
            valid, retry, QUOTA_RETRY_IF_LINE, "        if: inputs.quota_retry_drill"
        ),
        "a retry not gated on the classifier": _replace_in_step(
            valid, retry, QUOTA_RETRY_IF_LINE, "        if: steps.trust_boundary.outputs.trusted_context == 'true'"
        ),
        "no retry at all": _without_step(valid, retry),
        "no route check before the retry": _without_step(valid, "Validate the quota retry route"),
        "a route check that never runs": _replace_in_step(
            valid, "Validate the quota retry route", QUOTA_RETRY_IF_LINE, "        if: ${{ false }}"
        ),
        "a first attempt the drill does not skip": _replace_once(
            valid, FIRST_ATTEMPT_IF_LINE, "        if: steps.trust_boundary.outputs.trusted_context == 'true'"
        ),
        "a first attempt the org route does not skip": _replace_once(
            valid, FIRST_ATTEMPT_IF_LINE, FIRST_ATTEMPT_IF_LINE.replace(" && vars.OMAR_ROUTE != 'azure'", "")
        ),
        "an org route the classifier does not read": _replace_in_step(
            valid, "Classify Omar provider failure", CLASSIFY_ROUTE_LINE + "\n", ""
        ),
        "an org route the classifier compares case-sensitively": _replace_in_step(
            valid, "Classify Omar provider failure", CLASSIFY_ROUTE_LINE, "          ROUTE: ${{ vars.OMAR_ROUTE || '' }}"
        ),
        "a route the classifier reads from the pull request": _replace_in_step(
            valid,
            "Classify Omar provider failure",
            CLASSIFY_ROUTE_LINE + "\n",
            "          # " + CLASSIFY_ROUTE_LINE.strip() + "\n          ROUTE: ${{ github.head_ref }}\n",
        ),
        "a classifier that takes any org route value": _replace_in_step(
            valid, "Classify Omar provider failure", CLASSIFY_ROUTE_TEST_LINE, '          if [ -n "${ROUTE}" ]; then'
        ),
        "a first attempt that fails the job by itself": _replace_in_step(
            valid, "Run Omar Gate", "        continue-on-error: true\n", ""
        ),
        "a retry after any provider failure": _replace_once(
            valid,
            '          elif [ "${FIRST_OUTCOME}" = "failure" ] && [ "${FIRST_FAILURE_CLASS}" = "provider_failure" ]; then',
            '          elif [ "${FIRST_OUTCOME}" = "failure" ]; then',
        ),
        "a drill switch any event can set": _replace_once(
            valid,
            "DRILL: ${{ github.event_name == 'workflow_dispatch' && inputs.quota_retry_drill && 'true' || 'false' }}",
            "DRILL: ${{ inputs.quota_retry_drill && 'true' || 'false' }}",
        ),
        "a selection that passes a failed attempt": _replace_once(
            valid, '          if [ "${outcome}" != "success" ]; then', "          if false; then"
        ),
        "a selection that keeps the first attempt's status after a retry": _replace_once(
            valid, '            gate_status="${QUOTA_GATE_STATUS}"', '            gate_status="${OPENAI_GATE_STATUS}"'
        ),
        "an artifact scan blind to the retry endpoint": _replace_in_step(
            valid, "Scan staged artifacts for secrets", QUOTA_RETRY_SECRET_LINES[1] + "\n", ""
        ),
        "an artifact scan blind to the review key": _replace_in_step(
            valid, "Scan staged artifacts for secrets", "          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}\n", ""
        ),
        "another step reading the retry key": _replace_in_step(
            valid,
            "Require direct OpenAI key",
            "          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}\n",
            "          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}\n" + QUOTA_RETRY_SECRET_LINES[0] + "\n",
        ),
    }
    for label, candidate in weakened.items():
        if candidate == valid:
            raise AssertionError(f"self-test mutation changed nothing: {label}")
        try:
            validate_omar_contract(candidate)
        except OmarWorkflowContractError:
            continue
        raise AssertionError(f"the contract accepted {label}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify the canonical Omar Gate uses direct OpenAI gpt-6.1-sol."
    )
    parser.add_argument("--workflow", default=".github/workflows/omar-gate.yml")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    workflow_text = Path(args.workflow).read_text(encoding="utf-8")
    try:
        if args.self_test:
            _run_self_tests(workflow_text)
        validate_omar_contract(workflow_text)
    except OmarWorkflowContractError as exc:
        print(f"::error::{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
