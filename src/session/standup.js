import process from "node:process";
import { checkedTransport, credentialFor, isAuthenticated } from "../auth/credential-destinations.js";
import { requestJson } from "../auth/http.js";
import { resolveActiveAuthSession } from "../auth/service.js";
import { urlPathSegment } from "../net/url-path.js";

const SECTIONS = [
  ["accepted", "Accepted"],
  ["ownerAttested", "Owner-attested (unverified)"],
  ["reportedButUnverified", "Reported but unverified"],
  ["inProgress", "In progress"],
  ["open", "Open"],
  ["blocked", "Blocked"],
  ["inReview", "In review"],
  ["needsOwnerDecision", "Needs an owner decision"],
  ["unknown", "Unknown"],
];
const BOARD_LIMIT = 200;
const EVIDENCE_KINDS = new Set(["pr-merged", "sha-on-branch", "check-conclusive", "deploy-sha"]);

const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const boolean = (value) => typeof value === "boolean" ? value : null;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return null;
  const ms = Date.parse(value), day = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(ms) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  return new Date(ms).toISOString();
}

function sinceTime(since, now) {
  if (since === undefined) return null;
  if (since === "24h") return new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const parsed = timestamp(since);
  if (!parsed) throw new Error("--since must be 24h or an ISO timestamp with a timezone.");
  return parsed;
}

function evidenceClaim(claim) {
  let reference = null;
  if (claim.kind === "pr-merged") {
    const pr = Number.isSafeInteger(claim.pr) ? String(claim.pr) : text(claim.pr);
    if (pr && /^[1-9]\d*$/.test(pr)) reference = `#${pr}`;
  } else if (claim.kind === "sha-on-branch" || claim.kind === "deploy-sha") {
    reference = text(claim.sha)?.slice(0, 12) || null;
  } else if (claim.kind === "check-conclusive") {
    reference = text(claim.check);
  }
  reference ||= text(claim.url);
  if (reference?.length > 80) reference = `${reference.slice(0, 79)}…`;
  return { kind: claim.kind, reference };
}

function ticketRecord(raw) {
  const t = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const evidence = Array.isArray(t.doneVerdict?.evidence)
    ? t.doneVerdict.evidence.filter((claim) => claim && EVIDENCE_KINDS.has(claim.kind)).map(evidenceClaim) : [];
  const ownerAttested = t.doneVerdict?.kind === "owner-attested" || t.completion?.source === "owner_attested";
  return {
    id: text(t.id), title: text(t.title), status: text(t.status),
    assignee: text(t.assignee), acceptedBy: text(t.acceptedBy),
    claimedAt: timestamp(t.claimedAt), createdAt: timestamp(t.createdAt), updatedAt: timestamp(t.updatedAt),
    hasDoneVerdict: boolean(t.hasDoneVerdict), unaccepted: boolean(t.unaccepted), staleClaim: boolean(t.staleClaim),
    completion: t.completion && typeof t.completion === "object"
      ? { source: text(t.completion.source), verified: boolean(t.completion.verified) } : null,
    verdict: { kind: evidence[0]?.kind || null, reference: evidence[0]?.reference || null, evidence },
    ownerAttestation: ownerAttested ? {
      statement: text(t.doneVerdict?.statement), attestedBy: text(t.doneVerdict?.attestedBy),
      attestedAt: timestamp(t.doneVerdict?.attestedAt), verified: false,
    } : null,
    unknown: [],
  };
}

// Select a whole record, never graft a prior verdict onto a newer claim. When
// timestamps cannot resolve different records, retain only their shared identity.
function coalesce(items) {
  const groups = new Map();
  for (const raw of items) {
    const item = ticketRecord(raw);
    const key = item.id ? `id:${item.id}` : `record:${JSON.stringify(item)}`;
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key).set(JSON.stringify(item), item);
  }
  return [...groups.values()].map((group) => {
    const records = [...group.values()].sort((a, b) => compare(b.updatedAt || "", a.updatedAt || ""));
    if (records.length === 1) return records[0];
    if (records.every((t) => t.updatedAt) && records[0].updatedAt !== records[1].updatedAt) return records[0];
    const conflict = ticketRecord({ id: records[0].id,
      updatedAt: records.every((t) => t.updatedAt) ? records[0].updatedAt : null });
    conflict.unknown.push("conflicting duplicate records");
    return conflict;
  }).sort((a, b) => compare(a.id || "", b.id || "") || compare(JSON.stringify(a), JSON.stringify(b)));
}

