// How a wake prompt reaches a host CLI (claude, codex) whole.
//
// Both hosts take the prompt as an argument or on stdin. A short prompt stays an argument, as it
// always has. A long one goes over stdin, because argv cannot carry a whole server-limit
// message: Windows caps a whole command line at 32,767 UTF-16 units and Linux caps one argument
// at 128 KiB.

import { WAKE_ARGV_PROMPT_MAX_CHARS } from "../message-limits.js";

export function promptFitsArgv(prompt) {
  return String(prompt ?? "").length <= WAKE_ARGV_PROMPT_MAX_CHARS;
}

/**
 * Writes the prompt to a spawned child's stdin and closes it. Returns "" on success, or a
 * reason when the prompt cannot be delivered; the caller then reports the wake as failed.
 */
export function sendPromptOnStdin(child, prompt) {
  const stdin = child?.stdin;
  if (!stdin || typeof stdin.end !== "function") {
    try {
      child?.kill?.();
    } catch {
      // The wake already failed; a child that cannot be stopped exits at its timeout.
    }
    return "wake_prompt_stdin_unavailable";
  }
  // A host that exits before reading the prompt closes the pipe; its exit status reports the
  // failure, so an EPIPE here must not crash the process.
  if (typeof stdin.on === "function") stdin.on("error", () => {});
  stdin.end(String(prompt ?? ""), "utf8");
  return "";
}
