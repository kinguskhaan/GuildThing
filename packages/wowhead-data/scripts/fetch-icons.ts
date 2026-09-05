// Downloads every class/spec/buff icon referenced by the raid comp
// catalog (packages/wowhead-data/src/raidcomp.ts) into
// apps/web/public/icons/wow/{slug}.jpg — so the shipped app never
// hotlinks a third party at runtime. Idempotent: existing files are
// skipped, so re-run freely after catalog changes.
//
// Sources (verified against wowtbc.gg's own raid-comp pages, one per
// expansion — see raidcomp.ts's header comment):
//   - Class icons: Wowhead's class-icon CDN (wow.zamimg.com).
//   - Spec/buff icons: wowtbc.gg's own icon CDN (sunderarmor.com), split
//     across two folders — "WOW" for classic/tbc/wotlk-era assets, and
//     "WOWCATA" for the cata/mop-era refresh (verified: MoP's raid-comp
//     page still serves its spec icons from the WOWCATA folder).
//
// Usage: pnpm --filter @guildthing/wowhead-data exec tsx scripts/fetch-icons.ts

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EXPANSIONS, type ExpansionId } from "../src/raidcomp";

const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/web/public/icons/wow",
);

// Referenced directly by UI fallbacks rather than the catalog itself (e.g.
// a roster member with no known class yet).
const MANUAL_ICONS: { slug: string; url: string }[] = [
  {
    slug: "inv_misc_questionmark",
    url: "https://wow.zamimg.com/images/wow/icons/large/inv_misc_questionmark.jpg",
  },
];

function eraFolder(expansion: ExpansionId): "WOW" | "WOWCATA" {
  return expansion === "cata" || expansion === "mop" ? "WOWCATA" : "WOW";
}

interface IconJob {
  slug: string;
  url: string;
}

function collectJobs(): IconJob[] {
  const jobs = new Map<string, string>();
  const set = (slug: string, url: string) => {
    if (!jobs.has(slug)) jobs.set(slug, url);
  };

  for (const extra of MANUAL_ICONS) set(extra.slug, extra.url);

  for (const expansion of Object.values(EXPANSIONS)) {
    const folder = eraFolder(expansion.id);
    for (const cls of expansion.classes) {
      set(cls.icon, `https://wow.zamimg.com/images/wow/icons/large/${cls.icon}.jpg`);
    }
    for (const spec of expansion.specs) {
      set(spec.icon, `https://sunderarmor.com/${folder}/Specs/${spec.icon}.jpg`);
    }
    for (const buff of expansion.buffs) {
      // Abilities are shared across every era's icon set (only Specs got a
      // refreshed folder for Cata/MoP) — verified against wowtbc.gg itself.
      set(buff.icon, `https://sunderarmor.com/WOW/Abilities/${buff.icon}.jpg`);
    }
  }

  return [...jobs.entries()].map(([slug, url]) => ({ slug, url }));
}

async function fetchOne(job: IconJob): Promise<boolean> {
  try {
    const res = await fetch(job.url);
    if (!res.ok) {
      console.error(`[fetch-icons] ${job.slug}: HTTP ${res.status} (${job.url})`);
      return false;
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length < 500) {
      console.error(`[fetch-icons] ${job.slug}: suspiciously small (${data.length}B) — ${job.url}`);
      return false;
    }
    const out = join(OUT_DIR, `${job.slug}.jpg`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, data);
    return true;
  } catch (err) {
    console.error(`[fetch-icons] ${job.slug}: ${err}`);
    return false;
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const jobs = collectJobs();
  console.log(`[fetch-icons] ${jobs.length} unique icons referenced`);
  const missing: IconJob[] = [];
  for (const job of jobs) {
    if (existsSync(join(OUT_DIR, `${job.slug}.jpg`))) continue;
    const ok = await fetchOne(job);
    if (!ok) missing.push(job);
  }
  if (missing.length > 0) {
    console.error(`[fetch-icons] FAILED (${missing.length}):`);
    for (const job of missing) console.error(`  ${job.slug} <- ${job.url}`);
    process.exitCode = 1;
  } else {
    console.log("[fetch-icons] all icons present");
  }
}

void main();