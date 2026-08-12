import { readFileSync } from "node:fs";

import {
  asArray,
  asObject,
  asString,
  parseLuaGlobals,
  type LuaValue,
} from "./luaTable";

export interface RecipeEntry {
  name: string;
  itemID: number | null;
  spellID: number | null;
}

// Matches wowImportSchema on the web side (see
// apps/web/src/server/wow-import.ts) minus `peers` — peer-relayed data
// (OurRecipes' P2P mesh, GuildThingDB.P2PDataByGuild) only has recipe
// *names*, no itemID, and isn't pushed by this script yet.
export interface ImportedCharacter {
  name: string;
  realm: string;
  class?: string;
  professions: Record<string, RecipeEntry[]>;
}

function isCharacterEntry(value: LuaValue): value is Record<string, LuaValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "professions" in value
  );
}

// OurRecipes.lua: `GuildThingDB = { p2pSettings = {...}, KnownCharacters =
// {...}, P2PDataByGuild = {...}, ["Tankkingen-Spineshatter"] = { name =
// "Tankkingen", class = "WARRIOR", professions = { Engineering = [...] }
// }, ... }` — every character on the account is a top-level key shaped
// "<Name>-<Realm>", sitting alongside a handful of fixed bookkeeping keys.
// Rather than hardcode that exact list of non-character keys (fragile if
// the addon adds more), this just keeps whichever top-level entries have a
// `professions` field — every real character entry has one, none of the
// bookkeeping ones do.
export function parseRecipesFile(filePath: string): ImportedCharacter[] {
  const globals = parseLuaGlobals(readFileSync(filePath, "utf8"));
  const db = asObject(globals.GuildThingDB);

  const characters: ImportedCharacter[] = [];
  for (const [key, value] of Object.entries(db)) {
    if (!isCharacterEntry(value)) continue;

    // Character names never contain a hyphen; realm names sometimes do
    // (e.g. "Area-52") — so split on the FIRST hyphen, not the last.
    const dash = key.indexOf("-");
    if (dash === -1) continue;
    const name = key.slice(0, dash);
    const realm = key.slice(dash + 1);

    const professionsRaw = asObject(value.professions);
    const professions: Record<string, RecipeEntry[]> = {};
    for (const [professionName, recipesRaw] of Object.entries(
      professionsRaw,
    )) {
      professions[professionName] = asArray(recipesRaw).map((r) => {
        const recipe = asObject(r);
        return {
          name: asString(recipe.name),
          itemID: typeof recipe.itemID === "number" ? recipe.itemID : null,
          spellID: typeof recipe.spellID === "number" ? recipe.spellID : null,
        };
      });
    }

    characters.push({
      name,
      realm,
      class: typeof value.class === "string" ? value.class : undefined,
      professions,
    });
  }
  return characters;
}
