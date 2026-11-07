// Explicit owner control plane. Its only network operation is the exact-agent
// notification GET. Room workers resolve their own admission setup separately;
// this module never hands them the account credential or reads/posts a room.
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";

import { checkedTransport } from "../auth/credential-destinations.js";
import { requestJson } from "../auth/http.js";
import { resolveActiveAuthSession } from "../auth/service.js";
import { exactWatcherAgent, ownerWatcherAuth } from "./agent-added-owner-auth.js";
import { startAddedRoomListener } from "./added-room-listener.js";

const PAGE_SIZE = 50;
const MAX_PAGES_PER_POLL = 10;
const MAX_PENDING = 500;
const MAX_ATTEMPTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function readAgentAddedPage(owner, agentId, cursor, { requestRead = requestJson, signal } = {}) {
  const query = new URLSearchParams({ kind: "agent_added", agentId, limit: String(PAGE_SIZE) });
  if (cursor) query.set("after", cursor);
  return checkedTransport(requestRead)(`${owner.apiUrl}/api/v1/sessions/notifications?${query}`, {
    method: "GET", credential: owner.credential, timeoutMs: 10_000, maxRetries: 0, signal,
  });
}

export function checkedAddition(item, agentId, now) {
  if (!item || item.kind !== "agent_added" || item.payload?.agentId !== agentId
      || typeof item.id !== "string" || !/^[a-zA-Z0-9._:-]{1,100}$/.test(item.id)
      || typeof item.payload?.sessionId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(item.payload.sessionId)) {
    throw new Error("The server returned an invalid agent-added notification.");
  }
  const created = Date.parse(item.createdAt);
  if (!Number.isFinite(created) || created > now + 60_000) throw new Error("The server returned an invalid notification time.");
  if (created + DAY_MS <= now) return null;
  // Never pass a server title, body, URL, command, goal or sender instructions to
  // a worker. The owner chooses the identity; the server supplies only the room.
  return { id: item.id, sessionId: item.payload.sessionId, agentId, expiresAt: created + DAY_MS };
}