export function buildSessionStandup(items, { sessionId, since, now = Date.now(), truncated = false } = {}) {
  const cutoff = sinceTime(since, now);
  const report = { sessionId, since: cutoff, truncated: truncated === true || items.length >= BOARD_LIMIT,
    ...Object.fromEntries(SECTIONS.map(([key]) => [key, []])) };
  for (const item of coalesce(items)) {
    if (cutoff && item.updatedAt && item.updatedAt < cutoff) continue;
    for (const field of ["id", "title", "status", "updatedAt"]) {
      if (item[field] === null) item.unknown.push(field);
    }
    let section = "unknown";
    if (!item.id || item.unknown.includes("conflicting duplicate records") || (cutoff && !item.updatedAt)) {
      // There is not enough evidence to identify or date this work.
    } else if (item.status === "done") {
      if (item.ownerAttestation) {
        section = "ownerAttested";
        for (const field of ["statement", "attestedBy", "attestedAt"]) {
          if (item.ownerAttestation[field] === null) item.unknown.push(`ownerAttestation.${field}`);
        }
      } else {
        section = item.hasDoneVerdict === true && item.verdict.evidence.length
          ? "accepted" : "reportedButUnverified";
        if (item.hasDoneVerdict === null) item.unknown.push("hasDoneVerdict");
        if (!item.verdict.kind) item.unknown.push("verdict.kind");
        if (!item.verdict.evidence.length || item.verdict.evidence.some((claim) => !claim.reference)) item.unknown.push("verdict.reference");
      }
    } else if (item.unaccepted === true) {
      section = "needsOwnerDecision";
      if (!item.createdAt) item.unknown.push("createdAt");
    } else if (["working", "in_progress"].includes(item.status)) {
      section = "inProgress";
      for (const field of ["assignee", "claimedAt", "staleClaim"]) {
        if (item[field] === null) item.unknown.push(field);
      }
    } else if (["open", "assigned", "accepted"].includes(item.status)) {
      section = "open";
    } else if (item.status === "blocked") {
      section = "blocked";
    } else if (item.status === "in_review") {
      section = "inReview";
    } else {
      item.unknown.push("classification");
      if (item.unaccepted === null) item.unknown.push("unaccepted");
    }
    report[section].push(item);
  }
  report.needsOwnerDecision.sort((a, b) => compare(a.createdAt || "~", b.createdAt || "~") || compare(a.id, b.id));
  return report;
}

export async function sessionStandup(sessionId, {
  since, targetPath = process.cwd(), now = Date.now(),
  resolveAuthSession = resolveActiveAuthSession, requestRead = requestJson,
} = {}) {
  const cutoff = sinceTime(since, now); // Invalid windows refuse before any request.
  const auth = await resolveAuthSession({ cwd: targetPath, env: process.env, autoRotate: false });
  if (!isAuthenticated(auth) || !auth?.apiUrl) throw new Error("Not authenticated for this session.");
  let body;
  try {
    body = await checkedTransport(requestRead)(`${auth.apiUrl.replace(/\/+$/, "")}/api/v1/sessions/${urlPathSegment(sessionId, { label: "sessionId" })}/tickets?limit=${BOARD_LIMIT}`, {
      method: "GET", credential: await credentialFor(auth),
    });
  } catch (error) {
    if (error?.status === 403 || error?.status === 404) {
      throw new Error(`Standup refused (HTTP ${error.status}): this session's tickets are unavailable or you do not have permission to read them.`, { cause: error });
    }
    throw error;
  }
  if (!Array.isArray(body?.items)) throw new Error("The ticket response has no items array; refusing to invent a standup.");
  const truncated = body.hasMore === true || Boolean(text(body.nextCursor) || text(body.nextAfterId));
  return buildSessionStandup(body.items, { sessionId, ...(cutoff ? { since: cutoff } : {}), now, truncated });
}

export function formatSessionStandup(report) {
  // Keep untrusted server text on one terminal line, without directional overrides.
  const display = (value) => String(value ?? "unknown").replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, " ");
  const lines = [`Standup ${display(report.sessionId)} · since ${report.since || "all returned records"}`];
  if (report.truncated) lines.push("Warning: ticket board is truncated; more tickets may exist beyond this page.");
  for (const [key, heading] of SECTIONS) {
    lines.push("", heading);
    if (!report[key].length) lines.push("  (none)");
    for (const item of report[key]) {
      let detail = "";
      if (key === "accepted") detail = ` · verdict: ${item.verdict.evidence.map((claim) => `${display(claim.kind)} ${display(claim.reference)}`).join("; ")}`;
      if (key === "ownerAttested") detail = ` · owner statement by ${display(item.ownerAttestation.attestedBy)} (unverified): ${display(item.ownerAttestation.statement)}`;
      if (key === "reportedButUnverified") detail = " · no re-checkable done verdict";
      if (key === "inProgress") detail = ` · assignee: ${display(item.assignee)} · since: ${display(item.claimedAt)}${item.staleClaim === true ? " · STALE claim" : ""}`;
      if (key === "needsOwnerDecision") detail = ` · created: ${display(item.createdAt)}`;
      const missing = item.unknown.length ? ` · unknown: ${item.unknown.join(", ")}` : "";
      lines.push(`  ${display(item.id)}  ${display(item.title)}${detail}${missing}`);
    }
  }
  return lines.join("\n");
}
