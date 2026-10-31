function keyString(value) {
  return String(value || "").trim();
}

function timestampKey(...values) {
  for (const value of values) {
    const normalized = keyString(value);
    if (!normalized) continue;
    const epoch = Date.parse(normalized);
    if (Number.isFinite(epoch)) {
      return new Date(epoch).toISOString();
    }
    return normalized;
  }
  return "";
}

export function readSessionEventSequence(event = {}) {
  const value = Number(event?.sequenceId ?? event?.sequence_id ?? event?.sequence);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function sessionEventHasDurableCursor(event = {}) {
  return Boolean(keyString(event?.cursor));
}

// Before every read path kept messages whole, the CLI could store a long message cut short: the
// local redactor kept 16,384 characters and appended LEGACY_CUT_MARKER, and the human-message
// relay kept 2,000 characters and set payload.truncated. A whole copy of the same message at
// the same revision replaces such a cut copy.
const LEGACY_CUT_MARKER = "…[truncated]";

function payloadBodyText(event = {}) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  for (const value of [payload.message, payload.note, payload.text]) {
    if (typeof value === "string") return value;
  }
  return "";
}

function isCutCopy(event = {}) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  return payload.truncated === true || payloadBodyText(event).endsWith(LEGACY_CUT_MARKER);
}

/**
 * True when candidateEvent is a whole copy of a message that existingEvent holds cut short.
 */
export function sessionEventRestoresCutCopy(existingEvent = {}, candidateEvent = {}) {
  if (!isCutCopy(existingEvent) || isCutCopy(candidateEvent)) return false;
  const cutText = payloadBodyText(existingEvent);
  const keptText = cutText.endsWith(LEGACY_CUT_MARKER) ? cutText.slice(0, -LEGACY_CUT_MARKER.length) : cutText;
  return payloadBodyText(candidateEvent).length > keptText.length;
}

export function sessionEventUpgradesExisting(existingEvent = {}, candidateEvent = {}) {
  const existingRevision = Number(existingEvent.messageRevision ?? 1);
  const candidateRevision = Number(candidateEvent.messageRevision ?? 1);
  if (candidateRevision !== existingRevision) return candidateRevision > existingRevision;
  if (sessionEventRestoresCutCopy(existingEvent, candidateEvent)) return true;
  const existingSequence = readSessionEventSequence(existingEvent);
  const candidateSequence = readSessionEventSequence(candidateEvent);
  if (candidateSequence > 0 && existingSequence <= 0) {
    return true;
  }
  return sessionEventHasDurableCursor(candidateEvent) && !sessionEventHasDurableCursor(existingEvent);
}

function stableJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stableJsonValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, stableJsonValue(entryValue)])
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableJsonValue(value));
}

function messageEventCanUseRelaxedContentKey(eventKind) {
  return [
    "agent_response",
    "human_relay",
    "session_message",
    "session_say",
  ].includes(keyString(eventKind));
}

function eventDurabilityScore(event = {}) {
  let score = 0;
  if (readSessionEventSequence(event) > 0) score += 2;
  if (sessionEventHasDurableCursor(event)) score += 1;
  return score;
}

function mergeObjectPreferringPrimary(primaryValue, secondaryValue) {
  if (
    primaryValue &&
    typeof primaryValue === "object" &&
    !Array.isArray(primaryValue) &&
    secondaryValue &&
    typeof secondaryValue === "object" &&
    !Array.isArray(secondaryValue)
  ) {
    return { ...secondaryValue, ...primaryValue };
  }
  return primaryValue === undefined ? secondaryValue : primaryValue;
}

function mergeDuplicateEvent(existingEvent = {}, candidateEvent = {}) {
  const existingScore = eventDurabilityScore(existingEvent);
  const candidateScore = eventDurabilityScore(candidateEvent);
  const existingRevision = Number(existingEvent.messageRevision ?? 1);
  const candidateRevision = Number(candidateEvent.messageRevision ?? 1);
  const differentRevision = existingRevision !== candidateRevision;
  const restoresCutCopy = !differentRevision && sessionEventRestoresCutCopy(existingEvent, candidateEvent);
  const candidateIsPrimary = differentRevision ? candidateRevision > existingRevision : restoresCutCopy || candidateScore > existingScore || (
    candidateScore === existingScore &&
    sessionEventUpgradesExisting(existingEvent, candidateEvent)
  ) || (
    candidateScore === existingScore &&
    !sessionEventUpgradesExisting(candidateEvent, existingEvent)
  );
  const primaryEvent = candidateIsPrimary ? candidateEvent : existingEvent;
  const secondaryEvent = candidateIsPrimary ? existingEvent : candidateEvent;
  // Revision snapshots replace, rather than merge, the body/routing fields.
  let payload = differentRevision
    ? primaryEvent.payload
    : mergeObjectPreferringPrimary(primaryEvent.payload, secondaryEvent.payload);
  if (restoresCutCopy && payload && typeof payload === "object" && !Object.hasOwn(candidateEvent.payload || {}, "truncated")) {
    // The whole copy must not inherit the cut copy's truncated flag.
    payload = { ...payload };
    delete payload.truncated;
  }

  return {
    ...secondaryEvent,
    ...primaryEvent,
    agent: mergeObjectPreferringPrimary(primaryEvent.agent, secondaryEvent.agent),
    payload,
  };
}

