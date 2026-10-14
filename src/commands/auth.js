import process from "node:process";

import pc from "picocolors";

import { SentinelayerApiError } from "../auth/http.js";
import {
  DEFAULT_API_TOKEN_TTL_DAYS,
  DEFAULT_AUTH_TIMEOUT_MS,
  getAuthStatus,
  listStoredAuthSessions,
  loginAndPersistSession,
  logoutSession,
  revokeAuthToken,
} from "../auth/service.js";
import { resolveCredentialsFilePath } from "../auth/session-store.js";
import { CLI_VERSION } from "../legacy-cli.js";
import { authLoginHint } from "../ui/command-hints.js";

const AUTH_DEBUG_ENV = "SENTINELAYER_DEBUG_ERRORS";
const AUTH_UNMASK_REQUEST_IDS_ENV = "SENTINELAYER_UNMASK_REQUEST_IDS";

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

function parsePositiveNumber(rawValue, field, fallbackValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallbackValue;
  }
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive number.`);
  }
  return normalized;
}

function normalizeUser(user = {}) {
  return {
    id: String(user.id || "").trim(),
    githubUsername: String(user.githubUsername || user.github_username || "").trim(),
    email: String(user.email || "").trim(),
    avatarUrl: String(user.avatarUrl || user.avatar_url || "").trim(),
    isAdmin: Boolean(user.isAdmin || user.is_admin),
  };
}

function renderUserSummary(user = {}) {
  const normalized = normalizeUser(user);
  const identity = normalized.githubUsername || normalized.email || normalized.id || "unknown";
  return `${identity}${normalized.isAdmin ? " (admin)" : ""}`;
}

function formatApiError(error) {
  if (!(error instanceof SentinelayerApiError)) {
    return error instanceof Error ? error.message : String(error || "Unknown error");
  }
  const requestIdValue = error.requestId
    ? (shouldExposeSensitiveAuthInfo() ? error.requestId : maskIdentifier(error.requestId))
    : "";
  const requestId = requestIdValue ? ` request_id=${requestIdValue}` : "";
  return `${error.message} [${error.code}] status=${error.status}${requestId}`;
}

function shouldExposeSensitiveAuthInfo() {
  const normalized = String(process.env[AUTH_DEBUG_ENV] || "").trim().toLowerCase();
  const unmask = String(process.env[AUTH_UNMASK_REQUEST_IDS_ENV] || "").trim().toLowerCase();
  const isTty = Boolean(process.stdout && process.stdout.isTTY);
  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  const isDev = nodeEnv === "development";
  const debugEnabled = normalized === "true" || normalized === "1" || normalized === "yes";
  const unmaskEnabled = unmask === "true" || unmask === "1" || unmask === "yes";
  return debugEnabled && unmaskEnabled && isTty && isDev;
}

function shouldRevealTokenIdentifiers() {
  return shouldExposeSensitiveAuthInfo();
}

function maskIdentifier(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length <= 6) {
    return `${raw.slice(0, 2)}…`;
  }
  return `${raw.slice(0, 4)}…${raw.slice(-2)}`;
}

function printAuthHint() {
  console.log(pc.gray(`Run \`${authLoginHint()}\` to create a persistent CLI session.`));
}

