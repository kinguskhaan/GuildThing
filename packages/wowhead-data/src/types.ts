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
  /**
   * itemID of this entry's item form — set when this entry (of either
   * kind) has been seen as a reagent elsewhere and its itemID was captured
   * from that reagent's item link. For kind:"item" entries this usually
   * just duplicates `id`; for kind:"spell" entries it's the *only* place
   * the crafted item's own itemID is recorded (spellID and itemID are
   * different numbers). Absent until backfilled — see wowhead-sync.ts.
   */
  itemId?: number;
}
