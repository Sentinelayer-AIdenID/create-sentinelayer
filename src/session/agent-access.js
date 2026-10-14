import process from "node:process";

import { checkedTransport, credentialFor, isAuthenticated } from "../auth/credential-destinations.js";
import { requestJson, requestJsonMutation } from "../auth/http.js";
import { resolveActiveAuthSession } from "../auth/service.js";
import { urlPathSegment } from "../net/url-path.js";
import { readAdmissionCredentialState } from "./admission.js";
import { assertCanonicalAgentId, currentAdmittedAgent } from "./admission-auth.js";

const GRANT_ROLES = new Set(["auditor", "coder", "coordinator", "observer", "orchestrator", "reviewer"]);
const MAX_GRANT_PAGES = 20;
const PAGE_LIMIT = 100;

function refused(code, reason, status = null) {
  return { ok: false, code, reason, status, source: "legacy_grant_presence" };
}

/** A stored admission is never permission to enter the human-account legacy path. */
export async function legacyJoinAdmissionRefusal(sessionId, agentId, {
  homeDir,
  readAdmissionState = readAdmissionCredentialState,
} = {}) {
  if (currentAdmittedAgent()) return refused("ADMISSION_CREDENTIAL_REFUSED", "admitted_context");
  let held;
  try {
    held = await readAdmissionState(sessionId, agentId, { homeDir });
  } catch {
    return refused("ADMISSION_CREDENTIAL_REFUSED", "admission_lookup_unavailable");
  }
  if (held?.state === "none") return null;
  return held?.state === "live"
    ? refused("ADMISSION_REQUIRED", "stored_admission_requires_scoped_join")
    : refused("ADMISSION_CREDENTIAL_REFUSED", held?.reason || "admission_lookup_unavailable");
}

/**
 * Verify an existing account-bound legacy grant and its room-scoped presence.
 * Never POST /agent-grants: GET lists active grants only, whereas POST reactivates
 * revoked grants. Absence therefore cannot safely authorize an automatic grant.
 * No transcript event, email or cryptographic identity is minted here.
 */
