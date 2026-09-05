import { EXPANSIONS, type ExpansionDef, type ExpansionId } from "@guildthing/wowhead-data";

// groupIndex for bench slots — bench holds placed-but-ungrouped picks, and
// is part of the comp (saved, rendered, draggable) but never counts toward
// raid buff coverage.
export const BENCH_GROUP_INDEX = -1;
export const GROUP_SIZE = 5;

export interface CompSlot {
  groupIndex: number; // -1 = bench
  slotIndex: number;
  rosterMemberId: string | null;
  characterName: string | null;
  classToken: string | null;
  specToken: string | null;
}

export interface CompState {
  id: string;
  name: string;
  groupCount: number;
  slots: CompSlot[];
}

export function expansionDef(expansionId: string): ExpansionDef {
  return EXPANSIONS[(expansionId as ExpansionId) in EXPANSIONS ? (expansionId as ExpansionId) : "tbc"];
}

// First empty slot across the raid groups, group 0 first — the click-to-add
// target. Bench is never auto-filled.
export function firstEmptyGroupSlot(
  comp: CompState,
): { groupIndex: number; slotIndex: number } | null {
  const occupied = new Set(
    comp.slots
      .filter((s) => s.groupIndex >= 0)
      .map((s) => `${s.groupIndex}:${s.slotIndex}`),
  );
  for (let g = 0; g < comp.groupCount; g++) {
    for (let i = 0; i < GROUP_SIZE; i++) {
      if (!occupied.has(`${g}:${i}`)) return { groupIndex: g, slotIndex: i };
    }
  }
  return null;
}

export function benchSlots(comp: CompState): CompSlot[] {
  return comp.slots
    .filter((s) => s.groupIndex === BENCH_GROUP_INDEX)
    .sort((a, b) => a.slotIndex - b.slotIndex);
}

export function groupSlots(comp: CompState, groupIndex: number): CompSlot[] {
  return comp.slots
    .filter((s) => s.groupIndex === groupIndex)
    .sort((a, b) => a.slotIndex - b.slotIndex);
}


// Does any placed slot provide this buff? A buff with specToken(s) is tied
// to specific spec(s) (TBC Battle Shout: Arms OR Fury; Commanding Shout:
// Protection only); a buff with only a classToken comes from any member of
// the class (e.g. a mage's Arcane Intellect). Buffs with neither are
// outside the auto-coverage model and render as uncovered.
export function providedBySlots(
  buff: { specToken?: string; specTokens?: string[]; classToken?: string },
  slots: CompSlot[],
): boolean {
  const specSet = buff.specTokens ?? (buff.specToken ? [buff.specToken] : []);
  if (specSet.length > 0) {
    return slots.some((slot) => slot.specToken != null && specSet.includes(slot.specToken));
  }
  if (buff.classToken) {
    return slots.some((slot) => slot.classToken === buff.classToken);
  }
  return false;
}

// Raid-level coverage for the bands: every buff of the expansion with a
// covered flag, in catalog order (catalog order is the display order).
export function raidCoverage(expansion: ExpansionDef, comp: CompState) {
  const placed = comp.slots.filter((s) => s.groupIndex >= 0);
  const buffs = expansion.buffs.filter((b) => b.kind === "buff");
  const debuffs = expansion.buffs.filter((b) => b.kind === "debuff");
  return {
    buffs: buffs.map((buff) => ({ buff, covered: providedBySlots(buff, placed) })),
    debuffs: debuffs.map((buff) => ({ buff, covered: providedBySlots(buff, placed) })),
  };
}

// Group-scoped buffs one specific group currently provides — the per-group
// footer line (TBC: Bloodlust/party totems; Cata+ raid-wide buffs don't show
// here because scope "raid" moves them to the raid band).
export function groupCoverage(expansion: ExpansionDef, comp: CompState, groupIndex: number) {
  const slots = comp.slots.filter((s) => s.groupIndex === groupIndex);
  return expansion.buffs.filter(
    (b) => b.kind === "buff" && b.scope === "group" && providedBySlots(b, slots),
  );
}