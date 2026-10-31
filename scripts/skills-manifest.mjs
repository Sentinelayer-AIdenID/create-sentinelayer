#!/usr/bin/env node
// scripts/skills-manifest.mjs -- writes skills/<bundle>.manifest.json, the record that
// `sl skills install` checks the bundled skill files against before it writes anything:
// each file's sha256 and size, its executable bit as committed (git mode 100755), and each
// skill's name and description from its SKILL.md front matter.
//
// Run it after changing anything under skills/<bundle>/. `--check` exits 1 when the committed
// manifest is stale; tests/unit.skills-install.test.mjs runs the same comparison.
//
//   node scripts/skills-manifest.mjs [--bundle senti] [--check]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

import {
  DEFAULT_SKILL_BUNDLE,
  SKILLS_MANIFEST_SCHEMA_VERSION,
  SKILLS_ROOT,
  listBundleFiles,
  safePathSegments,
  sha256Hex,
} from "../src/skills/install.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readFrontMatter(text, label) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error(`${label} has no front matter`);
  const data = parseYaml(match[1]);
  if (!data || typeof data !== "object") throw new Error(`${label} front matter is not a mapping`);
  return data;
}

// Executable bits as committed: git keeps them on every platform (Windows file modes do not).
function committedExecutables(bundleRoot) {
  const relativeRoot = path.relative(REPO_ROOT, bundleRoot).split(path.sep).join("/");
  const result = spawnSync("git", ["ls-files", "--stage", "--", relativeRoot], { cwd: REPO_ROOT, encoding: "utf8" });
  const executables = new Set();
  if (result.status !== 0) return executables;
  for (const line of String(result.stdout || "").split("\n")) {
    const match = line.match(/^(\d{6}) [0-9a-f]+ \d+\t(.+)$/);
    if (match && match[1] === "100755") executables.add(path.posix.relative(relativeRoot, match[2]));
  }
  return executables;
}

export async function buildSkillsManifest({ skillsRoot = SKILLS_ROOT, bundle = DEFAULT_SKILL_BUNDLE } = {}) {
  const bundleRoot = path.join(skillsRoot, bundle);
  const executables = committedExecutables(bundleRoot);
  const relativePaths = await listBundleFiles(bundleRoot);
  const files = [];
  const skillNames = new Set();
  for (const relative of relativePaths) {
    const segments = safePathSegments(relative);
    const absolute = path.join(bundleRoot, ...segments);
    const info = fs.lstatSync(absolute);
    if (!info.isFile()) throw new Error(`${relative} is not a regular file`);
    const data = fs.readFileSync(absolute);
    if (segments.length > 1) skillNames.add(segments[0]);
    files.push({ path: relative, sha256: sha256Hex(data), bytes: data.length, executable: executables.has(relative) });
  }
  const skills = [];
  for (const name of [...skillNames].sort()) {
    const skillFile = path.join(bundleRoot, name, "SKILL.md");
    if (!fs.existsSync(skillFile)) throw new Error(`${name}/ has no SKILL.md`);
    const frontMatter = readFrontMatter(fs.readFileSync(skillFile, "utf8"), `${name}/SKILL.md`);
    if (frontMatter.name !== name) throw new Error(`${name}/SKILL.md names itself ${JSON.stringify(frontMatter.name)}`);
    const description = typeof frontMatter.description === "string" ? frontMatter.description.trim() : "";
    if (!description) throw new Error(`${name}/SKILL.md has no description`);
    skills.push({ name, description });
  }
  return { schemaVersion: SKILLS_MANIFEST_SCHEMA_VERSION, bundle, skills, files };
}

export function serializeSkillsManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function main(argv) {
  const bundleIndex = argv.indexOf("--bundle");
  const bundle = bundleIndex >= 0 ? argv[bundleIndex + 1] : DEFAULT_SKILL_BUNDLE;
  const manifestPath = path.join(SKILLS_ROOT, `${bundle}.manifest.json`);
  const expected = serializeSkillsManifest(await buildSkillsManifest({ bundle }));
  if (argv.includes("--check")) {
    const current = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : "";
    if (current !== expected) {
      console.error(`${path.relative(REPO_ROOT, manifestPath)} is stale: run node scripts/skills-manifest.mjs`);
      process.exitCode = 1;
      return;
    }
    console.log(`${path.relative(REPO_ROOT, manifestPath)} is current.`);
    return;
  }
  fs.writeFileSync(manifestPath, Buffer.from(expected, "utf8"));
  console.log(`Wrote ${path.relative(REPO_ROOT, manifestPath)}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
