import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The WTF folder's default location varies by platform, and on Linux/Steam
// Proton it also depends on the game's per-title compatdata folder id,
// which can't be guessed — WOW_WTF_DIR in .env always wins when set.
export function defaultWowWtfDir(): string | null {
  if (process.env.WOW_WTF_DIR) return process.env.WOW_WTF_DIR;

  if (process.platform === "win32") {
    return "C:\\Program Files (x86)\\World of Warcraft\\_anniversary_\\WTF";
  }

  return null;
}

// Both addons write account-wide (not per-character) SavedVariables, under
// WTF/Account/<ACCOUNT>/SavedVariables/<addon-file>.lua — the account
// folder name isn't knowable in advance, so this checks every account
// under WTF/Account for the file and returns the first match.
export function findSavedVariablesFile(wtfDir: string, filename: string): string {
  const accountsDir = join(wtfDir, "Account");
  if (!existsSync(accountsDir)) {
    throw new Error(
      `No Account folder found under ${wtfDir} — check WOW_WTF_DIR in .env points at your WTF folder.`,
    );
  }

  const accounts = readdirSync(accountsDir, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory(),
  );
  for (const account of accounts) {
    const candidate = join(accountsDir, account.name, "SavedVariables", filename);
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `Couldn't find ${filename} under ${accountsDir}/*/SavedVariables — make sure the addon is installed and you've logged in at least once since installing it.`,
  );
}
