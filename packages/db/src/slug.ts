import type { PrismaClient } from "../generated/prisma";

const DIACRITICS = /[̀-ͯ]/g;
const NON_ALPHANUMERIC = /[^a-z0-9]+/g;
const LEADING_TRAILING_HYPHENS = /^-+|-+$/g;

// Top-level static routes under /guilds/ that a guild slug would otherwise
// shadow — e.g. a guild slugged "settings" would make /guilds/settings
// (the instance owner's settings page) unreachable, since Next.js resolves
// the static route over the dynamic [guildSlug] one. Guild pages that live
// *under* a slug (roster, events, addon, bot, admin/*, ...) don't need an
// entry here — those are namespaced per-guild, so they can't collide.
const RESERVED_SLUGS = new Set(["settings"]);

// Turns a guild name into a URL-safe slug, e.g. "Wailing Caverns!" ->
// "wailing-caverns". Falls back to "guild" if nothing alphanumeric survives
// (e.g. a name that's entirely emoji or CJK, which the naive ASCII strip
// below would otherwise reduce to an empty string).
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .trim()
    .replace(NON_ALPHANUMERIC, "-")
    .replace(LEADING_TRAILING_HYPHENS, "");
  return slug || "guild";
}

// Appends -2, -3, ... until it finds a slug not already used by another
// guild. `excludeGuildId` lets a rename check re-derive a slug for the same
// guild without colliding with itself (not currently used — slugs are only
// assigned once, at creation — but kept correct in case that changes).
export async function uniqueGuildSlug(
  db: PrismaClient,
  name: string,
  excludeGuildId?: string,
): Promise<string> {
  const rawBase = slugify(name);
  const base = RESERVED_SLUGS.has(rawBase) ? `${rawBase}-guild` : rawBase;
  let candidate = base;
  let suffix = 2;
  while (
    await db.guild.findFirst({
      where: {
        slug: candidate,
        ...(excludeGuildId ? { id: { not: excludeGuildId } } : {}),
      },
      select: { id: true },
    })
  ) {
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  return candidate;
}
