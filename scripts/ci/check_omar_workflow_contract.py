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


def validate_omar_contract(workflow_text: str) -> None:
    for marker in FORBIDDEN_ROUTE_MARKERS:
        if marker.casefold() in workflow_text.casefold():
            raise OmarWorkflowContractError(f"alternate/broken Omar route in workflow: {marker}")

    if "./.github/actions/omar-gate" in workflow_text:
        raise OmarWorkflowContractError("Omar workflow must call the pinned Action directly")
    action_uses = re.findall(
        r"(?m)^\s*uses:\s*(mrrCarter/sentinelayer-v1-action@\S+)", workflow_text
    )
    if action_uses != [ACTION_REF]:
        raise OmarWorkflowContractError(
            f"Omar workflow requires one reviewed Action pin ({ACTION_REF})"
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


def _run_self_tests(workflow_text: str) -> None:
    validate_omar_contract(workflow_text)
    mutations = (
        (f"uses: {ACTION_REF}", "uses: mrrCarter/sentinelayer-v1-action@8afb7dbb42a5e1c25233d422c4cabe401ba02380"),
        ("llm_provider: openai", "llm_provider: google"),
        ("          model: gpt-6.1-sol", "          model: gpt-5.3-codex"),
        ("          model_fallback: gpt-6.1-sol", "          model_fallback: gpt-4.1-mini"),
        ('use_codex: "false"', 'use_codex: "true"'),
        ('sentinelayer_managed_llm: "false"', 'sentinelayer_managed_llm: "true"'),
        ("review_routing: legacy", "review_routing: intent-cascade-v1"),
        ("llm_provider: openai", "llm_provider: openai\n          google_api_key: ${{ secrets.GOOGLE_API_KEY }}"),
        ("      - name: Require direct OpenAI key", "      - name: OpenAI key check removed"),
        ('"llm_scope": "legacy_bounded_context"', '"llm_scope": "full_source"'),
        ('"source_wide_llm_coverage": False', '"source_wide_llm_coverage": True'),
        ("    if: ${{ always() }}", "    if: ${{ needs.omar_scan.result == 'success' }}"),
        ("    name: Omar Gate (Deep Scan)", "    name: Omar Gate Scan"),
        ("actions/upload-artifact", "actions/cache"),
    )
    for old, new in mutations:
        _assert_fails(_replace_once(workflow_text, old, new))


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
