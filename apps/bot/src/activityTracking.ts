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
// message, throttled. Tracked for every registered guild regardless of
// whether the inactivity filter itself is enabled — the roster page's
// "last active" column consumes this too, so tracking can't be gated
// behind that one feature's toggle. Only *acting* on it (runInactivityFilter)
// checks inactivityFilterEnabled.
export async function trackMessageActivity(message: Message): Promise<void> {
  if (message.author.bot || !message.guild) return;

  const guild = await db.guild.findUnique({
    where: { discordGuildId: message.guild.id },
    select: { id: true },
  });
  if (!guild) return;

  const existing = await db.guildMemberActivity.findUnique({
    where: {
      guildId_discordUserId: {
        guildId: guild.id,
        discordUserId: message.author.id,
      },
    },
  });

  if (!existing) {
    const member =
      message.member ??
      (await message.guild.members.fetch(message.author.id).catch(() => null));
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

  if (
    Date.now() - existing.lastActiveAt.getTime() <
    ACTIVITY_UPDATE_THROTTLE_MS
  )
    return;

  await db.guildMemberActivity.update({
    where: { id: existing.id },
    data: {
      lastActiveAt: message.createdAt,
      discordUserTag: message.author.tag,
    },
  });
}

// Seeds an activity row on join so a brand-new member is protected by
// their own joinedAt (see runInactivityFilter's skip condition) even
// before they've sent a single message. Tracked unconditionally — see
// trackMessageActivity above for why this isn't gated on the filter toggle.
export async function initializeMemberActivity(
  member: GuildMember,
): Promise<void> {
  const guild = await db.guild.findUnique({
    where: { discordGuildId: member.guild.id },
    select: { id: true },
  });
  if (!guild) return;

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
    .delete({
      where: { guildId_discordUserId: { guildId: guild.id, discordUserId } },
    })
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
      botEnabled: true,
      inactivityDays: true,
      inactivityRoleId: true,
      adminNotifyChannelId: true,
      inactivityTargetRoles: { select: { discordRoleId: true } },
    },
  });

  for (const guildRow of guilds) {
    if (!guildRow.botEnabled) continue;

    const targetRoleIds = new Set(
      guildRow.inactivityTargetRoles.map((r) => r.discordRoleId),
    );
    if (
      !guildRow.inactivityDays ||
      targetRoleIds.size === 0 ||
      !guildRow.inactivityRoleId
    ) {
      continue; // filter's on but not fully configured yet
    }

    const discordGuild = client.guilds.cache.get(guildRow.discordGuildId);
    if (!discordGuild) continue;

    const cutoff = new Date(
      Date.now() - guildRow.inactivityDays * 24 * 60 * 60_000,
    );
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
        await db.guildMemberActivity
          .delete({ where: { id: row.id } })
          .catch(() => {});
        continue;
      }

      if (!member.roles.cache.some((r) => targetRoleIds.has(r.id))) continue;
      if (member.roles.cache.has(guildRow.inactivityRoleId)) continue;

      try {
        await member.roles.add(guildRow.inactivityRoleId);
        await db.guildMemberActivity.update({
          where: { id: row.id },
          data: { markedInactiveAt: new Date() },
        });
        count++;
      } catch (err) {
        console.error(`[bot] failed to mark ${member.user.tag} inactive:`, err);
        failed.push(member.user.tag);
      }
    }

    if ((count > 0 || failed.length > 0) && guildRow.adminNotifyChannelId) {
      try {
        const channel = await discordGuild.channels.fetch(
          guildRow.adminNotifyChannelId,
        );
        if (channel?.isTextBased()) {
          const parts = [
            `💤 Inactivity filter: moved ${count} member(s) to the inactive role.`,
          ];
          if (failed.length > 0) {
            parts.push(
              `Failed for ${failed.length}: ${failed.join(", ")} — check my role position.`,
            );
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

// /reactivate — lets a member marked inactive remove the inactive role
// themselves, rather than requiring an officer to do it by hand. Only the
// inactive role itself is touched (see runInactivityFilter above — it adds
// that role on top rather than replacing everything else), so there's
// nothing to restore.
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

  try {
    await member.roles.remove(guildRow.inactivityRoleId);
  } catch (err) {
    console.error(
      `[bot] failed to remove inactive role for ${member.user.tag}:`,
      err,
    );
    await interaction.reply({
      content:
        "Heads up — I couldn't remove your inactive role, most likely a permissions issue on my end. Ask an officer to check.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await db.guildMemberActivity.updateMany({
    where: { guildId: guildRow.id, discordUserId: member.id },
    data: { lastActiveAt: new Date(), markedInactiveAt: null },
  });

  await interaction.reply({
    content: "Welcome back! Your inactive role has been removed.",
    flags: MessageFlags.Ephemeral,
  });
}
