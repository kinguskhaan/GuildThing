import { createHash, randomBytes } from "node:crypto";

const KEY_PREFIX = "gt_";
// Shown in the UI next to a key's name so an admin can tell keys apart
// without ever seeing the secret again — long enough to be distinctive,
// short enough that it's useless on its own for authentication.
const DISPLAY_PREFIX_LENGTH = 11;

// Generates a new API key. The raw value is returned once, to show the
// admin at creation time — only the hash gets persisted (see GuildApiKey in
// the Prisma schema), so a leaked database dump can't be used to forge
// requests.
export function generateApiKey(): {
  raw: string;
  hash: string;
  prefix: string;
} {
  const raw = KEY_PREFIX + randomBytes(24).toString("base64url");
  return {
    raw,
    hash: hashApiKey(raw),
    prefix: raw.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
