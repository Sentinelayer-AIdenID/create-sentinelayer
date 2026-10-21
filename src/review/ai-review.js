import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import {
  createMultiProviderApiClient,
  resolveModel,
  resolveProvider,
} from "../ai/client.js";
import { computeProviderCost } from "../billing/price-book.js";
import { buildBillingRunId, buildCallIdempotencyKey, sanitizeBillingMetadata } from "../billing/ledger-entry.js";
import { recordSessionUsage } from "../billing/session-usage.js";
import { loadConfig, userConfigValues } from "../config/service.js";
import { evaluateBudget } from "../cost/budget.js";
import { appendCostEntry, summarizeCostHistory, loadCostHistory } from "../cost/history.js";
import { estimateTokens } from "../cost/tokenizer.js";
import { evaluateSeverityClassification, normalizeSeverityClassifier, withSeverityEvaluationQueue, severityResourceTotals, parseSeverityEvaluationMaxCost, TYPESAFE_SEVERITY_MODEL, SEVERITY_DICTIONARY_VERSION } from "./typesafe-severity.js";
import { appendRunEvent, loadRunEvents, deriveStopClassFromBudget } from "../telemetry/ledger.js";

const AI_SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);
const DEFAULT_AI_MAX_FINDINGS = 20;
const DEFAULT_REVIEW_AI_MODEL = "gpt-5.3-codex";

function normalizeString(value) {
  return String(value || "").trim();
}

function parseNonNegativeNumber(rawValue, field) {
  const normalized = Number(rawValue || 0);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return normalized;
}

function parsePercent(rawValue, field) {
  const normalized = Number(rawValue || 0);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 100) {
    throw new Error(`${field} must be between 0 and 100.`);
  }
  return normalized;
}

function resolveConfiguredApiKey(provider, resolvedConfig = {}) {
  const normalizedProvider = normalizeString(provider).toLowerCase();
  if (normalizedProvider === "openai") {
    return normalizeString(resolvedConfig.openaiApiKey);
  }
  if (normalizedProvider === "anthropic") {
    return normalizeString(resolvedConfig.anthropicApiKey);
  }
  if (normalizedProvider === "google") {
    return normalizeString(resolvedConfig.googleApiKey);
  }
  return "";
}

