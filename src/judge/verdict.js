// judge-verdict v1: the document a judging model posts back to a coder.
//
// One schema, enforced the same way by this CLI and by the SentinelLayer API (the shared
// agreement cases live in tests/fixtures/judge-verdict-cases.json). The judge is never named
// in the document: the server records who judged from the credential or the stored post.

export const JUDGE_VERDICT_KIND = "judge-verdict";
export const JUDGE_VERDICT_VERSION = 1;
export const JUDGE_VERDICT_MAX_BYTES = 32768;
export const JUDGE_VERDICT_DEFAULT_MAX_ROUNDS = 3;
export const JUDGE_VERDICT_SEVERITIES = Object.freeze(["P0", "P1", "P2", "P3"]);
export const JUDGE_VERDICT_TARGET_TYPES = Object.freeze(["pr", "ticket", "message"]);

const TOP_KEYS = new Set([
  "kind", "version", "verdict", "round", "maxRounds", "target", "coder", "summary", "comments",
  "escalate", "doNotTrain",
]);
const TARGET_KEYS = new Set(["type", "ref", "sha"]);
const COMMENT_KEYS = new Set(["file", "line", "severity", "text", "fix"]);
const MAX_ROUNDS_LIMIT = 10;
const MAX_COMMENTS = 50;
const MAX_LINE = 10_000_000;
const PR_REF_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}#[1-9][0-9]{0,9}$/;
const MESSAGE_REF_RE = /^[1-9][0-9]{0,18}$/;
const SHA_RE = /^[0-9a-fA-F]{7,64}$/;
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Control characters are U+0000..U+001F and U+007F. Multi-line text may keep \t \n \r.
const ANY_CONTROL_RE = /[\u0000-\u001f\u007f]/;
const TEXT_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ASCII_EDGE_WHITESPACE_RE = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;
// The fenced-block scanner works line by line, so its cost is linear in the message whatever the
// message holds (an unclosed fence included). Each pattern is tested on one line, never the text.
const FENCE_OPEN_RE = /^```(?:judge-verdict|json)[ \t]*$/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;
export const JUDGE_VERDICT_BLOCK_MAX_BYTES = 64 * 1024;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function trimAscii(value) {
  return value.replace(ASCII_EDGE_WHITESPACE_RE, "");
}

function codePoints(value) {
  return [...value].length;
}

function isWholeNumber(value) {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * Validate a judge-verdict document.
 *
 * Returns `{ ok: true, verdict }` with the normalized document (strings trimmed, defaults
 * filled, sha lowercased), or `{ ok: false, errors }` where each error is `{ path, message }`.
 */
export function validateJudgeVerdict(document) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });

  if (!isPlainObject(document)) {
    return { ok: false, errors: [{ path: "", message: "must be a JSON object" }] };
  }
  let serialized;
  try {
    serialized = JSON.stringify(document);
  } catch {
    return { ok: false, errors: [{ path: "", message: "must be serializable JSON" }] };
  }
  if (Buffer.byteLength(serialized, "utf8") > JUDGE_VERDICT_MAX_BYTES) {
    return { ok: false, errors: [{ path: "", message: `must be at most ${JUDGE_VERDICT_MAX_BYTES} bytes as compact JSON` }] };
  }
  for (const key of Object.keys(document)) {
    if (!TOP_KEYS.has(key)) fail(key, "is not a judge-verdict field (the judge is never named in the document)");
  }

  const text = (path, value, { min, max, multiline = false, required = true }) => {
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string") {
      fail(path, "must be a string");
      return undefined;
    }
    if ((multiline ? TEXT_CONTROL_RE : ANY_CONTROL_RE).test(value)) {
      fail(path, multiline ? "must not contain control characters other than tab and newline" : "must not contain control characters");
      return undefined;
    }
    const trimmed = trimAscii(value);
    const length = codePoints(trimmed);
    if (length < min || length > max) {
      fail(path, min > 0 ? `must be ${min}..${max} characters` : `must be at most ${max} characters`);
      return undefined;
    }
    return trimmed;
  };
  const integer = (path, value, min, max) => {
    if (!isWholeNumber(value) || value < min || value > max) {
      fail(path, `must be an integer ${min}..${max}`);
      return undefined;
    }
    return value;
  };
  const flag = (path, value) => {
    if (value === undefined) return false;
    if (typeof value !== "boolean") {
      fail(path, "must be true or false");
      return false;
    }
    return value;
  };

  if (document.kind !== JUDGE_VERDICT_KIND) fail("kind", `must be "${JUDGE_VERDICT_KIND}"`);
  if (document.version !== JUDGE_VERDICT_VERSION) fail("version", `must be ${JUDGE_VERDICT_VERSION}`);
  const verdict = document.verdict;
  if (verdict !== "ACCEPT" && verdict !== "CHANGES") fail("verdict", 'must be "ACCEPT" or "CHANGES"');
  const round = integer("round", document.round, 1, MAX_ROUNDS_LIMIT);
  const maxRounds = document.maxRounds === undefined
    ? JUDGE_VERDICT_DEFAULT_MAX_ROUNDS
    : integer("maxRounds", document.maxRounds, 1, MAX_ROUNDS_LIMIT);
  if (round !== undefined && maxRounds !== undefined && round > maxRounds) {
    fail("round", "must not exceed maxRounds");
  }

  let target;
  if (!isPlainObject(document.target)) {
    fail("target", "must be an object with type and ref");
  } else {
    for (const key of Object.keys(document.target)) {
      if (!TARGET_KEYS.has(key)) fail(`target.${key}`, "is not a target field");
    }
    const type = document.target.type;
    if (!JUDGE_VERDICT_TARGET_TYPES.includes(type)) fail("target.type", 'must be "pr", "ticket" or "message"');
    const ref = text("target.ref", document.target.ref, { min: 1, max: 200 });
    if (ref !== undefined && type === "pr" && !PR_REF_RE.test(ref)) fail("target.ref", "must look like owner/repo#123");
    if (ref !== undefined && type === "message" && !MESSAGE_REF_RE.test(ref)) {
      fail("target.ref", "must be the message's sequence id");
    }
    let sha;
    if (document.target.sha !== undefined) {
      sha = text("target.sha", document.target.sha, { min: 1, max: 64 });
      if (sha !== undefined && !SHA_RE.test(sha)) {
        fail("target.sha", "must be 7..64 hex characters");
        sha = undefined;
      }
    } else if (type === "pr") {
      fail("target.sha", "is required for a pr target (the exact head you judged)");
    }
    target = { type, ref, ...(sha !== undefined ? { sha: sha.toLowerCase() } : {}) };
  }

  const coder = text("coder", document.coder, { min: 1, max: 64 });
  if (coder !== undefined && (!AGENT_ID_RE.test(coder) || coder.toLowerCase().startsWith("human-"))) {
    fail("coder", "must be the coding agent's id");
  }
  const summary = text("summary", document.summary, { min: 1, max: 2000, multiline: true });

  const comments = [];
  if (!Array.isArray(document.comments)) {
    fail("comments", "must be an array");
  } else if (document.comments.length > MAX_COMMENTS) {
    fail("comments", `must have at most ${MAX_COMMENTS} entries`);
  } else {
    document.comments.forEach((comment, index) => {
      const at = `comments[${index}]`;
      if (!isPlainObject(comment)) {
        fail(at, "must be an object with file, line, severity and text");
        return;
      }
      for (const key of Object.keys(comment)) {
        if (!COMMENT_KEYS.has(key)) fail(`${at}.${key}`, "is not a comment field");
      }
      const file = text(`${at}.file`, comment.file, { min: 1, max: 300 });
      const line = integer(`${at}.line`, comment.line, 0, MAX_LINE);
      const severity = comment.severity;
      if (!JUDGE_VERDICT_SEVERITIES.includes(severity)) fail(`${at}.severity`, "must be P0, P1, P2 or P3");
      const body = text(`${at}.text`, comment.text, { min: 1, max: 2000, multiline: true });
      const fix = text(`${at}.fix`, comment.fix, { min: 0, max: 500, multiline: true, required: false });
      comments.push({ file, line, severity, text: body, ...(fix !== undefined ? { fix } : {}) });
    });
  }

  const escalate = flag("escalate", document.escalate);
  const doNotTrain = flag("doNotTrain", document.doNotTrain);
  if (verdict === "CHANGES" && Array.isArray(document.comments) && document.comments.length === 0) {
    fail("comments", "CHANGES needs at least one comment");
  }
  if (verdict === "ACCEPT" && comments.some((comment) => comment.severity === "P0" || comment.severity === "P1")) {
    fail("verdict", "ACCEPT cannot carry a P0 or P1 comment");
  }
  if (escalate && verdict !== "CHANGES") fail("escalate", "only a CHANGES verdict escalates");
  if (verdict === "CHANGES" && round !== undefined && maxRounds !== undefined && round === maxRounds && !escalate) {
    fail("escalate", "the last round's CHANGES verdict must escalate to the human");
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    verdict: {
      kind: JUDGE_VERDICT_KIND,
      version: JUDGE_VERDICT_VERSION,
      verdict,
      round,
      maxRounds,
      target,
      coder,
      summary,
      comments,
      escalate,
      doNotTrain,
    },
  };
}

export function formatJudgeVerdictErrors(errors = []) {
  return errors.map((error) => (error.path ? `${error.path} ${error.message}` : error.message)).join("; ");
}

function targetLabel(target) {
  if (target.type === "pr") return `${target.ref} @ ${target.sha.slice(0, 12)}`;
  if (target.type === "message") return `message #${target.ref}${target.sha ? ` @ ${target.sha.slice(0, 12)}` : ""}`;
  return `ticket ${target.ref}${target.sha ? ` @ ${target.sha.slice(0, 12)}` : ""}`;
}

