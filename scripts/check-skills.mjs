import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { buildCliProgram } from "../src/cli.js";

export function skillCommands(markdown) {
  const commands = new Set();
  const joined = markdown.replace(/\\\r?\n\s*/g, " ");
  for (const line of joined.split(/\r?\n/)) {
    if (/^\s*sl(?:\s|$)/.test(line)) commands.add(line.trim());
    for (const match of line.matchAll(/`(sl(?:\s[^`]*?)?)`/g)) commands.add(match[1]);
  }
  return [...commands];
}

export function validateCommand(example, program) {
  const tokens = example.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
  let command = program;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith("-")) {
      const flag = token.split("=", 1)[0];
      if (["--help", "-h"].includes(flag)) continue;
      let owner = command;
      let option;
      while (owner && !option) {
        option = owner.options.find((item) => item.long === flag || item.short === flag);
        owner = owner.parent;
      }
      if (!option) throw new Error(`Unknown flag ${flag} in ${example}`);
      if (!token.includes("=") && (option.required || option.optional)) {
        if (option.required && (tokens[index + 1] == null || tokens[index + 1].startsWith("--"))) {
          throw new Error(`Missing value for ${flag} in ${example}`);
        }
        if (tokens[index + 1] != null && !tokens[index + 1].startsWith("--")) index += 1;
      }
    } else if (command.commands.length) {
      const child = command.commands.find((item) => item.name() === token || item.aliases().includes(token));
      if (child) command = child;
      else if (!command.registeredArguments.length) throw new Error(`Unknown command ${token} in ${example}`);
    }
  }
}

export async function checkSkills() {
  const program = await buildCliProgram();
  const names = ["senti-agent-identity", "senti-room-listen", "sentinelayer-cli"];
  let count = 0;
  for (const name of names) {
    const markdown = await readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf8");
    const commands = skillCommands(markdown);
    if (!commands.length) throw new Error(`No command examples found in ${name}`);
    for (const command of commands) { validateCommand(command, program); count += 1; }
  }
  const require = createRequire(import.meta.url);
  const { commandArgs } = require("../skills/senti-room-listen/listen-wrapper.cjs");
  for (const args of Object.values(commandArgs("room", "example-agent"))) {
    validateCommand(`sl ${args.join(" ")}`, program);
    count += 1;
  }
  return count;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = await checkSkills();
  console.log(`Validated ${count} skill command examples against the CLI registry.`);
}
