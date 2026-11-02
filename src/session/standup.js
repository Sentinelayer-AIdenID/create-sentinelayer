import process from "node:process";
import { checkedTransport, credentialFor, isAuthenticated } from "../auth/credential-destinations.js";
import { requestJson } from "../auth/http.js";
import { resolveActiveAuthSession } from "../auth/service.js";
import { urlPathSegment } from "../net/url-path.js";

const SECTIONS = [
  ["accepted", "Accepted"],
  ["reportedButUnverified", "Reported but unverified"],
  ["inProgress", "In progress"],
  ["needsOwnerDecision", "Needs an owner decision"],
  ["unknown", "Unknown"],
];

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

function ticketRecord(raw) {
  const t = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    id: text(t.id), title: text(t.title), status: text(t.status),
    assignee: text(t.assignee), acceptedBy: text(t.acceptedBy),
    claimedAt: timestamp(t.claimedAt), createdAt: timestamp(t.createdAt), updatedAt: timestamp(t.updatedAt),
    hasDoneVerdict: boolean(t.hasDoneVerdict), unaccepted: boolean(t.unaccepted), staleClaim: boolean(t.staleClaim),
    completion: t.completion && typeof t.completion === "object" ? { verified: boolean(t.completion.verified) } : null,
    verdict: { kind: text(t.lastVerdict?.kind), reference: text(t.lastVerdict?.ref) || text(t.lastVerdict?.reference) },
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

export function buildSessionStandup(items, { sessionId, since, now = Date.now() } = {}) {
  const cutoff = sinceTime(since, now);
  const report = { sessionId, since: cutoff, ...Object.fromEntries(SECTIONS.map(([key]) => [key, []])) };
  for (const item of coalesce(items)) {
    if (cutoff && item.updatedAt && item.updatedAt < cutoff) continue;
    for (const field of ["id", "title", "status", "updatedAt"]) {
      if (item[field] === null) item.unknown.push(field);
    }
    let section = "unknown";
    if (!item.id || item.unknown.includes("conflicting duplicate records") || (cutoff && !item.updatedAt)) {
      // There is not enough evidence to identify or date this work.
    } else if (item.unaccepted === true) {
      section = "needsOwnerDecision";
      if (!item.createdAt) item.unknown.push("createdAt");
    } else if (item.status === "done") {
      section = item.hasDoneVerdict === true && item.verdict.kind && item.verdict.reference
        ? "accepted" : "reportedButUnverified";
      if (item.hasDoneVerdict === null) item.unknown.push("hasDoneVerdict");
      if (!item.verdict.kind) item.unknown.push("verdict.kind");
      if (!item.verdict.reference) item.unknown.push("verdict.reference");
      if (!item.acceptedBy) item.unknown.push("acceptedBy");
    } else if (["working", "in_progress"].includes(item.status)) {
      section = "inProgress";
      for (const field of ["assignee", "claimedAt", "staleClaim"]) {
        if (item[field] === null) item.unknown.push(field);
      }
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
  const sid = urlPathSegment(sessionId, { label: "sessionId" });
  const auth = await resolveAuthSession({ cwd: targetPath, env: process.env, autoRotate: false });
  if (!isAuthenticated(auth) || !auth?.apiUrl) throw new Error("Not authenticated for this session.");
  let body;
  try {
    body = await checkedTransport(requestRead)(`${auth.apiUrl.replace(/\/+$/, "")}/api/v1/sessions/${sid}/tickets`, {
      method: "GET", credential: await credentialFor(auth),
    });
  } catch (error) {
    if (error?.status === 403 || error?.status === 404) {
      throw new Error(`Standup refused (HTTP ${error.status}): this session's tickets are unavailable or you do not have permission to read them.`, { cause: error });
    }
    throw error;
  }
  if (!Array.isArray(body?.items)) throw new Error("The ticket response has no items array; refusing to invent a standup.");
  return buildSessionStandup(body.items, { sessionId, ...(cutoff ? { since: cutoff } : {}), now });
}

export function formatSessionStandup(report) {
  // Keep server text on one terminal line; JSON retains the original values.
  const display = (value) => String(value ?? "unknown").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  const lines = [`Standup ${display(report.sessionId)} · since ${report.since || "all returned records"}`];
  for (const [key, heading] of SECTIONS) {
    lines.push("", heading);
    if (!report[key].length) lines.push("  (none)");
    for (const item of report[key]) {
      let detail = "";
      if (key === "accepted") detail = ` · verdict: ${display(item.verdict.kind)} ${display(item.verdict.reference)} · accepted by: ${display(item.acceptedBy)}`;
      if (key === "reportedButUnverified") detail = " · no re-checkable done verdict";
      if (key === "inProgress") detail = ` · assignee: ${display(item.assignee)} · since: ${display(item.claimedAt)}${item.staleClaim === true ? " · STALE claim" : ""}`;
      if (key === "needsOwnerDecision") detail = ` · created: ${display(item.createdAt)}`;
      const missing = item.unknown.length ? ` · unknown: ${item.unknown.join(", ")}` : "";
      lines.push(`  ${display(item.id)}  ${display(item.title)}${detail}${missing}`);
    }
  }
  return lines.join("\n");
}
