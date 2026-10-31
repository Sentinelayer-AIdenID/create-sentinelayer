// Installs the agent skills bundled in this package (skills/<bundle>/) into an agent's skills folder.
//
// The npm package is the integrity boundary: skills/<bundle>.manifest.json, shipped beside the files,
// records every file's sha256 and size. Before anything is written, every listed file is read and
// checked against it, and any file the manifest does not list fails the install, so a corrupted or
// partial package fails loudly and writes nothing. Manifest paths are relative, and every path written
// stays inside the destination: an absolute path, a "..", a backslash or a dotfile segment is refused.
//
// Each skill is written to a fresh staging folder inside the destination, read back and checked again,
// then renamed into place. An existing folder is replaced only with `force`, and only when it is a real
// skill folder (a directory holding SKILL.md, not a link); a failure part-way restores what was there.

import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SKILLS_ROOT = fileURLToPath(new URL("../../skills/", import.meta.url));
export const DEFAULT_SKILL_BUNDLE = "senti";
export const SKILLS_MANIFEST_SCHEMA_VERSION = 1;

/** Where each supported agent reads personal skills from (one folder per skill, each with a SKILL.md). */
export const SKILL_TARGETS = Object.freeze({
  // Claude Code: personal skills.
  claude: Object.freeze({
    label: "Claude Code",
    segments: Object.freeze([".claude", "skills"]),
    next: "Restart Claude Code (or start a new session) so it loads the skills, then ask it to join a Senti room.",
  }),
  // Codex: user skills.
  codex: Object.freeze({
    label: "Codex",
    segments: Object.freeze([".agents", "skills"]),
    next: "Codex picks up new skills on its own (restart it if they do not appear), then ask it to join a Senti room.",
  }),
});

const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
// One path segment: letters, digits, ".", "_" and "-"; no leading dot (so never "." or ".."), no trailing dot.
const PATH_SEGMENT_RE = /^[A-Za-z0-9_](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_FILES = 512;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export class SkillsInstallError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SkillsInstallError";
    this.code = code;
    this.details = details;
  }
}

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Split a manifest path ("skill-name/SKILL.md") into safe segments, or refuse it.
 * @returns {string[]}
 */
export function safePathSegments(relativePath) {
  const value = typeof relativePath === "string" ? relativePath : "";
  const refuse = () => {
    throw new SkillsInstallError(
      "unsafe_path",
      `Refusing unsafe skill file path ${JSON.stringify(relativePath)}: paths must stay inside the skills folder.`,
      { path: relativePath },
    );
  };
  if (!value || value.length > 512 || value.includes("\\") || value.includes("\0")) refuse();
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) refuse();
  const segments = value.split("/");
  if (!segments.every((segment) => PATH_SEGMENT_RE.test(segment))) refuse();
  return segments;
}

/** Resolve segments under root, refusing anything that would land outside it (or on root itself). */
export function resolveInside(root, segments) {
  const base = path.resolve(root);
  const target = path.resolve(base, ...segments);
  const relative = path.relative(base, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SkillsInstallError(
      "unsafe_path",
      `Refusing to write outside ${base}: ${segments.join("/")}`,
      { path: segments.join("/") },
    );
  }
  return target;
}

