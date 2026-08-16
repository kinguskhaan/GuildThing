import type { Client, Guild as DiscordGuild } from "discord.js";

import { db } from "@guildthing/db";

import {
  applyChannelGrants,
  evaluateRules,
  notifyAdmins,
  type MatchedCharacter,
} from "./roleLogic.js";

// How often the whole roster gets walked to add/remove rule-granted roles
// as characters level up, get promoted, etc. Roster data only changes when
// an admin re-imports it (manually today, later maybe an automated WTF-file
// reader) — it doesn't need to reflect instantly, once a day is plenty for
// now. Bump this down if that stops being true.
export const ROLE_SYNC_INTERVAL_MS = 24 * 60 * 60_000;

async function loadGuildsWithRules() {
  return db.guild.findMany({
    include: {
      roleRules: {
        include: { conditions: true, grantedRoles: true, grantedChannels: true },
      },
    },
  });
}

type GuildWithRules = Awaited<ReturnType<typeof loadGuildsWithRules>>[number];

// Walks every registered guild's claimed roster and brings each claimed
// Discord member's rule-granted roles in line with their current
// rank/level/class — adds roles for rules that now fire, removes roles for
// ones that no longer do. Only touches roles that appear as a grantedRole
// on at least one of the guild's rules ("managed roles"); anything an admin
// assigned by hand for an unrelated reason is left alone. The PUG role
// isn't roster-driven (no character is matched for a PUG) so it's out of
// scope here too.
export async function runFullRoleSync(client: Client<true>): Promise<void> {
  const guilds = await loadGuildsWithRules();

  for (const guildRow of guilds) {
    if (guildRow.roleRules.length === 0) continue;

    const discordGuild = client.guilds.cache.get(guildRow.discordGuildId);
    if (!discordGuild) continue; // bot isn't (or is no longer) in this server

    await syncGuildRoles(discordGuild, guildRow);
  }
}

async function syncGuildRoles(
  discordGuild: DiscordGuild,
  guildRow: GuildWithRules,
): Promise<void> {
  const managedRoleIds = new Set(
    guildRow.roleRules.flatMap((r) => r.grantedRoles.map((g) => g.discordRoleId)),
  );
  if (managedRoleIds.size === 0) return;

  const rosterRows = await db.guildRosterMember.findMany({
    where: { guildId: guildRow.id, claimedByDiscordUserId: { not: null } },
  });

  const rowsByDiscordUser = new Map<string, typeof rosterRows>();
  for (const row of rosterRows) {
    const discordUserId = row.claimedByDiscordUserId;
    if (!discordUserId) continue;
    rowsByDiscordUser.set(discordUserId, [
      ...(rowsByDiscordUser.get(discordUserId) ?? []),
      row,
    ]);
  }

  for (const [discordUserId, rows] of rowsByDiscordUser) {
    const matched: MatchedCharacter[] = rows.map((r) => ({
      rank: r.rank,
      level: r.level,
      class: r.class,
    }));

    const { roleIds: desiredRoleIds, channelGrants } = evaluateRules(
      guildRow.roleRules,
      matched,
    );

    let member;
    try {
      member = await discordGuild.members.fetch(discordUserId);
    } catch {
      continue; // no longer in the server — nothing to sync
    }

    const currentManaged = member.roles.cache.filter((r) => managedRoleIds.has(r.id));
    const toAdd = [...desiredRoleIds].filter((id) => !currentManaged.has(id));
    const toRemoveRoles = currentManaged.filter((r) => !desiredRoleIds.has(r.id));
    const toRemove = toRemoveRoles.map((r) => r.id);

    if (toAdd.length > 0 || toRemove.length > 0) {
      try {
        if (toAdd.length > 0) await member.roles.add(toAdd);
        if (toRemove.length > 0) await member.roles.remove(toRemove);
        const roleName = (id: string) =>
          discordGuild.roles.cache.get(id)?.name ?? id;
        const added = toAdd.map(roleName).join(", ") || "none";
        const removed = toRemoveRoles.map((r) => r.name).join(", ") || "none";
        console.log(
          `[bot] role sync for ${member.user.tag} in ${discordGuild.name}: +[${added}] -[${removed}]`,
        );
      } catch (err) {
        console.error(
          `[bot] role resync failed for ${member.user.tag} in ${discordGuild.name}:`,
          err,
        );
        // Nobody's actively waiting on this (it's a background run), but an
        // officer still needs to know their permissions/role setup broke.
        await notifyAdmins(
          member,
          guildRow.id,
          `⚠️ Daily role resync failed for ${member.user.tag} in ${discordGuild.name} — most likely my role isn't positioned above the role(s) involved.`,
        );
      }
    }

    // Background resync shouldn't DM someone just because a channel-grant
    // update failed (no direct action of theirs triggered this run) —
    // admins still get notified via applyChannelGrants' own notifyAdmins
    // call regardless of this flag.
    await applyChannelGrants(member, guildRow.id, channelGrants, {
      notifyOnFailure: false,
    });
  }
}