function sanitizeExcerpt(text) {
  return String(text || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function cloneJsonCompatible(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value === "string") {
    return normalizeString(value) || null;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function extractJsonPayload(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    return null;
  }

  const candidates = [];
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    candidates.push(fencedMatch[1].trim());
  }
  candidates.push(text);

  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(text.slice(objectStart, objectEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        return { findings: parsed };
      }
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function normalizeSeverity(value) {
  const normalized = normalizeString(value).toUpperCase();
  if (AI_SEVERITIES.has(normalized)) {
    return normalized;
  }
  return "P2";
}

function normalizeLine(value) {
  const normalized = Number(value || 1);
  if (!Number.isFinite(normalized) || normalized < 1) {
    return 1;
  }
  return Math.floor(normalized);
}

function normalizeConfidence(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return null;
  }
  return Math.max(0, Math.min(1, normalized));
}

function normalizeTrafficLight(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (["green", "yellow", "red"].includes(normalized)) {
    return normalized;
  }
  return "";
}

function normalizeAiFinding(rawFinding, index) {
  if (!rawFinding || typeof rawFinding !== "object" || Array.isArray(rawFinding)) {
    return null;
  }

  const message = normalizeString(rawFinding.title || rawFinding.message);
  const evidence = normalizeString(rawFinding.evidence || rawFinding.excerpt);
  const rootCause = normalizeString(rawFinding.rootCause || rawFinding.root_cause || rawFinding.rationale);
  const recommendedFix = normalizeString(
    rawFinding.recommendedFix || rawFinding.recommended_fix || rawFinding.suggestedFix
  );
  const rationale = normalizeString(rawFinding.rationale || rootCause || evidence || rawFinding.excerpt);
  const suggestedFix = normalizeString(rawFinding.suggestedFix || recommendedFix);
  const lensEvidence = cloneJsonCompatible(rawFinding.lensEvidence || rawFinding.lens_evidence);
  const reproduction = cloneJsonCompatible(rawFinding.reproduction);
  const userImpact = normalizeString(rawFinding.userImpact || rawFinding.user_impact);
  const trafficLight = normalizeTrafficLight(rawFinding.trafficLight || rawFinding.traffic_light);

  return {
    severity: normalizeSeverity(rawFinding.severity),
    file: normalizeString(rawFinding.file) || "unknown",
    line: normalizeLine(rawFinding.line),
    message: message || `AI finding ${index + 1}`,
    rationale: rationale || "AI reviewer flagged a potential issue requiring validation.",
    suggestedFix: suggestedFix || "Review and remediate this finding.",
    evidence,
    lensEvidence,
    reproduction,
    userImpact,
    trafficLight,
    rootCause,
    recommendedFix: recommendedFix || suggestedFix || "Review and remediate this finding.",
    confidence: normalizeConfidence(rawFinding.confidence),
  };
}

function summarizeFindings(findings = []) {
  const summary = {
    P0: 0,
    P1: 0,
    P2: 0,
    P3: 0,
  };
  for (const finding of findings) {
    const severity = normalizeSeverity(finding.severity);
    summary[severity] += 1;
  }
  return {
    ...summary,
    blocking: summary.P0 > 0 || summary.P1 > 0,
  };
}

// Normalization remains permissive for legacy reports. Completion requires a
// structured review, so error envelopes and invented defaults cannot prove it.
function validateReviewResponse(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  let parsed;
  try {
    parsed = JSON.parse(fenced ? fenced[1] : raw);
  } catch {
    return { valid: false, reason: "unstructured_response" };
  }
  if (Array.isArray(parsed)) parsed = { findings: parsed };
  if (!parsed || typeof parsed !== "object") return { valid: false, reason: "invalid_review_envelope" };
  const hasError = (value) => value !== undefined && value !== null && value !== false && value !== "" &&
    !(Array.isArray(value) && value.length === 0);
  const invalidStatus = Object.hasOwn(parsed, "status") &&
    (typeof parsed.status !== "string" || !["ok", "success", "complete", "completed", "passed"].includes(parsed.status.trim().toLowerCase()));
  if (hasError(parsed.error) || hasError(parsed.errors) || hasError(parsed.refusal) || invalidStatus ||
      parsed.ok === false || parsed.success === false || parsed.complete === false) {
    return { valid: false, reason: "error_response" };
  }
  if (!Array.isArray(parsed.findings)) return { valid: false, reason: "missing_or_invalid_findings" };
  const malformed = parsed.findings.some((finding) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) return true;
    const message = finding.title || finding.message;
    const line = typeof finding.line === "string" && /^\d+$/.test(finding.line) ? Number(finding.line) : finding.line;
    return typeof message !== "string" || !message.trim() ||
      typeof finding.file !== "string" || !finding.file.trim() ||
      typeof finding.severity !== "string" || !AI_SEVERITIES.has(finding.severity.trim().toUpperCase()) ||
      !Number.isSafeInteger(line) || line < 1 ||
      (finding.confidence !== undefined && finding.confidence !== null &&
        (typeof finding.confidence !== "number" || !Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1));
  });
  return { valid: !malformed, reason: malformed ? "malformed_findings" : "structured_review" };
}

export function parseAiReviewResponse({ text, maxFindings = DEFAULT_AI_MAX_FINDINGS } = {}) {
  const parsed = extractJsonPayload(text);
  const reviewValidity = validateReviewResponse(text);
  const normalizedMaxFindings = Math.max(1, Math.floor(Number(maxFindings || DEFAULT_AI_MAX_FINDINGS)));

  if (!parsed) {
    return {
      parser: "fallback_text",
      reviewValidity,
      summary:
        sanitizeExcerpt(text) || "AI response could not be parsed as JSON; no structured findings extracted.",
      findings: [],
    };
  }

  const summary = normalizeString(
    parsed.summary?.highLevel || parsed.summary?.risk || parsed.summary?.text || parsed.summary
  );
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings = [];
  for (let index = 0; index < rawFindings.length; index += 1) {
    if (findings.length >= normalizedMaxFindings) {
      break;
    }
    const normalized = normalizeAiFinding(rawFindings[index], index);
    if (normalized) {
      findings.push(normalized);
    }
  }

  return {
    parser: "json",
    reviewValidity,
    summary: summary || "Structured AI response parsed successfully.",
    findings,
  };
}

function formatDeterministicFindingLine(finding) {
  return `- [${finding.severity}] ${finding.file}:${finding.line} ${finding.message}`;
}

function buildScopedFileSummary(scopedFiles = [], maxItems = 200) {
  const normalized = Array.isArray(scopedFiles) ? scopedFiles : [];
  const visible = normalized.slice(0, maxItems);
  const omitted = Math.max(0, normalized.length - visible.length);
  const lines = visible.map((item) => `- ${item}`);
  if (omitted > 0) {
    lines.push(`- ... ${omitted} more files omitted`);
  }
  return lines.join("\n") || "- none";
}

