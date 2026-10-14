import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

import {
  clearStoredSession,
  readStoredSession,
  readStoredSessionMetadata,
  resetSessionWarningsForTests,
  resolveCredentialsFilePath,
  setKeytarClientForTests,
  writeStoredSession,
} from "../src/auth/session-store.js";

test("Unit auth session store: file storage round-trip is deterministic when keyring is disabled", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-store-"));
  try {
    const persisted = await writeStoredSession(
      {
        apiUrl: "https://api.sentinelayer.dev",
        token: "api_token_example_1",
        tokenId: "token_1",
        tokenPrefix: "api_token_",
        tokenExpiresAt: "2027-01-01T00:00:00.000Z",
        user: {
          id: "user_1",
          githubUsername: "demo-user",
          email: "demo@example.com",
          isAdmin: true,
        },
      },
      { homeDir: tempRoot }
    );

    assert.equal(persisted.storage, "file");
    assert.equal(persisted.token, "api_token_example_1");
    assert.equal(persisted.user.githubUsername, "demo-user");
    assert.equal(persisted.user.isAdmin, true);

    const stored = await readStoredSession({ homeDir: tempRoot });
    assert.equal(stored?.token, "api_token_example_1");
    assert.equal(stored?.tokenId, "token_1");
    assert.equal(stored?.storage, "file");

    const metadata = await readStoredSessionMetadata({ homeDir: tempRoot });
    assert.equal(metadata?.token, null);
    assert.equal(metadata?.tokenId, "token_1");
    assert.equal(metadata?.user.email, "demo@example.com");

    const clearResult = await clearStoredSession({ homeDir: tempRoot });
    assert.equal(clearResult.hadSession, true);

    const postClear = await readStoredSession({ homeDir: tempRoot });
    assert.equal(postClear, null);
  } finally {
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth session store: keyring metadata without keytar returns null and clears locally", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";
  resetSessionWarningsForTests();

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-store-"));
  const warnings = [];
  const previousStderrWrite = process.stderr.write;
  process.stderr.write = (chunk, ...args) => {
    warnings.push(String(chunk || ""));
    const callback = args.find((arg) => typeof arg === "function");
    if (callback) callback();
    return true;
  };
  try {
    const credentialsPath = resolveCredentialsFilePath({ homeDir: tempRoot });
    await mkdir(path.dirname(credentialsPath), { recursive: true });
    await writeFile(
      credentialsPath,
      `${JSON.stringify(
        {
          version: 1,
          apiUrl: "https://api.sentinelayer.dev",
          storage: "keyring",
          keyringService: "sentinelayer-cli",
          keyringAccount: "default-simulated",
          user: {
            id: "user_1",
            github_username: "demo-user",
            email: "demo@example.com",
            is_admin: false,
          },
          createdAt: "2026-04-02T00:00:00.000Z",
          updatedAt: "2026-04-02T00:00:00.000Z",
        },
        null,
        2
      )}\n`,
      "utf-8"
    );

    const stored = await readStoredSession({ homeDir: tempRoot });
    assert.equal(stored, null);

    const metadata = await readStoredSessionMetadata({ homeDir: tempRoot });
    assert.equal(metadata?.storage, "keyring");
    assert.equal(metadata?.user.githubUsername, "demo-user");
    assert.equal(metadata?.token, null);

    const clearResult = await clearStoredSession({ homeDir: tempRoot });
    assert.equal(clearResult.hadSession, true);
    assert.equal(
      warnings.filter((entry) => entry.includes('"code":"KEYRING_FALLBACK_UNAVAILABLE"')).length,
      1,
    );
  } finally {
    process.stderr.write = previousStderrWrite;
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth session store: warning payload writes to stderr once and omits token-like values", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";
  resetSessionWarningsForTests();

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-store-"));
  const warnings = [];
  const previousStderrWrite = process.stderr.write;
  process.stderr.write = (chunk, ...args) => {
    warnings.push(String(chunk || ""));
    const callback = args.find((arg) => typeof arg === "function");
    if (callback) callback();
    return true;
  };
  try {
    const credentialsPath = resolveCredentialsFilePath({ homeDir: tempRoot });
    await mkdir(path.dirname(credentialsPath), { recursive: true });
    await writeFile(
      credentialsPath,
      `${JSON.stringify(
        {
          version: 1,
          apiUrl: "https://api.sentinelayer.dev",
          storage: "keyring",
          keyringService: "sentinelayer-cli",
          keyringAccount: "default-simulated",
          user: {
            id: "user_1",
            github_username: "demo-user",
            email: "demo@example.com",
            is_admin: false,
          },
          createdAt: "2026-04-02T00:00:00.000Z",
          updatedAt: "2026-04-02T00:00:00.000Z",
        },
        null,
        2
      )}\n`,
      "utf-8"
    );

    assert.equal(await readStoredSession({ homeDir: tempRoot }), null);
    assert.equal(await readStoredSession({ homeDir: tempRoot }), null);

    const warningLine = warnings.find((entry) => entry.startsWith("sentinelayer.auth.session "));
    assert.equal(Boolean(warningLine), true);
    assert.equal(
      warnings.filter((entry) => entry.startsWith("sentinelayer.auth.session ")).length,
      1,
    );
    const payload = JSON.parse(warningLine.replace("sentinelayer.auth.session ", ""));
    assert.equal(typeof payload.code, "string");
    assert.equal(typeof payload.reason, "string");
    assert.equal(typeof payload.source, "string");
    const serialized = JSON.stringify(payload).toLowerCase();
    assert.equal(serialized.includes("api_token"), false);
    assert.equal(serialized.includes("authorization"), false);
    assert.equal(serialized.includes("password"), false);
  } finally {
    process.stderr.write = previousStderrWrite;
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth session store: keyring writes retain encrypted file fallback for updates", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  const previousKeyringMode = process.env.SENTINELAYER_KEYRING_MODE;
  delete process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_KEYRING_MODE = "keyring";
  resetSessionWarningsForTests();

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-store-keyring-"));
  const fallbackToken = ["api", "token", "keyring", "with", "fallback"].join("_");
  const keyringPasswords = new Map();
  const restoreKeytar = setKeytarClientForTests({
    getPassword: async (service, account) => keyringPasswords.get(`${service}:${account}`) || null,
    setPassword: async (service, account, token) => {
      keyringPasswords.set(`${service}:${account}`, token);
    },
    deletePassword: async (service, account) => {
      keyringPasswords.delete(`${service}:${account}`);
    },
  });
  try {
    const persisted = await writeStoredSession(
      {
        apiUrl: "https://api.sentinelayer.dev",
        token: fallbackToken,
        tokenId: "token_keyring",
        tokenPrefix: "api_token_",
        tokenExpiresAt: "2027-01-01T00:00:00.000Z",
        user: { id: "user_1", githubUsername: "demo-user" },
      },
      { homeDir: tempRoot },
    );
    assert.equal(persisted.storage, "keyring");

    const credentialsPath = resolveCredentialsFilePath({ homeDir: tempRoot });
    const rawMetadata = JSON.parse(await readFile(credentialsPath, "utf-8"));
    assert.equal(rawMetadata.storage, "keyring");
    assert.equal(rawMetadata.token, null);
    assert.equal(typeof rawMetadata.tokenEncrypted, "string");
    assert.equal(typeof rawMetadata.tokenIv, "string");
    assert.equal(typeof rawMetadata.tokenTag, "string");
  } finally {
    restoreKeytar();
  }

  const warnings = [];
  const previousStderrWrite = process.stderr.write;
  const restoreUnavailableKeytar = setKeytarClientForTests(null);
  process.stderr.write = (chunk, ...args) => {
    warnings.push(String(chunk || ""));
    const callback = args.find((arg) => typeof arg === "function");
    if (callback) callback();
    return true;
  };
  try {
    const stored = await readStoredSession({ homeDir: tempRoot });
    assert.equal(stored?.token, fallbackToken);
    assert.equal(stored?.storage, "file");

    const storedAgain = await readStoredSession({ homeDir: tempRoot });
    assert.equal(storedAgain?.token, fallbackToken);
    assert.equal(
      warnings.filter((entry) => entry.includes('"code":"KEYRING_FALLBACK_USED"')).length,
      1,
    );
  } finally {
    process.stderr.write = previousStderrWrite;
    restoreUnavailableKeytar();
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    if (previousKeyringMode === undefined) {
      delete process.env.SENTINELAYER_KEYRING_MODE;
    } else {
      process.env.SENTINELAYER_KEYRING_MODE = previousKeyringMode;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth session store: invalid metadata payload fails closed", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-store-"));
  try {
    const credentialsPath = resolveCredentialsFilePath({ homeDir: tempRoot });
    await mkdir(path.dirname(credentialsPath), { recursive: true });
    await writeFile(credentialsPath, "[1,2,3]\n", "utf-8");

    const stored = await readStoredSession({ homeDir: tempRoot });
    assert.equal(stored, null);

    const metadata = await readStoredSessionMetadata({ homeDir: tempRoot });
    assert.equal(metadata, null);

    const raw = await readFile(credentialsPath, "utf-8");
    assert.match(raw, /^\[1,2,3\]/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth session store: concurrent first writes all encrypt with the persisted key", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-key-race-"));
  const restoreKeytar = setKeytarClientForTests(null);
  try {
    const sessions = await Promise.all(Array.from({ length: 16 }, (_, index) => writeStoredSession({
      apiUrl: "https://api.sentinelayer.dev",
      token: `synthetic_concurrent_${index}`,
      tokenId: `synthetic_${index}`,
      tokenExpiresAt: "2099-01-01T00:00:00.000Z",
    }, { homeDir: tempRoot })));
    const keyPath = path.join(tempRoot, ".sentinelayer", "keys", "credentials.key");
    const key = Buffer.from(await readFile(keyPath, "utf8"), "base64");
    for (const session of sessions) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(session.tokenIv, "base64"));
      decipher.setAuthTag(Buffer.from(session.tokenTag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(session.tokenEncrypted, "base64")), decipher.final(),
      ]).toString("utf8");
      assert.equal(plaintext === session.token, true);
    }
    const stored = await readStoredSession({ homeDir: tempRoot });
    assert.equal(sessions.some((session) => session.token === stored?.token), true);
    const restarted = await import(`../src/auth/session-store.js?restart=${Date.now()}`);
    assert.equal((await restarted.readStoredSession({ homeDir: tempRoot }))?.token === stored.token, true);
    if (process.platform !== "win32") {
      assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
      assert.equal((await stat(resolveCredentialsFilePath({ homeDir: tempRoot }))).mode & 0o777, 0o600);
    }
  } finally {
    restoreKeytar();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth session store: missing decryption key never creates a replacement", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-key-missing-"));
  const restoreKeytar = setKeytarClientForTests(null);
  try {
    await writeStoredSession({ apiUrl: "https://api.sentinelayer.dev", token: "synthetic_missing_key" }, { homeDir: tempRoot });
    const keyPath = path.join(tempRoot, ".sentinelayer", "keys", "credentials.key");
    const credentialsPath = resolveCredentialsFilePath({ homeDir: tempRoot });
    const metadata = await readFile(credentialsPath, "utf8");
    await rename(keyPath, `${keyPath}.retained`);
    assert.equal(await readStoredSession({ homeDir: tempRoot }), null);
    await assert.rejects(readFile(keyPath), { code: "ENOENT" });
    assert.equal(await readFile(credentialsPath, "utf8"), metadata);
    await rename(`${keyPath}.retained`, keyPath);
    assert.equal((await readStoredSession({ homeDir: tempRoot }))?.token === "synthetic_missing_key", true);
  } finally {
    restoreKeytar();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth session store: invalid keys are retained and fail closed for reads and writes", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-key-invalid-"));
  const restoreKeytar = setKeytarClientForTests(null);
  try {
    await writeStoredSession({ apiUrl: "https://api.sentinelayer.dev", token: "synthetic_invalid_key" }, { homeDir: tempRoot });
    const keyPath = path.join(tempRoot, ".sentinelayer", "keys", "credentials.key");
    const credentialsPath = resolveCredentialsFilePath({ homeDir: tempRoot });
    const metadata = await readFile(credentialsPath, "utf8");
    await writeFile(keyPath, "invalid-synthetic-key", "utf8");
    assert.equal(await readStoredSession({ homeDir: tempRoot }), null);
    await assert.rejects(writeStoredSession({ apiUrl: "https://api.sentinelayer.dev", token: "synthetic_new" }, { homeDir: tempRoot }), { code: "CREDENTIALS_KEY_INVALID" });
    assert.equal(await readFile(keyPath, "utf8"), "invalid-synthetic-key");
    assert.equal(await readFile(credentialsPath, "utf8"), metadata);
  } finally {
    restoreKeytar();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth session store: legacy-key decryption is read-only and metadata retains AIdenID", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-key-legacy-"));
  const restoreKeytar = setKeytarClientForTests(null);
  try {
    const aidenid = { orgId: "synthetic-org", projectId: "synthetic-project", apiKeyPrefix: "aid_", provisionedAt: "2026-01-01T00:00:00Z" };
    await writeStoredSession({ apiUrl: "https://api.sentinelayer.dev", token: "synthetic_legacy_key", aidenid }, { homeDir: tempRoot });
    const keyPath = path.join(tempRoot, ".sentinelayer", "keys", "credentials.key");
    const legacyPath = path.join(tempRoot, ".sentinelayer", "credentials.key");
    await rename(keyPath, legacyPath);
    const legacy = await readFile(legacyPath, "utf8");
    const stored = await readStoredSession({ homeDir: tempRoot });
    assert.equal(stored?.token === "synthetic_legacy_key", true);
    assert.deepEqual(stored?.aidenid, aidenid);
    await assert.rejects(readFile(keyPath), { code: "ENOENT" });
    assert.equal(await readFile(legacyPath, "utf8"), legacy);
    assert.deepEqual((await readStoredSessionMetadata({ homeDir: tempRoot }))?.aidenid, aidenid);
  } finally {
    restoreKeytar();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth session store: independent processes share one first-use encryption key", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-process-key-race-"));
  const moduleUrl = new URL("../src/auth/session-store.js", import.meta.url).href;
  const script = `
    import { writeStoredSession } from ${JSON.stringify(moduleUrl)};
    import crypto from "node:crypto";
    import fsp from "node:fs/promises";
    import path from "node:path";
    const homeDir = process.argv[1];
    const session = await writeStoredSession({ apiUrl: "https://synthetic.invalid", token: "synthetic_child_" + process.argv[2] }, { homeDir });
    const key = Buffer.from(await fsp.readFile(path.join(homeDir, ".sentinelayer", "keys", "credentials.key"), "utf8"), "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(session.tokenIv, "base64"));
    decipher.setAuthTag(Buffer.from(session.tokenTag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(session.tokenEncrypted, "base64")), decipher.final()]).toString("utf8");
    if (plaintext !== session.token) throw new Error("Synthetic encryption key mismatch");
  `;
  try {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, tempRoot, String(index)], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Synthetic child failed (${code}): ${stderr}`)));
    })));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    assert.equal(Boolean(await readStoredSession({ homeDir: tempRoot })), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
