import type { PrismaClient } from "../generated/prisma";

const DIACRITICS = /[̀-ͯ]/g;
const NON_ALPHANUMERIC = /[^a-z0-9]+/g;
const LEADING_TRAILING_HYPHENS = /^-+|-+$/g;

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
  const base = slugify(name);
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
