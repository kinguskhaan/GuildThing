import type {
  ChatInputCommandInteraction,
  Client,
  GuildMember,
  Message,
} from "discord.js";
import { MessageFlags } from "discord.js";

import { db } from "@guildthing/db";

// Matches the throttle the pattern this was ported from uses — no need to
// write to the DB on every single message, "active sometime in the last
// half day" is plenty granular for a days-scale inactivity check.
const ACTIVITY_UPDATE_THROTTLE_MS = 12 * 60 * 60_000;

// Updates GuildMemberActivity.lastActiveAt for whoever just sent a
// message, throttled. Only bothers at all if the guild has the inactivity
// filter turned on — no point tracking data nobody's using.
export async function trackMessageActivity(message: Message): Promise<void> {
  if (message.author.bot || !message.guild) return;

  const guild = await db.guild.findUnique({
    where: { discordGuildId: message.guild.id },
    select: { id: true, inactivityFilterEnabled: true },
  });
  if (!guild?.inactivityFilterEnabled) return;

  const existing = await db.guildMemberActivity.findUnique({
    where: {
      guildId_discordUserId: { guildId: guild.id, discordUserId: message.author.id },
    },
  });

  if (!existing) {
    const member =
      message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
    await db.guildMemberActivity.create({
      data: {
        guildId: guild.id,
        discordUserId: message.author.id,
        discordUserTag: message.author.tag,
        lastActiveAt: message.createdAt,
        joinedAt: member?.joinedAt ?? message.createdAt,
      },
    });
    return;
  }

  if (Date.now() - existing.lastActiveAt.getTime() < ACTIVITY_UPDATE_THROTTLE_MS) return;

  await db.guildMemberActivity.update({
    where: { id: existing.id },
    data: { lastActiveAt: message.createdAt, discordUserTag: message.author.tag },
  });
}

// Seeds an activity row on join so a brand-new member is protected by
// their own joinedAt (see runInactivityFilter's skip condition) even
// before they've sent a single message.
export async function initializeMemberActivity(member: GuildMember): Promise<void> {
  const guild = await db.guild.findUnique({
    where: { discordGuildId: member.guild.id },
    select: { id: true, inactivityFilterEnabled: true },
  });
  if (!guild?.inactivityFilterEnabled) return;

  await db.guildMemberActivity.upsert({
    where: {
      guildId_discordUserId: { guildId: guild.id, discordUserId: member.id },
    },
    create: {
      guildId: guild.id,
      discordUserId: member.id,
      discordUserTag: member.user.tag,
      lastActiveAt: member.joinedAt ?? new Date(),
      joinedAt: member.joinedAt ?? new Date(),
    },
    update: {
      // Rejoined — restart their clock rather than keep stale history.
      lastActiveAt: member.joinedAt ?? new Date(),
      joinedAt: member.joinedAt ?? new Date(),
      previousRoleIds: null,
      markedInactiveAt: null,
    },
  });
}

// Cleans up tracking data for someone who left — nothing left to filter.
export async function removeMemberActivity(
  discordGuildId: string,
  discordUserId: string,
): Promise<void> {
  const guild = await db.guild.findUnique({
    where: { discordGuildId },
    select: { id: true },
  });
  if (!guild) return;

  await db.guildMemberActivity
    .delete({ where: { guildId_discordUserId: { guildId: guild.id, discordUserId } } })
    .catch(() => {
      // No row to delete — fine, they were never tracked.
    });
}

