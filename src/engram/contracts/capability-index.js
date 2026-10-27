/**
 * ENGRAM §EW08 — Capability Index and Skill Descriptor contracts.
 *
 * Defines:
 *   - skillSchema: a single capability skill descriptor (MCP-tool-compatible)
 *   - capabilityIndexSchema: a deterministic, versioned, digest-signed index
 *     of all advertised skills for a publisher origin.
 *
 * Every skill in the index maps onto an MCP tool descriptor unchanged so a
 * later MCP adapter (EW20) reuses it. The index carries a sha256 digest over
 * the canonical JSON of its body (sans the digest field) so a consumer can
 * verify integrity without trusting the transport.
 *
 * All schemas are strict: extra fields are rejected.
 */

import { z } from "zod";
import { capabilityVersionSchema } from "./capability.js";
import { sha256ContentHashSchema } from "./content-hash.js";

// ---------------------------------------------------------------------------
// Skill descriptor
// ---------------------------------------------------------------------------

/** Valid scope values for a skill. */
const SKILL_SCOPE = z.enum(["read", "write"]);

/** Valid side-effect classifications. */
const SKILL_SIDE_EFFECTS = z.enum(["none", "simulated", "real"]);

/** Valid visibility levels. */
const SKILL_VISIBILITY = z.enum(["public", "private"]);

/**
 * A bounded text field: plain text, no control characters, size-capped.
 * MCP tools have titles and descriptions; this is the ENGRAM equivalent
 * for a skill descriptor that can be projected onto a tool unchanged.
 */
const boundedTextField = (maxLen, label) =>
  z.string()
    .min(1, `${label} must not be empty`)
    .max(maxLen, `${label} exceeds ${maxLen} characters`)
    .refine((s) => !/[\u0000-\u001f\u007f-\u009f]/.test(s), {
      message: `${label} must not contain control characters`,
    });

/**
 * A single capability skill descriptor.
 *
 * Fields project directly onto MCP tool annotations:
 *   - name + title + description → tool identity
 *   - inputSchema / outputSchema → JSON Schema objects (size-bounded)
 *   - readOnlyHint / destructiveHint / idempotentHint → scope + sideEffects
 *   - requiresConfirmation → a client UX gate
 *   - fallback → what to show when the capability is unavailable
 *
 * Private skills are NEVER included in a public index.
 */
export const skillSchema = z.object({
  capability: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
  version: capabilityVersionSchema,
  title: boundedTextField(128, "title"),
  purpose: boundedTextField(1024, "purpose"),
  inputSchema: z.record(z.unknown()).refine(
    (s) => JSON.stringify(s).length <= 8192,
    { message: "inputSchema JSON must not exceed 8192 bytes" },
  ),
  outputSchema: z.record(z.unknown()).refine(
    (s) => JSON.stringify(s).length <= 8192,
    { message: "outputSchema JSON must not exceed 8192 bytes" },
  ),
  scope: SKILL_SCOPE,
  sideEffects: SKILL_SIDE_EFFECTS,
  requiresConfirmation: z.boolean(),
  fallback: z.string().max(2048).optional(),
  visibility: SKILL_VISIBILITY,
}).strict().superRefine((skill, ctx) => {
  if (!versionNameMatches(skill.capability, skill.version)) {
    ctx.addIssue({
      code: "custom",
      path: ["version"],
      message: "version name must match capability",
    });
  }
});

// ---------------------------------------------------------------------------
// Capability index
// ---------------------------------------------------------------------------

/**
 * A publisher origin: an https origin with no path, query, or fragment.
 */
const publisherOriginSchema = z.string().refine((s) => {
  try {
    const u = new URL(s);
    return (
      u.protocol === "https:" &&
      u.hostname.length > 0 &&
      u.pathname === "/" &&
      u.search === "" &&
      u.hash === "" &&
      u.username === "" &&
      u.password === ""
    );
  } catch {
    return false;
  }
}, { message: "publisherOrigin must be an https origin with no path" });

/**
 * An ISO-8601 datetime string in UTC (must end with Z).
 */
