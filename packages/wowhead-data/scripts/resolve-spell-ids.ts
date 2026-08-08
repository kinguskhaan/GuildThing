/**
 * Fills in missing Recipe.spellId for professions that only carry an itemId
 * (Cooking, Engineering, ...). Wowhead's tooltip API has no item->spell
 * reference, and Wowhead's own site is behind bot detection that blocks
 * plain HTTP requests. tbcdb.com (a Wowhead-engine TBC database mirror)
 * serves the same underlying data as static, server-rendered <script> JSON
 * with no bot wall — each profession's spell-list page
 * (tbcdb.com/?spells=<category>.<skillLineId>) embeds every recipe in that
 * profession with its spellId and reagents in one response, so this only
 * needs one request per profession rather than one per recipe.
 *
 * Run with:
 *
 *   pnpm resolve-spell-ids
 *
 * Safe to re-run any time — only recipes with spellId still null are
 * updated. Run this before `pnpm wowhead:sync` so the sync step picks up
 * spellId (and can resolve reagents/description) for every profession, not
 * just Enchanting.
 */
import { PrismaClient } from "@guildthing/db";
import {
  fetchProfessionSpells,
  PROFESSION_SKILL_LINES,
} from "../src/profession-catalog";

const REQUEST_DELAY_MS = 300;

const db = new PrismaClient();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  let updated = 0;
  let unresolved = 0;

  for (const [professionName, skillLineQuery] of Object.entries(
    PROFESSION_SKILL_LINES,
  )) {
    const missing = await db.recipe.findMany({
      where: { spellId: null, profession: { name: professionName } },
      select: { id: true, name: true },
    });
    if (missing.length === 0) continue;

    const byName = new Map<string, { id: string }[]>();
    for (const r of missing) {
      const list = byName.get(r.name) ?? [];
      list.push({ id: r.id });
      byName.set(r.name, list);
    }

    const recipes = await fetchProfessionSpells(skillLineQuery);
    const spellIdByName = new Map(recipes.map((r) => [r.name, r.spellId]));

    let professionUnresolved = 0;
    for (const [name, rows] of byName) {
      const spellId = spellIdByName.get(name);
      if (spellId == null) {
        professionUnresolved += rows.length;
        continue;
      }
      await db.recipe.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { spellId },
      });
      updated += rows.length;
    }
    unresolved += professionUnresolved;

    console.log(
      `[resolve-spell-ids] ${professionName}: ${missing.length} missing, resolved ${missing.length - professionUnresolved}`,
    );

    await sleep(REQUEST_DELAY_MS);
  }

  console.log(
    `[resolve-spell-ids] recipe rows updated: ${updated}, unresolved: ${unresolved}`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
