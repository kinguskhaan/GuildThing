import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  ComponentType,
  type GuildMember,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

import { db } from "@guildthing/db";

import {
  applyNicknameAndRoles,
  MAX_NICKNAME_LENGTH,
  matchRosterAndApply,
} from "./roleLogic.js";

const QUESTION_TIMEOUT_MS = 5 * 60_000;

// Guards against overlapping onboarding runs for the same person — e.g.
// double-clicking "Start Onboarding", or running /onboarding while a
// button-triggered flow is still active. Without this, two concurrent runs
// end up racing each other's modal/button collectors.
const activeOnboarding = new Set<string>();

// Everything the flow needs is driven through Discord interactions
// (button clicks, modal submits) — never DMs — so it works regardless of
// whether the person has server-member DMs enabled. A "cursor" tracks the
// most recent not-yet-acknowledged interaction; each step consumes it and
// produces a new one.
type ChoiceInteraction = ButtonInteraction | ModalSubmitInteraction;
type ModalTriggerInteraction = ButtonInteraction | ChatInputCommandInteraction;

// Shows a single-field modal and waits for it to be submitted. Must be
// called on an interaction that hasn't been responded to yet — showModal()
// itself is the acknowledgement, same constraint as reply()/update().
async function askTextModal(
  interaction: ModalTriggerInteraction,
  modalTitle: string,
  fieldLabel: string,
): Promise<{ value: string; interaction: ModalSubmitInteraction } | null> {
  const modalId = `onboard-modal-${interaction.id}`;
  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle(modalTitle.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("value")
          .setLabel(fieldLabel.slice(0, 45))
          .setStyle(TextInputStyle.Short)
          .setMaxLength(32)
          .setRequired(true),
      ),
    );

  await interaction.showModal(modal);
  try {
    const submitted = await interaction.awaitModalSubmit({
      time: QUESTION_TIMEOUT_MS,
      filter: (i) => i.user.id === interaction.user.id && i.customId === modalId,
    });
    return { value: submitted.fields.getTextInputValue("value").trim(), interaction: submitted };
  } catch (err) {
    console.log(
      `[bot] ${interaction.user.tag} didn't submit the "${fieldLabel}" modal in time (or an error occurred):`,
      err,
    );
    return null;
  }
}

// Button-choice question, ephemeral so only the person themselves sees it.
// Replies fresh if `interaction` hasn't been acknowledged yet (e.g. right
// after a modal submit), or updates it in place if it's a previous button
// click being chained — either way returns the RAW clicked interaction,
// unacknowledged, so the caller decides what happens next (another
// update(), a showModal(), a final notify, etc).
async function askChoice(
  interaction: ChoiceInteraction,
  content: string,
  choices: { id: string; label: string; primary?: boolean }[],
): Promise<{ value: string; interaction: ButtonInteraction } | null> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    choices.map((c) =>
      new ButtonBuilder()
        .setCustomId(c.id)
        .setLabel(c.label)
        .setStyle(c.primary ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );

  if (interaction.isButton()) {
    await interaction.update({ content, components: [row] });
  } else {
    await interaction.reply({ content, components: [row], flags: MessageFlags.Ephemeral });
  }

  try {
    const message = await interaction.fetchReply();
    const clicked = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: QUESTION_TIMEOUT_MS,
      filter: (i) => i.user.id === interaction.user.id,
    });
    return { value: clicked.customId, interaction: clicked };
  } catch (err) {
    console.log(
      `[bot] ${interaction.user.tag} didn't answer the button prompt in time (or an error occurred):`,
      err,
    );
    return null;
  }
}

