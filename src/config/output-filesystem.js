import fsp from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outputCapabilities = new WeakSet();

/** Writers accept only a capability created for this operation's output policy. */
export function requireOutputFileSystem(outputFs) {
  if (!outputCapabilities.has(outputFs)) {
    throw new TypeError("An output filesystem capability is required for artifact writes.");
  }
  return outputFs;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Validate the complete destination, including an existing final-file link. */
export async function assertWorkspaceOutputPath(destination, workspaceRoot) {
  try {
    const value = destination instanceof URL ? fileURLToPath(destination) : destination;
    if (typeof value !== "string") throw new Error("Unverifiable artifact destination");
    const root = path.resolve(workspaceRoot);
    const candidate = path.resolve(value);
    if (!isInside(root, candidate)) throw new Error("Artifact outside workspace");
    const realRoot = await fsp.realpath(root);
    let ancestor = candidate;
    for (;;) {
      let resolved;
      try {
        resolved = await fsp.realpath(ancestor);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const entry = await fsp.lstat(ancestor).catch((statError) => {
          if (statError.code !== "ENOENT") throw statError;
          return null;
        });
        if (entry) {
          if (entry.isSymbolicLink()) throw new Error("Unresolved artifact link");
          // A concurrent artifact writer may have created this ordinary entry
          // after realpath saw ENOENT. Resolve it once, then apply the same real
          // workspace check below; never treat its mere existence as authority.
          resolved = await fsp.realpath(ancestor);
        } else {
          const parent = path.dirname(ancestor);
          if (parent === ancestor) throw error;
          ancestor = parent;
          continue;
        }
      }
      if (!isInside(realRoot, path.resolve(resolved, path.relative(ancestor, candidate)))) {
        throw new Error("Artifact link leaves workspace");
      }
      return candidate;
    }
  } catch {
    throw new Error("Workspace artifact destination must resolve inside the workspace.");
  }
}

/** Per-operation capability; never stored in a process-global path registry. */
export function createOutputFileSystem({ workspaceRoot = null } = {}) {
  workspaceRoot = workspaceRoot ? path.resolve(workspaceRoot) : null;
  const assertPath = async (destination) => {
    if (workspaceRoot) return assertWorkspaceOutputPath(destination, workspaceRoot);
    return destination;
  };
  const assertFilePath = async (destination) => {
    const checked = await assertPath(destination);
    if (workspaceRoot) {
      const entry = await fsp.lstat(checked).catch((error) => {
        if (error.code !== "ENOENT") throw new Error("Workspace artifact destination must resolve inside the workspace.");
        return null;
      });
      if (entry?.isSymbolicLink() || (entry?.isFile() && entry.nlink > 1)) {
        throw new Error("Workspace artifact destination must resolve inside the workspace without linked files.");
      }
    }
    return checked;
  };
  // Expose only read operations and the mutations guarded below. Adding a new
  // writer must not silently inherit an unchecked fs/promises method.
  const io = { assertPath, assertFilePath };
  for (const method of ["access", "readFile", "readdir", "readlink", "realpath", "stat", "lstat", "statfs", "opendir"]) {
    io[method] = fsp[method];
  }
  for (const method of ["mkdir", "rm", "unlink", "truncate"]) {
    io[method] = async (destination, ...args) => {
      const checked = await (method === "mkdir" ? assertPath(destination) : assertFilePath(destination));
      return fsp[method](checked, ...args);
    };
  }
  for (const method of ["rename", "copyFile"]) {
    io[method] = async (source, destination, ...args) => {
      const checkedSource = method === "rename" ? await assertFilePath(source) : source;
      const checkedDestination = await assertFilePath(destination);
      return fsp[method](checkedSource, checkedDestination, ...args);
    };
  }
  io.open = async (destination, flags, ...args) => {
    const writeFlags = constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_TRUNC;
    if (typeof flags === "number" ? Boolean(flags & writeFlags) : /[wa+]/.test(flags || "r")) {
      const checked = await assertFilePath(destination);
      return fsp.open(checked, workspaceRoot ? numericOpenFlags(flags) | (constants.O_NOFOLLOW || 0) : flags, ...args);
    }
    return fsp.open(destination, flags, ...args);
  };
  for (const method of ["writeFile", "appendFile"]) {
    io[method] = async (destination, data, options) => {
      if (!workspaceRoot) return fsp[method](destination, data, options);
      if (options !== undefined && options !== null && typeof options !== "string" && typeof options !== "object") {
        throw new TypeError("Artifact file options must be an encoding string or an object.");
      }
      const normalizedOptions = typeof options === "string" ? { encoding: options } : options || {};
      const flag = normalizedOptions.flag || (method === "appendFile" ? "a" : "w");
      const checked = await assertFilePath(destination);
      return fsp[method](checked, data, {
        ...normalizedOptions,
        flag: numericOpenFlags(flag) | (constants.O_NOFOLLOW || 0),
      });
    };
  }
  outputCapabilities.add(io);
  return Object.freeze(io);
}

function numericOpenFlags(flags) {
  if (typeof flags === "number") return flags;
  const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_EXCL, O_SYNC } = constants;
  const modes = {
    r: O_RDONLY, rs: O_RDONLY | O_SYNC, sr: O_RDONLY | O_SYNC,
    "r+": O_RDWR, "rs+": O_RDWR | O_SYNC, "sr+": O_RDWR | O_SYNC,
    w: O_TRUNC | O_CREAT | O_WRONLY, wx: O_TRUNC | O_CREAT | O_WRONLY | O_EXCL,
    xw: O_TRUNC | O_CREAT | O_WRONLY | O_EXCL,
    "w+": O_TRUNC | O_CREAT | O_RDWR, "wx+": O_TRUNC | O_CREAT | O_RDWR | O_EXCL,
    "xw+": O_TRUNC | O_CREAT | O_RDWR | O_EXCL,
    a: O_APPEND | O_CREAT | O_WRONLY, ax: O_APPEND | O_CREAT | O_WRONLY | O_EXCL,
    xa: O_APPEND | O_CREAT | O_WRONLY | O_EXCL,
    "a+": O_APPEND | O_CREAT | O_RDWR, "ax+": O_APPEND | O_CREAT | O_RDWR | O_EXCL,
    "xa+": O_APPEND | O_CREAT | O_RDWR | O_EXCL,
    as: O_APPEND | O_CREAT | O_WRONLY | O_SYNC, sa: O_APPEND | O_CREAT | O_WRONLY | O_SYNC,
    "as+": O_APPEND | O_CREAT | O_RDWR | O_SYNC, "sa+": O_APPEND | O_CREAT | O_RDWR | O_SYNC,
  };
  if (!Object.hasOwn(modes, flags)) throw new TypeError("Unsupported artifact file open flag.");
  return modes[flags];
}

// Storage objects are often returned as JSON. Keep the executable capability
// out of that public data shape while allowing explicit downstream propagation.
export function bindOutputFileSystem(storage, outputFs) {
  Object.defineProperty(storage, "outputFs", { value: requireOutputFileSystem(outputFs), enumerable: false });
  return storage;
}
