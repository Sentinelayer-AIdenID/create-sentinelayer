import path from "node:path";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";

const SKILLS_ROOT = fileURLToPath(new URL("../../skills/", import.meta.url));
const SKILL_NAMES = ["senti-agent-identity", "senti-room-listen", "sentinelayer-cli"];

export async function listSkills() {
  return Promise.all(SKILL_NAMES.map(async (name) => {
    const text = await readFile(path.join(SKILLS_ROOT, name, "SKILL.md"), "utf8");
    const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const metadata = header && parse(header[1]);
    if (metadata?.name !== name || typeof metadata.description !== "string" || !metadata.description.trim()) {
      throw new Error(`Invalid bundled skill metadata: ${name}`);
    }
    return { name, description: metadata.description };
  }));
}

async function statOrMissing(file) {
  try { return await lstat(file); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function assertDirectory(dir) {
  const info = await statOrMissing(dir);
  if (info?.isSymbolicLink()) throw new Error(`Refusing symbolic link destination: ${dir}`);
  if (info && !info.isDirectory()) throw new Error(`Destination is not a directory: ${dir}`);
}

async function collectFiles(dir, prefix = "") {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path.join(dir, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported bundled skill file: ${relative}`);
  }
  return files.sort();
}

async function checkTarget(root, relative) {
  const target = path.resolve(root, relative);
  const contained = path.relative(root, target);
  if (!contained || contained === ".." || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) {
    throw new Error(`Skill path escapes destination: ${relative}`);
  }
  let parent = root;
  await assertDirectory(parent);
  for (const part of path.dirname(relative).split(path.sep)) {
    parent = path.join(parent, part);
    await assertDirectory(parent);
  }
  const info = await statOrMissing(target);
  if (info?.isSymbolicLink()) throw new Error(`Refusing symbolic link destination: ${target}`);
  if (info && !info.isFile()) throw new Error(`Destination is not a regular file: ${target}`);
  return { target, exists: Boolean(info) };
}

export async function installSkills({ dir = ".claude/skills", force = false, cwd = process.cwd() } = {}) {
  if (typeof dir !== "string" || !dir.trim()) throw new Error("Skill destination must be a nonempty directory path.");
  const destination = path.resolve(cwd, dir);
  const skills = await listSkills();
  const plan = [];
  // Check the whole bundle before touching any file, so one edited skill cannot
  // leave the other skills at a different version after a refused install.
  for (const { name } of skills) {
    for (const file of await collectFiles(path.join(SKILLS_ROOT, name))) {
      const relative = path.join(name, file);
      const source = path.join(SKILLS_ROOT, relative);
      const { target, exists } = await checkTarget(destination, relative);
      const identical = exists && (await readFile(source)).equals(await readFile(target));
      if (exists && !identical && !force) {
        throw new Error(`Refusing to overwrite ${target}. Back up your edits and use --force to replace bundled files.`);
      }
      plan.push({ source, target, relative, identical });
    }
  }
  const written = [];
  const unchanged = [];
  for (const item of plan) {
    if (item.identical) { unchanged.push(item.target); continue; }
    await checkTarget(destination, item.relative);
    await mkdir(path.dirname(item.target), { recursive: true });
    if (force) {
      // Rename a new file instead of truncating the old one: a hard link cannot
      // cause --force to change an unrelated file's contents.
      const temporary = `${item.target}.${randomUUID()}.tmp`;
      try {
        await copyFile(item.source, temporary, constants.COPYFILE_EXCL);
        await checkTarget(destination, item.relative);
        await rename(temporary, item.target);
      } finally { await rm(temporary, { force: true }); }
    } else {
      await copyFile(item.source, item.target, constants.COPYFILE_EXCL);
    }
    written.push(item.target);
  }
  return { destination, skills: skills.map(({ name }) => name), written, unchanged };
}