// Wraps a mutable "current interaction" reference into a notify function
// usable by applyNicknameAndRoles/matchRosterAndApply — the first call
// updates/replies on whatever interaction is current, later calls (or a
// cursor already marked replied by askNicknameSelectionInteractive) use
// followUp so multiple notices in a row all land as separate ephemeral
// messages instead of erroring on a double-reply.
function createNotifier(cursor: { interaction: ChoiceInteraction }) {
  return async (message: string): Promise<void> => {
    try {
      const interaction = cursor.interaction;
      if (!interaction.replied && !interaction.deferred) {
        if (interaction.isButton()) {
          await interaction.update({ content: message, components: [] });
        } else {
          await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
      } else {
        await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
      }
    } catch (err) {
      console.error(
        `[bot] failed to notify ${cursor.interaction.user.tag} via interaction:`,
        err,
      );
    }
  };
}

// Toggle-button question used when the full name list (main + alts) won't
// fit Discord's 32-char nickname cap — lets the person pick which alts to
// drop instead of the bot silently cutting the list at a "/" boundary. The
// main name (names[0]) is always kept; only alts get toggle buttons.
// Mutates `cursor` as clicks come in so whatever notify() runs afterward
// (in applyNicknameAndRoles) picks up from the right interaction.
async function askNicknameSelectionInteractive(
  cursor: { interaction: ChoiceInteraction },
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
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(altButtons.slice(i, i + 5)),
      );
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

  const interaction = cursor.interaction;
  if (interaction.isButton()) {
    await interaction.update({ content: buildContent(), components: buildComponents() });
  } else {
    await interaction.reply({
      content: buildContent(),
      components: buildComponents(),
      flags: MessageFlags.Ephemeral,
    });
  }

  for (;;) {
    let clicked: ButtonInteraction;
    try {
      const message = await cursor.interaction.fetchReply();
      clicked = await message.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: QUESTION_TIMEOUT_MS,
        filter: (i) => i.user.id === cursor.interaction.user.id,
      });
    } catch {
      console.log(
        `[bot] ${cursor.interaction.user.tag} didn't finish the nickname-selection prompt in time — using current selection`,
      );
      break;
    }
    cursor.interaction = clicked;

    if (clicked.customId === "confirm") {
      await clicked.update({ components: [] });
      break;
    }

    const altIndex = Number(clicked.customId.slice("toggle:".length));
    const name = altNames[altIndex];
    if (name != null) {
      if (selected.has(name)) selected.delete(name);
      else selected.add(name);
    }
    await clicked.update({ content: buildContent(), components: buildComponents() });
  }

  return [mainName, ...altNames.filter((n) => selected.has(n))];
}

// Used by the /onboarding command to force-restart cleanly — clears any
// stuck/abandoned session (e.g. someone who left mid-flow last time)
// before the guard would otherwise skip a rerun.
export function cancelOnboarding(discordUserId: string): void {
  activeOnboarding.delete(discordUserId);
}

// Best-effort DM nudge on join — NOT the interactive flow itself (which
// needs a live interaction to reply/showModal through, so it can only
// start from the "Start Onboarding" button or /onboarding command). Just
// points the person at how to start it. If DMs are closed this silently
// does nothing, which is fine: they'll see the onboarding channel/button
// on the server itself regardless.
export async function notifyNewMemberToOnboard(member: GuildMember): Promise<void> {
  const guild = await db.guild.findUnique({
    where: { discordGuildId: member.guild.id },
  });
  if (!guild) return;

  const hint = guild.onboardingChannelId
    ? `head to <#${guild.onboardingChannelId}> and click "Start Onboarding"`
    : "run `/onboarding`";
  await member.send(`Welcome to ${member.guild.name}! To get set up, ${hint}.`).catch(() => {
    // DMs disabled — fine, the onboarding channel/button on the server
    // itself is the reliable path now, this was just a nicety.
  });
}

