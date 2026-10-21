import { createHash } from "node:crypto";
import { RunAdmission, formatExposureUsd } from "../cost/run-admission.js";
import { loadConfig, userConfigValues } from "../config/service.js";
import { resolveProvider, resolveProviderAsync, resolveModel, resolveApiKey } from "./client.js";

// Reviewed public standard/global rates. Expiry refuses new sends; it is not a provider quote.
export const EXPOSURE_POLICY_VERSION = "2026-10-21-v2";
const POLICY_START = Date.parse("2026-10-21T00:00:00Z");
const POLICY_END = Date.parse("2026-10-28T00:00:00Z");
const POLICIES = Object.freeze({
  "openai:gpt-5.3-codex": Object.freeze({
    provider: "openai", model: "gpt-5.3-codex", endpoint: "https://api.openai.com/v1/responses",
    tier: "default", maxInput: 400000, maxOutput: 4096, inputNanos: 1750, outputNanos: 14000,
    source: "https://developers.openai.com/api/docs/pricing",
    limitsSource: "https://developers.openai.com/api/docs/models/gpt-5.3-codex",
  }),
  "anthropic:claude-sonnet-4-6": Object.freeze({
    provider: "anthropic", model: "claude-sonnet-4-6", endpoint: "https://api.anthropic.com/v1/messages",
    tier: "standard", maxInput: 1000000, maxOutput: 2048, inputNanos: 3000, outputNanos: 15000,
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
    limitsSource: "https://platform.claude.com/docs/en/build-with-claude/context-windows",
    inferenceGeo: "global", speed: "standard",
  }),
});
export function exposurePolicy(provider, model, now = Date.now()) {
  if (!Number.isFinite(now) || now < POLICY_START || now >= POLICY_END) throw new Error("cost_bound_unavailable: exposure rate policy expired or not yet valid");
  const policy = POLICIES[`${provider}:${model}`];
  if (!policy) throw new Error("cost_bound_unavailable: unsupported exact provider/model route");
  return policy;
}
class ProviderEvidenceError extends Error {
  constructor(reason, evidence = {}) { super(reason); this.evidence = evidence; }
}
// Provider objects and text never enter failure artifacts. Retain only recognized numeric counters.
function safeUsage(usage) {
  const result = {};
  for (const name of ["input_tokens", "output_tokens", "total_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
    if (Number.isSafeInteger(usage?.[name]) && usage[name] >= 0) result[name] = usage[name];
  }
  for (const [container, fields] of [["input_tokens_details", ["cached_tokens", "cache_write_tokens"]], ["output_tokens_details", ["reasoning_tokens"]]]) {
    for (const name of fields) {
      const value = usage?.[container]?.[name];
      if (Number.isSafeInteger(value) && value >= 0) (result[container] ||= {})[name] = value;
    }
  }
  return result;
}
function unpack(payload, policy) {
  const u = payload?.usage;
  const providerUsage = safeUsage(u);
  const fail = (reason, assuranceViolated = false, evidence = {}) => {
    throw new ProviderEvidenceError(reason, { providerUsage, assuranceViolated, ...evidence });
  };
  const tokens = value => {
    if (!Number.isSafeInteger(value) || value < 0) fail("invalid_provider_usage");
    return value;
  };
  if (!payload || payload.model !== policy.model) fail("provider_model_mismatch", true);
  if (!u || typeof u !== "object" || Array.isArray(u)) fail("missing_provider_usage");
  const input = tokens(u.input_tokens), output = tokens(u.output_tokens);
  let completed, text, finish;
  if (policy.provider === "openai") {
    if (payload.service_tier !== policy.tier) fail("provider_tier_mismatch", true);
    if ((u.input_tokens_details?.cache_write_tokens ?? 0) !== 0) fail("unsupported_cache_usage", true);
  } else {
    if (u.service_tier !== policy.tier) fail("provider_tier_mismatch", true);
    if (u.inference_geo !== policy.inferenceGeo || u.speed !== policy.speed) fail("provider_price_scope_mismatch", true);
    if (tokens(u.cache_read_input_tokens) !== 0 || tokens(u.cache_creation_input_tokens) !== 0 || u.server_tool_use && Object.values(u.server_tool_use).some(value => value !== 0)) fail("unsupported_cache_or_tool_usage", true);
  }
  // Conservatively account all input at the ordinary rate, including OpenAI cache hits.
  const charge = BigInt(input) * BigInt(policy.inputNanos) + BigInt(output) * BigInt(policy.outputNanos);
  if (input > policy.maxInput || output > policy.maxOutput) {
    const ceiling = BigInt(policy.maxInput) * BigInt(policy.inputNanos) + BigInt(policy.maxOutput) * BigInt(policy.outputNanos);
    fail("provider_bound_violation", true, {
      exceededCounters: [...(input > policy.maxInput ? ["input_tokens"] : []), ...(output > policy.maxOutput ? ["output_tokens"] : [])],
      observedPolicyCostUsd: formatExposureUsd(charge), observedExcessUsd: formatExposureUsd(charge > ceiling ? charge - ceiling : 0n),
    });
  }
  if (policy.provider === "openai") {
    if (tokens(u.total_tokens) !== input + output || tokens(u.input_tokens_details?.cached_tokens) > input) fail("invalid_provider_usage");
    if (u.output_tokens_details?.reasoning_tokens !== undefined && tokens(u.output_tokens_details.reasoning_tokens) > output) fail("invalid_provider_usage");
    const items = Array.isArray(payload.output) ? payload.output : [];
    if (items.some(item => !["message", "reasoning"].includes(item.type))) fail("unsupported_tool_or_output_usage", true);
    const refused = items.some(item => item.type === "message" && item.content?.some(part => part.type === "refusal"));
    const unexpected = items.some(item => item.type === "message" && item.status !== "completed");
    completed = payload.status === "completed" && !payload.error && !payload.incomplete_details && !refused && !unexpected;
    finish = completed ? "completed" : "incomplete";
    text = items.filter(item => item.type === "message").flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text || "").join("");
  } else {
    if (Array.isArray(payload.content) && payload.content.some(part => part.type !== "text")) fail("unsupported_tool_or_output_usage", true);
    completed = payload.stop_reason === "end_turn" && !payload.error && !payload.stop_details && Array.isArray(payload.content) && payload.content.every(part => part.type === "text");
    finish = completed ? "end_turn" : "incomplete";
    text = (payload.content || []).filter(part => part.type === "text").map(part => part.text || "").join("");
  }
  return { text, charge, completed, finish, usage: { inputTokens: input, outputTokens: output, costUsd: Number(charge) / 1e9 }, providerUsage };
}

