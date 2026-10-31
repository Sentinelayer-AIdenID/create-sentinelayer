// One place for the size limits that decide whether a session message reaches its reader whole.
//
// The API stores an agent message, a human message or a threaded reply of up to
// SERVER_MESSAGE_MAX_CHARS characters. Every read path in the CLI (the local stream store,
// `session read`, the MCP read and inbox tools, the human-message relay and the wake prompts)
// delivers a message whole up to that limit. A longer string cannot come from the server; if
// one appears anyway it is cut with an explicit marker that states its original length, never
// silently.
//
// Lengths against the server limit count Unicode code points, as the server does.

export const SERVER_MESSAGE_MAX_CHARS = 64_000;

// A message given as command-line words longer than this can be cut by the shell on Windows
// before the CLI ever sees it, so the CLI suggests --message-file or --stdin instead.
export const ARGV_MESSAGE_WARN_CHARS = 30_000;

// Default total size of one page of a bundled read (MCP read_history and poll_inbox,
// `session read --tail`). A page always ends between two whole messages.
export const DEFAULT_READ_PAGE_MAX_CHARS = 256_000;

// A wake prompt longer than this goes to the host CLI over stdin instead of argv: Windows caps
// a whole command line at 32,767 UTF-16 units (argument quoting can double a message), and
// Linux caps one argument at 128 KiB.
export const WAKE_ARGV_PROMPT_MAX_CHARS = 16_000;

/**
 * A character count with thousands separators, for messages and help text ("64,000").
 */
export function formatCount(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Number of Unicode code points in a string, the unit the server limit is counted in.
 */
export function countMessageChars(value) {
  let count = 0;
  for (const _codePoint of String(value ?? "")) count += 1;
  return count;
}

function codePointPrefix(text, maxChars) {
  let count = 0;
  let end = 0;
  for (const codePoint of text) {
    if (count === maxChars) break;
    count += 1;
    end += codePoint.length;
  }
  return text.slice(0, end);
}

export function beyondServerLimitMarker(originalChars) {
  return `\n[cut: this text has ${formatCount(originalChars)} characters, more than the ${formatCount(SERVER_MESSAGE_MAX_CHARS)}-character server limit for one message]`;
}

/**
 * Returns the text whole when it is within the server limit. A longer text keeps its first
 * SERVER_MESSAGE_MAX_CHARS characters followed by an explicit marker with its original length.
 *
 * @param {string} value
 * @returns {{ text: string, cut: boolean, originalChars: number }}
 */
export function boundToServerLimit(value) {
  const text = String(value ?? "");
  if (text.length <= SERVER_MESSAGE_MAX_CHARS) {
    return { text, cut: false, originalChars: text.length };
  }
  const originalChars = countMessageChars(text);
  if (originalChars <= SERVER_MESSAGE_MAX_CHARS) {
    return { text, cut: false, originalChars };
  }
  return {
    text: `${codePointPrefix(text, SERVER_MESSAGE_MAX_CHARS)}${beyondServerLimitMarker(originalChars)}`,
    cut: true,
    originalChars,
  };
}

/**
 * The error for a message, reply or note that is longer than the server accepts.
 */
export function messageTooLongError(chars, { what = "message" } = {}) {
  return new Error(
    `The ${what} has ${formatCount(chars)} characters; one session message holds at most ` +
      `${formatCount(SERVER_MESSAGE_MAX_CHARS)}. Attach the full text to the room as a file instead, ` +
      "or shorten it. The CLI never splits a message into parts.",
  );
}

/**
 * Throws messageTooLongError when the text is over the server limit; returns its length.
 */
export function assertMessageWithinServerLimit(value, { what = "message" } = {}) {
  const chars = countMessageChars(value);
  if (chars > SERVER_MESSAGE_MAX_CHARS) {
    throw messageTooLongError(chars, { what });
  }
  return chars;
}

/**
 * The warning for a long message given as command-line words, or "" when none is needed.
 */
export function argvMessageWarning(value) {
  const length = String(value ?? "").length;
  if (length <= ARGV_MESSAGE_WARN_CHARS) return "";
  return (
    `Warning: this ${formatCount(length)}-character message came from command-line arguments, ` +
    "which a shell on Windows can cut silently. Post long text with --message-file <path> or --stdin."
  );
}

/**
 * A positive integer page budget, or the default when the value is missing or invalid.
 */
export function normalizeReadPageMaxChars(value, fallback = DEFAULT_READ_PAGE_MAX_CHARS) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

export function serializedChars(item) {
  try {
    const json = JSON.stringify(item);
    return typeof json === "string" ? json.length : 0;
  } catch {
    return String(item ?? "").length;
  }
}

/**
 * Takes whole items, in order, until the next one would push the page past maxChars. The page
 * never splits an item and is contiguous, so a cursor taken from its edge resumes exactly at
 * the first item left out. The first item is always taken, even when it alone is larger than
 * the budget.
 *
 * @param {Array} items
 * @param {{ maxChars?: number, fromEnd?: boolean, measure?: (item: any) => number }} [options]
 *   fromEnd keeps the newest (last) items and leaves out the oldest.
 * @returns {{ items: Array, maxChars: number, usedChars: number, omittedCount: number, complete: boolean }}
 */
export function takeWholeItemsWithinBudget(
  items,
  { maxChars = DEFAULT_READ_PAGE_MAX_CHARS, fromEnd = false, measure = serializedChars } = {},
) {
  const list = Array.isArray(items) ? items : [];
  const budget = normalizeReadPageMaxChars(maxChars);
  let usedChars = 0;
  let kept = 0;
  for (let step = 0; step < list.length; step += 1) {
    const item = list[fromEnd ? list.length - 1 - step : step];
    const size = Math.max(0, Number(measure(item)) || 0);
    if (kept > 0 && usedChars + size > budget) break;
    usedChars += size;
    kept += 1;
  }
  const page = fromEnd ? list.slice(list.length - kept) : list.slice(0, kept);
  return {
    items: page,
    maxChars: budget,
    usedChars,
    omittedCount: list.length - kept,
    complete: kept === list.length,
  };
}