export function formatJudgeVerdictBlock(verdict) {
  return ["```judge-verdict", JSON.stringify(verdict), "```"].join("\n");
}

/**
 * Render a validated verdict as the room message the coder receives: the mention that wakes
 * the coder, the numbered comments in plain words, and the machine-readable block.
 */
export function renderJudgeVerdictMessage(verdict, { escalateTo = [] } = {}) {
  const mentions = [`@${verdict.coder}`];
  if (verdict.escalate) {
    for (const handle of escalateTo) mentions.push(`@${handle}`);
  }
  const lines = [
    `${mentions.join(" ")} Judge verdict: ${verdict.verdict} (round ${verdict.round} of ${verdict.maxRounds}) on ${targetLabel(verdict.target)}`,
    verdict.summary,
  ];
  if (verdict.comments.length) {
    lines.push("");
    verdict.comments.forEach((comment, index) => {
      const where = comment.line > 0 ? `${comment.file}:${comment.line}` : comment.file;
      lines.push(`${index + 1}. [${comment.severity}] ${where} - ${comment.text}`);
      if (comment.fix) lines.push(`   Fix: ${comment.fix}`);
    });
  }
  lines.push("");
  if (verdict.escalate) {
    lines.push(`Round limit reached. Stopping the loop here; a human decides what happens next.`);
  } else if (verdict.verdict === "CHANGES") {
    lines.push(`Fix each numbered comment, then reply with the new head and what changed per number. I will re-check every one.`);
  } else {
    lines.push(`Accepted. No further rounds.`);
  }
  lines.push("", formatJudgeVerdictBlock(verdict));
  return lines.join("\n");
}

