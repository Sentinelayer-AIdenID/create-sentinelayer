// Admission bootstrap is a separate control-plane operation. Once claimed,
// every receipt, presence, message and read uses the room's own credential.
import process from "node:process";

import { createAgentEvent } from "../events/schema.js";
import { runAdmissionJoin, fetchOwnAdmissionReceipt } from "./admission.js";
import { currentAdmittedAgent, withAgentAdmission } from "./admission-auth.js";
import { listenSessionEvents } from "./listener.js";
import { pollSessionEventsBefore, renewSessionPresence, syncSessionEventToApi } from "./sync.js";
import { exactWatcherAgent, ownerWatcherAuth } from "./agent-added-owner-auth.js";

export const ADDED_ROOM_GOAL = "Join this chat at the account owner's request.";
export const ADDED_ROOM_HELLO = "Hello, I'm here.";

export function startAddedRoomListener({
  sessionId, notificationId, agentId, ownerBinding, targetPath = process.cwd(),
  model = "cli", provider = "unknown", signal,
  onEvent = async () => {}, onNotice = async () => {},
  _ownerAuth = ownerWatcherAuth, _join = runAdmissionJoin, _withAdmission = withAgentAdmission,
  _receipt = fetchOwnAdmissionReceipt, _presence = renewSessionPresence,
  _post = syncSessionEventToApi, _listen = listenSessionEvents, _latest = pollSessionEventsBefore,
} = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const done = (async () => {
    try {
      agentId = exactWatcherAgent(agentId);
      if (currentAdmittedAgent()) throw new Error("A room listener cannot bootstrap another room from its admission.");
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(String(sessionId || "")) || typeof ownerBinding !== "string" || !ownerBinding) throw new Error("Invalid added-room binding.");
      if (controller.signal.aborted) return resolveReady({ joined: false });
      // Resolve independently: the owner watcher never supplies this credential.
      const owner = await _ownerAuth(agentId, { targetPath });
      if (owner.binding !== ownerBinding) throw new Error("The account changed before admission setup.");
      const joined = await _join(sessionId, {
        agentId, targetPath, model, provider, goal: ADDED_ROOM_GOAL,
        actions: ["session.read", "session.post"], noAutoGrant: true,
        wait: true, waitTimeoutMs: 30_000, requireAccountCheck: true, signal: controller.signal,
        resolveAuthSession: async () => owner.auth,
      });
      if (joined?.status !== "active" || controller.signal.aborted) return resolveReady({ joined: false });
      await _withAdmission(sessionId, agentId, async () => {
        const receipt = await _receipt(sessionId, { targetPath });
        if (receipt?.agentId !== agentId) throw new Error("Admission receipt names another agent.");
        if (controller.signal.aborted) return resolveReady({ joined: false });
        const presence = await _presence(sessionId, { targetPath, agentId, model, provider,
          clientKind: "cli", listenerId: `added-${notificationId}`, state: "idle", signal: controller.signal });
        if (!presence?.ok || presence.recorded !== true) throw new Error("The room did not accept listener presence.");
        if (controller.signal.aborted) return resolveReady({ joined: false });
        // Prime before the hello. A person replying while the listener starts
        // must remain after this cursor and arrive on its first read.
        const latest = await _latest(sessionId, { targetPath, limit: 1 });
        if (!latest?.ok) throw new Error("The room did not accept the initial read.");
        if (controller.signal.aborted) return resolveReady({ joined: false });
        const hello = createAgentEvent({ event: "session_message", agentId, agentModel: model, sessionId,
          idempotencyToken: `agent-added:${notificationId}:${agentId}`, payload: { message: ADDED_ROOM_HELLO } });
        const posted = await _post(sessionId, hello, { targetPath, noAutoGrant: true });
        if (!posted?.synced) throw new Error("The room did not accept the hello.");
        resolveReady({ joined: true });
        if (controller.signal.aborted) return;
        await _listen({ sessionId, agentId, targetPath, signal: controller.signal, transport: "poll",
          since: latest.cursor || null, replay: true, onEvent,
          onControl: async (control) => { if (["stop", "listener_stop"].includes(control?.type || control?.action || control?.event)) stop(); },
          onError: async (result) => {
            if (/401|403|not_authenticated|forbidden|admission/i.test(String(result?.reason || ""))) stop();
            await onNotice({ type: "room_read_unavailable", agentId, sessionId });
          },
          onLifecycle: async (state) => {
            if (state.type !== "heartbeat" || controller.signal.aborted) return;
            const result = await _presence(sessionId, { targetPath, agentId, model, provider,
              clientKind: "cli", listenerId: `added-${notificationId}`, state: "idle", signal: controller.signal });
            if (!result?.ok && /401|403|not_authenticated|forbidden|admission/i.test(String(result?.reason || ""))) stop();
          },
        });
      }, { requireStored: true });
    } catch (error) {
      rejectReady(error);
      throw error;
    } finally {
      stop();
      signal?.removeEventListener("abort", stop);
    }
  })();
  // ready is awaited first; mark the parallel completion observed immediately.
  void done.catch(() => {});
  return { ready, done, stop };
}