export class BoundedReviewClient {
  #key; #policy; #controller; #fetch; #now;
  constructor({ provider, model, apiKey, maximumUsd, fetchImpl = globalThis.fetch, now = Date.now }) {
    this.#policy = exposurePolicy(provider, model, now());
    this.#controller = new RunAdmission(maximumUsd);
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("cost_bound_unavailable: direct provider credential missing");
    this.#key = apiKey; this.#fetch = fetchImpl; this.#now = now;
  }
  get provider() { return this.#policy.provider; }
  get model() { return this.#policy.model; }
  snapshot() {
    const policy = { ...this.#policy, version: EXPOSURE_POLICY_VERSION, validFrom: new Date(POLICY_START).toISOString(), expiresAt: new Date(POLICY_END).toISOString(), maxAttempts: 1, inputBound: "documented-full-context-ceiling" };
    return { ...this.#controller.snapshot(), tokenBasis: "provider_reported", costBasis: "pinned_rate_conservative_exposure", usageLedger: "local_only", policy, policySha256: createHash("sha256").update(JSON.stringify(policy)).digest("hex") };
  }
  async invoke(prompt) {
    const p = exposurePolicy(this.provider, this.model, this.#now());
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("invalid_bounded_review_prompt");
    const body = JSON.stringify(p.provider === "openai" ? {
      model: p.model, input: prompt, max_output_tokens: p.maxOutput, service_tier: "default",
      stream: false, store: false, tools: [], truncation: "disabled",
    } : {
      model: p.model, messages: [{ role: "user", content: prompt }], max_tokens: p.maxOutput,
      stream: false, service_tier: "standard_only", inference_geo: "global", thinking: { type: "disabled" },
    });
    const ceiling = BigInt(p.maxInput) * BigInt(p.inputNanos) + BigInt(p.maxOutput) * BigInt(p.outputNanos);
    const id = await this.#controller.reserve(ceiling, { requestSha256: createHash("sha256").update(body).digest("hex") });
    try {
      exposurePolicy(this.provider, this.model, this.#now());
      this.#controller.sent(id);
    } catch (error) { this.#controller.cancelBeforeSend(id); throw error; }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 120000);
    let response;
    try {
      response = await this.#fetch(p.endpoint, {
        method: "POST", redirect: "error", signal: timeout.signal,
        headers: p.provider === "openai" ? { "Content-Type": "application/json", Authorization: `Bearer ${this.#key}` } : { "Content-Type": "application/json", "x-api-key": this.#key, "anthropic-version": "2023-06-01" },
        body,
      });
      if (!response.ok) throw new ProviderEvidenceError("provider_http_failure");
      const parsed = unpack(await response.json(), p);
      this.#controller.settle(id, parsed.charge, { finish: parsed.finish, providerUsage: parsed.providerUsage });
      if (!parsed.completed) this.#controller.block("provider_response_incomplete");
      const exposure = this.snapshot();
      exposure.attempts = exposure.attempts.filter(attempt => attempt.id === id);
      return { ...parsed, charge: undefined, exposure, provider: p.provider, model: p.model };
    } catch (error) {
      // Never include provider-controlled error text or a credential in an artifact.
      const reason = error instanceof ProviderEvidenceError ? error.message : "provider_outcome_uncertain";
      this.#controller.uncertain(id, reason, error instanceof ProviderEvidenceError ? error.evidence : {});
      throw new Error(`${reason}: exposure retained; no retry`);
    } finally { clearTimeout(timer); }
  }
}

export async function prepareBoundedReview({ targetPath, provider, model, maximumUsd, severityClassifier = "off", dryRun = false, requireUsageLedger = false }) {
  if (severityClassifier !== "off" || dryRun) throw new Error("Model-token exposure mode requires live AI with severity classifier off.");
  if (requireUsageLedger) throw new Error("cost_bound_unavailable: bounded direct usage supports local exposure evidence only, not the remote billing ledger");
  const config = await loadConfig({ cwd: targetPath });
  let selected = resolveProvider({ provider, configProvider: config.resolved.defaultModelProvider });
  if (selected === "openai" && !provider && !config.resolved.defaultModelProvider) selected = await resolveProviderAsync();
  const selectedModel = resolveModel({ provider: selected, model, configModel: config.resolved.defaultModelId || "gpt-5.3-codex" });
  exposurePolicy(selected, selectedModel);
  const keys = userConfigValues(config);
  const apiKey = resolveApiKey({ provider: selected, explicitApiKey: keys[`${selected}ApiKey`] });
  return new BoundedReviewClient({ provider: selected, model: selectedModel, apiKey, maximumUsd });
}