/**
 * Find the judge-verdict block in a room message. Returns `{ status, document }` where status
 * is "none", "one" or "ambiguous" (more than one block: nothing is taken). The document is
 * returned unvalidated; pass it to validateJudgeVerdict.
 *
 * A block opens at a line that is exactly ```judge-verdict or ```json (trailing spaces or tabs
 * allowed) and closes at the next line that is exactly ```. An opener with no closing line ends
 * the scan. A block body over JUDGE_VERDICT_BLOCK_MAX_BYTES (UTF-8) is skipped unparsed, and the
 * scan stops at the second candidate. The API runs the same algorithm against the same vectors
 * (tests/fixtures/judge-verdict-block-cases.json).
 */
export function extractJudgeVerdictBlock(message) {
  const text = typeof message === "string" ? message : "";
  // Every candidate carries "kind": "judge-verdict", so a message without the word has none.
  if (!text.includes(JUDGE_VERDICT_KIND)) return { status: "none", document: null };
  const lines = text.split("\n");
  const line = (index) => (lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index]);
  let document = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (!FENCE_OPEN_RE.test(line(index))) continue;
    const body = [];
    let bytes = 0;
    let close = index + 1;
    for (; close < lines.length; close += 1) {
      const current = line(close);
      if (FENCE_CLOSE_RE.test(current)) break;
      bytes += Buffer.byteLength(current, "utf8") + (close > index + 1 ? 1 : 0);
      if (bytes <= JUDGE_VERDICT_BLOCK_MAX_BYTES) body.push(current);
    }
    if (close >= lines.length) break;
    index = close;
    if (bytes > JUDGE_VERDICT_BLOCK_MAX_BYTES) continue;
    let parsed;
    try {
      parsed = JSON.parse(body.join("\n"));
    } catch {
      continue;
    }
    if (!isPlainObject(parsed) || parsed.kind !== JUDGE_VERDICT_KIND) continue;
    if (document) return { status: "ambiguous", document: null };
    document = parsed;
  }
  return document ? { status: "one", document } : { status: "none", document: null };
}
