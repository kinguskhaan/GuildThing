import { statSync } from "node:fs";

import { postCharacters, postRoster } from "./api";
import { defaultWowWtfDir, findSavedVariablesFile } from "./paths";
import { parseRecipesFile } from "./parseRecipes";
import { parseRosterFile } from "./parseRoster";

interface Config {
  apiUrl: string;
  apiKey: string;
  wtfDir: string;
}

function loadConfig(): Config {
  const apiUrl = process.env.GUILDTHING_API_URL;
  const apiKey = process.env.GUILDTHING_API_KEY;
  if (!apiUrl || !apiKey) {
    console.error(
      "Set GUILDTHING_API_URL and GUILDTHING_API_KEY in apps/sync/.env (copy .env.example) — get a key from your guild's admin > API keys page.",
    );
    process.exit(1);
  }

  const wtfDir = defaultWowWtfDir();
  if (!wtfDir) {
    console.error(
      "Couldn't guess your WoW install path (this is normal on Linux/Steam Proton) — set WOW_WTF_DIR in apps/sync/.env to the folder that contains 'Account' (e.g. .../World of Warcraft/_anniversary_/WTF).",
    );
    process.exit(1);
  }

  return { apiUrl, apiKey, wtfDir };
}

async function syncOnce(config: Config): Promise<void> {
  const rosterFile = findSavedVariablesFile(config.wtfDir, "GuildThing.lua");
  const members = parseRosterFile(rosterFile);
  const rosterResult = await postRoster(config.apiUrl, config.apiKey, members);
  console.log(`[sync] roster: pushed ${rosterResult.count} member(s)`);

  const recipesFile = findSavedVariablesFile(config.wtfDir, "OurRecipes.lua");
  const characters = parseRecipesFile(recipesFile);
  const charResult = await postCharacters(
    config.apiUrl,
    config.apiKey,
    characters,
  );
  console.log(
    `[sync] characters: imported ${charResult.imported}/${characters.length}`,
  );
  for (const err of charResult.errors) {
    console.error(`[sync]   ${err.name}-${err.realm}: ${err.message}`);
  }
}

const POLL_INTERVAL_MS = 15_000;
// WoW writes several addons' SavedVariables files close together on
// logout/reload — wait for things to settle before syncing, so a run
// doesn't fire mid-write or fire twice for one logout.
const DEBOUNCE_MS = 5_000;

function watch(config: Config): void {
  console.log("[sync] watching for SavedVariables changes (Ctrl+C to stop)...");

  let lastRosterMtime = 0;
  let lastRecipesMtime = 0;
  let pendingSync: NodeJS.Timeout | null = null;

  const check = () => {
    let rosterMtime: number;
    let recipesMtime: number;
    try {
      rosterMtime = statSync(
        findSavedVariablesFile(config.wtfDir, "GuildThing.lua"),
      ).mtimeMs;
      recipesMtime = statSync(
        findSavedVariablesFile(config.wtfDir, "OurRecipes.lua"),
      ).mtimeMs;
    } catch (err) {
      console.error("[sync] couldn't check SavedVariables files:", err);
      return;
    }

    if (rosterMtime === lastRosterMtime && recipesMtime === lastRecipesMtime) {
      return;
    }
    lastRosterMtime = rosterMtime;
    lastRecipesMtime = recipesMtime;

    if (pendingSync) clearTimeout(pendingSync);
    pendingSync = setTimeout(() => {
      syncOnce(config).catch((err: unknown) => {
        console.error("[sync] failed:", err);
      });
    }, DEBOUNCE_MS);
  };

  check();
  setInterval(check, POLL_INTERVAL_MS);
}

const config = loadConfig();
if (process.argv.includes("--once")) {
  syncOnce(config)
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error("[sync] failed:", err);
      process.exit(1);
    });
} else {
  watch(config);
}
