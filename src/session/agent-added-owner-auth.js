// Shared owner authentication for the explicit watcher and admission bootstrap.
import process from "node:process";

import { credentialFor, credentialHmac, isAuthenticated } from "../auth/credential-destinations.js";
import { resolveActiveAuthSession } from "../auth/service.js";
import { assertCanonicalAgentId, currentAdmittedAgent } from "./admission-auth.js";

export function exactWatcherAgent(value) {
  const agentId = String(value || "");
  assertCanonicalAgentId(agentId, "--agent");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agentId) || agentId.startsWith("human-") || ["cli-user", "unknown"].includes(agentId)) {
    throw new Error("--agent must be the exact granted agent id, in lowercase.");
  }
  return agentId;
}

export async function ownerWatcherAuth(agentId, { targetPath, resolveAuth = resolveActiveAuthSession } = {}) {
  if (currentAdmittedAgent()) throw new Error("The owner watcher cannot run inside a room admission. Start it yourself with your account sign-in.");
  const auth = await resolveAuth({ cwd: targetPath, env: process.env, autoRotate: false });
  if (!isAuthenticated(auth) || !["env", "config", "session"].includes(auth.source)) {
    throw new Error("The owner watcher requires your configured account sign-in.");
  }
  const credential = await credentialFor(auth);
  const apiUrl = String(auth.apiUrl || "").replace(/\/+$/, "");
  if (!apiUrl) throw new Error("The account has no configured API.");
  return { auth, credential, apiUrl, binding: credentialHmac(credential, `agent-added-owner:v1:${apiUrl}:${agentId}`) };
}