export function sessionEventIdentityKeys(event = {}) {
  if (!event || typeof event !== "object") return [];
  const keys = [];
  const eventKind = keyString(event.event || event.type);
  const id = keyString(event.id);
  if (id) {
    keys.push(`id:${id}`);
  }
  if (typeof event.cursor === "string" && event.cursor.trim()) {
    keys.push(`cursor:${event.cursor.trim()}`);
  }
  if (typeof event.eventId === "string" && event.eventId.trim()) {
    keys.push(`event:${event.eventId.trim()}`);
  }
  if (typeof event.idempotencyToken === "string" && event.idempotencyToken.trim()) {
    keys.push(`idempotency:${event.idempotencyToken.trim()}`);
  }
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const clientMessageId = typeof payload.clientMessageId === "string" ? payload.clientMessageId.trim() : "";
  if (clientMessageId) {
    keys.push(`client-message:${clientMessageId}`);
  }
  const messageId = typeof payload.messageId === "string" ? payload.messageId.trim() : "";
  if (messageId) {
    keys.push(`message:${messageId}`);
  }
  const actionId = typeof payload.actionId === "string"
    ? payload.actionId.trim()
    : typeof payload.action_id === "string"
      ? payload.action_id.trim()
      : "";
  if (actionId) {
    keys.push(`action:${actionId}`);
  }
  const timestamp = timestampKey(event.ts, event.timestamp, event.at);
  const hasPayloadSignal = Object.keys(payload).length > 0;
  const hasFingerprintSignal =
    id || messageId || keyString(event.eventId) || keyString(event.idempotencyToken) ||
    keyString(event.agent?.id || event.agentId) || timestamp || hasPayloadSignal;
  if (hasFingerprintSignal) {
    try {
      keys.push(`fingerprint:${stableStringify({
        event: event.event || event.type || "",
        id,
        eventId: keyString(event.eventId),
        idempotencyToken: keyString(event.idempotencyToken),
        agent: event.agent?.id || event.agentId || "",
        payload,
        ts: timestamp,
      })}`);
    } catch {
      // Best-effort duplicate suppression only.
    }
  }
  const message = keyString(payload.message || payload.text || payload.body);
  if (message) {
    try {
      keys.push(`content:${stableStringify({
        event: eventKind,
        agent: keyString(event.agent?.id || event.agentId || payload.agentId || payload.authorId),
        payload: {
          channel: keyString(payload.channel),
          clientKind: keyString(payload.clientKind),
          message,
          source: keyString(payload.source),
          to: payload.to || payload.recipient || payload.mentions || null,
        },
        ts: timestampKey(event.ts, event.timestamp, event.at),
      })}`);
    } catch {
      // Best-effort duplicate suppression only.
    }
    if (messageEventCanUseRelaxedContentKey(eventKind)) {
      try {
        keys.push(`content-relaxed:${stableStringify({
          event: eventKind,
          agent: keyString(event.agent?.id || event.agentId || payload.agentId || payload.authorId),
          payload: {
            channel: keyString(payload.channel),
            message,
            source: keyString(payload.source),
          },
          ts: timestampKey(event.ts, event.timestamp, event.at),
        })}`);
      } catch {
        // Best-effort duplicate suppression only.
      }
    }
  }
  return keys;
}

export function sessionEventHasKnownIdentity(event = {}, knownKeys = new Set()) {
  const keys = sessionEventIdentityKeys(event);
  return keys.length > 0 && keys.some((key) => knownKeys.has(key));
}

export function addSessionEventIdentityKeys(knownKeys, event = {}) {
  for (const key of sessionEventIdentityKeys(event)) {
    knownKeys.add(key);
  }
}

export function dedupeSessionEvents(events = []) {
  const normalizedEvents = Array.isArray(events) ? events : [];
  const deduped = [];
  const indexByKey = new Map();

  for (const event of normalizedEvents) {
    const keys = sessionEventIdentityKeys(event);
    const existingIndexes = keys
      .map((key) => indexByKey.get(key))
      .filter((index) => Number.isInteger(index) && index >= 0);
    const existingIndex = existingIndexes.length > 0 ? Math.min(...existingIndexes) : -1;

    if (existingIndex >= 0) {
      deduped[existingIndex] = mergeDuplicateEvent(deduped[existingIndex], event);
      for (const key of keys) {
        indexByKey.set(key, existingIndex);
      }
      continue;
    }

    const nextIndex = deduped.length;
    deduped.push(event);
    for (const key of keys) {
      indexByKey.set(key, nextIndex);
    }
  }

  return deduped;
}
