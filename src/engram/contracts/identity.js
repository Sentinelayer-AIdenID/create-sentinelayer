import { z } from "zod";

// Preserve identity bytes exactly. Trimming at parse time could silently
// change a tenant or source key; blank or padded identities are invalid.
export const nonblankIdentitySchema = z.string().min(1).refine(
  (value) => value.trim().length > 0 && value.trim() === value,
  "identity must be nonblank and unpadded",
);
