import type { NextRequest } from "next/server";

import { resolveApiKey, unauthorizedResponse } from "~/server/api-key-auth";
import { db } from "~/server/db";
import { getGuildRolesSnapshot } from "~/server/discord";

const ENTRY_LIMIT = 200;

// Read-only counterpart to /api/v1/discord-roles — apps/sync pulls this
// down and merges it into the addon's own GuildThing.lua (see
// mergeSavedVariablesText in apps/sync/src/luaWriter.ts for why it can't
// be a file of its own), read by the addon's Audit Log tab. Merges
// GuildRankChangeEvent (in-game rank transitions), GuildRoleChangeEvent
// (every Discord role add/remove GuildThing has made, bot-driven or a
// human's manual edit the resync left alone), and roster claims — same
// feed as the web admin panel's guild.auditLog query, keyed by roster
// member NAME — the only identifier the addon itself has — rather than
// Discord user id. Carries discordNick/discordTag too (resolved the same
// way discord-roles/route.ts does) so the addon's Audit Log tab can show
// and filter on them, not just the in-game name. Also carries
// guildId/guildName on every entry — a player with characters in multiple
// guilds on the same WoW install has apps/sync merge several guilds'
// entries into one SyncData.lua (see the wtfDir-grouping comment in
// apps/sync/src/index.ts), and without a guild tag the addon can't avoid
// showing one guild's officer-only audit history to a character in
// another guild entirely.
export async function GET(request: NextRequest) {
  const auth = await resolveApiKey(request);
  if (!auth) return unauthorizedResponse();

  const guild = await db.guild.findUnique({
    where: { id: auth.guildId },
    select: {
      name: true,
      discordGuildId: true,
      rosterMembers: {
        where: { claimedByDiscordUserId: { not: null } },
        select: { name: true, claimedByDiscordUserId: true },
      },
    },
  });
  if (!guild) {
    return Response.json({ error: "Guild not found." }, { status: 404 });
  }

  const nameByDiscordUserId = new Map<string, string>();
  const discordUserIdByName = new Map<string, string>();
  for (const m of guild.rosterMembers) {
    if (!m.claimedByDiscordUserId) continue;
    nameByDiscordUserId.set(m.claimedByDiscordUserId, m.name);
    discordUserIdByName.set(m.name, m.claimedByDiscordUserId);
  }

  const [rankEvents, roleChanges, claims, snapshot] = await Promise.all([
    db.guildRankChangeEvent.findMany({
      where: { guildId: auth.guildId },
      orderBy: { detectedAt: "desc" },
      take: ENTRY_LIMIT,
    }),
    db.guildRoleChangeEvent.findMany({
      where: { guildId: auth.guildId },
      orderBy: { detectedAt: "desc" },
      take: ENTRY_LIMIT,
    }),
    db.guildRosterMember.findMany({
      where: { guildId: auth.guildId, claimedAt: { not: null } },
      select: {
        name: true,
        claimedByDiscordUserId: true,
        claimedByDiscordTag: true,
        claimedAt: true,
      },
      orderBy: { claimedAt: "desc" },
      take: ENTRY_LIMIT,
    }),
    getGuildRolesSnapshot(guild.discordGuildId),
  ]);

  const identity = (discordUserId: string | null | undefined) => {
    const entry = discordUserId ? snapshot[discordUserId] : undefined;
    return { discordNick: entry?.nick ?? null, discordTag: entry?.tag ?? null };
  };

  const entries = [
    ...rankEvents.map((r) => ({
      characterName: r.characterName,
      detail: `Rank: ${r.oldRank ?? "?"} -> ${r.newRank}`,
      detectedAt: Math.floor(r.detectedAt.getTime() / 1000),
      ...identity(discordUserIdByName.get(r.characterName)),
    })),
    ...roleChanges.map((r) => {
      const added = (JSON.parse(r.addedRoleNames) as string[]).join(", ");
      const removed = (JSON.parse(r.removedRoleNames) as string[]).join(", ");
      const parts = [added && `+${added}`, removed && `-${removed}`].filter(Boolean);
      const by = r.source === "bot" ? "bot" : (r.executorTag ?? "someone");
      return {
        characterName: nameByDiscordUserId.get(r.discordUserId) ?? r.discordUserTag,
        detail: `${parts.join(" ")} by ${by}`,
        detectedAt: Math.floor(r.detectedAt.getTime() / 1000),
        ...identity(r.discordUserId),
      };
    }),
    ...claims.map((c) => ({
      characterName: c.name,
      detail: `Claimed by ${c.claimedByDiscordTag ?? "someone"}`,
      // claimedAt is guaranteed non-null by the where clause above.
      detectedAt: Math.floor(c.claimedAt!.getTime() / 1000),
      ...identity(c.claimedByDiscordUserId),
    })),
  ].map((e) => ({ ...e, guildId: auth.guildId, guildName: guild.name }));
  entries.sort((a, b) => b.detectedAt - a.detectedAt);

  return Response.json({ entries: entries.slice(0, ENTRY_LIMIT) });
}