function invalidManifest(manifestPath, reason) {
  return new SkillsInstallError(
    "manifest_invalid",
    `The skills manifest in this package is invalid (${reason}): ${manifestPath}. ` +
      "Nothing was written. Reinstall the package (for npx, clear its cache) and try again.",
    { manifestPath },
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateManifest(manifest, { bundle, manifestPath }) {
  if (!isPlainObject(manifest)) throw invalidManifest(manifestPath, "not a JSON object");
  if (manifest.schemaVersion !== SKILLS_MANIFEST_SCHEMA_VERSION) {
    throw invalidManifest(manifestPath, `unsupported schemaVersion ${JSON.stringify(manifest.schemaVersion)}`);
  }
  if (manifest.bundle !== bundle) throw invalidManifest(manifestPath, `bundle is not "${bundle}"`);
  const { skills, files } = manifest;
  if (!Array.isArray(skills) || skills.length === 0 || skills.length > 64) {
    throw invalidManifest(manifestPath, "skills must be a non-empty list");
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_MANIFEST_FILES) {
    throw invalidManifest(manifestPath, "files must be a non-empty list");
  }
  const skillNames = new Set();
  for (const skill of skills) {
    if (!isPlainObject(skill) || typeof skill.name !== "string" || !SKILL_NAME_RE.test(skill.name)) {
      throw invalidManifest(manifestPath, `invalid skill name ${JSON.stringify(skill?.name)}`);
    }
    if (skillNames.has(skill.name)) throw invalidManifest(manifestPath, `duplicate skill ${skill.name}`);
    if (typeof skill.description !== "string" || !skill.description.trim()) {
      throw invalidManifest(manifestPath, `skill ${skill.name} has no description`);
    }
    skillNames.add(skill.name);
  }
  const seenPaths = new Set();
  const entries = [];
  for (const file of files) {
    if (!isPlainObject(file) || typeof file.path !== "string") {
      throw invalidManifest(manifestPath, "a file entry has no path");
    }
    // Path safety is checked for the whole list before any file is read.
    const segments = safePathSegments(file.path);
    if (seenPaths.has(file.path)) throw invalidManifest(manifestPath, `duplicate file ${file.path}`);
    if (typeof file.sha256 !== "string" || !SHA256_RE.test(file.sha256)) {
      throw invalidManifest(manifestPath, `file ${file.path} has no valid sha256`);
    }
    if (!Number.isInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES) {
      throw invalidManifest(manifestPath, `file ${file.path} has no valid size`);
    }
    if (typeof file.executable !== "boolean") {
      throw invalidManifest(manifestPath, `file ${file.path} has no executable flag`);
    }
    // A file sits in a listed skill's folder, or at the bundle root (a bundle README): never elsewhere.
    if (segments.length > 1 && !skillNames.has(segments[0])) {
      throw invalidManifest(manifestPath, `file ${file.path} is outside every listed skill`);
    }
    seenPaths.add(file.path);
    entries.push({ path: file.path, segments, sha256: file.sha256, bytes: file.bytes, executable: file.executable });
  }
  for (const name of skillNames) {
    if (!seenPaths.has(`${name}/SKILL.md`)) throw invalidManifest(manifestPath, `skill ${name} has no SKILL.md`);
  }
  return {
    skills: skills.map((skill) => ({ name: skill.name, description: skill.description })),
    files: entries,
  };
}

/** Every regular file under dir, as sorted "/"-separated relative paths; anything else is listed as is. */
export async function listBundleFiles(dir) {
  const out = [];
  async function walk(current, prefix) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), relative);
      } else {
        out.push(relative);
      }
    }
  }
  await walk(dir, "");
  return out.sort();
}

function corrupt(message, details = {}) {
  return new SkillsInstallError(
    "bundle_corrupt",
    `${message} The installed package is corrupted; nothing was written. ` +
      "Reinstall it (for npx, clear its cache) and try again.",
    details,
  );
}

/**
 * Read the bundled skills and verify every file against the package manifest, in both directions:
 * each listed file exists with the recorded sha256 and size, and nothing unlisted is present.
 * Writes nothing.
 */
export async function readSkillBundle({ skillsRoot = SKILLS_ROOT, bundle = DEFAULT_SKILL_BUNDLE } = {}) {
  const manifestPath = path.join(skillsRoot, `${bundle}.manifest.json`);
  const bundleRoot = path.join(skillsRoot, bundle);
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  } catch (error) {
    throw invalidManifest(manifestPath, error?.code === "ENOENT" ? "missing" : "unreadable");
  }
  const validated = validateManifest(manifest, { bundle, manifestPath });

  const files = [];
  for (const entry of validated.files) {
    const source = resolveInside(bundleRoot, entry.segments);
    let data;
    try {
      const info = await fsp.lstat(source);
      if (!info.isFile()) throw new Error("not a regular file");
      data = await fsp.readFile(source);
    } catch (error) {
      throw corrupt(`Bundled skill file ${entry.path} is missing or unreadable (${error.code || error.message}).`, {
        path: entry.path,
      });
    }
    const actual = sha256Hex(data);
    if (data.length !== entry.bytes || actual !== entry.sha256) {
      throw corrupt(
        `Bundled skill file ${entry.path} does not match the package manifest ` +
          `(expected ${entry.bytes} bytes, sha256 ${entry.sha256}; found ${data.length} bytes, sha256 ${actual}).`,
        { path: entry.path, expected: entry.sha256, actual },
      );
    }
    files.push({ ...entry, data });
  }

  let present;
  try {
    present = await listBundleFiles(bundleRoot);
  } catch (error) {
    throw corrupt(`The bundled skills folder cannot be read (${error.code || error.message}).`);
  }
  const listed = new Set(files.map((file) => file.path));
  const unlisted = present.filter((relative) => !listed.has(relative));
  if (unlisted.length > 0) {
    throw corrupt(`The bundled skills folder holds files the manifest does not list: ${unlisted.join(", ")}.`, {
      unlisted,
    });
  }

  return {
    bundle,
    bundleRoot,
    manifestPath,
    skills: validated.skills.map((skill) => ({
      ...skill,
      files: files
        .filter((file) => file.segments.length > 1 && file.segments[0] === skill.name)
        .map((file) => ({ ...file, segments: file.segments.slice(1), path: file.segments.slice(1).join("/") })),
    })),
  };
}