export async function runOnboardingInteractive(
  triggerInteraction: ModalTriggerInteraction,
): Promise<void> {
  const discordUserId = triggerInteraction.user.id;
  if (activeOnboarding.has(discordUserId)) {
    await triggerInteraction
      .reply({
        content:
          "You've already got an onboarding session in progress — check your recent messages here, or wait a bit and try again.",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }
  activeOnboarding.add(discordUserId);
  try {
    await runOnboarding(triggerInteraction);
  } finally {
    activeOnboarding.delete(discordUserId);
  }
}

async function runOnboarding(triggerInteraction: ModalTriggerInteraction): Promise<void> {
  if (!triggerInteraction.guild) return;
  const discordGuild = triggerInteraction.guild;
  const member = await discordGuild.members.fetch(triggerInteraction.user.id);

  const guild = await db.guild.findUnique({
    where: { discordGuildId: discordGuild.id },
  });
  if (!guild) {
    // This Discord server isn't registered as a GuildThing guild — nothing
    // for the bot to do here.
    await triggerInteraction
      .reply({
        content: "This Discord server isn't registered with GuildThing — nothing for me to do here.",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  const mainNameResult = await askTextModal(
    triggerInteraction,
    `Welcome to ${discordGuild.name}!`,
    "What's your in-game nickname?",
  );
  if (mainNameResult == null) return;
  const mainName = mainNameResult.value;

  const affiliationResult = await askChoice(
    mainNameResult.interaction,
    "Are you a guild member, or are you here to join a PUG?",
    [
      { id: "guild", label: "Guild member", primary: true },
      { id: "pug", label: "PUG" },
    ],
  );
  if (affiliationResult == null) return;

  if (affiliationResult.value === "pug") {
    const cursor = { interaction: affiliationResult.interaction as ChoiceInteraction };
    await applyNicknameAndRoles(
      member,
      guild.id,
      [mainName],
      guild.pugRoleId ? [guild.pugRoleId] : [],
      [],
      { notify: createNotifier(cursor) },
    );
    return;
  }

  const hasAltsResult = await askChoice(affiliationResult.interaction, "Do you have any alts?", [
    { id: "yes", label: "Yes", primary: true },
    { id: "no", label: "No" },
  ]);
  if (hasAltsResult == null) return;

  const altNames: string[] = [];
  let lastChoice = hasAltsResult.interaction;
  if (hasAltsResult.value === "yes") {
    let addingAlts = true;
    while (addingAlts) {
      const altResult = await askTextModal(lastChoice, "Add an alt", "What is your alt's name?");
      if (altResult == null) return;
      altNames.push(altResult.value);

      const addAnotherResult = await askChoice(
        altResult.interaction,
        `Added \`${altResult.value}\`. Add another alt?`,
        [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No", primary: true },
        ],
      );
      if (addAnotherResult == null) return;
      lastChoice = addAnotherResult.interaction;
      addingAlts = addAnotherResult.value === "yes";
    }
  }

  const allNames = [mainName, ...altNames];

  // Only worth asking if there's actually a choice to make — someone with
  // no alts just gets their main name, no extra question.
  let includeAltsInNickname = true;
  let finalInteraction: ButtonInteraction = lastChoice;
  if (altNames.length > 0) {
    const includeResult = await askChoice(
      lastChoice,
      `Do you want your alts included in your server nickname? e.g. "${allNames.join("/")}"`,
      [
        { id: "yes", label: "Yes", primary: true },
        { id: "no", label: "No" },
      ],
    );
    if (includeResult == null) return;
    includeAltsInNickname = includeResult.value === "yes";
    finalInteraction = includeResult.interaction;
  }

  const cursor = { interaction: finalInteraction as ChoiceInteraction };
  const notify = createNotifier(cursor);
  const { matchedCount, unmatchedCount } = await matchRosterAndApply(
    member,
    guild,
    allNames,
    includeAltsInNickname,
    {
      chooseNicknameNames: (names) => askNicknameSelectionInteractive(cursor, names),
      notify,
    },
  );

  if (unmatchedCount > 0) {
    // At least one name (could be the main, could just be an alt) wasn't
    // found in the roster — not a claim dispute, just data that probably
    // hasn't been (re-)imported since they joined. Queue this for the
    // daily role-sync job to retry automatically (see pendingMatches.ts)
    // instead of that name being stuck as plain text forever. Whatever DID
    // match already got claimed/applied above regardless.
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
    await notify(
      matchedCount > 0
        ? `Heads up — I found some of your names in the roster and set those up, but ${unmatchedCount === 1 ? "one name wasn't" : `${unmatchedCount} names weren't`} found yet. I'll keep checking automatically for up to 42 hours.`
        : `I couldn't find "${mainName}" in the guild roster yet — that's probably just because it hasn't been updated recently, not a mistake on your end. I'll keep checking automatically for the next 42 hours and set your roles the moment it shows up. If it still hasn't resolved by then, please ping an officer.`,
    );
  } else {
    await db.guildPendingRosterMatch.deleteMany({
      where: { guildId: guild.id, discordUserId: member.id },
    });
  }
}
