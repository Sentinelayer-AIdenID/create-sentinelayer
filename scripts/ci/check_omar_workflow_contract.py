from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


class OmarWorkflowContractError(ValueError):
    pass


BRIDGE_OR_BROKEN_MARKERS = (
    "GitHub App bridge",
    "thin GitHub App bridge",
    "Playwright + SBOM + model policy",
    "721bc7efe1402fcce416becea3d247b838119ed2",
    "fc444dee5bab4c79136775eb6930f1dea020d07c",
    "c82f840313be35fd74f88c7b0c62e7769f806042",
)


ALLOWED_OPENAI_API_KEY_LINE = "openai_api_key: ${{ secrets.OPENAI_API_KEY }}"
ALLOWED_DETERMINISTIC_OPENAI_API_KEY_LINE = 'openai_api_key: ""'
ALLOWED_GOOGLE_API_KEY_LINE = "google_api_key: ${{ secrets.GOOGLE_GEMINI_API_KEY != '' && secrets.GOOGLE_GEMINI_API_KEY || secrets.GOOGLE_API_KEY }}"
ALLOWED_DETERMINISTIC_GOOGLE_API_KEY_LINE = 'google_api_key: ""'
OPENAI_PRESENT_EXPR = "secrets.OPENAI_API_KEY != ''"
GOOGLE_PRESENT_EXPR = "(secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '')"
GOOGLE_ABSENT_EXPR = "secrets.GOOGLE_GEMINI_API_KEY == '' && secrets.GOOGLE_API_KEY == ''"
ACTION_REF = "mrrCarter/sentinelayer-v1-action@8afb7dbb42a5e1c25233d422c4cabe401ba02380"

JEVA_ACTION_REF = "Sentinelayer-AIdenID/sentinelayer-v1-action@ebfcb813126ff64f21bb1fccfef8ab30609af67c"

ALLOWED_JEVA_LLM_PROVIDER_LINE = "llm_provider: typesafe"
ALLOWED_JEVA_REVIEW_ROUTING_LINE = "review_routing: intent-cascade-v1"
ALLOWED_JEVA_FORK_POLICY_LINE = "fork_policy: block"
ALLOWED_JEVA_SCAN_MODE_LINE = "scan_mode: pr-diff"
ALLOWED_JEVA_SEVERITY_GATE_LINE = "severity_gate: P1"
ALLOWED_JEVA_COMMENT_TAG_LINE = "comment_tag: jev"
ALLOWED_JEVA_PUBLISH_GITHUB_LINE = 'publish_github: "true"'
ALLOWED_JEVA_LLM_FAILURE_POLICY_LINE = "llm_failure_policy: block"
ALLOWED_JEVA_CODEX_MODEL_LINE = "codex_model: gpt-6-sol"
ALLOWED_JEVA_USE_CODEX_LINE = 'use_codex: "false"'
ALLOWED_JEVA_CODEX_ONLY_LINE = 'codex_only: "false"'
ALLOWED_JEVA_SENTINELAYER_MANAGED_LLM_LINE = 'sentinelayer_managed_llm: "false"'
ALLOWED_JEVA_INTENT_PRICE_PROFILE_LINE = "intent_price_profile: typesafe-input-20261020"

JEVA_REQUIRED_FRAGMENTS = (
    JEVA_ACTION_REF,
    ALLOWED_JEVA_LLM_PROVIDER_LINE,
    ALLOWED_JEVA_REVIEW_ROUTING_LINE,
    ALLOWED_JEVA_FORK_POLICY_LINE,
    ALLOWED_JEVA_COMMENT_TAG_LINE,
    ALLOWED_JEVA_PUBLISH_GITHUB_LINE,
    'name: Omar Gate (Jev)',
    "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
    "actions/upload-artifact@50769540e7f4bd5e21e526ee35c689e35e0d6874",
    "github_token: ${{ secrets.GITHUB_TOKEN }}",
    "sentinelayer_token: ${{ secrets.SENTINELAYER_TOKEN }}",
    "intent_model_pin: ${{ secrets.INTENT_MODEL_PIN }}",
    "intent_policy: ${{ secrets.INTENT_POLICY }}",
    "typesafe_api_key: ${{ secrets.TYPESAFE_API_KEY }}",
    "openai_api_key: ${{ secrets.OPENAI_API_KEY }}",
    "if-no-files-found: error",
)