export function buildAiReviewPrompt({
  targetPath,
  mode,
  deterministicSummary,
  deterministicFindings = [],
  scopedFiles = [],
  specContext = null,
  systemPrompt = "",
  maxFindings = DEFAULT_AI_MAX_FINDINGS,
} = {}) {
  const normalizedSummary = deterministicSummary || { P0: 0, P1: 0, P2: 0, P3: 0 };
  const findingLines = deterministicFindings
    .slice(0, 120)
    .map((finding) => formatDeterministicFindingLine(finding))
    .join("\n");
  const normalizedMaxFindings = Math.max(1, Math.floor(Number(maxFindings || DEFAULT_AI_MAX_FINDINGS)));
  const specPath = normalizeString(specContext?.specPath) || "none";
  const specHash = normalizeString(specContext?.specHashSha256) || "unknown";
  const specEndpointCount = Number(specContext?.endpointCount || 0);
  const specAcceptanceCriteriaCount = Number(specContext?.acceptanceCriteriaCount || 0);
  const specPreview = Array.isArray(specContext?.endpointsPreview) ? specContext.endpointsPreview : [];

  const basePrompt = [
    "You are Sentinelayer Omar reviewer layer 9.3.",
    "Review the deterministic findings and scoped files. Add ONLY materially new findings.",
    "Do not repeat deterministic findings unless you add new exploitability rationale.",
    "Output STRICT JSON only. Do not wrap in markdown.",
    "",
    "JSON schema:",
    "{",
    '  "summary": {"risk": "low|medium|high|critical", "highLevel": "short summary"},',
    '  "findings": [',
    "    {",
    '      "severity": "P0|P1|P2|P3",',
    '      "file": "relative/path",',
    '      "line": 1,',
    '      "title": "finding title",',
    '      "evidence": "concrete code excerpt or static trace evidence",',
    '      "lensEvidence": {"A": "passed|failed|not_applicable: short evidence"},',
    '      "reproduction": {"type": "static_trace|manual_step|shell|runtime_probe", "steps": ["step 1"]},',
    '      "user_impact": "operator/user/system impact",',
    '      "trafficLight": "green|yellow|red",',
    '      "rootCause": "why this exists",',
    '      "recommendedFix": "specific remediation",',
    '      "rationale": "why this matters",',
    '      "suggestedFix": "specific remediation",',
    '      "confidence": 0.0',
    "    }",
    "  ]",
    "}",
    "",
    `Maximum findings: ${normalizedMaxFindings}`,
    "",
    `Target path: ${targetPath}`,
    `Review mode: ${mode}`,
    `Deterministic summary: P0=${normalizedSummary.P0} P1=${normalizedSummary.P1} P2=${normalizedSummary.P2} P3=${normalizedSummary.P3}`,
    `Spec path: ${specPath}`,
    `Spec sha256: ${specHash}`,
    `Spec endpoints declared: ${specEndpointCount}`,
    `Spec acceptance criteria count: ${specAcceptanceCriteriaCount}`,
    `Spec endpoint preview: ${specPreview.length > 0 ? specPreview.join(", ") : "none"}`,
    "",
    "Scoped files:",
    buildScopedFileSummary(scopedFiles),
    "",
    "Deterministic findings:",
    findingLines || "- none",
  ].join("\n");

  const promptPrelude = normalizeString(systemPrompt);
  if (!promptPrelude) {
    return basePrompt;
  }
  return [
    promptPrelude,
    "",
    "---",
    "",
    basePrompt,
  ].join("\n");
}

function maybeEstimateModelCost({ modelId, inputTokens, outputTokens }) {
  const priced = computeProviderCost({
    model: modelId,
    inputTokens,
    outputTokens,
  });
  return {
    costUsd: priced.providerCostUsd ?? 0,
    providerCostUsd: priced.providerCostUsd,
    pricingFound: !priced.unpriced,
    priceBookVersion: priced.priceBookVersion,
    canonicalModel: priced.canonicalModel,
  };
}

