import { parseExposureUsd } from "../cost/run-admission.js";

const FLAG = "--max-model-token-exposure";

export function parseExposureOption(value, previous) {
  if (previous !== undefined) throw new Error(`${FLAG} must be supplied exactly once.`);
  parseExposureUsd(value);
  return value;
}

/** Only this money-bound flag is normalized; unrelated legacy arguments are untouched. */
export function normalizeExposureOption(args) {
  const indexes = args.flatMap((arg, index) => arg === FLAG || String(arg).startsWith(`${FLAG}=`) ? [index] : []);
  if (!indexes.length) return args;
  if (indexes.length !== 1) throw new Error(`${FLAG} must be supplied exactly once.`);
  const index = indexes[0], delimiter = args.indexOf("--");
  if (String(args[0]).toLowerCase() !== "/omargate" || String(args[1]).toLowerCase() !== "deep" || index < 2 || delimiter >= 0 && delimiter < index) {
    throw new Error(`${FLAG} is supported only after omargate deep, before --.`);
  }
  const inline = String(args[index]).startsWith(`${FLAG}=`);
  const value = inline ? String(args[index]).slice(FLAG.length + 1) : args[index + 1];
  parseExposureOption(value);
  return inline ? [...args.slice(0, index), FLAG, value, ...args.slice(index + 1)] : args;
}
