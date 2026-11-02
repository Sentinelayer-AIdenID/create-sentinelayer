export function sessionMessageEditText(event = {}) {
  const payload = event.payload || {};
  const text = payload.message ?? payload.reply?.note ?? payload.event?.payload?.message;
  return typeof text === "string" ? text : "";
}

export function formatEditSummary(event = {}) {
  if ((event.event || event.type) !== "session_message_edited") return "";
  const payload = event.payload || {};
  const sequence = Number(payload.targetSequenceId ?? payload.reply?.targetSequenceId ?? payload.event?.sequenceId);
  const target = Number.isSafeInteger(sequence) && sequence > 0 ? sequence : "?";
  const kind = payload.targetActionId || payload.reply ? "edited reply under" : "edited";
  return [`[${kind} #${target}]`, sessionMessageEditText(event).trim()].filter(Boolean).join(" ");
}

export function withEditSummary(event) {
  const editSummary = formatEditSummary(event);
  return editSummary ? { ...event, editSummary } : event;
}
