import process from "node:process";
import path from "node:path";
import fsp from "node:fs/promises";

import { getConfigPaths } from "./paths.js";
import { ensureConfigFile, readConfigFile, writeConfigFile } from "./io.js";
import { CONFIG_KEYS, configSchema } from "./schema.js";
import { createOutputFileSystem } from "./output-filesystem.js";

const ENV_MAPPING = Object.freeze({
  SENTINELAYER_API_URL: "apiUrl",
  SENTINELAYER_WEB_URL: "webUrl",
  SENTINELAYER_TOKEN: "sentinelayerToken",
  SENTINELAYER_POLICY_PACK: "defaultPolicyPack",
  OPENAI_API_KEY: "openaiApiKey",
  ANTHROPIC_API_KEY: "anthropicApiKey",
  GOOGLE_API_KEY: "googleApiKey",
});

const WRITABLE_SCOPES = new Set(["global", "project"]);
const LAYER_SCOPES = new Set(["global", "project", "env", "resolved"]);

function normalizeKey(key) {
  const normalized = String(key || "").trim();
  if (!CONFIG_KEYS.includes(normalized)) {
    throw new Error(`Unknown config key '${normalized}'. Allowed keys: ${CONFIG_KEYS.join(", ")}`);
  }
  return normalized;
}

function normalizeValueForKey(key, value) {
  const payload = { [key]: value };
  const parsed = configSchema.partial().parse(payload);
  return parsed[key];
}

function buildEnvLayer(env) {
  const layer = {};
  for (const [envVar, key] of Object.entries(ENV_MAPPING)) {
    if (envVar in env) {
      const value = normalizeValueForKey(key, env[envVar]);
      if (value !== undefined) {
        layer[key] = value;
      }
    }
  }
  return layer;
}

function mergeLayers(...layers) {
  return layers.reduce((accumulator, layer) => {
    for (const [key, value] of Object.entries(layer || {})) {
      if (value !== undefined) {
        accumulator[key] = value;
      }
    }
    return accumulator;
  }, {});
}

function normalizeLayerScope(scope, { allowResolved = true } = {}) {
  const normalized = String(scope || "resolved").trim();
  if (!allowResolved && normalized === "resolved") {
    throw new Error("Resolved scope is read-only. Use global or project.");
  }
  if (!LAYER_SCOPES.has(normalized)) {
    throw new Error(`Invalid scope '${normalized}'. Use global, project, env, or resolved.`);
  }
  return normalized;
}

// Values a workspace .sentinelayer.yml may not set for the user: where the user's token goes, the
// token itself, provider keys, and where alerts are sent. They come from the environment (where a
// variable is named) or the global config only.
const USER_ONLY_KEYS = Object.freeze({
  apiUrl: "SENTINELAYER_API_URL",
  sentinelayerToken: "SENTINELAYER_TOKEN",
  openaiApiKey: "OPENAI_API_KEY",
  anthropicApiKey: "ANTHROPIC_API_KEY",
  googleApiKey: "GOOGLE_API_KEY",
  "alerts.channels": "",
});
const noticedProjectFiles = new Set();

function workspaceSets(projectConfig, key) {
  const [head, field] = key.split(".");
  const value = projectConfig?.[head];
  return field ? value?.[field] !== undefined : value !== undefined;
}

// One notice per workspace config that sets any of them, so an ignored value is never silent.
function noticeIgnoredWorkspaceValues(projectPath, projectConfig) {
  const keys = Object.keys(USER_ONLY_KEYS).filter((key) => workspaceSets(projectConfig, key));
  if (keys.length === 0 || noticedProjectFiles.has(projectPath)) return;
  noticedProjectFiles.add(projectPath);
  const envs = keys.map((key) => USER_ONLY_KEYS[key]).filter(Boolean);
  const instead = envs.length > 0 ? `set ${envs.join(", ")} or the global config` : "set them in the global config";
  process.stderr.write(
    `NOTICE: workspace .sentinelayer.yml ${keys.join(", ")} ignored; ${instead} (~/.sentinelayer/config.yml).\n`,
  );
}

/** The user's own config values (global, then environment), never the workspace's. */
export function userConfigValues(config) {
  return { ...(config?.layers?.global || {}), ...(config?.layers?.env || {}) };
}

export async function loadConfig({ cwd = process.cwd(), env = process.env, homeDir } = {}) {
  const paths = getConfigPaths({ cwd, homeDir });
  const [globalConfig, projectConfig] = await Promise.all([
    readConfigFile(paths.global),
    readConfigFile(paths.project),
  ]);
  noticeIgnoredWorkspaceValues(paths.project, projectConfig);

  const envConfig = buildEnvLayer(env);
  const resolved = configSchema.parse(mergeLayers(globalConfig, projectConfig, envConfig));

  return {
    paths,
    layers: {
      global: globalConfig,
      project: projectConfig,
      env: envConfig,
    },
    resolved,
  };
}