ALLOWED_LLM_PROVIDER_LINE = f"llm_provider: ${{{{ {OPENAI_PRESENT_EXPR} && 'openai' || ({GOOGLE_PRESENT_EXPR} && 'google' || 'openai') }}}}"
ALLOWED_DETERMINISTIC_LLM_PROVIDER_LINE = "llm_provider: openai"
ALLOWED_MODEL_LINE = f"model: ${{{{ {OPENAI_PRESENT_EXPR} && 'gpt-5.3-codex' || ({GOOGLE_PRESENT_EXPR} && 'gemini-2.5-flash' || 'gpt-5.3-codex') }}}}"
ALLOWED_DETERMINISTIC_MODEL_LINE = "model: gpt-5.3-codex"
ALLOWED_MODEL_FALLBACK_LINE = f"model_fallback: ${{{{ {GOOGLE_PRESENT_EXPR} && 'gemini-2.5-flash' || 'gpt-4.1-mini' }}}}"
ALLOWED_DETERMINISTIC_MODEL_FALLBACK_LINE = "model_fallback: gpt-4.1-mini"
ALLOWED_USE_CODEX_LINE = f"use_codex: ${{{{ {OPENAI_PRESENT_EXPR} || ({GOOGLE_ABSENT_EXPR}) }}}}"
ALLOWED_DETERMINISTIC_USE_CODEX_LINE = 'use_codex: "false"'
MANAGED_LLM_FALLBACK_RE = re.compile(
    r"^sentinelayer_managed_llm:\s*\$\{\{\s*"
    r"(?:steps\.resolve_omar_credentials\.outputs\.sentinelayer_token|secrets\.[A-Z0-9_]+)"
    r"\s*!=\s*''\s*\}\}$"
)


def _line_has_managed_llm_fallback(line: str) -> bool:
    stripped = line.split("#", 1)[0].strip()
    return bool(MANAGED_LLM_FALLBACK_RE.match(stripped))


def _is_job_start(line: str) -> bool:
    stripped = line.strip()
    return (
        line.startswith("  ")
        and not line.startswith("    ")
        and stripped.endswith(":")
        and stripped[:-1].replace("_", "").replace("-", "").isalnum()
    )


def _find_job_lines(lines: list[str], job_name: str) -> list[str]:
    start = None
    expected = f"  {job_name}:"
    for index, line in enumerate(lines):
        if line.rstrip() == expected:
            start = index
            break

    if start is None:
        raise OmarWorkflowContractError(f"omar-gate.yml is missing jobs.{job_name}")

    end = len(lines)
    for index in range(start + 1, len(lines)):
        if _is_job_start(lines[index]):
            end = index
            break

    return lines[start:end]


def _permissions_block_has(lines: list[str], header: str, indent: str, permission: str) -> bool:
    permissions_start = None
    for index, line in enumerate(lines):
        if line.rstrip() == header:
            permissions_start = index
            break

    if permissions_start is None:
        return False

    for line in lines[permissions_start + 1 :]:
        if line.strip() == "" or line.lstrip().startswith("#"):
            continue
        if not line.startswith(indent):
            break
        if line.split("#", 1)[0].strip() == permission:
            return True

    return False


