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
