import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { formatAttachmentSummary } from "../src/session/attachment-summary.js";

function event(attachments, sessionId = "room-test") {
  return { event: "session_message", sessionId, payload: { attachments } };
}

test("Attachment summary: removed metadata overrides status and omits fetch hints", () => {
  for (const status of [undefined, "uploaded"]) {
    const summary = formatAttachmentSummary(event([{
      filename: "notes.txt", attachmentId: "att-file-0001", removed: true, status,
    }]));
    assert.equal(summary, "[attachment: file notes.txt, status removed]");
  }
});

test("Attachment summary: lists the first five files and counts the rest", () => {
  for (const count of [0, 5, 6, 80]) {
    const source = event(Array.from({ length: count }, (_, index) => ({ filename: `file-${index}.txt` })));
    const before = structuredClone(source);
    const summary = formatAttachmentSummary(source);
    assert.equal((summary.match(/\[attachment:/g) || []).length, Math.min(count, 5));
    for (let index = 0; index < Math.min(count, 5); index += 1) {
      assert.ok(summary.includes(`file-${index}.txt`));
    }
    assert.doesNotMatch(summary, /file-5\.txt/);
    assert.equal(summary.endsWith(`+${count - 5} more`), count > 5);
    assert.deepEqual(source, before);
  }
});

test("Attachment summary: strips marker delimiters from every display field", () => {
  const summary = formatAttachmentSummary(event([{
    kind: "[im`age]", filename: "[photo]`<one>.png", status: "<up[load]ed>`",
  }]));
  assert.equal(summary, "[attachment: image photoone.png, status uploaded] (fetch: sl session files room-test)");
});

test("Attachment summary: caps each display field at 255 characters", () => {
  const field = "a".repeat(255);
  const summary = formatAttachmentSummary(event([{
    kind: field + "overflow", filename: field + "overflow", status: field + "overflow",
  }]));
  assert.equal(summary, `[attachment: ${field} ${field}, status ${field}] (fetch: sl session files room-test)`);
});

test("Attachment summary: the display cap preserves complete Unicode code points", () => {
  const field = "a".repeat(254) + "📎";
  const summary = formatAttachmentSummary(event([{ filename: field + "overflow" }]));
  assert.equal(summary, `[attachment: file ${field}] (fetch: sl session files room-test)`);
  assert.equal(summary.isWellFormed(), true);
});

test("Attachment summary: ordinary token and signature filenames remain visible", () => {
  for (const filename of ["signature.pdf", "token-design.md", "bearer-notes.txt"]) {
    assert.equal(formatAttachmentSummary(event([{ filename }])),
      `[attachment: file ${filename}] (fetch: sl session files room-test)`);
  }
});

test("Attachment summary: bearer headers and recognized secrets stay hidden", () => {
  for (const value of ["Bearer " + "example-credential", "Authorization: bEaReR\t" + "example", "sk-" + "x".repeat(24)]) {
    const summary = formatAttachmentSummary(event([{ kind: value, filename: value, status: value }]));
    assert.equal(summary, "[attachment: file unnamed] (fetch: sl session files room-test)");
  }
});

test("Attachment summary: accepts size_bytes and prefers an explicit sizeBytes including zero", () => {
  for (const [size, expected] of [
    [{ size_bytes: 2048 }, "2.0 KB"],
    [{ size_bytes: 2048, sizeBytes: 0 }, "0 B"],
    [{ size_bytes: 2048, sizeBytes: 1024 }, "1.0 KB"],
  ]) {
    assert.equal(formatAttachmentSummary(event([{ filename: "notes.txt", ...size }])),
      `[attachment: file notes.txt, ${expected}] (fetch: sl session files room-test)`);
  }
});

test("Attachment summary: derives a safe pointer id only from the same session", () => {
  const pointer = "/api/v1/sessions/room-test/attachments/att-file-0001";
  const summary = (item, sessionId = "room-test") => formatAttachmentSummary(event([{
    filename: "notes.txt", ...item,
  }], sessionId));
  assert.match(summary({ pointer }), /files get room-test att-file-0001/);
  assert.match(summary({ pointer, attachmentId: "att-explicit-0002" }), /files get room-test att-explicit-0002/);
  for (const invalid of [
    pointer.replace("room-test", "room-other"),
    "https://example.invalid" + pointer,
    pointer + "?download=true", pointer + "/extra", pointer + "#fragment",
    pointer.replace("att-file-0001", "../att-file-0001"),
    pointer.replace("att-file-0001", "att-file;echo"),
    pointer.replace("att-file-0001", "att%2Ffile-0001"),
    pointer.replace("att-file-0001", "short"),
    { url: pointer },
  ]) {
    assert.equal(summary({ pointer: invalid }), "[attachment: file notes.txt] (fetch: sl session files room-test)");
  }
  assert.doesNotMatch(summary({ pointer }, ""), /files get/);
});