def _reject_bridge_or_provider_inputs(text: str) -> None:
    for marker in BRIDGE_OR_BROKEN_MARKERS:
        if marker in text:
            raise OmarWorkflowContractError(
                f"Omar workflow references bridge or broken Omar marker: {marker}"
            )

    for line in text.splitlines():
        stripped = line.split("#", 1)[0].strip()
        if stripped.startswith("pr_number:"):
            raise OmarWorkflowContractError(
                "full Omar action workflow must not pass bridge-only pr_number"
            )
        if stripped.startswith("openai_api_key:") and stripped not in {
            ALLOWED_OPENAI_API_KEY_LINE,
            ALLOWED_DETERMINISTIC_OPENAI_API_KEY_LINE,
        }:
            raise OmarWorkflowContractError(
                "Omar workflow may only bind openai_api_key to secrets.OPENAI_API_KEY"
            )
        if stripped.startswith("google_api_key:") and stripped not in {
            ALLOWED_GOOGLE_API_KEY_LINE,
            ALLOWED_DETERMINISTIC_GOOGLE_API_KEY_LINE,
        }:
            raise OmarWorkflowContractError(
                "Omar workflow may only bind google_api_key to secrets.GOOGLE_GEMINI_API_KEY with secrets.GOOGLE_API_KEY fallback"
            )
        if stripped.startswith("llm_provider:") and stripped not in {
            ALLOWED_LLM_PROVIDER_LINE,
            ALLOWED_DETERMINISTIC_LLM_PROVIDER_LINE,
        }:
            raise OmarWorkflowContractError(
                "Omar workflow must prefer OpenAI/Codex when configured, then Google, then managed SentinelLayer"
            )
        if stripped.startswith("model:") and stripped not in {
            ALLOWED_MODEL_LINE,
            ALLOWED_DETERMINISTIC_MODEL_LINE,
        }:
            raise OmarWorkflowContractError(
                "Omar workflow must route OpenAI-key scans to Codex before Gemini fallback"
            )
        if stripped.startswith("model_fallback:") and stripped not in {
            ALLOWED_MODEL_FALLBACK_LINE,
            ALLOWED_DETERMINISTIC_MODEL_FALLBACK_LINE,
        }:
            raise OmarWorkflowContractError(
                "Omar workflow must use Gemini as the OpenAI fallback whenever a Google key is configured"
            )
        if stripped.startswith("use_codex:") and stripped not in {
            ALLOWED_USE_CODEX_LINE,
            ALLOWED_DETERMINISTIC_USE_CODEX_LINE,
        }:
            raise OmarWorkflowContractError(
                "Omar workflow must enable Codex whenever OpenAI is configured or no Google key exists"
            )
        if stripped.startswith(("anthropic_api_key:", "xai_api_key:")):
            raise OmarWorkflowContractError(
                "Omar workflow must not pass alternate provider-key or provider-selection inputs"
            )
        if (
            stripped.startswith("sentinelayer_managed_llm:")
            and not _line_has_managed_llm_fallback(stripped)
            and stripped != 'sentinelayer_managed_llm: "false"'
        ):
            raise OmarWorkflowContractError(
                "sentinelayer_managed_llm must be a SentinelLayer token-present managed-capacity fallback expression"
            )


