import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type GuildMember,
} from "discord.js";

import { db } from "@guildthing/db";

// A PUG's nickname/role application doesn't need the roster-matching parts
// of matchRosterAndApply (there's no roster row for a PUG at all), so it
// uses applyNicknameAndRoles directly instead.
import {
  applyNicknameAndRoles,
  MAX_NICKNAME_LENGTH,
  matchRosterAndApply,
} from "./roleLogic.js";

const QUESTION_TIMEOUT_MS = 5 * 60_000;

// Guards against overlapping onboarding conversations for the same person
// — e.g. testing by leaving and rejoining the server fires a fresh
// GuildMemberAdd each time, and without this, multiple concurrent DM flows
// end up racing each other's askText/askChoice collectors in the same
// channel (whichever's listening grabs the reply, the rest just time out).
const activeOnboarding = new Set<string>();

async function askText(
  member: GuildMember,
  question: string,
): Promise<string | null> {
  const dm = await member.createDM();
  await dm.send(question);
  try {
    const collected = await dm.awaitMessages({
      filter: (m) => m.author.id === member.id,
      max: 1,
      time: QUESTION_TIMEOUT_MS,
      errors: ["time"],
    });
    return collected.first()?.content.trim() ?? null;
  } catch (err) {
    console.log(
      `[bot] ${member.user.tag} didn't answer in time (or an error occurred):`,
      err,
    );
    return null;
  }
}

// Generic button-choice question — used for guild/PUG and the
// include-alts-in-nickname question. Returns the clicked button's
// customId, or null on timeout.
async function askChoice(
  member: GuildMember,
  content: string,
  choices: { id: string; label: string; primary?: boolean }[],
): Promise<string | null> {
  const dm = await member.createDM();
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    choices.map((c) =>
      new ButtonBuilder()
        .setCustomId(c.id)
        .setLabel(c.label)
        .setStyle(c.primary ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );
  await dm.send({ content, components: [row] });
  try {
    // Collected on the channel, not the specific message — message-scoped
    // collection (Message#awaitMessageComponent) filters on
    // interaction.message matching, which doesn't reliably hold for DM
    // interactions; filtering by user id on the channel instead sidesteps
    // that entirely.
    const interaction = await dm.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: QUESTION_TIMEOUT_MS,
      filter: (i) => i.user.id === member.id,
    });
    const ageAtReceipt = Date.now() - interaction.createdTimestamp;
    console.log(
      `[bot] ${member.user.tag} clicked "${interaction.customId}" — interaction was ${ageAtReceipt}ms old when our collector received it`,
    );
    const updateStarted = Date.now();
    await interaction.update({ components: [] });
    console.log(`[bot] update() took ${Date.now() - updateStarted}ms`);
    return interaction.customId;
  } catch (err) {
    console.log(
      `[bot] ${member.user.tag} didn't answer the button prompt in time (or an error occurred):`,
      err,
    );
    return null;
  }
}

// Toggle-button question used when the full name list (main + alts) won't
// fit Discord's 32-char nickname cap — lets the person pick which alts to
// drop instead of the bot silently cutting the list at a "/" boundary. The
// main name (names[0]) is always kept; only alts get toggle buttons. Falls
// back to whatever's currently selected (starts as "all") on timeout, so
// applyNicknameAndRoles' own truncateNickname safety net still applies.
async function askNicknameSelection(
  member: GuildMember,
  names: string[],
): Promise<string[]> {
  const mainName = names[0]!;
  const altNames = names.slice(1);
  const selected = new Set(altNames);

  function currentPreview(): string {
    return [mainName, ...altNames.filter((n) => selected.has(n))].join("/");
  }

  function buildContent(): string {
    const preview = currentPreview();
    return (
      `Your name list is too long to fit Discord's 32-character nickname limit. ` +
      `Choose which alts to include — your main, **${mainName}**, is always kept.\n\n` +
      `Preview: \`${preview}\` (${preview.length}/${MAX_NICKNAME_LENGTH} chars)`
    );
  }

  function buildComponents(): ActionRowBuilder<ButtonBuilder>[] {
    const altButtons = altNames.map((name, i) =>
      new ButtonBuilder()
        .setCustomId(`toggle:${i}`)
        .setLabel(selected.has(name) ? `✅ ${name}` : name)
        .setStyle(selected.has(name) ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < altButtons.length; i += 5) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(altButtons.slice(i, i + 5)));
    }
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("confirm")
          .setLabel("Confirm")
          .setStyle(ButtonStyle.Success)
          .setDisabled(currentPreview().length > MAX_NICKNAME_LENGTH),
      ),
    );
    return rows;
  }

  const dm = await member.createDM();
  await dm.send({ content: buildContent(), components: buildComponents() });

  for (;;) {
    let interaction;
    try {
      interaction = await dm.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: QUESTION_TIMEOUT_MS,
        filter: (i) => i.user.id === member.id,
      });
    } catch {
      console.log(
        `[bot] ${member.user.tag} didn't finish the nickname-selection prompt in time — using current selection`,
      );
      break;
    }

    if (interaction.customId === "confirm") {
      await interaction.update({ components: [] });
      break;
    }

    const altIndex = Number(interaction.customId.slice("toggle:".length));
    const name = altNames[altIndex];
    if (name != null) {
      if (selected.has(name)) selected.delete(name);
      else selected.add(name);
    }
    await interaction.update({ content: buildContent(), components: buildComponents() });
  }

  return [mainName, ...altNames.filter((n) => selected.has(n))];
}