/**
 * Resolve where skills go: --dir wins as an explicit folder; otherwise --target (default claude).
 * @returns {{ target: string, label: string, targetDir: string, next: string }}
 */
export function resolveSkillsDestination({ target, dir, homeDir = os.homedir(), cwd = process.cwd() } = {}) {
  const hasDir = dir !== undefined && dir !== null && String(dir).trim() !== "";
  const hasTarget = target !== undefined && target !== null && String(target).trim() !== "";
  if (hasDir && hasTarget) {
    throw new SkillsInstallError("target_conflict", "Use either --target or --dir, not both.");
  }
  if (hasDir) {
    const raw = String(dir).trim();
    const expanded = /^~(?=$|[\\/])/.test(raw) ? path.join(homeDir, raw.slice(1)) : raw;
    const targetDir = path.resolve(cwd, expanded);
    return {
      target: "dir",
      label: "your agent",
      targetDir,
      next: `Point your agent at ${targetDir} (one folder per skill, each with a SKILL.md), then ask it to join a Senti room.`,
    };
  }
  const name = hasTarget ? String(target).trim().toLowerCase() : "claude";
  const spec = Object.hasOwn(SKILL_TARGETS, name) ? SKILL_TARGETS[name] : null;
  if (!spec) {
    throw new SkillsInstallError(
      "target_invalid",
      `Unknown --target ${JSON.stringify(String(target))}. Use claude or codex, or --dir <path> for any other agent.`,
    );
  }
  return { target: name, label: spec.label, targetDir: path.join(homeDir, ...spec.segments), next: spec.next };
}