def validate_omar_contract(workflow_text: str) -> None:
    _reject_bridge_or_provider_inputs(workflow_text)

    if "./.github/actions/omar-gate" in workflow_text:
        raise OmarWorkflowContractError(
            "Omar workflow must call sentinelayer-v1-action directly, not a local wrapper"
        )
    if ACTION_REF not in workflow_text:
        raise OmarWorkflowContractError(
            "Omar workflow must use the managed-capacity fallback sentinelayer-v1-action pin directly"
        )
    if ALLOWED_OPENAI_API_KEY_LINE not in workflow_text:
        raise OmarWorkflowContractError(
            "Omar workflow must configure openai_api_key from secrets.OPENAI_API_KEY"
        )
    if ALLOWED_GOOGLE_API_KEY_LINE not in workflow_text:
        raise OmarWorkflowContractError(
            "Omar workflow must configure google_api_key from the dedicated Gemini key with generic Google fallback"
        )
    if ALLOWED_LLM_PROVIDER_LINE not in workflow_text:
        raise OmarWorkflowContractError(
            "Omar workflow must configure the OpenAI-when-present provider selector"
        )
    if ALLOWED_MODEL_LINE not in workflow_text:
        raise OmarWorkflowContractError(
            "Omar workflow must configure the OpenAI-when-present model selector"
        )
    if ALLOWED_USE_CODEX_LINE not in workflow_text:
        raise OmarWorkflowContractError(
            "Omar workflow must configure Codex for OpenAI or managed-only routes"
        )
    if not any(_line_has_managed_llm_fallback(line) for line in workflow_text.splitlines()):
        raise OmarWorkflowContractError(
            "Omar workflow must configure managed LLM as the BYO OpenAI absent fallback"
        )

    workflow_lines = workflow_text.splitlines()
    if not _permissions_block_has(workflow_lines, "permissions:", "  ", "id-token: write"):
        raise OmarWorkflowContractError("top-level permissions must include id-token: write")

    omar_scan_lines = _find_job_lines(workflow_lines, "omar_scan")
    if "    name: Omar Gate (Deep Scan)" not in "\n".join(omar_scan_lines):
        raise OmarWorkflowContractError(
            "jobs.omar_scan.name must be 'Omar Gate (Deep Scan)' for GitHub visibility"
        )
    if not _permissions_block_has(omar_scan_lines, "    permissions:", "      ", "id-token: write"):
        raise OmarWorkflowContractError("jobs.omar_scan.permissions must include id-token: write")

    forbidden_comment_fragments = (
        "Wait for authoritative Omar Gate review surface",
        "wait_for_" + "authoritative" + "_omar_review.py",
        "sentinelayer-omar-" + "summary",
        "--summary-out",
        "--upsert" + "-comment",
    )
    for fragment in forbidden_comment_fragments:
        if fragment in workflow_text:
            raise OmarWorkflowContractError(
                f"omar-gate.yml must not require PR summary-comment evidence: {fragment}"
            )

    required_direct_fragments = (
        "Validate Omar configuration invariants",
        "OMAR_SPEC_ID must be a 64-character lowercase hex digest",
        "Validate Omar workflow contract",
        "check_omar_workflow_contract.py --self-test",
        "check_forbidden_omar_surface.py --self-test",
        "check_forbidden_omar_surface.py",
        "Verify managed Omar token secret",
        "Run Omar Gate",
        "continue-on-error: true",
        "Classify managed Omar failure",
        "classify_omar_provider_outage.py",
        "RUN_SUMMARY.json",
        "--run-summary",
        "provider_outage_break_glass",
        "Run deterministic Omar Gate fallback",
        'sentinelayer_managed_llm: "false"',
        'use_codex: "false"',
        "llm_failure_policy: deterministic_only",
        "artifact_name_suffix: provider-outage-fallback",
        "Select Omar Gate result",
        "selected_source",
        "Assert Omar LLM contract is active",
        "openai_api_key: ${{ secrets.OPENAI_API_KEY }}",
        "google_api_key: ${{ secrets.GOOGLE_GEMINI_API_KEY != '' && secrets.GOOGLE_GEMINI_API_KEY || secrets.GOOGLE_API_KEY }}",
        ACTION_REF,
        "llm_provider: ${{ secrets.OPENAI_API_KEY != '' && 'openai' || ((secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'google' || 'openai') }}",
        "sentinelayer_managed_llm: ${{ steps.resolve_omar_credentials.outputs.sentinelayer_token != '' }}",
        "model: ${{ secrets.OPENAI_API_KEY != '' && 'gpt-5.3-codex' || ((secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'gemini-2.5-flash' || 'gpt-5.3-codex') }}",
        "model_fallback: ${{ (secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'gemini-2.5-flash' || 'gpt-4.1-mini' }}",
        "use_codex: ${{ secrets.OPENAI_API_KEY != '' || (secrets.GOOGLE_GEMINI_API_KEY == '' && secrets.GOOGLE_API_KEY == '') }}",
        "REQUESTED_PROVIDER: ${{ secrets.OPENAI_API_KEY != '' && 'openai' || ((secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'google' || 'openai') }}",
        "REQUESTED_MODEL: ${{ secrets.OPENAI_API_KEY != '' && 'gpt-5.3-codex' || ((secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'gemini-2.5-flash' || 'gpt-5.3-codex') }}",
        "REQUESTED_FALLBACK_MODEL: ${{ (secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'gemini-2.5-flash' || 'gpt-4.1-mini' }}",
        "REQUESTED_OPENAI_KEY_PRESENT: ${{ secrets.OPENAI_API_KEY != '' }}",
        "REQUESTED_GOOGLE_KEY_PRESENT: ${{ secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '' }}",
        "REQUESTED_MANAGED_LLM: ${{ steps.resolve_omar_credentials.outputs.sentinelayer_token != '' }}",
        "REQUESTED_USE_CODEX: ${{ secrets.OPENAI_API_KEY != '' || (secrets.GOOGLE_GEMINI_API_KEY == '' && secrets.GOOGLE_API_KEY == '') }}",
        "REQUESTED_FAILURE_POLICY: block",
        "REQUESTED_CODEX_MODEL: gpt-5.3-codex",
        "Omar provider-outage break-glass contract active",
        "Omar provider-outage break-glass contract drifted",
        'codex_only: "false"',
        "max_daily_scans: ${{ vars.OMAR_MAX_DAILY_SCANS || '200' }}",
        "min_scan_interval_minutes: ${{ vars.OMAR_MIN_SCAN_INTERVAL_MINUTES || '0' }}",
        "rate_limit_fail_mode: closed",
        "Omar LLM contract active",
        "Omar Gate did not pass",
        "Stage Omar artifacts",
        "omar-artifacts/summary.json",
        "omar_gate_summary",
        "schema_version",
        '"llm_provider": env("OMAR_LLM_PROVIDER", "openai")',
        '"model": env("OMAR_MODEL", "gpt-5.3-codex")',
        '"model_fallback": env("OMAR_MODEL_FALLBACK", "gpt-4.1-mini")',
        '"llm_route": "openai_api_key" if bool_env("OMAR_OPENAI_KEY_PRESENT") else ("google_api_key" if bool_env("OMAR_GOOGLE_KEY_PRESENT") else "sentinelayer_managed")',
        '"google_key_present": bool_env("OMAR_GOOGLE_KEY_PRESENT")',
        '"openai_key_present": bool_env("OMAR_OPENAI_KEY_PRESENT")',
        '"managed_llm": bool_env("OMAR_MANAGED_LLM")',
        '"selected_source": env("OMAR_SELECTED_SOURCE")',
        '"provider_outage_break_glass": bool_env("OMAR_PROVIDER_OUTAGE_BREAK_GLASS")',
        "run_url",
        "Upload Omar artifacts",
        "actions/upload-artifact",
        "omar-artifacts/**",
    )
    for fragment in required_direct_fragments:
        if fragment not in workflow_text:
            raise OmarWorkflowContractError(
                f"omar-gate.yml is missing direct Omar Gate evidence fragment: {fragment}"
            )

    required_enforcer_fragments = (
        "omar_enforce:",
        "if: ${{ always() }}",
        "Require selected Omar scan success",
        "Trusted Omar scan did not succeed",
        "Untrusted Omar scan did not succeed",
    )
    for fragment in required_enforcer_fragments:
        if fragment not in workflow_text:
            raise OmarWorkflowContractError(
                f"omar-gate.yml is missing fail-closed Omar enforcer fragment: {fragment}"
            )

    if workflow_text.index("Validate Omar workflow contract") > workflow_text.index("Run Omar Gate"):
        raise OmarWorkflowContractError(
            "workflow contract validation must run before Omar consumes scan quota"
        )
    if workflow_text.index("Validate Omar configuration invariants") > workflow_text.index("Run Omar Gate"):
        raise OmarWorkflowContractError(
            "workflow configuration validation must run before Omar consumes scan quota"
        )


