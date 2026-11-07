// Actual scoped mutations; each starts one fresh Node test process and restores
// its source in finally. Run only while this checkout is reserved for the proof.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

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
    'redactString(content, MAX_IMAGE_DESCRIPTION_CHARS * 2)', "redactString(content)", "stream redaction"],
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
  ["allow_nonuploaded_image_description", "src/session/image-descriptions.js",
    'pointer.status !== "uploaded"', "false", "visibility status"],
  ["allow_removed_image_description", "src/session/image-descriptions.js",
    '["removed", "hidden", "deleted", "blocked"]', '["hidden", "deleted", "blocked"]', "visibility removed"],
  ["allow_hidden_image_description", "src/session/image-descriptions.js",
    '["removed", "hidden", "deleted", "blocked"]', '["removed", "deleted", "blocked"]', "visibility hidden"],
  ["allow_deleted_image_description", "src/session/image-descriptions.js",
    '["removed", "hidden", "deleted", "blocked"]', '["removed", "hidden", "blocked"]', "visibility deleted"],
  ["allow_blocked_image_description", "src/session/image-descriptions.js",
    '["removed", "hidden", "deleted", "blocked"]', '["removed", "hidden", "deleted"]', "visibility blocked"],
  ["allow_malformed_visibility_flags", "src/session/image-descriptions.js",
    "pointer[flag] !== undefined && pointer[flag] !== false", "pointer[flag] === true", "visibility hidden"],
  ["retain_rejected_image_stream_json", "src/session/redact.js",
    '      if (attachment && ["description", "descriptionTrust", "descriptionNotice"].includes(key)) continue;\n',
    "", "visibility stream disk"],
  ["trust_caller_stream_notice", "src/session/redact.js",
    '      Object.assign(out, image, {\n',
    '      Object.assign(out, image, {\n        descriptionNotice: value.descriptionNotice,\n', "canonical raw stream notice"],
  ["retain_nonimage_sanitized_fields", "src/session/image-descriptions.js",
    '  if (isAttachmentPointer(value)) {', '  if (value.kind === "image") {', "non-image sanitization"],
  ["retain_nonimage_stream_fields", "src/session/redact.js",
    '    const attachment = isAttachmentPointer(value);', '    const attachment = value.kind === "image";', "non-image stream disk"],
  ["drop_legacy_attachment_alias_filter", "src/session/image-descriptions.js",
    '["attachmentId", "attachment_id"].some', '["attachmentId"].some', "non-image sanitization"],
];
const results = [];
const originals = new Map(mutants.map(([, file]) => [file, fs.readFileSync(file)]));
for (const [name, file, before, after] of mutants) {
  if (before === after || originals.get(file).toString("utf8").split(before).length !== 2) {
    throw new Error(`${name}: expected one exact source anchor`);
  }
}

function restore() {
  for (const [file, bytes] of originals) fs.writeFileSync(file, bytes);
}
for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => { restore(); process.exit(status); });
}
function run(name, pattern) {
  const report = path.join(directory, `${name}.xml`);
  const args = ["--import", "./tests/setup-env.mjs", "--test", "--test-concurrency=1",
    "--test-reporter=tap", "--test-reporter=junit", "--test-reporter-destination=stdout", `--test-reporter-destination=${report}`];
  if (pattern) args.push("--test-name-pattern", `Image descriptions: ${pattern}`);
  args.push("tests/unit.session-image-descriptions.test.mjs");
  const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30_000 });
  fs.writeFileSync(path.join(directory, `${name}.log`), (result.stdout || "") + (result.stderr || ""));
  return { result, report };
}
try {
  const { result: baseline, report } = run("baseline");
  const baselinePasses = Number((baseline.stdout || "").match(/^# pass (\d+)$/m)?.[1] || 0);
  if (baseline.status !== 0 || !baselinePasses || !/^# fail 0$/m.test(baseline.stdout || "")
      || !/^# cancelled 0$/m.test(baseline.stdout || "") || !/^# skipped 0$/m.test(baseline.stdout || "")
      || !fs.existsSync(report)) throw new Error("Unmodified baseline failed; no mutation proof is valid");
  fs.writeFileSync(path.join(directory, "baseline.json"), JSON.stringify({ passed: baselinePasses, status: baseline.status }) + "\n");
  console.log(`baseline: ${baselinePasses} passed, no failures or skips`);
  for (const [name, file, before, after, pattern] of mutants) {
    for (const [source, bytes] of originals) {
      if (!fs.readFileSync(source).equals(bytes)) throw new Error("Checkout changed during reserved mutation proof");
    }
    try {
      fs.writeFileSync(file, originals.get(file).toString("utf8").replace(before, after));
      const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", timeout: 10_000 });
      if (syntax.status !== 0) throw new Error(`${name}: invalid mutation syntax`);
      const { result, report: mutationReport } = run(name, pattern);
      const output = result.stdout || "";
      const namedFailures = [...output.matchAll(/^not ok \d+ - (Image descriptions: .+)$/gm)].length;
      const assertionFailures = [...output.matchAll(/^\s+code: 'ERR_ASSERTION'$/gm)].length;
      const failed = Number(output.match(/^# fail (\d+)$/m)?.[1] || 0);
      const killed = result.status === 1 && namedFailures > 0 && namedFailures === failed
        && assertionFailures === namedFailures && /^# cancelled 0$/m.test(output)
        && /^# skipped 0$/m.test(output) && fs.existsSync(mutationReport);
      results.push({ name, killed, status: result.status, namedFailures, assertionFailures });
      console.log(`${name}: ${killed ? "KILLED" : "SURVIVED/INVALID"} (exit ${result.status})`);
      fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify(results, null, 2) + "\n");
    } finally {
      restore();
    }
  }
  process.exitCode = results.every((result) => result.killed) ? 0 : 1;
} finally {
  restore();
  const restoration = [...originals].map(([file, bytes]) => {
    const actual = fs.readFileSync(file);
    return { file, restored: actual.equals(bytes),
      beforeSha256: createHash("sha256").update(bytes).digest("hex"),
      afterSha256: createHash("sha256").update(actual).digest("hex") };
  });
  fs.writeFileSync(path.join(directory, "restoration.json"), JSON.stringify(restoration, null, 2) + "\n");
  if (!restoration.every((entry) => entry.restored)) throw new Error("Source restoration failed");
}