function stableConfigHash(value = {}) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function composeAiReviewMarkdown({
  generatedAt,
  runId,
  mode,
  parser,
  reviewValidity,
  summary,
  provider,
  model,
  dryRun,
  findings = [],
  usage,
  severityClassification = null,
  combinedSummary,
} = {}) {
  const findingLines =
    findings.length > 0
      ? findings
          .map(
            (finding, index) =>
              `${index + 1}. [${finding.severity}] ${finding.file}:${finding.line} ${finding.message}\n` +
              `   rationale: ${finding.rationale}\n` +
              (finding.evidence ? `   evidence: ${finding.evidence}\n` : "") +
              (finding.userImpact ? `   user_impact: ${finding.userImpact}\n` : "") +
              (finding.trafficLight ? `   traffic_light: ${finding.trafficLight}\n` : "") +
              `   suggested_fix: ${finding.suggestedFix}` +
              (finding.confidence === null ? "" : `\n   confidence: ${finding.confidence.toFixed(2)}`) +
              (finding.severityClassification ? `\n   severity_evaluation: ${finding.severityClassification.status} / ${finding.severityClassification.reason}; candidate=${finding.severityClassification.severity || "unverified"}; category=${finding.severityClassification.category || "unverified"}; authority=evaluation_only` : "")
          )
          .join("\n")
      : "- none";

  return [
    "# REVIEW_AI",
    "",
    `Generated: ${generatedAt}`,
    `Run ID: ${runId}`,
    `Mode: ${mode}`,
    `Provider: ${provider}`,
    `Model: ${model}`,
    `Dry run: ${dryRun ? "yes" : "no"}`,
    `Parser: ${parser}`,
    `Structured review: ${reviewValidity?.valid ? "valid" : "incomplete"} (${reviewValidity?.reason || "unknown"})`,
    "",
    ...(severityClassification ? [`TypeSafe classification evaluation: ${severityClassification.status} / ${severityClassification.reason}; schema validation only, original gate severities unchanged.`, `Classifier usage: ${severityClassification.usage ? JSON.stringify(severityClassification.usage) : "unknown/not submitted (not zero cost)"}; attempted=${severityClassification.attempted}`, ""] : []),
    "Summary:",
    `- ${summary || "No summary provided."}`,
    `- Combined findings: P0=${combinedSummary.P0} P1=${combinedSummary.P1} P2=${combinedSummary.P2} P3=${combinedSummary.P3}`,
    `- Blocking: ${combinedSummary.blocking ? "yes" : "no"}`,
    `- ${severityClassification ? "Generation usage" : "Usage"}: input_tokens=${usage.inputTokens} output_tokens=${usage.outputTokens} cost_usd=${usage.costUsd.toFixed(6)} duration_ms=${usage.durationMs}`,
    "",
    "AI Findings:",
    findingLines,
    "",
  ].join("\n");
}

function toReviewFinding(aiFinding, index) {
  const suggestedFix = aiFinding.suggestedFix || aiFinding.recommendedFix;
  return {
    severity: aiFinding.severity,
    file: aiFinding.file,
    line: aiFinding.line,
    message: aiFinding.message,
    excerpt: sanitizeExcerpt(aiFinding.evidence || aiFinding.rationale),
    ruleId: `SL-AI-${String(index + 1).padStart(3, "0")}`,
    suggestedFix,
    layer: "ai_reasoning",
    confidence: aiFinding.confidence,
    evidence: aiFinding.evidence,
    lensEvidence: aiFinding.lensEvidence,
    reproduction: aiFinding.reproduction,
    userImpact: aiFinding.userImpact,
    trafficLight: aiFinding.trafficLight,
    rootCause: aiFinding.rootCause,
    recommendedFix: aiFinding.recommendedFix || suggestedFix,
    rationale: aiFinding.rationale,
  };
}

function buildDryRunResponse({ deterministicSummary, maxFindings } = {}) {
  const findingCount = Math.max(1, Math.min(2, Math.floor(Number(maxFindings || 1))));
  const findings = [];
  for (let index = 0; index < findingCount; index += 1) {
    findings.push({
      severity: index === 0 ? "P2" : "P3",
      file: "src/example.js",
      line: 1 + index,
      title: `DRY_RUN finding ${index + 1}`,
      evidence: "const unsafe = exampleInput;",
      lensEvidence: {
        A: "not_applicable: no route/runtime boundary in dry-run fixture",
        J: "failed: synthetic path needs targeted verification before merge",
        K: "passed: no AI tool permission escalation in dry-run fixture",
      },
      reproduction: {
        type: "static_trace",
        steps: ["Inspect src/example.js", "Trace exampleInput into the synthetic finding path"],
      },
      user_impact: "Operator sees a synthetic risk used to validate OmarGate evidence plumbing.",
      trafficLight: index === 0 ? "yellow" : "green",
      rootCause: "DRY_RUN synthetic root cause for evidence-contract validation.",
      recommendedFix: "Validate this path with targeted remediation.",
      rationale: `Synthetic AI rationale with deterministic context P1=${deterministicSummary.P1}.`,
      suggestedFix: "Validate this path with targeted remediation.",
      confidence: index === 0 ? 0.72 : 0.54,
    });
  }
  return JSON.stringify(
    {
      summary: {
        risk: "medium",
        highLevel: "DRY_RUN_RESPONSE: synthetic AI review output.",
      },
      findings,
    },
    null,
    2
  );
}

