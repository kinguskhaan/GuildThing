import type { NextRequest } from "next/server";

import { resolveApiKey, unauthorizedResponse } from "~/server/api-key-auth";
import { db } from "~/server/db";

// A single guild member's rule-managed Discord roles not matching what the
// rules currently say they should have — see RoleMismatch in
// apps/bot/src/roleSync.ts, which is what actually computes and caches
// this (GuildRoleMismatchCache), refreshed hourly and right after every
// sync run. This route never talks to Discord itself.
interface CachedMismatch {
  discordUserId: string;
  discordUserTag: string;
  toAdd: string[];
  toRemove: string[];
}

// Read-only counterpart to /api/v1/discord-roles, same shape of trip:
// apps/sync pulls this down and writes it into the addon's own
// SavedVariables so the addon's Discord Roles tab can flag drift and point
// at the existing "Request sync" button as the fix, without the addon (or
// this route) ever touching Discord directly. Keyed by roster member NAME
// — the only identifier the addon itself has — same join as
// discord-roles/route.ts, so a Discord user claiming several characters
// gets the same mismatch listed under each of their character names.
export async function GET(request: NextRequest) {
  const auth = await resolveApiKey(request);
  if (!auth) return unauthorizedResponse();

  const guild = await db.guild.findUnique({
    where: { id: auth.guildId },
    select: {
      rosterMembers: {
        where: { claimedByDiscordUserId: { not: null } },
        select: { name: true, claimedByDiscordUserId: true },
      },
    },
  });
  if (!guild) {
    return Response.json({ error: "Guild not found." }, { status: 404 });
  }

  const cache = await db.guildRoleMismatchCache.findUnique({
    where: { guildId: auth.guildId },
  });
  const mismatches: CachedMismatch[] = cache
    ? (JSON.parse(cache.data) as CachedMismatch[])
    : [];
  const byDiscordUserId = new Map(
    mismatches.map((m) => [m.discordUserId, m]),
  );

  const members: Record<string, { toAdd: string[]; toRemove: string[] }> = {};
  for (const m of guild.rosterMembers) {
    const entry = m.claimedByDiscordUserId
      ? byDiscordUserId.get(m.claimedByDiscordUserId)
      : undefined;
    if (!entry) continue;
    members[m.name] = { toAdd: entry.toAdd, toRemove: entry.toRemove };
  }

  return Response.json({
    members,
    computedAt: cache?.computedAt.toISOString() ?? null,
  });
}
