import { randomUUID } from "node:crypto";
import { updateSessionComposing } from "./sync.js";

/** A runtime calls this only when it explicitly begins preparing one reply. */
export async function startSessionComposing(sessionId, {
  runId = randomUUID(), targetKind, targetId, agentId, targetPath,
  signal, onStatus = () => {}, update = updateSessionComposing,
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const options = { runId, targetKind, targetId, agentId, targetPath };
  let stopped = false;
  let timer;
  let pending = Promise.resolve();
  let stopPromise;
  const report = (result) => {
    try { onStatus(result); } catch { /* A diagnostic callback cannot strand a lease. */ }
    return result;
  };
  const send = (operation) => {
    pending = pending.then(() => update(sessionId, { ...options, operation }))
      .catch(() => ({ ok: false, reason: "composing_transport_failed" })).then(report);
    return pending;
  };
  if (signal?.aborted) throw new Error("Composing run was cancelled before starting.");
  const started = await send("start");
  if (!started.ok) throw new Error(`Composing start failed (${started.reason || "unknown"}).`);
  const tick = async () => {
    if (stopped) return;
    let renewed;
    try { renewed = await send("heartbeat"); }
    catch { renewed = { ok: false, reason: "composing_transport_failed" }; }
    // A stale/expired lease never re-starts itself. The server expires a lost
    // runtime after 45s; no unbounded retry loop or inferred activity.
    if (!stopped && renewed.ok) schedule();
  };
  const schedule = () => { timer = setTimer(() => { void tick(); }, 15_000); timer?.unref?.(); };
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    clearTimer(timer);
    signal?.removeEventListener("abort", onAbort);
    // A failed heartbeat must not prevent the bounded cleanup attempt.
    pending = pending.catch(() => {});
    stopPromise = send("stop");
    return stopPromise;
  };
  const onAbort = () => { void stop().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) { await stop(); throw new Error("Composing run was cancelled while starting."); }
  schedule();
  return { runId, stop };
}

/** Runtime/daemon adapter: reply completion, failure and cancellation clean up. */
export async function withSessionComposing(sessionId, options, work) {
  const handle = await startSessionComposing(sessionId, options);
  try { return await work(handle); }
  finally { await handle.stop(); }
}
