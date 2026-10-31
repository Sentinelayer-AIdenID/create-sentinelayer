import { installSkills, listSkills } from "../skills/install.js";

export function registerSkillsCommand(program) {
  const skills = program.command("skills").description("Install bundled agent skills for Claude Code");
  skills.command("list").description("List the skills included in this CLI package")
    .option("--json", "Emit machine-readable output")
    .action(async (_options, command) => {
      const entries = await listSkills();
      if (command.optsWithGlobals().json) console.log(JSON.stringify({ skills: entries }, null, 2));
      else for (const skill of entries) console.log(`${skill.name}: ${skill.description}`);
    });
  skills.command("install").description("Copy bundled skills into a project or a custom directory")
    .option("--dir <directory>", "Destination skills directory", ".claude/skills")
    .option("--force", "Replace existing bundled files, including user edits")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const json = command.optsWithGlobals().json;
      try {
        const result = await installSkills(options);
        if (json) console.log(JSON.stringify(result, null, 2));
        else {
          for (const file of result.written) console.log(`Wrote ${file}`);
          for (const file of result.unchanged) console.log(`Unchanged ${file}`);
        }
      } catch (error) {
        if (json) console.log(JSON.stringify({ error: error.message }));
        else console.error(error.message);
        process.exitCode = 1;
      }
    });
}
