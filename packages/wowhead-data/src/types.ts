export type Expansion = "tbc" | "classic" | "wotlk";

export interface WowheadReagent {
  name: string;
  quantity: number;
}

export interface WowheadEntry {
  kind: "item" | "spell";
  id: number;
  name: string;
  icon: string;
  /** Missing for some spell tooltips (Wowhead only reports quality for items). */
  quality?: number;
  /** What the recipe/enchant does, e.g. "Permanently enchant ... Requires a level 35 or higher item." */
  description?: string;
  /** Crafting materials, if any. Look each one up via getWowheadEntry(name) for its own icon/id. */
  reagents?: WowheadReagent[];
}