async function lstatOrNull(file) {
  try {
    return await fsp.lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** missing | skill (a real directory holding SKILL.md) | folder (a directory without one) | link | file */
async function destinationState(dir) {
  const info = await lstatOrNull(dir);
  if (!info) return "missing";
  if (info.isSymbolicLink()) return "link";
  if (!info.isDirectory()) return "file";
  const skillFile = await lstatOrNull(path.join(dir, "SKILL.md"));
  return skillFile?.isFile() ? "skill" : "folder";
}

const CONFLICT_REASONS = {
  skill: "already exists; re-run with --force to replace it (edits to it are lost)",
  folder: "exists but is not a skill folder (no SKILL.md); move it aside first, --force never replaces it",
  link: "is a symbolic link; remove the link first, --force never replaces it",
  file: "exists and is not a folder; move it aside first",
};

async function assertDestinationRoot(targetDir) {
  let info;
  try {
    info = await fsp.stat(targetDir);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!info.isDirectory()) {
    throw new SkillsInstallError("target_invalid", `${targetDir} exists and is not a folder. Nothing was written.`);
  }
}

async function planInstall(loaded, destination, { force }) {
  await assertDestinationRoot(destination.targetDir);
  const plan = [];
  const conflicts = [];
  for (const skill of loaded.skills) {
    const dest = resolveInside(destination.targetDir, [skill.name]);
    const state = await destinationState(dest);
    // An identical copy is already installed: nothing to write, so nothing to refuse.
    if (state === "skill" && (await matchesBundled(dest, skill))) {
      plan.push({ skill, dest, action: "unchanged" });
    } else if (state === "missing" || (state === "skill" && force)) {
      for (const file of skill.files) resolveInside(dest, file.segments);
      plan.push({ skill, dest, action: state === "missing" ? "install" : "replace" });
    } else {
      conflicts.push({ name: skill.name, path: dest, state, reason: CONFLICT_REASONS[state] });
    }
  }
  if (conflicts.length > 0) {
    throw new SkillsInstallError(
      "destination_exists",
      `Nothing was written:\n${conflicts.map((c) => `  ${c.path} ${c.reason}`).join("\n")}`,
      { conflicts },
    );
  }
  return plan;
}

async function writeVerified(file, out) {
  await fsp.mkdir(path.dirname(out), { recursive: true });
  // "wx": a fresh path inside a fresh staging folder; never follows or overwrites anything.
  await fsp.writeFile(out, file.data, { flag: "wx", mode: file.executable ? 0o755 : 0o644 });
  const back = await fsp.readFile(out);
  if (back.length !== file.bytes || sha256Hex(back) !== file.sha256) {
    throw new SkillsInstallError("write_failed", `${out} did not read back as written.`);
  }
}

async function removeQuietly(target) {
  await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
}

// On Windows a folder whose files were just written can be briefly locked (indexing, antivirus).
async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (error) {
      const transient = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
      if (!transient || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

// Stage every skill first, then swap each into place; on any failure, undo what was swapped and
// restore every replaced folder, so an install either completes or leaves the destination as it was.
async function commitPlan(plan, targetDir) {
  const staged = [];
  const placed = [];
  try {
    await fsp.mkdir(targetDir, { recursive: true });
    for (const item of plan) {
      const staging = path.join(targetDir, `.sl-skill-staging-${randomUUID()}`);
      staged.push({ item, staging });
      await fsp.mkdir(staging);
      for (const file of item.skill.files) await writeVerified(file, resolveInside(staging, file.segments));
    }
    for (const { item, staging } of staged) {
      let backup = null;
      if (item.action === "replace") {
        if ((await destinationState(item.dest)) !== "skill") {
          throw new SkillsInstallError("destination_exists", `${item.dest} changed during the install; nothing was replaced.`);
        }
        backup = path.join(targetDir, `.sl-skill-backup-${randomUUID()}`);
        await renameWithRetry(item.dest, backup);
      }
      try {
        await renameWithRetry(staging, item.dest);
      } catch (error) {
        if (backup) await renameWithRetry(backup, item.dest).catch(() => {});
        throw error;
      }
      placed.push({ item, backup });
    }
  } catch (error) {
    for (const { item, backup } of placed.reverse()) {
      await removeQuietly(item.dest);
      if (backup) await renameWithRetry(backup, item.dest).catch(() => {});
    }
    for (const { staging } of staged) await removeQuietly(staging);
    if (error instanceof SkillsInstallError) throw error;
    throw new SkillsInstallError(
      "write_failed",
      `Could not write the skills to ${targetDir} (${error?.code || error?.message}). Nothing was changed.`,
    );
  }
  for (const { backup } of placed) if (backup) await removeQuietly(backup);
}

function describeFiles(files) {
  return files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256, executable: file.executable }));
}

/**
 * Verify the bundled skills, then install them (or, with dryRun, report what would be written).
 */
export async function installSkills({
  target,
  dir,
  force = false,
  dryRun = false,
  homeDir,
  cwd,
  skillsRoot,
  bundle,
} = {}) {
  const loaded = await readSkillBundle({ skillsRoot, bundle });
  const destination = resolveSkillsDestination({ target, dir, homeDir, cwd });
  const plan = await planInstall(loaded, destination, { force: Boolean(force) });
  const writes = plan.filter((item) => item.action !== "unchanged");
  if (!dryRun && writes.length > 0) await commitPlan(writes, destination.targetDir);
  const done = { install: "installed", replace: "replaced", unchanged: "unchanged" };
  return {
    bundle: loaded.bundle,
    target: destination.target,
    agent: destination.label,
    targetDir: destination.targetDir,
    dryRun: Boolean(dryRun),
    force: Boolean(force),
    verified: true,
    skills: plan.map((item) => ({
      name: item.skill.name,
      path: item.dest,
      action: dryRun && item.action !== "unchanged" ? `would-${item.action}` : done[item.action],
      files: describeFiles(item.skill.files),
    })),
    next: destination.next,
  };
}

async function matchesBundled(dest, skill) {
  try {
    const present = await listBundleFiles(dest);
    if (present.join("\n") !== skill.files.map((file) => file.path).sort().join("\n")) return false;
    for (const file of skill.files) {
      const data = await fsp.readFile(resolveInside(dest, file.segments));
      if (sha256Hex(data) !== file.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * List the bundled skills and, for the destination, whether each is installed and identical.
 */
export async function listSkills({ target, dir, homeDir, cwd, skillsRoot, bundle } = {}) {
  const loaded = await readSkillBundle({ skillsRoot, bundle });
  const destination = resolveSkillsDestination({ target, dir, homeDir, cwd });
  const skills = [];
  for (const skill of loaded.skills) {
    const dest = resolveInside(destination.targetDir, [skill.name]);
    const state = await destinationState(dest);
    let status = "not-installed";
    if (state === "skill") status = (await matchesBundled(dest, skill)) ? "installed" : "changed";
    else if (state !== "missing") status = "blocked";
    skills.push({ name: skill.name, description: skill.description, path: dest, status, files: describeFiles(skill.files) });
  }
  return {
    bundle: loaded.bundle,
    target: destination.target,
    agent: destination.label,
    targetDir: destination.targetDir,
    verified: true,
    skills,
  };
}
