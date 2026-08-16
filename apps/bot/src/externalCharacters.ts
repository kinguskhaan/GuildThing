import type { Client } from "discord.js";

import { db } from "@guildthing/db";

import { lookupCharacter } from "./battlenetApi.js";
import { matchRosterAndApply, type NamedCharacter } from "./roleLogic.js";

// Once a day (same tick as runFullRoleSync/syncPendingRosterMatches — see
// index.ts), handles every GuildExternalCharacter (a real character that
// wasn't a member of THIS guild at onboarding time — see
// matchRosterAndApply in roleLogic.ts):
//
// - If the LOCAL roster now has the name (an officer re-ran the addon
//   export/import) — that's the authoritative "they're really in" signal,
//   so re-run a full match for everything this person's onboarded with and
//   let it claim/apply roles for real. Fully automatic, no /onboarding
//   needed. matchRosterAndApply itself deletes the now-stale
//   GuildExternalCharacter row(s) once it finds them in the roster (see
//   graduatedNames there).
// - Otherwise, just refresh level/class/actualGuildName from Battle.net —
//   cosmetic (admin panel display), doesn't change access. A name Battle.net
//   says no longer exists gets dropped as stale.
export async function syncExternalCharacters(
  client: Client<true>,
): Promise<void> {
  const rows = await db.guildExternalCharacter.findMany({
    include: { guild: true },
  });
  if (rows.length === 0) return;

  // Grouped so a person with several external alts gets re-matched once,
  // not once per alt.
  const groups = new Map<
    string,
    {
      guild: (typeof rows)[number]["guild"];
      discordUserId: string;
      discordUserTag: string;
      names: string[];
    }
  >();
  for (const row of rows) {
    const key = `${row.guildId}:${row.discordUserId}`;
    const group = groups.get(key);
    if (group) {
      group.names.push(row.name);
    } else {
      groups.set(key, {
        guild: row.guild,
        discordUserId: row.discordUserId,
        discordUserTag: row.discordUserTag,
        names: [row.name],
      });
    }
  }

  for (const group of groups.values()) {
    const { guild } = group;
    const discordGuild = client.guilds.cache.get(guild.discordGuildId);
    if (!discordGuild) continue;

    let member;
    try {
      member = await discordGuild.members.fetch(group.discordUserId);
    } catch {
      // Left the server — nothing left to track.
      await db.guildExternalCharacter.deleteMany({
        where: { guildId: guild.id, discordUserId: group.discordUserId },
      });
      continue;
    }

    const rosterRows = await db.guildRosterMember.findMany({
      where: { guildId: guild.id },
      select: { name: true },
    });
    const rosterNamesLower = new Set(
      rosterRows.map((r) => r.name.toLowerCase()),
    );
    const graduatedNow = group.names.filter((n) =>
      rosterNamesLower.has(n.toLowerCase()),
    );

    if (graduatedNow.length > 0) {
      const claimedRows = await db.guildRosterMember.findMany({
        where: { guildId: guild.id, claimedByDiscordUserId: group.discordUserId },
        select: { name: true },
      });
      const characters: NamedCharacter[] = [
        ...claimedRows.map((r) => ({ name: r.name, class: null })),
        ...group.names.map((name) => ({ name, class: null })),
      ];
      await matchRosterAndApply(member, guild, characters, true, {});

      const list = graduatedNow.map((n) => `"${n}"`).join(", ");
      await member
        .send(
          `Good news — ${list} now shows up as a member of this guild! I've set up your roles for it automatically.`,
        )
        .catch(() => {
          // Best-effort.
        });
      console.log(
        `[bot] ${group.discordUserTag}'s external character(s) ${list} graduated into the guild roster`,
      );
      continue;
    }

    if (
      !guild.wowRegion ||
      !guild.wowRealmSlug ||
      !guild.wowGuildName ||
      !guild.wowNamespaceFlavor
    ) {
      // Armory config was cleared since these rows were created — nothing
      // to refresh against; leave them as-is.
      continue;
    }

    for (const row of rows) {
      if (row.guildId !== guild.id || row.discordUserId !== group.discordUserId) {
        continue;
      }

      const lookup = await lookupCharacter(
        guild.wowRegion,
        guild.wowRealmSlug,
        row.name,
        guild.wowNamespaceFlavor,
        guild.wowGuildName,
      );

      if (lookup.status === "unavailable") continue; // transient — retry tomorrow

      if (lookup.status === "not_found") {
        // Character no longer exists (renamed/deleted in-game) — stale.
        await db.guildExternalCharacter.delete({ where: { id: row.id } });
        continue;
      }

      if (lookup.status === "matches_expected_guild") {
        // Battle.net already sees them in-guild, but the local roster
        // (addon export) hasn't caught up yet — can't safely grant real
        // roles without real rank data, so leave the row as-is. It'll
        // graduate for real (see graduatedNow above) once the roster
        // import catches up, no further action needed here.
        continue;
      }

      // Still wrong_guild or unguilded — refresh the stored snapshot
      // (level may have changed, or they may have transferred again).
      await db.guildExternalCharacter.update({
        where: { id: row.id },
        data: {
          level: lookup.level,
          class: lookup.class,
          actualGuildName: lookup.actualGuildName,
        },
      });
    }
  }
}
