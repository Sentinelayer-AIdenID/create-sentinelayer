import { installSkills, listSkills } from "../skills/service.js";

export function registerSkillsCommand(program) {
  const skills = program.command("skills").description("Install and inspect bundled Senti agent skills");
  for (const action of ["install", "list"]) {
    const command = skills.command(action === "install" ? "install [names...]" : action)
      .description(action === "install"
        ? "Install bundled skills (all, or only the named ones) without replacing local edits"
        : "List bundled and installed skill versions and SHA-256 hashes")
      .option("--dir <path>", "Skills directory (default: ~/.claude/skills)")
      .option("--json", "Emit machine-readable output");
    if (action === "install") command.option("--force", "Replace differing local files");
    command.action(async (...args) => {
      const invoked = args.at(-1);
      const options = args.at(-2);
      const names = action === "install" ? args[0] : undefined;
      const json = Boolean(invoked.optsWithGlobals().json);
      try {
        const result = await (action === "install" ? installSkills({ ...options, names }) : listSkills(options));
        if (json) {
          console.log(JSON.stringify({ command: `skills ${action}`, ...result }, null, 2));
          return;
        }
        console.log(`Skills directory: ${result.directory}`);
        for (const skill of result.skills) {
          if (action === "install") {
            console.log(`${skill.name} ${skill.version}: ${skill.written} written, ${skill.unchanged} unchanged (sha256 ${skill.hash})`);
          } else {
            console.log(`${skill.name}: ${skill.status}`);
            console.log(`  bundled: ${skill.bundled.version} sha256 ${skill.bundled.hash}`);
            console.log(skill.installed ? `  installed: ${skill.installed.version || "unknown"} sha256 ${skill.installed.hash}` : "  installed: none");
            if (skill.error) console.log(`  error: ${skill.error}`);
          }
        }
      } catch (error) {
        if (json) console.log(JSON.stringify({ command: `skills ${action}`, error: {
          code: error.code || "SKILLS_ERROR", message: error.message,
          ...(error.files ? { files: error.files } : {}),
        } }, null, 2));
        else console.error(error.message);
        process.exitCode = 1;
      }
    });
  }
}