export function getLayer(config, scope) {
  const normalized = normalizeLayerScope(scope);
  if (normalized === "resolved") {
    return config.resolved;
  }
  return config.layers[normalized] || {};
}

export function findConfigSource(config, key) {
  const normalizedKey = normalizeKey(key);
  if (Object.prototype.hasOwnProperty.call(config.layers.env, normalizedKey)) {
    return "env";
  }
  if (Object.prototype.hasOwnProperty.call(config.layers.project, normalizedKey)) {
    return "project";
  }
  if (Object.prototype.hasOwnProperty.call(config.layers.global, normalizedKey)) {
    return "global";
  }
  return null;
}

export async function setConfigValue({
  key,
  value,
  scope = "project",
  cwd = process.cwd(),
  homeDir,
} = {}) {
  const normalizedScope = normalizeLayerScope(scope, { allowResolved: false });
  if (!WRITABLE_SCOPES.has(normalizedScope)) {
    throw new Error(`Cannot write scope '${normalizedScope}'. Use global or project.`);
  }

  const normalizedKey = normalizeKey(key);
  const normalizedValue = normalizeValueForKey(normalizedKey, value);

  const paths = getConfigPaths({ cwd, homeDir });
  const targetPath = paths[normalizedScope];
  const current = await readConfigFile(targetPath);
  const next = {
    ...current,
    [normalizedKey]: normalizedValue,
  };

  await writeConfigFile(targetPath, next);

  return {
    scope: normalizedScope,
    path: targetPath,
    key: normalizedKey,
    value: normalizedValue,
  };
}

export async function ensureEditableConfigPath({ scope = "project", cwd = process.cwd(), homeDir } = {}) {
  const normalizedScope = normalizeLayerScope(scope, { allowResolved: false });
  if (!WRITABLE_SCOPES.has(normalizedScope)) {
    throw new Error(`Cannot edit scope '${normalizedScope}'. Use global or project.`);
  }

  const paths = getConfigPaths({ cwd, homeDir });
  const targetPath = paths[normalizedScope];
  await ensureConfigFile(targetPath);

  return {
    scope: normalizedScope,
    path: targetPath,
  };
}

export function listConfigKeys() {
  return [...CONFIG_KEYS];
}

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Workspace configuration is untrusted. Check both the lexical destination and its existing
// filesystem ancestry before any artifact writer uses it. Explicit CLI/global choices stay trusted.
async function resolveProjectOutputDir(value, cwd) {
  try {
    if (path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
      throw new Error();
    }
    const root = path.resolve(cwd);
    const candidate = path.resolve(root, value);
    // Treat backslashes as separators for containment even on POSIX, so config stays portable.
    if (!isInsideRoot(root, candidate) || !isInsideRoot(root, path.resolve(root, value.replace(/\\/g, "/")))) {
      throw new Error();
    }
    const realRoot = await fsp.realpath(root);
    let ancestor = candidate;
    for (;;) {
      let realAncestor;
      try {
        realAncestor = await fsp.realpath(ancestor);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        // A dangling link is an existing entry with no resolvable destination, not a missing directory.
        const entry = await fsp.lstat(ancestor).catch((statError) => {
          if (statError.code !== "ENOENT") throw statError;
          return null;
        });
        if (entry) throw new Error();
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
        continue;
      }
      const effectiveCandidate = path.resolve(realAncestor, path.relative(ancestor, candidate));
      if (!isInsideRoot(realRoot, effectiveCandidate)) throw new Error();
      return candidate;
    }
  } catch {
    // Do not echo private configuration values or filesystem errors containing their paths.
    throw new Error("Workspace outputDir must resolve to a relative path inside the workspace.");
  }
}

export async function resolveOutputContext({
  cwd = process.cwd(),
  outputDirOverride = "",
  env = process.env,
  homeDir,
} = {}) {
  const overrideValue = String(outputDirOverride || "").trim();
  if (overrideValue) {
    return { outputRoot: path.resolve(cwd, overrideValue), outputFs: createOutputFileSystem() };
  }

  const config = await loadConfig({ cwd, env, homeDir });
  const configuredOutputDir = String(config.resolved.outputDir || "").trim();
  if (configuredOutputDir) {
    if (findConfigSource(config, "outputDir") === "project") {
      return {
        outputRoot: await resolveProjectOutputDir(configuredOutputDir, cwd),
        outputFs: createOutputFileSystem({ workspaceRoot: path.resolve(cwd) }),
      };
    }
    return { outputRoot: path.resolve(cwd, configuredOutputDir), outputFs: createOutputFileSystem() };
  }

  return { outputRoot: path.resolve(cwd, ".sentinelayer"), outputFs: createOutputFileSystem() };
}

export async function resolveOutputRoot(options = {}) {
  return (await resolveOutputContext(options)).outputRoot;
}
