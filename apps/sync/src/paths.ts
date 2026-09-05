import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

// The Battle.net launcher installs each version side by side under one WoW
// root, in a folder named after the version — these are the launcher's own
// folder names, not something GuildThing invented.
const VERSION_FOLDERS = {
  retail: "_retail_",
  classic: "_classic_",
  classic_era: "_classic_era_",
  anniversary: "_anniversary_",
} as const;

export type WowVersion = keyof typeof VERSION_FOLDERS;

// Lets a sync target say { wowDir, version: "classic_era" } instead of
// spelling out the full .../classic_era_/WTF path by hand.
export function resolveWtfDir(wowDir: string, version: string): string {
  const folder = (VERSION_FOLDERS as Record<string, string>)[version];
  if (!folder) {
    throw new Error(
      `Unknown WoW version "${version}" — expected one of: ${Object.keys(VERSION_FOLDERS).join(", ")}.`,
    );
  }
  return join(wowDir, folder, "WTF");
}

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
// folder names aren't knowable in advance, so this checks every account
// under WTF/Account. One install can hold several Battle.net accounts,
// each with its own copy of the addon's data — sync consumers need them
// ALL, so this lists every account's file (sorted, so run-to-run read
// order is stable).
export function listSavedVariablesFiles(wtfDir: string, filename: string): string[] {
  const accountsDir = join(wtfDir, "Account");
  if (!existsSync(accountsDir)) return [];

  return readdirSync(accountsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(accountsDir, entry.name, "SavedVariables", filename))
    .filter((candidate) => existsSync(candidate))
    .sort();
}

// The first account's file, for callers that only care whether one exists
// at all (the legacy single-account read).
export function findSavedVariablesFileOptional(
  wtfDir: string,
  filename: string,
): string | null {
  return listSavedVariablesFiles(wtfDir, filename)[0] ?? null;
}

// Only GuildThing.lua (the roster/`/gtr` addon) is required — OurRecipes is
// optional, so callers wanting it use findSavedVariablesFileOptional()
// instead and treat a miss as "no recipe data" rather than an error.
export function findSavedVariablesFile(wtfDir: string, filename: string): string {
  const found = findSavedVariablesFileOptional(wtfDir, filename);
  if (found) return found;

  const accountsDir = join(wtfDir, "Account");
  if (!existsSync(accountsDir)) {
    throw new Error(
      `No Account folder found under ${wtfDir} — check WOW_WTF_DIR in .env points at your WTF folder.`,
    );
  }
  throw new Error(
    `Couldn't find ${filename} under ${accountsDir}/*/SavedVariables — make sure the addon is installed and you've logged in at least once since installing it.`,
  );
}

// The GuildThing addon's own install folder — Interface/AddOns/GuildThing,
// a sibling of WTF under the same version folder (.../_classic_era_/WTF
// and .../_classic_era_/Interface/AddOns/GuildThing). Unlike SavedVariables
// (per-account, under WTF/Account/<ACCOUNT>/...), an addon's own files are
// ONE copy shared by every account on this install — no per-account
// discovery needed, just this one fixed relative path. Used for writing
// plain addon-code files (see luaWriter.ts's SyncData.lua comment for why)
// rather than SavedVariables globals, so they're re-read fresh from disk
// on every addon load instead of being subject to WoW's save-current-
// state-first-then-reload behavior for SavedVariables.
export function resolveAddonInstallDir(wtfDir: string): string {
  const dir = join(dirname(wtfDir), "Interface", "AddOns", "GuildThing");
  if (!existsSync(dir)) {
    throw new Error(
      `Couldn't find the GuildThing addon's install folder at ${dir} — make sure the addon is installed there (this is derived from your WTF folder's location, not WOW_WTF_DIR directly).`,
    );
  }
  return dir;
}
