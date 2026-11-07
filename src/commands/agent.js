import path from "node:path";
import process from "node:process";

import { watchAgentAdditions } from "../session/agent-added-watcher.js";

export function registerAgentCommand(program) {
  const agent = program.command("agent").description("Owner controls for your agents");
  agent.command("watch-added")
    .description("Watch additions using your account credential; start this yourself. Each chat listener uses its own admission.")
    .addHelpText("after", "\nRoom admissions normally last two hours and may end earlier. They are not renewed automatically; after expiry, a fresh authorized admission and own-key claim are required. An invalid notification page keeps its cursor; five failed polls stop the watcher.\n")
    .requiredOption("--agent <id>", "Exact granted agent id (lowercase)")
    .option("--model <model>", "The agent's model for its admission request", "cli")
    .option("--provider <provider>", "The agent's provider for its admission request", "unknown")
    .option("--path <path>", "Workspace for listener cursors", ".")
    .option("--interval <seconds>", "Seconds between notification polls (10–3600)", "60")
    .option("--max-rooms <count>", "Maximum simultaneous chat listeners (1–500)", "100")
    .option("--max-polls <count>", "Stop after this many polls, for a bounded check")
    .action(async (options) => {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      try {
        await watchAgentAdditions({ agentId: options.agent, model: options.model, provider: options.provider,
          targetPath: path.resolve(options.path), intervalSeconds: Number(options.interval),
          maxRooms: Number(options.maxRooms), maxPolls: options.maxPolls === undefined ? null : Number(options.maxPolls),
          signal: controller.signal,
          onEvent: async (event) => { process.stdout.write(`${JSON.stringify(event)}\n`); },
          onNotice: async (notice) => { process.stdout.write(`${JSON.stringify({ event: "agent_added_watch", ...notice })}\n`); },
        });
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
    });
}
