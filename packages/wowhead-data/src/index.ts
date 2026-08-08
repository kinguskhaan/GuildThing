import { tbcRecipes } from "./tbc/recipes";
import type { WowheadEntry } from "./types";

export type { Expansion, WowheadEntry, WowheadReagent } from "./types";
export { tbcProfessionRecipes } from "./tbc/professions";
export { tbcRecipes } from "./tbc/recipes";
export { PROFESSION_SKILL_LINES } from "./profession-catalog";

export function getWowheadEntry(recipeName: string): WowheadEntry | undefined {
  return tbcRecipes[recipeName];
}

export function wowheadUrl(entry: WowheadEntry): string {
  return `https://www.wowhead.com/tbc/${entry.kind}=${entry.id}`;
}

export function wowheadIconUrl(entry: WowheadEntry): string {
  return `https://wow.zamimg.com/images/wow/icons/medium/${entry.icon}.jpg`;
}