export function registerAuthCommand(program) {
  const auth = program
    .command("auth")
    .description("Manage Sentinelayer CLI authentication and persistent sessions");

  auth
    .command("login")
    .description("Authenticate in browser and persist a long-lived API token")
    .option("--api-url <url>", "Override Sentinelayer API base URL")
    .option("--skip-browser-open", "Do not auto-open browser; print authorize URL instead")
    .option(
      "--timeout-ms <ms>",
      "Authentication timeout in milliseconds",
      String(DEFAULT_AUTH_TIMEOUT_MS)
    )
    .option("--token-label <label>", "Label to apply to the issued API token")
    .option(
      "--token-ttl-days <days>",
      "Issued API token lifetime in days",
      String(DEFAULT_API_TOKEN_TTL_DAYS)
    )
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const timeoutMs = parsePositiveNumber(options.timeoutMs, "timeoutMs", DEFAULT_AUTH_TIMEOUT_MS);
      const tokenTtlDays = parsePositiveNumber(
        options.tokenTtlDays,
        "tokenTtlDays",
        DEFAULT_API_TOKEN_TTL_DAYS
      );

      let result;
      try {
        result = await loginAndPersistSession({
          cwd: process.cwd(),
          env: process.env,
          explicitApiUrl: options.apiUrl,
          skipBrowserOpen: Boolean(options.skipBrowserOpen),
          timeoutMs,
          tokenLabel: options.tokenLabel,
          tokenTtlDays,
          cliVersion: CLI_VERSION,
          onAuthorize: ({ authorizeUrl }) => {
            // A spawned opener does not prove a browser exists on a headless host.
            if (!authorizeUrl) return;
            const safeUrl = String(authorizeUrl).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 4096);
            const line = `Open this URL to approve sign-in:\n${safeUrl}\n`;
            if (shouldEmitJson(options, command)) process.stderr.write(line);
            else console.log(line.trimEnd());
          },
        });
      } catch (error) {
        throw new Error(formatApiError(error));
      }

      const payload = {
        command: "auth login",
        authenticated: true,
        ...result,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("Authentication successful"));
      console.log(pc.gray(`API: ${result.apiUrl}`));
      console.log(pc.gray(`User: ${renderUserSummary(result.user)}`));
      console.log(pc.gray(`Storage: ${result.storage}`));
      if (result.tokenExpiresAt) {
        console.log(pc.gray(`Token expiry: ${result.tokenExpiresAt}`));
      }
      if (result.filePath) {
        console.log(pc.gray(`Session metadata: ${result.filePath}`));
      }
    });

  auth
    .command("status")
    .description("Show current authentication/session status")
    .option("--api-url <url>", "Override Sentinelayer API base URL")
    .option("--offline", "Skip remote token validation (`/auth/me`)")
    .option("--no-auto-rotate", "Disable near-expiry auto-rotation for this command")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      let status;
      try {
        status = await getAuthStatus({
          cwd: process.cwd(),
          env: process.env,
          explicitApiUrl: options.apiUrl,
          checkRemote: !options.offline,
          autoRotate: Boolean(options.autoRotate),
        });
      } catch (error) {
        throw new Error(formatApiError(error));
      }

      const payload = {
        command: "auth status",
        ...status,
        defaultCredentialsPath: resolveCredentialsFilePath(),
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("Authentication status"));
      console.log(pc.gray(`API: ${status.apiUrl}`));
      if (status.validation === "storage_unavailable") {
        console.log(pc.yellow("Stored sign-in metadata exists, but its credential cannot be read. Authentication is unknown."));
        if (status.filePath) console.log(pc.gray(`Session metadata: ${status.filePath}`));
        console.log(pc.gray("Check the current user/home, keyring availability, encryption key and file permissions."));
        console.log(pc.gray("Credentials were not cleared. Repair storage instead of logging out or signing in again for this error."));
        return;
      }
      if (!status.source) {
        console.log(pc.yellow("No active session token found."));
        printAuthHint();
        return;
      }

      console.log(pc.gray(`Token source: ${status.source}`));
      if (status.source === "session") {
        console.log(pc.gray(`Session storage: ${status.storage || "unknown"}`));
        if (status.filePath) {
          console.log(pc.gray(`Session metadata: ${status.filePath}`));
        }
      }
      if (status.tokenExpiresAt) {
        console.log(pc.gray(`Token expiry: ${status.tokenExpiresAt}`));
      }
      if (status.rotated) {
        console.log(pc.yellow("Token was rotated because it was close to expiry."));
      }

      if (status.authenticated) {
        const displayUser = status.remoteUser || status.user || {};
        console.log(pc.green(`Authenticated as ${renderUserSummary(displayUser)}`));

        if (status.aidenid && (status.aidenid.orgId || status.aidenid.projectId)) {
          if (shouldExposeSensitiveAuthInfo()) {
            const orgDisplay = status.aidenid.orgId ? maskIdentifier(status.aidenid.orgId) : "unknown";
            const projectDisplay = status.aidenid.projectId ? maskIdentifier(status.aidenid.projectId) : "unknown";
            console.log(pc.green(`AIdenID: provisioned (org: ${orgDisplay}, project: ${projectDisplay})`));
            if (status.aidenid.apiKeyPrefix) {
              console.log(pc.gray(`  API key prefix: ${maskIdentifier(status.aidenid.apiKeyPrefix)}`));
            }
          } else {
            console.log(pc.green("AIdenID: provisioned"));
          }
        } else {
          console.log(pc.gray("AIdenID: not provisioned (will provision on next login)"));
        }
        return;
      }

      if (status.remoteError) {
        console.log(pc.red(`Remote validation failed: ${status.remoteError.message}`));
        const requestIdValue = status.remoteError.requestId
          ? (shouldExposeSensitiveAuthInfo()
            ? status.remoteError.requestId
            : maskIdentifier(status.remoteError.requestId))
          : "";
        console.log(
          pc.gray(
            `Error code: ${status.remoteError.code} status=${status.remoteError.status}${
              requestIdValue ? ` request_id=${requestIdValue}` : ""
            }`
          )
        );
        if (status.validation === "unavailable") {
          console.log(pc.yellow("Remote validation is temporarily unavailable; your existing credentials were not cleared."));
          console.log(pc.gray("Retry auth status when the API is reachable. Do not sign in again solely for this validation error."));
          return;
        }
        if (["CREDENTIAL_DESTINATION_REFUSED", "CREDENTIAL_PATH_REFUSED"].includes(status.remoteError.code)) {
          console.log(pc.yellow("Credential destination was refused. Check the configured API; signing in again does not change this boundary."));
          return;
        }
      } else {
        console.log(pc.yellow("Remote validation was skipped (`--offline`)."));
      }
      printAuthHint();
    });

  auth
    .command("sessions")
    .alias("list")
    .description("List persisted local session metadata for resume and auditability")
    .option("--api-url <url>", "Override Sentinelayer API base URL")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      let result;
      try {
        result = await listStoredAuthSessions({
          cwd: process.cwd(),
          env: process.env,
          explicitApiUrl: options.apiUrl,
        });
      } catch (error) {
        throw new Error(formatApiError(error));
      }

      const payload = {
        command: "auth sessions",
        ...result,
        defaultCredentialsPath: resolveCredentialsFilePath(),
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("Stored sessions"));
      console.log(pc.gray(`API: ${result.apiUrl}`));
      if (!result.sessions.length) {
        console.log(pc.yellow("No persisted sessions found."));
        printAuthHint();
        return;
      }

      for (const session of result.sessions) {
        console.log(
          `${renderUserSummary(session.user)} | source=${session.source} | storage=${session.storage || "unknown"}`
        );
        if (session.tokenId) {
          const tokenDisplay = shouldRevealTokenIdentifiers() ? session.tokenId : maskIdentifier(session.tokenId);
          console.log(pc.gray(`  token_id: ${tokenDisplay}`));
        }
        if (session.tokenExpiresAt) {
          console.log(pc.gray(`  expires_at: ${session.tokenExpiresAt}`));
        }
        if (session.updatedAt) {
          console.log(pc.gray(`  updated_at: ${session.updatedAt}`));
        }
        if (session.filePath) {
          console.log(pc.gray(`  metadata: ${session.filePath}`));
        }
      }
    });

  auth
    .command("revoke")
    .description("Revoke a remote API token and clear matching local session metadata")
    .option("--api-url <url>", "Override Sentinelayer API base URL")
    .option("--token-id <id>", "API token id to revoke (defaults to active session token id)")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      let result;
      try {
        result = await revokeAuthToken({
          cwd: process.cwd(),
          env: process.env,
          explicitApiUrl: options.apiUrl,
          tokenId: options.tokenId,
        });
      } catch (error) {
        throw new Error(formatApiError(error));
      }

      const payload = {
        command: "auth revoke",
        ...result,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      const tokenDisplay = shouldRevealTokenIdentifiers() ? result.tokenId : maskIdentifier(result.tokenId);
      console.log(pc.green(`Revoked token: ${tokenDisplay}`));
      console.log(pc.gray(`API: ${result.apiUrl}`));
      if (result.matchedStoredSession) {
        console.log(
          pc.gray(
            result.clearedLocal
              ? "Matching local session metadata was cleared."
              : "Matching local session metadata was detected but not cleared."
          )
        );
      } else {
        console.log(pc.gray("No local session metadata matched the revoked token id."));
      }
      if (result.filePath) {
        console.log(pc.gray(`Session metadata path: ${result.filePath}`));
      }
    });

  auth
    .command("logout")
    .description("Clear local session and optionally revoke remote API token")
    .option("--api-url <url>", "Override Sentinelayer API base URL")
    .option("--local-only", "Clear local session only (skip remote revoke)")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      let result;
      try {
        result = await logoutSession({
          cwd: process.cwd(),
          env: process.env,
          explicitApiUrl: options.apiUrl,
          revokeRemote: !options.localOnly,
        });
      } catch (error) {
        throw new Error(formatApiError(error));
      }

      const payload = {
        command: "auth logout",
        ...result,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (!result.hadStoredSession) {
        console.log(pc.yellow("No stored session was found."));
        if (result.apiUrl) {
          console.log(pc.gray(`API: ${result.apiUrl}`));
        }
        return;
      }

      console.log(pc.green("Local session cleared."));
      if (!options.localOnly) {
        console.log(
          pc.gray(
            result.revokedRemote
              ? "Remote API token revoked."
              : "Remote API token revoke skipped or failed."
          )
        );
      }
      if (result.filePath) {
        console.log(pc.gray(`Session metadata path: ${result.filePath}`));
      }
    });
}
