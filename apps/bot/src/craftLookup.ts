import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
} from "discord.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";

import { db } from "@guildthing/db";
import { getWowheadEntry, tbcRecipes, wowheadIconUrl, wowheadUrl } from "@guildthing/wowhead-data";

// Prefix for the "Share in channel" button's customId, same convention as
// events.ts's "event:" prefix — index.ts's InteractionCreate router
// dispatches on this.
const CRAFT_SHARE_PREFIX = "craft-share:";

// "Can be crafted by" is only ever as complete as who's actually run the
// OurRecipes export — a link button nudging the viewer to install it costs
// nothing and might grow the list for next time.
const OUR_RECIPES_URL = "https://www.curseforge.com/wow/addons/ourrecipes";

// /guildthing craft <item> — TBC only for now (wowheadUrl/getWowheadEntry
// are themselves hardcoded to the "tbc" Wowhead namespace, and there's no
// Classic-era recipe catalog scraped yet). A guild on Classic Era will
// just get "couldn't find that" for everything, same as any unrecognized
// name — extending this to Classic needs both a scraped classicRecipes
// catalog and wowheadUrl/getWowheadEntry to take an expansion parameter
// instead of assuming tbc.

const AUTOCOMPLETE_LIMIT = 25;

const ALL_RECIPE_NAMES = Object.keys(tbcRecipes).sort((a, b) => a.localeCompare(b));

export async function handleCraftAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();
  const matches = (
    focused ? ALL_RECIPE_NAMES.filter((name) => name.toLowerCase().includes(focused)) : ALL_RECIPE_NAMES
  ).slice(0, AUTOCOMPLETE_LIMIT);
  await interaction.respond(matches.map((name) => ({ name, value: name }))).catch(() => {
    // Discord drops a stale autocomplete response (user kept typing) —
    // nothing to do about it, not worth logging every occurrence.
  });
}

// Resolves a claimed character's Discord account, the same
// (userId, providerId: "discord") lookup apps/web/src/server/discord.ts
// already uses — so the reply can @mention the actual person, not just
// name their character.
async function crafterLine(character: { name: string; userId: string | null }): Promise<string> {
  if (!character.userId) return character.name;
  const account = await db.account.findFirst({
    where: { userId: character.userId, providerId: "discord" },
    select: { accountId: true },
  });
  return account ? `<@${account.accountId}> (${character.name})` : character.name;
}

// Shared by the initial (ephemeral) reply and the "Share in channel"
// button, so both show identical data built the same way. Returns null
// for either "not a recognized recipe" or "this server isn't set up" —
// callers already know which, having checked before calling, so they
// don't need to know why here again.
async function buildCraftEmbed(
  discordGuildId: string,
  itemName: string,
): Promise<EmbedBuilder | null> {
  const entry = getWowheadEntry(itemName);
  if (!entry) return null;

  const guildRow = await db.guild.findUnique({ where: { discordGuildId } });
  if (!guildRow) return null;

  const recipeRows = await db.recipe.findMany({
    where: { name: itemName, profession: { character: { guildId: guildRow.id } } },
    include: { profession: { include: { character: true } } },
  });
  const crafterLines = await Promise.all(
    recipeRows.map((r) => crafterLine(r.profession.character)),
  );

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(entry.name)
    .setURL(wowheadUrl(entry))
    .setThumbnail(wowheadIconUrl(entry));

  if (entry.description) embed.setDescription(entry.description);

  if (entry.reagents && entry.reagents.length > 0) {
    const reagentText = entry.reagents
      .map((reagent) => {
        const reagentEntry = getWowheadEntry(reagent.name);
        const label = reagentEntry
          ? `[${reagent.name}](${wowheadUrl(reagentEntry)})`
          : reagent.name;
        return `${label} ×${reagent.quantity}`;
      })
      .join("\n");
    embed.addFields({ name: "Reagents", value: reagentText });
  }

  embed.addFields({
    name: "Can be crafted by",
    value: crafterLines.length > 0 ? crafterLines.join("\n") : "No one in this guild yet.",
  });

  return embed;
}

export async function handleCraftCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const itemName = interaction.options.getString("item", true);

  if (!getWowheadEntry(itemName)) {
    await interaction.reply({
      content: `Couldn't find "${itemName}" — pick one from the autocomplete list as you type. Only TBC recipes are known right now.`,
      ephemeral: true,
    });
    return;
  }
  if (!interaction.guildId) {
    await interaction.reply({ content: "This only works in a server.", ephemeral: true });
    return;
  }

  const embed = await buildCraftEmbed(interaction.guildId, itemName);
  if (!embed) {
    await interaction.reply({
      content: "This Discord server isn't set up with GuildThing yet.",
      ephemeral: true,
    });
    return;
  }

  // Ephemeral by default — a craft lookup is usually one person checking
  // for themselves, not something the whole channel needs to see. The
  // button re-runs the same lookup and posts it for real when someone
  // does want to share it.
  const shareRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setURL(OUR_RECIPES_URL)
      .setLabel("Want your crafts here? Get OurRecipes"),
    new ButtonBuilder()
      .setCustomId(`${CRAFT_SHARE_PREFIX}${itemName}`)
      .setLabel("Share in channel")
      .setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply({ embeds: [embed], components: [shareRow], ephemeral: true });
}

export async function handleCraftShareButton(interaction: ButtonInteraction): Promise<void> {
  const itemName = interaction.customId.slice(CRAFT_SHARE_PREFIX.length);
  if (!interaction.guildId) return;

  const embed = await buildCraftEmbed(interaction.guildId, itemName);
  if (!embed) {
    await interaction.reply({ content: "Couldn't rebuild that lookup.", ephemeral: true });
    return;
  }

  // A fresh, non-ephemeral reply — everyone in the channel sees this one,
  // unlike the original command invocation. Leaves the original ephemeral
  // message (and its button) as-is; clicking it again would just post a
  // second copy, harmless.
  await interaction.reply({ embeds: [embed] });
}