def validate_jev_contract(workflow_text: str) -> None:

    if JEVA_ACTION_REF not in workflow_text:
        raise OmarWorkflowContractError(
            "omar-gate-jev.yml must use the Sentinelayer-AIdenID sentinelayer-v1-action pin directly"
        )

    for fragment in JEVA_REQUIRED_FRAGMENTS:
        if fragment not in workflow_text:
            raise OmarWorkflowContractError(
                f"omar-gate-jev.yml is missing required Jev contract fragment: {fragment}"
            )

    forbidden_jev_fragments = (
        "mrrCarter/sentinelayer-v1-action",
        'llm_provider: ${{',
        'model: ${{',
        'model_fallback: ${{',
        'use_codex: ${{',
        'sentinelayer_managed_llm: ${{',
        'google_api_key:',
        'codex_model: gpt-5.',
        'intent_price_profile: standard',
    )
    for fragment in forbidden_jev_fragments:
        if fragment in workflow_text:
            raise OmarWorkflowContractError(
                f"omar-gate-jev.yml must not contain legacy/expression-based fragment: {fragment}"
            )

    jev_lines = workflow_text.splitlines()
    if "jobs:" not in workflow_text or "omar-jev:" not in "\n".join(jev_lines):
        raise OmarWorkflowContractError(
            "omar-gate-jev.yml must define jobs.omar-jev"
        )



