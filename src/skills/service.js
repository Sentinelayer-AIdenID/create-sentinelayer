import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "yaml";

const BUNDLE_ROOT = fileURLToPath(new URL("../../skills/", import.meta.url));
const SKILL_NAMES = ["senti-agent-identity", "senti-room-notifications", "sentinelayer-cli", "senti-judge", "omar-gate-setup"];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function statOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function unsafePath(filePath) {
  return Object.assign(new Error(`Expected a regular file or directory, not a link: ${filePath}`), {
    code: "SKILLS_UNSAFE_PATH",
  });
}

async function readTree(directory) {
  const rootStat = await statOrNull(directory);
  if (!rootStat) return null;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw unsafePath(directory);
  const files = [];
  async function visit(relative) {
    const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files.push({ name, content: await fs.readFile(fullPath) });
      else throw unsafePath(fullPath);
    }
  }
  await visit("");
  return files;
}

function describe(files) {
  const document = files.find((file) => file.name === "SKILL.md")?.content.toString("utf8") || "";
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document);
  let version = null;
  try {
    const value = frontmatter ? parse(frontmatter[1])?.metadata?.version : null;
    if (typeof value === "string") version = value;
  } catch {
    // Locally edited frontmatter can be invalid; its content hash still reports the change.
  }
  return {
    version,
    hash: sha256(JSON.stringify(files.map((file) => [file.name, sha256(file.content)]))),
  };
}

function resolveDirectory(dir) {
  if (dir === undefined) return path.join(os.homedir(), ".claude", "skills");
  if (typeof dir !== "string" || !dir.trim()) throw new Error("--dir must be a nonempty path.");
  return path.resolve(dir);
}

// Check every component below the chosen destination, including dangling symlinks.
async function inspectPath(root, destination) {
  const relative = path.relative(root, destination);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw unsafePath(destination);
  }
  const components = relative ? relative.split(path.sep) : [];
  let current = root;
  for (let index = 0; index <= components.length; index += 1) {
    const stat = await statOrNull(current);
    if (stat && (stat.isSymbolicLink() || (index < components.length && !stat.isDirectory()))) {
      throw unsafePath(current);
    }
    if (index === components.length) return stat;
    current = path.join(current, components[index]);
  }
}

async function loadBundle() {
  return Promise.all(SKILL_NAMES.map(async (name) => {
    const files = await readTree(path.join(BUNDLE_ROOT, name));
    if (!files?.some((file) => file.name === "SKILL.md")) {
      throw new Error(`Bundled skill is missing SKILL.md: ${name}`);
    }
    const metadata = describe(files);
    if (!metadata.version) throw new Error(`Bundled skill is missing a version: ${name}`);
    return { name, files, ...metadata };
  }));
}

async function replaceFile(source, destination) {
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      if (!["EPERM", "EBUSY"].includes(error.code) || Date.now() >= deadline) throw error;
      await delay(25);
    }
  }
}

export async function listSkills({ dir } = {}) {
  const directory = resolveDirectory(dir);
  const skills = [];
  for (const bundle of await loadBundle()) {
    const destination = path.join(directory, bundle.name);
    let installed = null;
    let error = null;
    try {
      await inspectPath(directory, destination);
      const files = await readTree(destination);
      if (files) installed = describe(files);
    } catch (caught) {
      error = caught.message;
    }
    skills.push({
      name: bundle.name,
      bundled: { version: bundle.version, hash: bundle.hash },
      installed,
      status: error ? "invalid" : !installed ? "not-installed" :
        installed.hash === bundle.hash ? "installed" : "modified",
      ...(error ? { error } : {}),
    });
  }
  return { directory, skills };
}

export async function installSkills({ dir, force = false } = {}) {
  const directory = resolveDirectory(dir);
  const bundles = await loadBundle();
  const plan = [];
  const conflicts = [];
  // Preflight the entire bundle so a conflict in the last skill cannot leave a partial install.
  for (const bundle of bundles) {
    for (const file of bundle.files) {
      const destination = path.join(directory, bundle.name, file.name);
      const stat = await inspectPath(directory, destination);
      if (stat && !stat.isFile()) throw unsafePath(destination);
      const unchanged = stat ? (await fs.readFile(destination)).equals(file.content) : false;
      if (stat && !unchanged && !force) conflicts.push(destination);
      plan.push({ bundle, file, destination, unchanged, exists: Boolean(stat) });
    }
  }
  if (conflicts.length) {
    throw Object.assign(new Error(`Local skill files differ; use --force to replace them:\n${conflicts.join("\n")}`), {
      code: "SKILLS_CONFLICT", files: conflicts,
    });
  }
  for (const item of plan) {
    if (item.unchanged) continue;
    await fs.mkdir(path.dirname(item.destination), { recursive: true });
    await inspectPath(directory, item.destination);
    if (!item.exists) {
      // Exclusive creation also protects a file created after preflight.
      await fs.copyFile(path.join(BUNDLE_ROOT, item.bundle.name, item.file.name), item.destination, constants.COPYFILE_EXCL);
    } else {
      const temporary = path.join(path.dirname(item.destination), `.skill-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, item.file.content, { flag: "wx" });
        // Replace the directory entry rather than modifying another file through a hard link.
        await replaceFile(temporary, item.destination);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
  }
  return {
    directory,
    skills: bundles.map((bundle) => {
      const entries = plan.filter((item) => item.bundle === bundle);
      return {
        name: bundle.name, version: bundle.version, hash: bundle.hash,
        written: entries.filter((item) => !item.unchanged).length,
        unchanged: entries.filter((item) => item.unchanged).length,
      };
    }),
  };
}
