// Display metadata only. The files command resolves pointers when asked to fetch.
import { containsSecret } from "./redact.js";
import { sessionMessageRoutingEvent } from "./message-edits.js";

const MAX_VISIBLE_ATTACHMENTS = 5;

function displayText(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  if (containsSecret(text) || /\w+:\/\/|\bbearer\s+\S+/i.test(text)) return fallback;
  return Array.from(text.replace(/[\[\]`<>]/g, "")).slice(0, 255).join("") || fallback;
}

function commandId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)
    && !value.includes("..") && !containsSecret(value) ? value : "";
}

function pointerAttachmentId(pointer, sessionId) {
  if (typeof pointer !== "string" || !sessionId) return "";
  const match = /^\/api\/v1\/sessions\/([^/]+)\/attachments\/([^/?#]+)$/.exec(pointer);
  return match && match[1] === sessionId ? commandId(match[2]) : "";
}

function fileSize(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatAttachmentSummary(event = {}) {
  const session = event?.sessionId || event?.session_id;
  event = sessionMessageRoutingEvent(event);
  const payload = event?.payload || {};
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const sourceSessionId = commandId(session || event?.sessionId || event?.session_id);
  const sessionId = sourceSessionId || "<sessionId>";
  const summaries = attachments.slice(0, MAX_VISIBLE_ATTACHMENTS).map((attachment) => {
    const item = attachment && typeof attachment === "object" ? attachment : {};
    const details = [`${displayText(item.kind, "file")} ${displayText(item.filename, "unnamed")}`];
    const size = fileSize(item.sizeBytes ?? item.size_bytes);
    if (size) details.push(size);
    if (typeof item.sha256 === "string" && /^[a-f\d]{64}$/i.test(item.sha256)) {
      details.push(`sha256 ${item.sha256.slice(0, 8).toLowerCase()}…`);
    }
    const status = item.removed === true ? "removed" : displayText(item.status);
    if (status) details.push(`status ${status}`);
    const marker = `[attachment: ${details.join(", ")}]`;
    if (item.removed === true) return marker;
    const attachmentId = commandId(item.attachmentId || item.attachment_id || item.id
      || pointerAttachmentId(item.pointer, sourceSessionId));
    const fetch = attachmentId.length >= 8
      ? `sl session files get ${sessionId} ${attachmentId}`
      : `sl session files ${sessionId}`;
    return `${marker} (fetch: ${fetch})`;
  });
  if (attachments.length > MAX_VISIBLE_ATTACHMENTS) {
    summaries.push(`+${attachments.length - MAX_VISIBLE_ATTACHMENTS} more`);
  }
  return summaries.join(" ");
}

export function appendAttachmentSummary(text, event) {
  return [text, formatAttachmentSummary(event)].filter(Boolean).join(" ");
}

export function withAttachmentSummary(event) {
  const attachmentSummary = formatAttachmentSummary(event);
  return attachmentSummary ? { ...event, attachmentSummary } : event;
}
