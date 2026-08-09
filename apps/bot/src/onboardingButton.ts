import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
} from "discord.js";

import { db } from "@guildthing/db";

export const START_ONBOARDING_BUTTON_ID = "start-onboarding";

const DEFAULT_MESSAGE_TEXT =
  "Click below to start (or redo) onboarding — I'll DM you a few quick questions to get your nickname and roles set up.";

function buildButtonMessage(customText: string | null) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(START_ONBOARDING_BUTTON_ID)
      .setLabel("Start Onboarding")
      .setStyle(ButtonStyle.Primary),
  );
  return {
    content: customText?.trim() || DEFAULT_MESSAGE_TEXT,
    components: [row],
  };
}

// Keeps each registered guild's "Start Onboarding" button message current:
// posts one if onboardingChannelId is set and none exists yet (landing at
// the current bottom of the channel — see repostOnboardingButton in the
// router for the explicit "move it back to the bottom" action), edits it in
// place if the text changed, and cleans up if the admin unsets the channel.
// Idempotent — safe to call repeatedly (see index.ts, called on
// ready/GuildCreate and on a short interval so admin changes land quickly
// without needing a bot restart).
export async function ensureOnboardingButtons(client: Client<true>): Promise<void> {
  const guilds = await db.guild.findMany({
    select: {
      id: true,
      discordGuildId: true,
      onboardingChannelId: true,
      onboardingMessageId: true,
      onboardingMessageText: true,
    },
  });

  for (const guildRow of guilds) {
    const discordGuild = client.guilds.cache.get(guildRow.discordGuildId);
    if (!discordGuild) continue;

    if (!guildRow.onboardingChannelId) {
      if (guildRow.onboardingMessageId) {
        // Channel was unset — best-effort cleanup of the old message; it
        // may already be gone, or in a channel we can no longer resolve.
        await db.guild.update({
          where: { id: guildRow.id },
          data: { onboardingMessageId: null },
        });
      }
      continue;
    }

    try {
      const channel = await discordGuild.channels.fetch(guildRow.onboardingChannelId);
      if (!channel?.isTextBased()) continue;

      const desired = buildButtonMessage(guildRow.onboardingMessageText);

      if (guildRow.onboardingMessageId) {
        const existing = await channel.messages
          .fetch(guildRow.onboardingMessageId)
          .catch(() => null);
        if (existing) {
          if (existing.content !== desired.content) {
            await existing.edit(desired);
          }
          continue;
        }
      }

      const message = await channel.send(desired);
      await db.guild.update({
        where: { id: guildRow.id },
        data: { onboardingMessageId: message.id },
      });
    } catch (err) {
      console.error(
        `[bot] failed to ensure onboarding button for guild ${guildRow.id}:`,
        err,
      );
    }
  }
}
