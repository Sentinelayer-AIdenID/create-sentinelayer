import "./setup-env.mjs";
// Unit tests for CLI attachment commands: sl session say --attach and sl session attachment-get.

import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";

function getCommandByPath(program, path) {
  const parts = path.split(" ");
  let current = program;
  for (const part of parts) {
    const found = current.commands.find((c) => c.name() === part);
    if (!found) return null;
    current = found;
  }
  return current;
}

test("CLI: session say registers --attach option (repeatable)", () => {
  const program = new Command();
  program.name("sl").exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerSessionCommand(program);

  const sayCmd = getCommandByPath(program, "session say");
  assert.ok(sayCmd, "session say command must exist");

  const attachOption = sayCmd.options.find((o) => o.long === "--attach");
  assert.ok(attachOption, "--attach option must be registered");
  assert.equal(attachOption.long, "--attach");
});

test("CLI: session attachment-get registers --out and --thumbnail options", () => {
  const program = new Command();
  program.name("sl").exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerSessionCommand(program);

  const getCmd = getCommandByPath(program, "session attachment-get");
  assert.ok(getCmd, "session attachment-get command must exist");

  const options = getCmd.options.map((o) => o.long);
  assert.ok(options.includes("--out"), "--out option must be registered");
  assert.ok(options.includes("--thumbnail"), "--thumbnail option must be registered");
  assert.ok(options.includes("--path"), "--path option must be registered");
  assert.ok(options.includes("--json"), "--json option must be registered");

  const sessionIdArg = getCmd.registeredArguments.find((a) => a.name() === "sessionId");
  assert.ok(sessionIdArg, "must have sessionId argument");
  assert.equal(sessionIdArg.required, true);

  const attachmentIdArg = getCmd.registeredArguments.find((a) => a.name() === "attachmentId");
  assert.ok(attachmentIdArg, "must have attachmentId argument");
  assert.equal(attachmentIdArg.required, true);
});

test("CLI: session attachment-get requires both arguments", () => {
  const program = new Command();
  program.name("sl").exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerSessionCommand(program);

  assert.throws(
    () => program.parse(["session", "attachment-get"], { from: "user" }),
    "should throw for missing required arguments",
  );
});

test("CLI: session say --attach: localOnly is declared before attachment loop", async () => {
  // Regression: localOnly was used at line 3945 before its let declaration at 3994,
  // causing a TDZ ReferenceError. The fix moves 'let localOnly' above the loop.
  // This test verifies the source ordering directly.
  const fs = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");

  const srcPath = fileURLToPath(new URL("../src/commands/session.js", import.meta.url));
  const src = fs.readFileSync(srcPath, "utf-8");

  const localOnlyDeclIdx = src.search(/let localOnly/);
  const forLoopIdx = src.search(/for \(const attachPath/);

  assert.ok(localOnlyDeclIdx >= 0, "let localOnly declaration must exist");
  assert.ok(forLoopIdx >= 0, "for (const attachPath loop must exist");
  assert.ok(
    localOnlyDeclIdx < forLoopIdx,
    "let localOnly must be declared before the attachment processing loop (was TDZ bug)",
  );
});
