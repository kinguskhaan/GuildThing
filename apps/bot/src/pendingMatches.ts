import type { Client } from "discord.js";

import { db } from "@guildthing/db";

import { matchRosterAndApply } from "./roleLogic.js";

// How long a GuildPendingRosterMatch is retried before giving up and
// telling the person to ask an officer. See GuildPendingRosterMatch in
// schema.prisma for why this exists at all.
export const PENDING_MATCH_RETENTION_MS = 42 * 60 * 60_000;

// Retries every still-open GuildPendingRosterMatch against the current
// roster — called from the same daily tick as runFullRoleSync (see
// index.ts). A match found here means the roster caught up with someone
// who onboarded before their name was imported; a still-unmatched entry
// older than PENDING_MATCH_RETENTION_MS gets dropped with a heads-up DM
// instead of retried forever.
export async function syncPendingRosterMatches(client: Client<true>): Promise<void> {
  const pending = await db.guildPendingRosterMatch.findMany({
    include: { guild: true },
  });

  for (const row of pending) {
    const discordGuild = client.guilds.cache.get(row.guild.discordGuildId);
    if (!discordGuild) continue; // bot isn't (or is no longer) in this server

    let member;
    try {
      member = await discordGuild.members.fetch(row.discordUserId);
    } catch {
      // They're no longer in the server — nothing left to retry.
      await db.guildPendingRosterMatch.delete({ where: { id: row.id } }).catch(() => {
        // Already gone — fine.
      });
      continue;
    }

    const names = JSON.parse(row.names) as string[];
    const { matchedCount } = await matchRosterAndApply(
      member,
      row.guild,
      names,
      row.includeAltsInNickname,
      { applyEvenIfNoMatch: false },
    );

    if (matchedCount > 0) {
      await db.guildPendingRosterMatch.delete({ where: { id: row.id } });
      await member
        .send(
          "Good news — I found you in the guild roster now and set your nickname/roles. Welcome!",
        )
        .catch(() => {
          // Best-effort.
        });
      console.log(`[bot] pending roster match resolved for ${member.user.tag}`);
      continue;
    }

    const ageMs = Date.now() - row.createdAt.getTime();
    if (ageMs > PENDING_MATCH_RETENTION_MS) {
      await db.guildPendingRosterMatch.delete({ where: { id: row.id } });
      await member
        .send(
          "I still couldn't find you in the guild roster after checking for 42 hours — please ask an officer to help get you set up.",
        )
        .catch(() => {
          // Best-effort.
        });
      console.log(`[bot] pending roster match expired for ${member.user.tag}`);
    }
  }
}
