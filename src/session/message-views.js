import { messageRevision } from "./message-edits.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Exact returned message/reply revisions only; a tail cursor is not a view. */
export function displayedMessageViewTargets(events = []) {
  const targets = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const type = event?.event || event?.type;
    const kind = type === "session_message" ? "message" : type === "session_reply" ? "reply" : null;
    const id = kind === "reply" ? event?.payload?.actionId : event?.id;
    if (!kind || !UUID.test(String(id || ""))) continue;
    const target = { kind, id, targetRevision: messageRevision(event) };
    const key = `${kind}:${id}`;
    if (!targets.has(key) || targets.get(key).targetRevision < target.targetRevision) targets.set(key, target);
  }
  return [...targets.values()];
}
