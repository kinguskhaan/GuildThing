import type { Client, Guild as DiscordGuild, GuildMember } from "discord.js";

import { db } from "@guildthing/db";

import {
  fetchRecentHumanRoleChanges,
  persistBotRoleChange,
  persistManualRoleChange,
  type HumanRoleChange,
} from "./auditLog.js";
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
      rolePriorities: true,
      protectedRoles: true,
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
  // Never touch a role an admin has marked hands-off, even if a rule also
  // grants it — see GuildProtectedRole in schema.prisma.
  for (const p of guildRow.protectedRoles) managedRoleIds.delete(p.discordRoleId);
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

  // One batched audit-log fetch for the whole guild, not one per member —
  // fetchRecentHumanRoleChanges is a REST call and this loop can run over
  // hundreds of members.
  const humanChanges = await fetchRecentHumanRoleChanges(discordGuild);

  for (const [discordUserId, rows] of rowsByDiscordUser) {
    const matched: MatchedCharacter[] = rows.map((r) => ({
      rank: r.rank,
      level: r.level,
      class: r.class,
    }));

    const { roleIds: desiredRoleIds, channelGrants } = evaluateRules(
      guildRow.roleRules,
      matched,
      guildRow.rolePriorities,
    );

    let member;
    try {
      member = await discordGuild.members.fetch(discordUserId);
    } catch {
      continue; // no longer in the server — nothing to sync
    }

    // "Senaste ändringen vinner" — a human's manual role edit only blocks
    // this cycle's resync if it happened AFTER this person's last rank
    // change (across any of their claimed characters). An old manual tweak
    // that predates a subsequent promotion/demotion should still be
    // overridden by the rule that now fires off the new rank; a member
    // with no recorded rank change yet (rankChangedAt always null) has no
    // baseline to compare against, so any detected human change wins.
    // humanChangeList is newest-first (see fetchRecentHumanRoleChanges) —
    // only its first entry's timestamp matters for this comparison, but
    // every entry in it gets logged below so the audit log shows the full
    // history, not just whichever edit happened to be newest.
    const humanChangeList = humanChanges.get(discordUserId);
    const newestHumanChange = humanChangeList?.[0];
    if (humanChangeList && newestHumanChange) {
      const latestRankChangeAt = rows.reduce<Date | null>((latest, r) => {
        if (!r.rankChangedAt) return latest;
        return !latest || r.rankChangedAt > latest ? r.rankChangedAt : latest;
      }, null);
      const humanIsNewer =
        !latestRankChangeAt || newestHumanChange.changedAt > latestRankChangeAt;
      if (humanIsNewer) {
        await logManualRoleChangeAndSkip(discordGuild, guildRow, member, humanChangeList);
        continue;
      }
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
        await persistBotRoleChange(guildRow.id, discordGuild, member, {
          addedRoleIds: toAdd,
          removedRoleIds: toRemove,
        });
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

// Persists a GuildRoleChangeEvent row for EVERY entry in `changes` (role
// names resolved from the guild's live role cache) and posts one admin
// notice, instead of applying this cycle's role diff for the member — see
// the "senaste ändringen vinner" comment at its call site above. Logging
// every entry (not just the newest) is what makes the audit log a real
// history instead of a "current state" summary — persistManualRoleChange's
// own dedup (by exact detectedAt) keeps re-running this on a later cycle
// from creating repeats.
async function logManualRoleChangeAndSkip(
  discordGuild: DiscordGuild,
  guildRow: GuildWithRules,
  member: GuildMember,
  changes: HumanRoleChange[],
): Promise<void> {
  const [newest] = changes;
  if (!newest) return;
  for (const change of changes) {
    await persistManualRoleChange(guildRow.id, discordGuild, member, change);
  }
  console.log(
    `[bot] skipping role resync for ${member.user.tag} in ${discordGuild.name} — manual change by ${newest.executorTag ?? newest.executorId} at ${newest.changedAt.toISOString()} is newer than their last rank change`,
  );
  await notifyAdmins(
    member,
    guildRow.id,
    `ℹ️ Skipped automatic role resync for ${member.user.tag} — ${newest.executorTag ?? "someone"} manually changed their Discord roles more recently than their last rank change. Logged on the site under Admin → Discord roles.`,
  );
}
