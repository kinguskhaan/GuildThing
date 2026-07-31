/**
 * Shared tbcdb.com scraping for TBC profession spell lists. tbcdb.com (a
 * Wowhead-engine TBC database mirror) serves each profession's full recipe
 * list as static, server-rendered <script> JSON with no bot wall — one
 * request per profession gives every recipe's name, spellId and reagents.
 * Used by resolve-spell-ids.ts (backfill Recipe.spellId for imported
 * characters) and wowhead-sync.ts (seed the full catalog regardless of
 * import status).
 */

// tbcdb.com skill-line query params (category.skillLineId), for professions
// that actually have craftable recipes (gathering skills like Mining or
// Herbalism have none, so they're not listed here).
export const PROFESSION_SKILL_LINES: Record<string, string> = {
  Alchemy: "11.171",
  Blacksmithing: "11.164",
  Enchanting: "11.333",
  Engineering: "11.202",
  Jewelcrafting: "11.755",
  Leatherworking: "11.165",
  Tailoring: "11.197",
  Cooking: "9.185",
};

export interface ProfessionRecipe {
  name: string;
  spellId: number;
}

function unescapeSingleQuoted(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

export function parseProfessionSpells(html: string): ProfessionRecipe[] {
  const section = /id:\s*'spells'[\s\S]*?data:\[([\s\S]*?)\]\}\);/.exec(
    html,
  )?.[1];
  if (!section) return [];

  const entries: ProfessionRecipe[] = [];
  for (const rawChunk of section.split("},{")) {
    const raw = rawChunk.replace(/^\{/, "").replace(/\}$/, "");

    const nameMatch = /name:\s*'@((?:[^'\\]|\\.)*)'/.exec(raw);
    const idMatch = /\bid:\s*(\d+)\s*$/.exec(raw);
    if (!nameMatch || !idMatch) continue;

    // Deliberately not filtering out skill-rank markers (e.g. "Cooking" -
    // Apprentice/Journeyman/...) or reagent-less specializations (e.g.
    // "Armorsmith", "Disenchant") — tbcdb's own per-profession totals count
    // every one of these, and matching that total is how this list gets
    // verified against tbcdb by hand.
    entries.push({
      name: unescapeSingleQuoted(nameMatch[1]!),
      spellId: Number(idMatch[1]!),
    });
  }
  return entries;
}

export async function fetchProfessionSpells(
  skillLineQuery: string,
): Promise<ProfessionRecipe[]> {
  const res = await fetch(`https://tbcdb.com/?spells=${skillLineQuery}`);
  if (!res.ok) {
    throw new Error(`tbcdb.com spells=${skillLineQuery} failed: ${res.status}`);
  }
  return parseProfessionSpells(await res.text());
}
