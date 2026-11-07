// Actual scoped mutations; each starts one fresh Node test process and restores
// its source in finally. Run only while this checkout is reserved for the proof.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const outputIndex = process.argv.indexOf("--evidence-dir");
if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw new Error("--evidence-dir is required");
const directory = path.resolve(process.argv[outputIndex + 1]);
fs.mkdirSync(directory, { recursive: true });
const mutants = [
  ["drop_quoted_summary", "src/session/attachment-summary.js",
    'return `${marker} (fetch: ${fetch})${description}`;', 'return `${marker} (fetch: ${fetch})`;', "full OCR"],
  ["drop_file_description", "src/session/room-files.js",
    "    ...imageDescriptionFields(pointer),", "", "room file metadata"],
  ["truncate_ocr_in_stream", "src/session/redact.js",
    'if (key === "description" && image.description) {', "if (false) {", "stream redaction"],
  ["trust_caller_marker", "src/session/image-descriptions.js",
    'pointer.descriptionTrust !== "quoted_untrusted"', "false", "legacy, removed"],
  ["allow_closing_tags", "src/session/image-descriptions.js",
    'const quoted = JSON.stringify(description).replace(/[<>&\\u2028\\u2029]/g,\n    (character) => `\\\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);',
    "const quoted = JSON.stringify(description);", "full OCR"],
  ["cut_quoted_wake_in_half", "src/session/wake/resolve-target.js",
    'formatAttachmentSummary(event, { includeImageDescriptions: false }).slice(0, attachmentBudget)',
    "fullAttachments.slice(0, attachmentBudget)", "host wake"],
  ["stop_redacting_ocr_secrets", "src/session/image-descriptions.js",
    "visibleText: redactString(source.visibleText, MAX_IMAGE_DESCRIPTION_CHARS * 2, IMAGE_REDACTION),",
    "visibleText: source.visibleText,", "direct quote"],
  ["expand_redaction_at_size_boundary", "src/session/image-descriptions.js",
    "Object.freeze({ nonExpanding: true })", "Object.freeze({ nonExpanding: false })", "boundary"],
  ["accept_oversized_ocr", "src/session/image-descriptions.js",
    "Array.from(source.text).length + Array.from(source.visibleText).length > MAX_IMAGE_DESCRIPTION_CHARS", "false",
    "legacy, removed"],
  ["bypass_poll_ocr_filter", "src/session/sync.js", "acceptedEvents.push(sanitizeImageDescriptions(item));",
    "acceptedEvents.push(item);", "direct poll"],
  ["bypass_history_ocr_filter", "src/session/sync.js", "const safeEvents = sanitizeImageDescriptions(payload?.events || []);",
    "const safeEvents = payload?.events || [];", "direct history"],
  ["bypass_raw_mcp_ocr_filter", "src/session/attachment-summary.js", "event = sanitizeImageDescriptions(event);",
    "event = event;", "MCP read_history raw=true filters"],
  ["bypass_summary_mcp_ocr_filter", "src/mcp/session-stdio-server.js", "const next = sanitizeImageDescriptions(payload);",
    "const next = { ...payload };", "MCP read_history raw=false filters"],
  ["bypass_listen_ocr_filter", "src/session/listener.js", "await onEvent(sanitizeImageDescriptions(event));",
    "await onEvent(event);", "listen poll filters"],
  ["drop_thread_image_pointer", "src/mcp/session-stdio-server.js", "    attachments: attachments.length ? attachments : undefined,\n",
    "", "MCP read_history raw=false keeps thread-only"],
  ["drop_thread_image_quote", "src/mcp/session-stdio-server.js", "    attachmentSummary: attachmentSummary || undefined,\n",
    "", "MCP read_history raw=false keeps thread-only"],
  ["bypass_action_ocr_filter", "src/session/sync.js",
    "const actions = Array.isArray(payload?.actions) ? sanitizeImageDescriptions(payload.actions) : [];",
    "const actions = Array.isArray(payload?.actions) ? payload.actions : [];", "direct actions"],
  ["bypass_projection_ocr_filter", "src/session/sync.js", "? sanitizeImageDescriptions(payload.projection)",
    "? payload.projection", "direct actions"],
];
const results = [];
for (const [name, file, before, after, pattern] of mutants) {
  const original = fs.readFileSync(file, "utf8");
  if (original.split(before).length !== 2) throw new Error(`${name}: expected one exact source anchor`);
  try {
    fs.writeFileSync(file, original.replace(before, after));
    const result = spawnSync(process.execPath, ["--import", "./tests/setup-env.mjs", "--test", "--test-concurrency=1",
      "--test-name-pattern", `Image descriptions: ${pattern}`, "tests/unit.session-image-descriptions.test.mjs"],
    { encoding: "utf8", timeout: 30_000 });
    fs.writeFileSync(path.join(directory, `${name}.log`), (result.stdout || "") + (result.stderr || ""));
    const killed = result.status === 1;
    results.push({ name, killed, status: result.status });
    console.log(`${name}: ${killed ? "KILLED" : "SURVIVED/INVALID"} (exit ${result.status})`);
  } finally {
    fs.writeFileSync(file, original);
  }
}
fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify(results, null, 2) + "\n");
process.exitCode = results.every((result) => result.killed) ? 0 : 1;
