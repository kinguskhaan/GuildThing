import { tbcRecipes } from "./tbc/recipes";
import type { WowheadEntry } from "./types";

export type { Expansion, WowheadEntry, WowheadReagent } from "./types";
export { tbcProfessionRecipes } from "./tbc/professions";
export { tbcRecipes } from "./tbc/recipes";
export { PROFESSION_SKILL_LINES } from "./profession-catalog";
export {
  EXPANSIONS,
  EXPANSION_ORDER,
  getExpansion,
  getSpec,
  specLabel,
  wowIconUrl,
  wowheadDomain,
  wowheadSpellUrl,
  type BuffDef,
  type BuffScope,
  type ExpansionDef,
  type ExpansionId,
  type WowClass,
  type WowSpec,
} from "./raidcomp";

export function getWowheadEntry(recipeName: string): WowheadEntry | undefined {
  return tbcRecipes[recipeName];
}

export function wowheadUrl(entry: WowheadEntry): string {
  return `https://www.wowhead.com/tbc/${entry.kind}=${entry.id}`;
}

export function wowheadIconUrl(entry: WowheadEntry): string {
  return `https://wow.zamimg.com/images/wow/icons/medium/${entry.icon}.jpg`;
}