def _assert_fails(workflow_text: str) -> None:
    try:
        validate_omar_contract(workflow_text)
    except OmarWorkflowContractError:
        return
    raise AssertionError("invalid Omar workflow should fail validation")


def _run_self_tests() -> None:
    valid_workflow = """
name: Omar Gate
permissions:
  contents: read
  id-token: write
jobs:
  omar_scan:
    name: Omar Gate (Deep Scan)
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Validate Omar workflow contract
        run: |
          python3 scripts/ci/check_omar_workflow_contract.py --self-test
          python3 scripts/ci/check_forbidden_omar_surface.py --self-test
          python3 scripts/ci/check_forbidden_omar_surface.py
      - name: Validate Omar configuration invariants
        run: |
          echo "OMAR_SPEC_ID must be a 64-character lowercase hex digest"
      - name: Run Omar Gate
        id: omar
        continue-on-error: true
        uses: mrrCarter/sentinelayer-v1-action@8afb7dbb42a5e1c25233d422c4cabe401ba02380
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          google_api_key: ${{ secrets.GOOGLE_GEMINI_API_KEY != '' && secrets.GOOGLE_GEMINI_API_KEY || secrets.GOOGLE_API_KEY }}
          llm_provider: ${{ secrets.OPENAI_API_KEY != '' && 'openai' || ((secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'google' || 'openai') }}
          sentinelayer_managed_llm: ${{ steps.resolve_omar_credentials.outputs.sentinelayer_token != '' }}
          model: ${{ secrets.OPENAI_API_KEY != '' && 'gpt-5.3-codex' || ((secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'gemini-2.5-flash' || 'gpt-5.3-codex') }}
          model_fallback: ${{ (secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'gemini-2.5-flash' || 'gpt-4.1-mini' }}
          use_codex: ${{ secrets.OPENAI_API_KEY != '' || (secrets.GOOGLE_GEMINI_API_KEY == '' && secrets.GOOGLE_API_KEY == '') }}
          codex_only: "false"
          max_daily_scans: ${{ vars.OMAR_MAX_DAILY_SCANS || '200' }}
          min_scan_interval_minutes: ${{ vars.OMAR_MIN_SCAN_INTERVAL_MINUTES || '0' }}
          rate_limit_fail_mode: closed
      - name: Classify managed Omar failure
        run: |
          summary_path=".sentinelayer/runs/run/RUN_SUMMARY.json"
          python3 scripts/ci/classify_omar_provider_outage.py --findings .sentinelayer/runs/run/FINDINGS.jsonl --run-summary "${summary_path}" --github-output "${GITHUB_OUTPUT}"
          echo "provider_outage_break_glass"
      - name: Run deterministic Omar Gate fallback
        uses: mrrCarter/sentinelayer-v1-action@8afb7dbb42a5e1c25233d422c4cabe401ba02380
        with:
          sentinelayer_managed_llm: "false"
          model: gpt-5.3-codex
          model_fallback: gpt-4.1-mini
          use_codex: "false"
          codex_only: "false"
          llm_failure_policy: deterministic_only
          artifact_name_suffix: provider-outage-fallback
      - name: Select Omar Gate result
        run: |
          echo "selected_source"
      - name: Assert Omar LLM contract is active
        env:
          REQUESTED_PROVIDER: ${{ secrets.OPENAI_API_KEY != '' && 'openai' || ((secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'google' || 'openai') }}
          REQUESTED_MODEL: ${{ secrets.OPENAI_API_KEY != '' && 'gpt-5.3-codex' || ((secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'gemini-2.5-flash' || 'gpt-5.3-codex') }}
          REQUESTED_CODEX_MODEL: gpt-5.3-codex
          REQUESTED_FALLBACK_MODEL: ${{ (secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'gemini-2.5-flash' || 'gpt-4.1-mini' }}
          REQUESTED_OPENAI_KEY_PRESENT: ${{ secrets.OPENAI_API_KEY != '' }}
          REQUESTED_GOOGLE_KEY_PRESENT: ${{ secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '' }}
          REQUESTED_MANAGED_LLM: ${{ steps.resolve_omar_credentials.outputs.sentinelayer_token != '' }}
          REQUESTED_USE_CODEX: ${{ secrets.OPENAI_API_KEY != '' || (secrets.GOOGLE_GEMINI_API_KEY == '' && secrets.GOOGLE_API_KEY == '') }}
          REQUESTED_FAILURE_POLICY: block
        run: |
          echo "Omar provider-outage break-glass contract active"
          echo "Omar provider-outage break-glass contract drifted"
          echo "Omar LLM contract active"
          echo "Omar Gate did not pass"
      - name: Verify managed Omar token secret
        run: echo "SENTINELAYER_TOKEN is required for Omar telemetry/upload."
      - name: Stage Omar artifacts
        run: |
          echo "omar_gate_summary"
          echo "schema_version"
          echo '"llm_provider": env("OMAR_LLM_PROVIDER", "openai")'
          echo '"model": env("OMAR_MODEL", "gpt-5.3-codex")'
          echo '"model_fallback": env("OMAR_MODEL_FALLBACK", "gpt-4.1-mini")'
          echo '"llm_route": "openai_api_key" if bool_env("OMAR_OPENAI_KEY_PRESENT") else ("google_api_key" if bool_env("OMAR_GOOGLE_KEY_PRESENT") else "sentinelayer_managed")'
          echo '"google_key_present": bool_env("OMAR_GOOGLE_KEY_PRESENT")'
          echo '"openai_key_present": bool_env("OMAR_OPENAI_KEY_PRESENT")'
          echo '"managed_llm": bool_env("OMAR_MANAGED_LLM")'
          echo '"selected_source": env("OMAR_SELECTED_SOURCE")'
          echo '"provider_outage_break_glass": bool_env("OMAR_PROVIDER_OUTAGE_BREAK_GLASS")'
          echo "run_url"
          echo "omar-artifacts/summary.json"
      - name: Upload Omar artifacts
        uses: actions/upload-artifact@50769540e7f4bd5e21e526ee35c689e35e0d6874
        with:
          path: omar-artifacts/**
  omar_enforce:
    name: Omar Gate
    if: ${{ always() }}
    steps:
      - name: Require selected Omar scan success
        run: |
          echo "Trusted Omar scan did not succeed"
          echo "Untrusted Omar scan did not succeed"
"""
    validate_omar_contract(valid_workflow)

    _assert_fails(
        valid_workflow.replace(
            ' --run-summary "${summary_path}"',
            "",
        ),
    )
    _assert_fails(
        valid_workflow.replace(
            "sentinelayer_managed_llm: ${{ steps.resolve_omar_credentials.outputs.sentinelayer_token != '' }}",
            "",
        ),
    )
    _assert_fails(
        valid_workflow.replace(
            "sentinelayer_managed_llm: ${{ steps.resolve_omar_credentials.outputs.sentinelayer_token != '' }}",
            'sentinelayer_managed_llm: "true"',
        ),
    )
    _assert_fails(
        valid_workflow.replace(
            "openai_api_key: ${{ secrets.OPENAI_API_KEY }}",
            "openai_api_key: ${{ secrets.BAD_OPENAI_API_KEY }}",
        ),
    )
    _assert_fails(
        valid_workflow.replace(
            "google_api_key: ${{ secrets.GOOGLE_GEMINI_API_KEY != '' && secrets.GOOGLE_GEMINI_API_KEY || secrets.GOOGLE_API_KEY }}",
            "google_api_key: ${{ secrets.BAD_GOOGLE_API_KEY }}",
        ),
    )
    _assert_fails(
        valid_workflow.replace(
            "llm_provider: ${{ secrets.OPENAI_API_KEY != '' && 'openai' || ((secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'google' || 'openai') }}",
            "llm_provider: google",
        ),
    )
    _assert_fails(
        valid_workflow.replace(
            "model: ${{ secrets.OPENAI_API_KEY != '' && 'gpt-5.3-codex' || ((secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'gemini-2.5-flash' || 'gpt-5.3-codex') }}",
            "model: ${{ (secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'gemini-2.5-flash' || 'gpt-5.3-codex' }}",
        )
    )
    _assert_fails(
        valid_workflow.replace(
            "use_codex: ${{ secrets.OPENAI_API_KEY != '' || (secrets.GOOGLE_GEMINI_API_KEY == '' && secrets.GOOGLE_API_KEY == '') }}",
            "use_codex: ${{ secrets.GOOGLE_GEMINI_API_KEY == '' && secrets.GOOGLE_API_KEY == '' }}",
        )
    )
    _assert_fails(
        valid_workflow.replace("if: ${{ always() }}", "if: ${{ needs.omar_scan.result == 'success' }}"),
    )
    _assert_fails(valid_workflow.replace("Omar Gate (Deep Scan)", "Omar Gate Scan"))
    _assert_fails(valid_workflow.replace("actions/upload-artifact", "actions/cache"))
    _assert_fails(valid_workflow.replace("mrrCarter/sentinelayer-v1-action@", "./.github/actions/omar-gate # "))
    _assert_fails(
        valid_workflow.replace(
            "model_fallback: ${{ (secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'gemini-2.5-flash' || 'gpt-4.1-mini' }}",
            "model_fallback: gpt-5.2-codex",
        )
    )
    # --- Jev workflow self-tests ---
    valid_jev_workflow = """\
name: Omar Gate (Jev)
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  actions: read
  pull-requests: write
  checks: write
jobs:
  omar-jev:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
      - name: Omar Gate (Jev intent cascade)
        uses: Sentinelayer-AIdenID/sentinelayer-v1-action@ebfcb813126ff64f21bb1fccfef8ab30609af67c
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          review_routing: intent-cascade-v1
          llm_provider: typesafe
          typesafe_api_key: ${{ secrets.TYPESAFE_API_KEY }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          intent_model_pin: ${{ secrets.INTENT_MODEL_PIN }}
          intent_policy: ${{ secrets.INTENT_POLICY }}
          intent_price_profile: typesafe-input-20261020
          sentinelayer_token: ${{ secrets.SENTINELAYER_TOKEN }}
          scan_mode: pr-diff
          severity_gate: P1
          codex_model: gpt-6-sol
          use_codex: "false"
          codex_only: "false"
          sentinelayer_managed_llm: "false"
          llm_failure_policy: block
          fork_policy: block
          publish_github: "true"
          comment_tag: jev
      - uses: actions/upload-artifact@50769540e7f4bd5e21e526ee35c689e35e0d6874
        if: always()
        with:
          name: omar-jev-${{ github.run_id }}-${{ github.run_attempt }}
          path: .sentinelayer/runs/
          include-hidden-files: true
          if-no-files-found: error
"""
    validate_jev_contract(valid_jev_workflow)

    _assert_fails(
        valid_jev_workflow.replace(
            "Sentinelayer-AIdenID/sentinelayer-v1-action@ebfcb813126ff64f21bb1fccfef8ab30609af67c",
            "mrrCarter/sentinelayer-v1-action@8afb7dbb42a5e1c25233d422c4cabe401ba02380",
        )
    )
    _assert_fails(
        valid_jev_workflow.replace(
            'llm_provider: typesafe',
            'llm_provider: openai',
        )
    )
    _assert_fails(
        valid_jev_workflow.replace(
            'comment_tag: jev',
            'comment_tag: omar',
        )
    )
    _assert_fails(
        valid_jev_workflow.replace(
            'if-no-files-found: error',
            'if-no-files-found: warn',
        )
    )



def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify create-sentinelayer Omar workflow uses authoritative managed Omar directly."
    )
    parser.add_argument("--workflow", default=".github/workflows/omar-gate.yml")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument(
        "--jev",
        action="store_true",
        dest="jev_mode",
        default=False,
        help="Validate omar-gate-jev.yml instead of omar-gate.yml.",
    )
    args = parser.parse_args(argv)

    if args.self_test:
        _run_self_tests()
        return 0

    try:
        workflow_text = Path(args.workflow).read_text(encoding="utf-8")
        if args.jev_mode:
            validate_jev_contract(workflow_text)
        else:
            validate_omar_contract(workflow_text)
    except OmarWorkflowContractError as exc:
        print(f"::error::{exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
