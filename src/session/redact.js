// Central payload-redaction utility for Senti session streams.
//
// Invariant: every event that lands on disk (stream.ndjson) or on the wire
// (API sync, human-message sync) passes through redactEventPayload before
// serialization. The sink call in stream.appendToStream is the enforcement
// point — if it writes raw, a secret leaks into the audit trail forever.
//
// Direct image outputs use the same bounded string filter as the stream sink.
import { imageDescriptionFields, isAttachmentPointer, MAX_IMAGE_DESCRIPTION_CHARS } from "./image-descriptions.js";
import { SECRET_LIKE_PATTERN, redactString } from "./secret-filter.js";

const REDACTION_MARKER = "[REDACTED]";
function redactValue(value, depth = 0) {
  if (depth > 8) {
    return REDACTION_MARKER;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const out = {};
    const image = imageDescriptionFields(value);
    const attachment = isAttachmentPointer(value);
    for (const [key, inner] of Object.entries(value)) {
      if (/^(authorization|cookie|set-cookie|x-api-key|api[_-]?key|secret|password|token)$/i.test(key)) {
        out[key] = REDACTION_MARKER;
        continue;
      }
      if (attachment && ["description", "descriptionTrust", "descriptionNotice"].includes(key)) continue;
      out[key] = redactValue(inner, depth + 1);
    }
    if (image.description) {
      // Rebuild all three fields from the validated contract, including its fixed
      // notice. Keep complete caption/OCR and the existing bounded secret filter.
      Object.assign(out, image, {
        description: Object.fromEntries(Object.entries(image.description).map(([name, content]) => [
          name, redactString(content, MAX_IMAGE_DESCRIPTION_CHARS * 2),
        ])),
      });
    }
    return out;
  }
  return value;
}

export function redactEventPayload(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return event;
  }
  const clone = { ...event };
  if (clone.payload !== undefined) {
    clone.payload = redactValue(clone.payload);
  }
  if (clone.message !== undefined) {
    clone.message = redactValue(clone.message);
  }
  if (clone.body !== undefined) {
    clone.body = redactValue(clone.body);
  }
  return clone;
}

export function containsSecret(value) {
  if (typeof value === "string") {
    return SECRET_LIKE_PATTERN.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsSecret(entry));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((entry) => containsSecret(entry));
  }
  return false;
}

export const __secretPatternForTests = SECRET_LIKE_PATTERN;
