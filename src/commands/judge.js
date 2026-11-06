import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { formatJudgeVerdictErrors, renderJudgeVerdictMessage, validateJudgeVerdict } from "../judge/verdict.js";

function shouldEmitJson(options, command) {
  if (options && options.json) return true;
  return typeof command?.optsWithGlobals === "function" ? Boolean(command.optsWithGlobals().json) : false;
}

async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readVerdictDocument(options) {
  if (options.file && options.stdin) throw new Error("Use --file or --stdin, not both.");
  if (!options.file && !options.stdin) throw new Error("Give the verdict with --file <path> or --stdin.");
  const raw = options.stdin
    ? await readStdinText()
    : await fsp.readFile(path.resolve(process.cwd(), String(options.file)), "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`The verdict is not valid JSON: ${error.message}`);
  }
}

function report(emitJson, payload, text) {
  if (emitJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${text}\n`);
  }
}

function fail(emitJson, command, error) {
  const message = error && error.message ? error.message : String(error);
  if (emitJson) {
    process.stdout.write(`${JSON.stringify({ command, ok: false, reason: message }, null, 2)}\n`);
  } else {
    process.stderr.write(`${command} failed: ${message}\n`);
  }
  process.exitCode = 1;
}

export function registerJudgeCommand(program) {
  const judge = program
    .command("judge")
    .description("Judge a coding agent's work and send the verdict back (LLM-as-a-judge loop)");

  judge
    .command("check")
    .description("Validate a judge-verdict offline and print the message the coder will receive")
    .option("--file <path>", "Verdict JSON file")
    .option("--stdin", "Read the verdict JSON from stdin")
    .option("--escalate-to <handle...>", "Human handle(s) to mention when the verdict escalates")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      try {
        const checked = validateJudgeVerdict(await readVerdictDocument(options));
        if (!checked.ok) {
          report(emitJson, { command: "judge check", ok: false, errors: checked.errors },
            `Invalid verdict: ${formatJudgeVerdictErrors(checked.errors)}`);
          process.exitCode = 1;
          return;
        }
        const message = renderJudgeVerdictMessage(checked.verdict, { escalateTo: options.escalateTo || [] });
        report(emitJson, { command: "judge check", ok: true, verdict: checked.verdict, message }, message);
      } catch (error) {
        fail(emitJson, "judge check", error);
      }
    });

  judge
    .command("verdict <sessionId>")
    .description("Send a judge-verdict to the room: the coder is mentioned and woken, and the verdict is recorded")
    .option("--agent <id>", "Your judge agent id (default: SENTINELAYER_AGENT_ID)")
    .option("--file <path>", "Verdict JSON file")
    .option("--stdin", "Read the verdict JSON from stdin")
    .option("--via <transport>", "auto (the API route when the server has it, else a room message), api, or room", "auto")
    .option("--escalate-to <handle...>", "Human handle(s) to mention when the verdict escalates")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--dry-run", "Validate and print the message without sending it")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      try {
        const verdict = await readVerdictDocument(options);
        const agentId = String(options.agent || process.env.SENTINELAYER_AGENT_ID || "").trim();
        if (!agentId) throw new Error("Name your judge agent with --agent <id> or SENTINELAYER_AGENT_ID.");
        const targetPath = path.resolve(process.cwd(), String(options.path || "."));
        // One implementation for the CLI and MCP: the native judge_verdict tool, which already runs
        // under the admission policy every local session tool uses.
        const { createSessionMcpToolHandlers } = await import("../mcp/session-stdio-server.js");
        const handlers = createSessionMcpToolHandlers({ targetPath });
        const result = await handlers.judge_verdict({
          sessionId,
          agentId,
          verdict,
          via: options.via,
          escalateTo: options.escalateTo || [],
          dryRun: Boolean(options.dryRun),
        });
        const payload = { command: "judge verdict", ...result };
        if (!result.ok) {
          const why = result.errors ? formatJudgeVerdictErrors(result.errors) : result.reason;
          report(emitJson, payload, `Verdict not sent: ${why}`);
          process.exitCode = 1;
          return;
        }
        if (result.dryRun) {
          report(emitJson, payload, result.message);
          return;
        }
        report(emitJson, payload,
          `Verdict ${result.verdict.verdict} (round ${result.verdict.round}) sent to @${result.verdict.coder} via ${result.transport}.`);
      } catch (error) {
        fail(emitJson, "judge verdict", error);
      }
    });
}