// Used by the /onboarding command to force-restart cleanly — clears any
// stuck/abandoned session (e.g. someone who left mid-conversation last
// time) before handleNewMember's own guard would otherwise skip a rerun.
export function cancelOnboarding(discordUserId: string): void {
  activeOnboarding.delete(discordUserId);
}

export async function handleNewMember(member: GuildMember): Promise<void> {
  if (activeOnboarding.has(member.id)) {
    console.log(
      `[bot] ${member.user.tag} already has an onboarding conversation in progress, skipping duplicate join event`,
    );
    return;
  }
  activeOnboarding.add(member.id);
  try {
    await runOnboarding(member);
  } finally {
    activeOnboarding.delete(member.id);
  }
}

async function runOnboarding(member: GuildMember): Promise<void> {
  const guild = await db.guild.findUnique({
    where: { discordGuildId: member.guild.id },
  });
  if (!guild) {
    // This Discord server isn't registered as a GuildThing guild — nothing
    // for the bot to do here.
    return;
  }

  const mainName = await askText(
    member,
    `Welcome to ${member.guild.name}! I'm going to ask a few onboarding questions you need to complete to get access to the Discord server.\n\nWhat is your in-game nickname? Please reply with a chat message.`,
  );
  if (mainName == null) return;

  const affiliation = await askChoice(
    member,
    "Are you a guild member, or are you here to join a PUG?",
    [
      { id: "guild", label: "Guild member", primary: true },
      { id: "pug", label: "PUG" },
    ],
  );
  if (affiliation == null) return;

  if (affiliation === "pug") {
    await applyNicknameAndRoles(
      member,
      guild.id,
      [mainName],
      guild.pugRoleId ? [guild.pugRoleId] : [],
      [],
    );
    return;
  }

  const hasAlts = await askChoice(member, "Do you have any alts?", [
    { id: "yes", label: "Yes", primary: true },
    { id: "no", label: "No" },
  ]);
  if (hasAlts == null) return;

  const altNames: string[] = [];
  if (hasAlts === "yes") {
    let addingAlts = true;
    while (addingAlts) {
      const altName = await askText(member, "What is your alt's name?");
      if (altName == null) return;
      altNames.push(altName);

      const addAnother = await askChoice(
        member,
        "Do you want to add another alt?",
        [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No", primary: true },
        ],
      );
      if (addAnother == null) return;
      addingAlts = addAnother === "yes";
    }
  }

  const allNames = [mainName, ...altNames];

  // Only worth asking if there's actually a choice to make — someone with
  // no alts just gets their main name, no extra question.
  let includeAltsInNickname = true;
  if (altNames.length > 0) {
    const choice = await askChoice(
      member,
      `Do you want your alts included in your server nickname? e.g. "${allNames.join("/")}"`,
      [
        { id: "yes", label: "Yes", primary: true },
        { id: "no", label: "No" },
      ],
    );
    if (choice == null) return;
    includeAltsInNickname = choice === "yes";
  }

  const { matchedCount, conflictCount } = await matchRosterAndApply(
    member,
    guild,
    allNames,
    includeAltsInNickname,
    { chooseNicknameNames: (names) => askNicknameSelection(member, names) },
  );

  if (matchedCount === 0 && conflictCount === 0) {
    // Genuinely not in the roster yet — not a claim dispute, just data that
    // probably hasn't been (re-)imported since they joined. Queue this for
    // the daily role-sync job to retry automatically (see pendingMatches.ts)
    // instead of leaving them stuck with no roles until someone notices.
    await db.guildPendingRosterMatch.upsert({
      where: { guildId_discordUserId: { guildId: guild.id, discordUserId: member.id } },
      create: {
        guildId: guild.id,
        discordUserId: member.id,
        discordUserTag: member.user.tag,
        names: JSON.stringify(allNames),
        includeAltsInNickname,
      },
      update: {
        discordUserTag: member.user.tag,
        names: JSON.stringify(allNames),
        includeAltsInNickname,
        createdAt: new Date(),
      },
    });
    await member
      .send(
        `I couldn't find "${mainName}" in the guild roster yet — that's probably just because it hasn't been updated recently, not a mistake on your end. I'll keep checking automatically for the next 42 hours and set your roles the moment it shows up. If it still hasn't resolved by then, please ping an officer.`,
      )
      .catch(() => {
        // Best-effort — if even this DM fails, there's nothing more to do.
      });
  } else {
    await db.guildPendingRosterMatch.deleteMany({
      where: { guildId: guild.id, discordUserId: member.id },
    });
  }
}