export async function runAiReviewLayer({
  targetPath,
  mode,
  runId,
  runDirectory,
  deterministic,
  outputDir = "",
  provider,
  model,
  apiKey,
  sessionId,
  maxFindings = DEFAULT_AI_MAX_FINDINGS,
  maxCostUsd = 1.0,
  maxOutputTokens = 0,
  maxRuntimeMs = 0,
  maxToolCalls = 0,
  maxNoProgress = 3,
  warningThresholdPercent = 80,
  systemPrompt = "",
  dryRun = false,
  severityClassifier = "off",
  requireUsageLedger = false,
  usageRecorder = recordSessionUsage,
  sourceCommand = "review",
  billingAgentId = "audit-orchestrator",
  billingAction = "audit_run",
  billingTier = "internal",
  billingMetadata = {},
  usageFailureLabel = "Review AI",
  env = process.env,
} = {}) {
  normalizeSeverityClassifier(severityClassifier);
  if (severityClassifier === "typesafe") maxCostUsd = parseSeverityEvaluationMaxCost(maxCostUsd, 1);
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const normalizedRunDirectory = path.resolve(String(runDirectory || "."));
  const normalizedMode = normalizeString(mode) || "full";
  const normalizedMaxFindings = Math.max(
    1,
    Math.floor(Number(maxFindings || DEFAULT_AI_MAX_FINDINGS))
  );
  const normalizedRunId = normalizeString(runId) || "review-ai";
  const normalizedRequireUsageLedger = Boolean(requireUsageLedger);
  const normalizedSourceCommand = normalizeString(sourceCommand) || "review";
  const normalizedBillingAgentId = normalizeString(billingAgentId) || "audit-orchestrator";
  const normalizedBillingAction = normalizeString(billingAction) || "audit_run";
  const normalizedBillingTier = normalizeString(billingTier) || "internal";
  const normalizedBillingMetadata = sanitizeBillingMetadata(billingMetadata);
  const normalizedUsageFailureLabel = normalizeString(usageFailureLabel) || "Review AI";

  const config = await loadConfig({ cwd: normalizedTargetPath, env });
  let resolvedProvider = resolveProvider({
    provider,
    configProvider: config.resolved.defaultModelProvider,
    env,
  });
  // If no explicit provider and default fell through to openai,
  // check for stored sentinelayer session (async fallback)
  if (resolvedProvider === "openai" && !provider && !config.resolved.defaultModelProvider) {
    try {
      const { resolveProviderAsync } = await import("../ai/client.js");
      resolvedProvider = await resolveProviderAsync({ env });
    } catch {
      // keep sync result
    }
  }
  const resolvedModel = resolveModel({
    provider: resolvedProvider,
    model,
    configModel: config.resolved.defaultModelId || DEFAULT_REVIEW_AI_MODEL,
  });
  const explicitApiKey = normalizeString(apiKey);
  const configuredApiKey = resolveConfiguredApiKey(resolvedProvider, userConfigValues(config));

  const prompt = buildAiReviewPrompt({
    targetPath: normalizedTargetPath,
    mode: normalizedMode,
    deterministicSummary: deterministic?.summary,
    deterministicFindings: deterministic?.findings || [],
    scopedFiles: deterministic?.scope?.scannedRelativeFiles || [],
    specContext: deterministic?.layers?.specBinding || null,
    systemPrompt,
    maxFindings: normalizedMaxFindings,
  });

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const responseText = dryRun
    ? buildDryRunResponse({
        deterministicSummary: deterministic?.summary || {},
        maxFindings: normalizedMaxFindings,
      })
    : (
        await createMultiProviderApiClient().invoke({
          provider: resolvedProvider,
          model: resolvedModel,
          prompt,
          apiKey: explicitApiKey || configuredApiKey,
          env,
          stream: false,
        })
      ).text;
  const durationMs = Math.max(0, Date.now() - startedAt);

  const parsed = parseAiReviewResponse({
    text: responseText,
    maxFindings: normalizedMaxFindings,
  });
  const aiFindings = parsed.findings.map((finding, index) => toReviewFinding(finding, index));
  const aiSummary = summarizeFindings(aiFindings);
  const deterministicSummary = deterministic?.summary || { P0: 0, P1: 0, P2: 0, P3: 0 };
  const combinedSummary = {
    P0: deterministicSummary.P0 + aiSummary.P0,
    P1: deterministicSummary.P1 + aiSummary.P1,
    P2: deterministicSummary.P2 + aiSummary.P2,
    P3: deterministicSummary.P3 + aiSummary.P3,
  };
  combinedSummary.blocking = combinedSummary.P0 > 0 || combinedSummary.P1 > 0;

  const inputTokens = estimateTokens(prompt, { model: resolvedModel });
  const outputTokens = estimateTokens(responseText, { model: resolvedModel });
  const modelCost = maybeEstimateModelCost({
    modelId: resolvedModel,
    inputTokens,
    outputTokens,
  });
  const normalizedSessionId =
    normalizeString(sessionId) || `${normalizedRunId}-ai`;

  const appendedCost = await appendCostEntry(
    {
      targetPath: normalizedTargetPath,
      outputDirOverride: outputDir,
    },
    {
      sessionId: normalizedSessionId,
      provider: resolvedProvider,
      model: resolvedModel,
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs,
      toolCalls: 1,
      costUsd: modelCost.costUsd,
      progressScore: aiFindings.length > 0 ? 1 : 0,
    }
  );
  const costSummary = summarizeCostHistory(appendedCost.history);
  const sessionSummary = costSummary.sessions.find((entry) => entry.sessionId === normalizedSessionId) || {
    sessionId: normalizedSessionId,
    invocationCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 0,
    toolCalls: 0,
    costUsd: 0,
    noProgressStreak: 0,
  };

  let budget = evaluateBudget({
    sessionSummary,
    maxCostUsd: parseNonNegativeNumber(maxCostUsd, "maxCostUsd"),
    maxOutputTokens: parseNonNegativeNumber(maxOutputTokens, "maxOutputTokens"),
    maxNoProgress: parseNonNegativeNumber(maxNoProgress, "maxNoProgress"),
    maxRuntimeMs: parseNonNegativeNumber(maxRuntimeMs, "maxRuntimeMs"),
    maxToolCalls: parseNonNegativeNumber(maxToolCalls, "maxToolCalls"),
    warningThresholdPercent: parsePercent(warningThresholdPercent, "warningThresholdPercent"),
  });

  const usageTelemetry = await appendRunEvent(
    {
      targetPath: normalizedTargetPath,
      outputDirOverride: outputDir,
    },
    {
      sessionId: normalizedSessionId,
      runId: normalizedRunId,
      eventType: "usage",
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: modelCost.costUsd,
        durationMs,
        toolCalls: 1,
      },
      metadata: {
        sourceCommand: normalizedSourceCommand,
        layer: "ai_reasoning",
        provider: resolvedProvider,
        model: resolvedModel,
        invocationId: appendedCost.entry.invocationId,
        dryRun: Boolean(dryRun),
      },
    }
  );

  let sessionUsageLedger = null;
  try {
    const billingRunId = buildBillingRunId({
      sessionId: normalizedSessionId,
      invocationTimestamp: startedAtIso,
      configHash: stableConfigHash({
        sourceCommand: normalizedSourceCommand,
        layer: "ai_reasoning",
        provider: resolvedProvider,
        model: resolvedModel,
        mode: normalizedMode,
        runId: normalizedRunId,
        dryRun: Boolean(dryRun),
        billingAgentId: normalizedBillingAgentId,
        billingAction: normalizedBillingAction,
      }),
    });
    sessionUsageLedger = await usageRecorder(
      normalizedSessionId,
      {
        agentId: normalizedBillingAgentId,
        action: normalizedBillingAction,
        model: resolvedModel,
        inputTokens,
        outputTokens,
        idempotencyKey: buildCallIdempotencyKey({ runId: billingRunId, callIndex: 0 }),
        billingTier: normalizedBillingTier,
        createdAt: startedAtIso,
        metadata: {
          ...normalizedBillingMetadata,
          sourceCommand: normalizedSourceCommand,
          layer: "ai_reasoning",
          provider: resolvedProvider,
          mode: normalizedMode,
          runId: normalizedRunId,
          dryRun: Boolean(dryRun),
          pricingFound: modelCost.pricingFound,
        },
      },
      {
        targetPath: normalizedTargetPath,
      },
    );
  } catch (error) {
    sessionUsageLedger = {
      ok: false,
      reason: error instanceof Error ? error.message : String(error || "session_usage_failed"),
    };
    if (normalizedRequireUsageLedger) {
      throw new Error(
        `${normalizedUsageFailureLabel} usage ledger recording failed: ${sessionUsageLedger.reason || "unknown"}.`
      );
    }
  }

  let severityClassification = null;
  if (severityClassifier === "typesafe") {
    const historyOptions = { targetPath: normalizedTargetPath, outputDirOverride: outputDir };
    severityClassification = await withSeverityEvaluationQueue(`${appendedCost.filePath}:${normalizedSessionId}`, async () => {
      let reservation = false; const attemptId = crypto.randomUUID();
      const event = (phase, metadata) => appendRunEvent(historyOptions, {
        sessionId: normalizedSessionId, runId: normalizedRunId,
        eventType: phase === "reserved" ? "tool_call" : "run_step",
        metadata: { layer: "severity_classification_evaluation", version: 1, attemptId, phase, costKnown: false, outputTokensKnown: false, ...metadata },
      });
      let classifierBudget = budget;
      try {
        const [{ events }, current] = await Promise.all([loadRunEvents(historyOptions), loadCostHistory(historyOptions)]);
        const baseline = summarizeCostHistory(current.history).sessions.find((r) => r.sessionId === normalizedSessionId) || sessionSummary;
        const extra = severityResourceTotals(events, normalizedSessionId);
        classifierBudget = evaluateBudget({ ...budget.limits, sessionSummary: { ...baseline, toolCalls: baseline.toolCalls + extra.toolCalls, durationMs: baseline.durationMs + extra.durationMs } });
        if (extra.unknownRuntime && budget.limits.maxRuntimeMs > 0) return { version: 1, mode: "typesafe", authority: "evaluation_only", verification: "response_schema_only", status: "unverified", reason: "prior_runtime_unknown", requestedModel: TYPESAFE_SEVERITY_MODEL, dictionaryVersion: SEVERITY_DICTIONARY_VERSION, attempted: false, durationMs: 0, usage: null, findings: parsed.findings.map(() => ({ status: "unverified", reason: "prior_runtime_unknown", severity: null, category: null })) };
      } catch {
        return { version: 1, mode: "typesafe", authority: "evaluation_only", status: "unverified", reason: "accounting_unavailable", requestedModel: TYPESAFE_SEVERITY_MODEL, dictionaryVersion: SEVERITY_DICTIONARY_VERSION, attempted: false, durationMs: 0, usage: null, findings: parsed.findings.map(() => ({ status: "unverified", reason: "accounting_unavailable", severity: null, category: null })) };
      }
      let evaluated = await evaluateSeverityClassification({
        mode: severityClassifier, findings: parsed.findings, env, dryRun,
        requireUsageLedger: normalizedRequireUsageLedger, budget: classifierBudget,
        beforeRequest: async () => { await event("reserved", { reservedRequests: 1 }); reservation = true; },
      });
      if (reservation) {
        try { await event("completed", { actualRequests: evaluated.attempted ? 1 : 0, durationMs: evaluated.durationMs, status: evaluated.status, reason: evaluated.reason, costKnown: false, outputTokensKnown: Boolean(evaluated.usage), reportedUsage: evaluated.usage }); }
        catch { evaluated = { ...evaluated, status: "unverified", reason: "accounting_unavailable" }; }
      }
      const resourcesAfter = evaluateBudget({ ...classifierBudget.limits, sessionSummary: {
        costUsd: classifierBudget.usage.costUsd + (evaluated.usage?.listPriceEstimateUsd || 0),
        outputTokens: classifierBudget.usage.outputTokens + (evaluated.usage?.outputTokens || 0),
        durationMs: classifierBudget.usage.runtimeMs + (reservation ? evaluated.durationMs : 0),
        toolCalls: classifierBudget.usage.toolCalls + (reservation ? 1 : 0),
        noProgressStreak: classifierBudget.usage.noProgressStreak,
      } });
      if (evaluated.attempted && !evaluated.usage) resourcesAfter.classificationUsageUnknown = true;
      return { ...evaluated, resourceAccounting: { reservedRequests: reservation ? 1 : 0, actualRequests: evaluated.attempted ? 1 : 0, durationMs: evaluated.durationMs, budgetAfter: resourcesAfter } };
    });
    if (severityClassification.resourceAccounting?.budgetAfter) budget = severityClassification.resourceAccounting.budgetAfter;
    aiFindings.forEach((finding, index) => {
      finding.severityClassification = { ...severityClassification.findings[index], authority: "evaluation_only", dictionaryVersion: severityClassification.dictionaryVersion, model: severityClassification.requestedModel };
    });
  }

  let stopTelemetry = null;
  if (budget.blocking) {
    stopTelemetry = await appendRunEvent(
      {
        targetPath: normalizedTargetPath,
        outputDirOverride: outputDir,
      },
      {
        sessionId: normalizedSessionId,
        runId: normalizedRunId,
        eventType: "run_stop",
        usage: {
          inputTokens: sessionSummary.inputTokens,
          outputTokens: sessionSummary.outputTokens,
          cacheReadTokens: sessionSummary.cacheReadTokens,
          cacheWriteTokens: sessionSummary.cacheWriteTokens,
          costUsd: sessionSummary.costUsd,
          durationMs: sessionSummary.durationMs,
          toolCalls: sessionSummary.toolCalls,
        },
        stop: {
          stopClass: deriveStopClassFromBudget(budget),
          blocking: true,
          reasonCodes: budget.reasons.map((reason) => reason.code),
        },
        metadata: {
          sourceCommand: normalizedSourceCommand,
          layer: "ai_reasoning",
          provider: resolvedProvider,
          model: resolvedModel,
          invocationId: appendedCost.entry.invocationId,
          dryRun: Boolean(dryRun),
        },
      }
    );
  }

  await fsp.mkdir(normalizedRunDirectory, { recursive: true });
  const promptPath = path.join(normalizedRunDirectory, "REVIEW_AI_PROMPT.txt");
  const reportMarkdownPath = path.join(normalizedRunDirectory, "REVIEW_AI.md");
  const reportJsonPath = path.join(normalizedRunDirectory, "REVIEW_AI.json");
  const generatedAt = new Date().toISOString();
  const usage = {
    inputTokens,
    outputTokens,
    costUsd: modelCost.costUsd,
    durationMs,
    toolCalls: 1,
  };
  const reportPayload = {
    schemaVersion: "1.0.0",
    generatedAt,
    runId: normalizedRunId,
    mode: normalizedMode,
    parser: parsed.parser,
    reviewValidity: parsed.reviewValidity,
    summary: parsed.summary,
    provider: resolvedProvider,
    model: resolvedModel,
    dryRun: Boolean(dryRun),
    requireUsageLedger: normalizedRequireUsageLedger,
    usage,
    pricingFound: modelCost.pricingFound,
    sessionUsageLedger,
    budget,
    deterministicSummary,
    aiSummary,
    combinedSummary,
    findings: aiFindings,
    ...(severityClassification ? { severityClassification } : {}),
  };

  const reportMarkdown = composeAiReviewMarkdown({
    generatedAt,
    runId: normalizedRunId,
    mode: normalizedMode,
    parser: parsed.parser,
    reviewValidity: parsed.reviewValidity,
    summary: parsed.summary,
    provider: resolvedProvider,
    model: resolvedModel,
    dryRun: Boolean(dryRun),
    findings: aiFindings,
    usage,
    severityClassification,
    combinedSummary,
  });

  await fsp.writeFile(promptPath, `${prompt}\n`, "utf-8");
  await fsp.writeFile(reportMarkdownPath, `${reportMarkdown.trim()}\n`, "utf-8");
  await fsp.writeFile(reportJsonPath, `${JSON.stringify(reportPayload, null, 2)}\n`, "utf-8");

  return {
    parser: parsed.parser,
    reviewValidity: parsed.reviewValidity,
    summary: parsed.summary,
    ...(severityClassification ? { severityClassification } : {}),
    findings: aiFindings,
    aiSummary,
    combinedSummary,
    provider: resolvedProvider,
    model: resolvedModel,
    dryRun: Boolean(dryRun),
    usage,
    pricingFound: modelCost.pricingFound,
    budget,
    artifacts: {
      promptPath,
      reportMarkdownPath,
      reportJsonPath,
    },
    cost: {
      filePath: appendedCost.filePath,
      invocationId: appendedCost.entry.invocationId,
      sessionId: normalizedSessionId,
    },
    telemetry: {
      filePath: usageTelemetry.filePath,
      usageEventId: usageTelemetry.event.eventId,
      stopEventId: stopTelemetry?.event?.eventId || null,
    },
    billing: sessionUsageLedger,
  };
}

