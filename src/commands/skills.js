import process from "node:process";

import pc from "picocolors";

import { SkillsInstallError, installSkills, listSkills } from "../skills/install.js";
import { preferredCliCommand } from "../ui/command-hints.js";

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function clip(text, max) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function reportFailure(commandName, error, emitJson) {
  const code = error instanceof SkillsInstallError ? error.code : "unexpected_error";
  const message = error instanceof Error ? error.message : String(error);
  if (emitJson) {
    const conflicts = error instanceof SkillsInstallError ? error.details?.conflicts : undefined;
    console.log(
      JSON.stringify({ ok: false, command: commandName, error: { code, message, ...(conflicts ? { conflicts } : {}) } }, null, 2)
    );
  } else {
    console.error(pc.red(`${commandName}: ${message}`));
  }
  process.exitCode = 1;
}

const STATUS_LABELS = {
  installed: pc.green("installed"),
  changed: pc.yellow("installed, differs from this version (install --force replaces it)"),
  "not-installed": pc.gray("not installed"),
  blocked: pc.red("blocked (something else is at that path)"),
};

export function registerSkillsCommand(program) {
  const skills = program
    .command("skills")
    .description("Install the Senti agent skills bundled with this CLI (no login needed)");

  skills
    .command("install")
    .description(
      "Install the bundled skills for an agent: Claude Code (~/.claude/skills, default), Codex (~/.agents/skills) or any folder"
    )
    .option("--target <agent>", "Agent to install for: claude (default) or codex")
    .option("--dir <path>", "Install into this skills folder instead (any agent)")
    .option("--force", "Replace an existing copy of these skills (a folder with a SKILL.md); edits to it are lost")
    .option("--dry-run", "Show what would be written, and write nothing")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      let result;
      try {
        result = await installSkills({
          target: options.target,
          dir: options.dir,
          force: Boolean(options.force),
          dryRun: Boolean(options.dryRun),
        });
      } catch (error) {
        reportFailure("skills install", error, emitJson);
        return;
      }

      if (emitJson) {
        console.log(JSON.stringify({ ok: true, command: "skills install", ...result }, null, 2));
        return;
      }

      const changed = result.skills.filter((skill) => skill.action !== "unchanged").length;
      const count = plural(result.skills.length, "Senti skill");
      if (result.dryRun) {
        console.log(pc.bold(`Dry run, nothing was written. ${count} for ${result.agent}:`));
      } else if (changed === 0) {
        console.log(pc.bold(pc.green(`All ${count} are already installed for ${result.agent}, identical to this version:`)));
      } else {
        const unchanged = result.skills.length - changed;
        const note = unchanged > 0 ? ` (${unchanged} already identical)` : "";
        console.log(pc.bold(pc.green(`Installed ${plural(changed, "Senti skill")} for ${result.agent}${note}:`)));
      }
      const labels = {
        installed: "installed",
        replaced: "replaced",
        unchanged: "already installed, identical",
        "would-install": "would install",
        "would-replace": "would replace",
      };
      for (const skill of result.skills) {
        console.log(`  ${skill.name} -> ${skill.path} (${labels[skill.action] || skill.action})`);
        if (skill.action === "unchanged") continue;
        for (const file of skill.files) {
          console.log(pc.gray(`      ${file.path} (${plural(file.bytes, "byte")})`));
        }
      }
      console.log(pc.gray("Every file matched this package's manifest (sha256) before anything was written."));
      if (!result.dryRun) {
        console.log("");
        console.log(`Next: ${result.next}`);
      }
    });

  skills
    .command("list")
    .description("List the bundled skills and whether each is installed for an agent")
    .option("--target <agent>", "Agent to check: claude (default) or codex")
    .option("--dir <path>", "Check this skills folder instead")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      let result;
      try {
        result = await listSkills({ target: options.target, dir: options.dir });
      } catch (error) {
        reportFailure("skills list", error, emitJson);
        return;
      }

      if (emitJson) {
        console.log(JSON.stringify({ ok: true, command: "skills list", ...result }, null, 2));
        return;
      }

      console.log(pc.bold(`Senti skills bundled with this CLI, for ${result.agent} (${result.targetDir}):`));
      for (const skill of result.skills) {
        console.log(`  ${skill.name}: ${STATUS_LABELS[skill.status] || skill.status}`);
        console.log(pc.gray(`      ${clip(skill.description, 140)}`));
      }
      if (result.skills.some((skill) => skill.status === "not-installed")) {
        const where =
          result.target === "claude" ? "" : result.target === "dir" ? ` --dir ${JSON.stringify(result.targetDir)}` : ` --target ${result.target}`;
        console.log("");
        console.log(`Install them with: ${preferredCliCommand()} skills install${where}`);
      }
    });
}
