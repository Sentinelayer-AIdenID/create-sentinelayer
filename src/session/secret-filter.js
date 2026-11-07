// Shared by stream redaction and direct image-description outputs. Keep this
// matcher aligned with sync.js; no output surface may bypass it for OCR.
export const SECRET_LIKE_PATTERN =
  /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]+PRIVATE KEY-----|SENTINELAYER_TOKEN|AIDENID_API_KEY|NPM_TOKEN|xox[baprs]-[A-Za-z0-9-]+|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,})/;

export function redactString(value, maxLength = 16_384, { nonExpanding = false } = {}) {
  if (typeof value !== "string") return value;
  const truncated = value.length > maxLength ? `${value.slice(0, maxLength)}…[truncated]` : value;
  return SECRET_LIKE_PATTERN.test(truncated)
    ? truncated.replace(new RegExp(SECRET_LIKE_PATTERN.source, "gi"), (match) =>
      nonExpanding && match.length < "[REDACTED]".length ? "[X]" : "[REDACTED]")
    : truncated;
}
