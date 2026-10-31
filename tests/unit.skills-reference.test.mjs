import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildCliProgram } from "../src/cli.js";
import { checkSkills, skillCommands, validateCommand } from "../scripts/check-skills.mjs";

test("all shipped skill examples and wrapper arguments match the live command registry", async () => {
  assert.ok(await checkSkills() > 30);
});

test("drift check detects a removed documented flag and unknown commands", async () => {
  const program = await buildCliProgram();
  const markdown = await readFile(new URL("../skills/senti-agent-identity/SKILL.md", import.meta.url), "utf8");
  const joinExample = skillCommands(markdown).find((line) => line.includes("--ttl"));
  assert.ok(joinExample);
  validateCommand(joinExample, program);
  const session = program.commands.find((command) => command.name() === "session");
  const join = session.commands.find((command) => command.name() === "join");
  join.options = join.options.filter((option) => option.long !== "--ttl");
  assert.throws(() => validateCommand(joinExample, program), /Unknown flag --ttl/);
  assert.throws(() => validateCommand("sl session missing-command --json", program), /Unknown command/);
  assert.throws(() => validateCommand("sl skills install --missing-option", program), /Unknown flag/);
});