const utcDatetimeSchema = z.string().refine(
  (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s),
  { message: "datetime must be ISO-8601 in UTC (ending with Z)" },
);

/**
 * A deterministic capability index for a publisher origin.
 *
 * Layout:
 *   - publisherOrigin: who published this index (https origin)
 *   - indexVersion: monotonic version of the index format
 *   - issuedAt / expiresAt: validity window
 *   - revoked: list of capability versions that are no longer valid
 *   - skills: only public, implemented skills sorted by capability name
 *   - digest: sha256 of the canonical JSON of the index WITHOUT this field
 *
 * The digest lets a consumer verify the index is intact: strip digest,
 * canonicalize, sha256, compare. If they don't match, the index is tampered
 * or corrupted.
 */
export const capabilityIndexSchema = z.object({
  publisherOrigin: publisherOriginSchema,
  indexVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  issuedAt: utcDatetimeSchema,
  expiresAt: utcDatetimeSchema,
  revoked: z.array(capabilityVersionSchema).default([]),
  skills: z.array(skillSchema),
  digest: sha256ContentHashSchema,
}).strict().superRefine((index, ctx) => {
  // Every revoked entry must correspond to a version of a capability that
  // exists (or existed) — validate the format at minimum.
  for (let i = 0; i < index.revoked.length; i++) {
    const r = index.revoked[i];
    if (!capabilityVersionSchema.safeParse(r).success) {
      ctx.addIssue({
        code: "custom",
        path: ["revoked", i],
        message: `revoked entry "${r}" is not a valid capability version`,
      });
    }
  }

  // Skills must be sorted by capability name (deterministic output).
  for (let i = 1; i < index.skills.length; i++) {
    if (index.skills[i].capability < index.skills[i - 1].capability) {
      ctx.addIssue({
        code: "custom",
        path: ["skills", i],
        message: "skills must be sorted by capability name",
      });
      break;
    }
  }

  // No private skills in a published index.
  for (let i = 0; i < index.skills.length; i++) {
    if (index.skills[i].visibility === "private") {
      ctx.addIssue({
        code: "custom",
        path: ["skills", i, "visibility"],
        message: "private skills must not appear in a published index",
      });
      break;
    }
  }

  // expiresAt must be after issuedAt.
  if (new Date(index.expiresAt) <= new Date(index.issuedAt)) {
    ctx.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "expiresAt must be after issuedAt",
    });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check that a capability version's name prefix matches the expected
 * capability name.
 */
function versionNameMatches(capability, version) {
  const parts = parseCapVersion(version);
  return parts !== null && parts[0] === capability;
}

/**
 * Parse a capability version string into [name, major, minor, patch].
 * Returns null if the string does not match.
 */
function parseCapVersion(v) {
  if (typeof v !== "string") return null;
  const m = v.match(
    /^([a-z][a-z0-9_-]{0,47})@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/,
  );
  if (!m) return null;
  return [m[1], Number(m[2]), Number(m[3]), Number(m[4])];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base error for capability index operations. */
export class CapabilityIndexError extends Error {
  constructor(message, evidence) {
    super(message);
    this.name = "CapabilityIndexError";
    this.evidence = evidence ?? null;
  }
}

/** The index digest does not match the computed digest over the body. */
export function digestMismatch(expected, actual, evidence) {
  return new CapabilityIndexError(
    `digest mismatch: expected ${expected}, computed ${actual}`,
    evidence,
  );
}

/** The index has expired. */
export function indexExpired(expiresAt, now, evidence) {
  return new CapabilityIndexError(
    `index expired at ${expiresAt} (now: ${now})`,
    evidence,
  );
}

/** The index publisher origin does not match the expected origin. */
export function originMismatch(expected, actual, evidence) {
  return new CapabilityIndexError(
    `origin mismatch: expected ${expected}, got ${actual}`,
    evidence,
  );
}

/** A requested capability has been revoked. */
export function capabilityRevoked(capability, version, evidence) {
  return new CapabilityIndexError(
    `capability ${capability} version ${version} has been revoked`,
    evidence,
  );
}