export async function watchAgentAdditions({
  agentId, targetPath = process.cwd(), model = "cli", provider = "unknown",
  intervalSeconds = 60, maxPolls = null, maxRooms = 100, signal,
  onEvent = async () => {}, onNotice = async () => {},
  _resolveAuth = resolveActiveAuthSession, _readPage = readAgentAddedPage,
  _startListener = startAddedRoomListener, _sleep = delay, _now = Date.now,
} = {}) {
  agentId = exactWatcherAgent(agentId);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 10 || intervalSeconds > 3600) throw new Error("--interval must be 10 to 3600 seconds.");
  if (!Number.isInteger(maxRooms) || maxRooms < 1 || maxRooms > 500) throw new Error("--max-rooms must be 1 to 500.");
  if (maxPolls !== null && (!Number.isInteger(maxPolls) || maxPolls < 1)) throw new Error("--max-polls must be a positive integer.");
  const owner = await ownerWatcherAuth(agentId, { targetPath, resolveAuth: _resolveAuth });
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const active = new Map();
  const pending = new Map();
  let cursor = null;
  let polls = 0;
  let failures = 0;
  try {
    await onNotice({ type: "watching", agentId, accountCredential: true });
    while (!controller.signal.aborted && (maxPolls === null || polls < maxPolls)) {
      polls += 1;
      // Stop on an account/token/API change. No previously acquired authority
      // is silently reused after the owner signs in as somebody else.
      let current = await ownerWatcherAuth(agentId, { targetPath, resolveAuth: _resolveAuth });
      if (current.binding !== owner.binding) throw new Error("Your account sign-in changed. Restart the owner watcher.");
      let started = 0;
      let settlementFollowup = false;
      let retryAfterMs = null;
      let cycleFailed = false;
      do {
        try {
          const pageLimit = settlementFollowup ? 1 : MAX_PAGES_PER_POLL;
          for (let pageNumber = 0; pageNumber < pageLimit && pending.size <= MAX_PENDING - PAGE_SIZE; pageNumber += 1) {
            const page = await _readPage(current, agentId, cursor, { signal: controller.signal });
            const hasHint = page != null && Object.hasOwn(page, "retryAfterMs");
            if (page?.ok !== true || !Array.isArray(page.notifications) || page.notifications.length > PAGE_SIZE
                || typeof page.nextCursor !== "string" || !/^aa1\.[A-Za-z0-9_-]{1,1024}$/.test(page.nextCursor)
                || (page.notifications.length && page.nextCursor === cursor)
                || (hasHint && (!Number.isInteger(page.retryAfterMs) || page.retryAfterMs < 1
                  || page.retryAfterMs > 10_000 || page.notifications.length >= PAGE_SIZE))) {
              throw new Error("The server returned an invalid agent-added page.");
            }
            const additions = page.notifications.map((item) => checkedAddition(item, agentId, _now()));
            for (const addition of additions) {
              if (addition && !active.has(addition.sessionId) && !pending.has(addition.id)) pending.set(addition.id, { ...addition, attempts: 0, nextAttempt: 0 });
            }
            cursor = page.nextCursor;
            if (page.notifications.length < PAGE_SIZE) {
              if (!settlementFollowup && hasHint) retryAfterMs = page.retryAfterMs;
              break;
            }
          }
        } catch (error) {
          cycleFailed = true;
          retryAfterMs = null;
          if ([400, 401, 403].includes(Number(error?.status))) throw new Error("The account notification feed refused this watcher. Check your sign-in and agent grant.");
          failures += 1;
          await onNotice({ type: "feed_unavailable", agentId });
          if (failures >= MAX_ATTEMPTS) throw new Error("The notification feed is unavailable after five attempts. Restart the watcher when it is available.");
        }
        for (const [id, entry] of pending) {
          if (controller.signal.aborted) break;
          if (entry.expiresAt <= _now() || active.has(entry.sessionId)) { pending.delete(id); continue; }
          if (entry.attempts >= MAX_ATTEMPTS) { pending.delete(id); continue; }
          if (entry.nextAttempt > _now() || active.size >= maxRooms || started >= 5) continue;
          started += 1;
          entry.attempts += 1;
          entry.nextAttempt = _now() + Math.min(intervalSeconds * 1000 * 2 ** (entry.attempts - 1), 300_000);
          let handle;
          try {
            // Only a non-reusable binding proof crosses this boundary. No account
            // credential, resolver, transport or token is passed into a listener.
            handle = _startListener({ sessionId: entry.sessionId, notificationId: entry.id, agentId,
              targetPath, model, provider, ownerBinding: owner.binding, signal: controller.signal,
              onEvent, onNotice });
            const result = await handle.ready;
            if (!result?.joined) {
              handle.stop();
              await handle.done;
              await onNotice({ type: entry.attempts >= MAX_ATTEMPTS ? "join_failed" : "join_pending", agentId, sessionId: entry.sessionId });
              if (entry.attempts >= MAX_ATTEMPTS) pending.delete(id);
              continue;
            }
            pending.delete(id);
            active.set(entry.sessionId, handle);
            void handle.done.catch(() => onNotice({ type: "listener_stopped", agentId, sessionId: entry.sessionId }))
              .finally(() => { if (active.get(entry.sessionId) === handle) active.delete(entry.sessionId); });
            await onNotice({ type: "joined", agentId, sessionId: entry.sessionId });
          } catch {
            handle?.stop();
            if (handle?.done) await handle.done.catch(() => {});
            await onNotice({ type: entry.attempts >= MAX_ATTEMPTS ? "join_failed" : "join_pending", agentId, sessionId: entry.sessionId });
            if (entry.attempts >= MAX_ATTEMPTS) pending.delete(id);
          }
        }
        // Settled rows are handled first. A single advisory delay can add one
        // short follow-up to this cycle; a repeated hint cannot keep it alive.
        if (settlementFollowup || retryAfterMs === null || controller.signal.aborted
            || pending.size > MAX_PENDING - PAGE_SIZE) break;
        await _sleep(retryAfterMs, undefined, { signal: controller.signal });
        if (controller.signal.aborted) break;
        current = await ownerWatcherAuth(agentId, { targetPath, resolveAuth: _resolveAuth });
        if (current.binding !== owner.binding) throw new Error("Your account sign-in changed. Restart the owner watcher.");
        settlementFollowup = true;
      } while (!controller.signal.aborted);
      if (!cycleFailed) failures = 0;
      if (!controller.signal.aborted && (maxPolls === null || polls < maxPolls)) {
        await _sleep(intervalSeconds * 1000, undefined, { signal: controller.signal });
      }
    }
    return { polls, pending: pending.size, listening: active.size };
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    return { polls, pending: pending.size, listening: active.size };
  } finally {
    abort();
    signal?.removeEventListener("abort", abort);
    const handles = [...active.values()];
    for (const handle of handles) handle.stop();
    await Promise.allSettled(handles.map((handle) => handle.done));
  }
}