export async function verifyLegacyAgentJoin(sessionId, {
  agentId,
  role = "coder",
  model = "cli",
  targetPath = process.cwd(),
  homeDir,
  remoteSession = {},
  timeoutMs = 10_000,
  now = () => Date.now(),
  readAdmissionState = readAdmissionCredentialState,
  resolveAuthSession = resolveActiveAuthSession,
  requestRead = requestJson,
  requestMutation = requestJsonMutation,
} = {}) {
  const sid = String(sessionId || "").trim();
  const agent = String(agentId || "").trim().toLowerCase();
  const requestedRole = String(role || "").trim().toLowerCase();
  try {
    assertCanonicalAgentId(agent, "legacy join agent");
    if (!sid || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agent) || agent.startsWith("human-") || ["cli-user", "unknown"].includes(agent)) {
      return refused("LEGACY_AGENT_ID_INVALID", "ungrantable_agent");
    }
    if (!GRANT_ROLES.has(requestedRole)) return refused("LEGACY_GRANT_ROLE_MISMATCH", "unsupported_role");
    if (remoteSession.agentAdmissionMode && remoteSession.agentAdmissionMode !== "legacy") {
      return refused("ADMISSION_REQUIRED", "room_requires_admission");
    }
    const admissionOptions = { homeDir, readAdmissionState };
    let refusal = await legacyJoinAdmissionRefusal(sid, agent, admissionOptions);
    if (refusal) return refusal;
    const auth = await resolveAuthSession({ cwd: targetPath, env: process.env, homeDir, autoRotate: false });
    if (!isAuthenticated(auth)) return refused("AUTH_REQUIRED", "not_authenticated", 401);
    if (auth.source === "session_admission") return refused("ADMISSION_CREDENTIAL_REFUSED", "admitted_context");
    const credential = await credentialFor(auth);
    const apiUrl = String(auth.apiUrl || "").replace(/\/+$/, "");
    const deadline = now() + Math.max(1, Math.min(Number(timeoutMs) || 10_000, 30_000));
    const remaining = () => Math.max(0, deadline - now());
    let after = "";
    let grant;
    for (let page = 0; page < MAX_GRANT_PAGES; page += 1) {
      refusal = await legacyJoinAdmissionRefusal(sid, agent, admissionOptions);
      if (refusal) return refusal;
      if (!remaining()) return refused("LEGACY_GRANT_UNAVAILABLE", "verification_timeout");
      const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (after) query.set("after", after);
      const result = await checkedTransport(requestRead)(`${apiUrl}/api/v1/sessions/agent-grants?${query}`, {
        method: "GET", credential, timeoutMs: remaining(), maxRetries: 0,
      });
      if (!Array.isArray(result?.grants) || result.grants.length > PAGE_LIMIT) {
        return refused("LEGACY_GRANT_CONTRACT_MISMATCH", "invalid_grant_page");
      }
      const matches = result.grants.filter((item) => item?.agentId === agent);
      if (matches.length > 1) return refused("LEGACY_GRANT_CONTRACT_MISMATCH", "duplicate_grant_identity");
      if (matches.length) { grant = matches[0]; break; }
      if (result.nextAfter === null) return refused("LEGACY_GRANT_NOT_ACTIVE", "missing_or_revoked");
      const next = result.nextAfter;
      if (typeof next !== "string" || !next || next <= after || !result.grants.some((item) => item?.agentId === next)) {
        return refused("LEGACY_GRANT_CONTRACT_MISMATCH", "invalid_grant_cursor");
      }
      after = next;
    }
    if (!grant) return refused("LEGACY_GRANT_UNAVAILABLE", "grant_page_limit");
    if (grant.exists === false || grant.revoked === true || grant.revokedAt != null) {
      return refused("LEGACY_GRANT_NOT_ACTIVE", "missing_or_revoked");
    }
    if (grant.exists !== true || grant.revoked !== false || grant.revokedAt !== null || typeof grant.id !== "string" || !grant.id) {
      return refused("LEGACY_GRANT_CONTRACT_MISMATCH", "invalid_grant_confirmation");
    }
    if (grant.role !== requestedRole) return refused("LEGACY_GRANT_ROLE_MISMATCH", "requested_role_not_granted");
    refusal = await legacyJoinAdmissionRefusal(sid, agent, admissionOptions);
    if (refusal) return refusal;
    if (!remaining()) return refused("LEGACY_PRESENCE_UNAVAILABLE", "verification_timeout");
    const presence = await checkedTransport(requestMutation)(
      `${apiUrl}/api/v1/sessions/${urlPathSegment(sid, { label: "sessionId" })}/presence`, {
        method: "PUT", operationName: "session.legacy_join_presence", credential,
        timeoutMs: remaining(), maxRetries: 0,
        body: { agentId: agent, state: "idle", model, clientKind: "cli", observedAt: new Date(now()).toISOString() },
      },
    );
    if (presence?.agentId !== agent) return refused("LEGACY_PRESENCE_CONTRACT_MISMATCH", "presence_identity_mismatch");
    if (presence.status !== "ok" || presence.recorded !== true || !Number.isFinite(presence.ttlSeconds) || presence.ttlSeconds <= 0) {
      return refused("LEGACY_PRESENCE_UNAVAILABLE", "presence_not_recorded");
    }
    return {
      ok: true, source: "legacy_grant_presence",
      grant: { id: grant.id, agentId: grant.agentId, role: grant.role },
      presence: { recorded: true, agentId: agent, ttlSeconds: presence.ttlSeconds },
    };
  } catch (error) {
    const status = Number(error?.status) || null;
    const code = error?.code;
    if (code === "ADMISSION_REQUIRED" || code === "ADMISSION_SCOPE_DENIED") return refused(code, "admission_required_or_refused", status);
    if (status === 401) return refused("AUTH_REQUIRED", "credential_rejected", status);
    if (status === 403) return refused("LEGACY_AGENT_ACCESS_DENIED", "grant_or_membership_refused", status);
    return refused("LEGACY_AGENT_ACCESS_UNAVAILABLE", "verification_failed", status);
  }
}