// Daily pass: for every guild with the filter on, swaps anyone who (a)
// holds the configured target role, (b) hasn't been active OR hasn't just
// joined within inactivityDays, and (c) isn't already marked, over to the
// inactive role — saving their other roles first so /reactivate can
// restore them. Posts a summary to the admin notify channel, if set.
export async function runInactivityFilter(client: Client<true>): Promise<void> {
  const guilds = await db.guild.findMany({
    where: { inactivityFilterEnabled: true },
    select: {
      id: true,
      discordGuildId: true,
      inactivityDays: true,
      inactivityRoleId: true,
      adminNotifyChannelId: true,
      inactivityTargetRoles: { select: { discordRoleId: true } },
    },
  });

  for (const guildRow of guilds) {
    const targetRoleIds = new Set(guildRow.inactivityTargetRoles.map((r) => r.discordRoleId));
    if (!guildRow.inactivityDays || targetRoleIds.size === 0 || !guildRow.inactivityRoleId) {
      continue; // filter's on but not fully configured yet
    }

    const discordGuild = client.guilds.cache.get(guildRow.discordGuildId);
    if (!discordGuild) continue;

    const cutoff = new Date(Date.now() - guildRow.inactivityDays * 24 * 60 * 60_000);
    const staleRows = await db.guildMemberActivity.findMany({
      where: {
        guildId: guildRow.id,
        lastActiveAt: { lt: cutoff },
        joinedAt: { lt: cutoff },
        markedInactiveAt: null,
      },
    });

    let count = 0;
    const failed: string[] = [];

    for (const row of staleRows) {
      let member: GuildMember;
      try {
        member = await discordGuild.members.fetch(row.discordUserId);
      } catch {
        await db.guildMemberActivity.delete({ where: { id: row.id } }).catch(() => {});
        continue;
      }

      if (!member.roles.cache.some((r) => targetRoleIds.has(r.id))) continue;
      if (member.roles.cache.has(guildRow.inactivityRoleId)) continue;

      const previousRoleIds = member.roles.cache
        .filter((r) => r.id !== discordGuild.id) // exclude @everyone
        .map((r) => r.id);

      try {
        await member.roles.set([guildRow.inactivityRoleId]);
        await db.guildMemberActivity.update({
          where: { id: row.id },
          data: {
            previousRoleIds: JSON.stringify(previousRoleIds),
            markedInactiveAt: new Date(),
          },
        });
        count++;
      } catch (err) {
        console.error(`[bot] failed to mark ${member.user.tag} inactive:`, err);
        failed.push(member.user.tag);
      }
    }

    if ((count > 0 || failed.length > 0) && guildRow.adminNotifyChannelId) {
      try {
        const channel = await discordGuild.channels.fetch(guildRow.adminNotifyChannelId);
        if (channel?.isTextBased()) {
          const parts = [`💤 Inactivity filter: moved ${count} member(s) to the inactive role.`];
          if (failed.length > 0) {
            parts.push(`Failed for ${failed.length}: ${failed.join(", ")} — check my role position.`);
          }
          await channel.send(parts.join(" "));
        }
      } catch (err) {
        console.error(
          `[bot] failed to post inactivity-filter notice for guild ${guildRow.id}:`,
          err,
        );
      }
    }
  }
}

// /reactivate — lets a member marked inactive restore their own previous
// roles themselves, mirroring the source pattern's recovery command,
// rather than requiring an officer to do it by hand.
export async function handleReactivate(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild) return;

  const guildRow = await db.guild.findUnique({
    where: { discordGuildId: interaction.guild.id },
    select: { id: true, inactivityRoleId: true },
  });
  if (!guildRow?.inactivityRoleId) {
    await interaction.reply({
      content: "Inactivity tracking isn't set up on this server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!member.roles.cache.has(guildRow.inactivityRoleId)) {
    await interaction.reply({
      content: "You're not currently marked inactive.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const activity = await db.guildMemberActivity.findUnique({
    where: { guildId_discordUserId: { guildId: guildRow.id, discordUserId: member.id } },
  });
  const previousRoleIds: string[] = activity?.previousRoleIds
    ? (JSON.parse(activity.previousRoleIds) as string[])
    : [];

  try {
    await member.roles.set(previousRoleIds);
  } catch (err) {
    console.error(`[bot] failed to restore roles for ${member.user.tag}:`, err);
    await interaction.reply({
      content:
        "Heads up — I couldn't restore your roles, most likely a permissions issue on my end. Ask an officer to check.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (activity) {
    await db.guildMemberActivity.update({
      where: { id: activity.id },
      data: { lastActiveAt: new Date(), markedInactiveAt: null, previousRoleIds: null },
    });
  }

  await interaction.reply({
    content: "Welcome back! Your previous roles have been restored.",
    flags: MessageFlags.Ephemeral,
  });
}
