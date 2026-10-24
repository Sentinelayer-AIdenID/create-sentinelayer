/** Structural SHA-256 address only; callers still verify bytes and trust. */
import { z } from "zod";

// 32 bytes: 64 hexadecimal characters or canonical padded base64.
export const sha256ContentHashSchema = z.string().regex(
  /^sha256:(?:[0-9a-fA-F]{64}|[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=)$/,
  { message: "contentHash must be a complete sha256 digest in hex or canonical base64" },
);
