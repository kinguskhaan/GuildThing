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
  applyChannelGrants,
  applyManagedRoles,
  applyNicknameAndRoles,
  MAX_NICKNAME_LENGTH,
  matchRosterAndApply,
  type NamedCharacter,
} from "./roleLogic.js";

const QUESTION_TIMEOUT_MS = 5 * 60_000;

// Only asked when Guild.rosterSource is "onboarding" (no addon to scan
// class from) — matches the class tokens the addon itself exports, same
// list CLASS_COLORS on the site keys off.
const WOW_CLASS_CHOICES = [
  { id: "WARRIOR", label: "Warrior" },
  { id: "PALADIN", label: "Paladin" },
  { id: "HUNTER", label: "Hunter" },
  { id: "ROGUE", label: "Rogue" },
  { id: "PRIEST", label: "Priest" },
  { id: "SHAMAN", label: "Shaman" },
  { id: "MAGE", label: "Mage" },
  { id: "WARLOCK", label: "Warlock" },
  { id: "DRUID", label: "Druid" },
];

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
  placeholder?: string,
): Promise<{ value: string; interaction: ModalSubmitInteraction } | null> {
  const modalId = `onboard-modal-${interaction.id}`;
  const textInput = new TextInputBuilder()
    .setCustomId("value")
    .setLabel(fieldLabel.slice(0, 45))
    .setStyle(TextInputStyle.Short)
    .setMaxLength(32)
    .setRequired(true);
  if (placeholder) {
    textInput.setPlaceholder(placeholder.slice(0, 100));
  }
  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle(modalTitle.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(textInput),
    );

  await interaction.showModal(modal);
  try {
    const submitted = await interaction.awaitModalSubmit({
      time: QUESTION_TIMEOUT_MS,
      filter: (i) =>
        i.user.id === interaction.user.id && i.customId === modalId,
    });
    return {
      value: submitted.fields.getTextInputValue("value").trim(),
      interaction: submitted,
    };
  } catch (err) {
    console.log(
      `[bot] ${interaction.user.tag} didn't submit the "${modalTitle}" / "${fieldLabel}" modal in time (or an error occurred):`,
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
  interaction: ChoiceInteraction | ChatInputCommandInteraction,
  content: string,
  choices: { id: string; label: string; primary?: boolean }[],
  // True when `interaction` might still be the untouched click on the
  // standing, PUBLIC "Start Onboarding" button rather than an already-
  // ephemeral reply from earlier in this flow. update()'ing that click
  // would edit the public button message in place for the whole channel to
  // see — forces a fresh ephemeral reply instead. Only ever needed for the
  // very first prompt of a run (see runOnboarding's callers).
  freshEntry = false,
): Promise<{ value: string; interaction: ButtonInteraction } | null> {
  // Chunked into rows of 5 (Discord's per-row button cap) — most questions
  // only ever have 2-3 choices and get one row same as before, but this
  // also covers longer lists like the class picker (9 choices, 2 rows).
  const buttons = choices.map((c) =>
    new ButtonBuilder()
      .setCustomId(c.id)
      .setLabel(c.label)
      .setStyle(c.primary ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons.slice(i, i + 5),
      ),
    );
  }

  if (interaction.isButton() && !freshEntry) {
    await interaction.update({ content, components: rows });
  } else {
    await interaction.reply({
      content,
      components: rows,
      flags: MessageFlags.Ephemeral,
    });
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
      `[bot] ${interaction.user.tag} didn't answer in time (or an error occurred) on: "${content}"`,
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
          await interaction.reply({
            content: message,
            flags: MessageFlags.Ephemeral,
          });
        }
      } else {
        await interaction.followUp({
          content: message,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (err) {
      console.error(
        `[bot] failed to notify ${cursor.interaction.user.tag} via interaction:`,
        err,
      );
    }
  };
}

// Toggle-button question for picking which alts to combine into a nickname
// alongside the main name (names[0] — always kept, only alts get toggle
// buttons). Used two ways: eagerly, as the "Multiple names" branch of the
// nickname-style choice below; and as an overflow fallback, passed to
// matchRosterAndApply as chooseNicknameNames, invoked only if a selection
// still doesn't fit Discord's 32-char cap. Mutates `cursor` as clicks come
// in so whatever notify() runs afterward (in applyNicknameAndRoles) picks
// up from the right interaction.
async function askNicknameSelectionInteractive(
  cursor: { interaction: ChoiceInteraction },
  names: string[],
  intro = "Choose which alts to include in your nickname",
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
      `${intro} — your main, **${mainName}**, is always kept.\n\n` +
      `Preview: \`${preview}\` (${preview.length}/${MAX_NICKNAME_LENGTH} chars)`
    );
  }

  function buildComponents(): ActionRowBuilder<ButtonBuilder>[] {
    const altButtons = altNames.map((name, i) =>
      new ButtonBuilder()
        .setCustomId(`toggle:${i}`)
        .setLabel(selected.has(name) ? `✅ ${name}` : name)
        .setStyle(
          selected.has(name) ? ButtonStyle.Primary : ButtonStyle.Secondary,
        ),
    );
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < altButtons.length; i += 5) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          altButtons.slice(i, i + 5),
        ),
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

  // Two call sites, two interaction states: as the eager "Multiple names"
  // branch below, cursor.interaction is a fresh, not-yet-acknowledged
  // button click (needs update()/reply()); as matchRosterAndApply's
  // chooseNicknameNames overflow fallback, it's already deferred by
  // runOnboarding up front (needs editReply()) — same three-way branch
  // askChoice/createNotifier already use elsewhere in this file.
  const firstRender = { content: buildContent(), components: buildComponents() };
  if (cursor.interaction.deferred || cursor.interaction.replied) {
    await cursor.interaction.editReply(firstRender);
  } else if (cursor.interaction.isButton()) {
    await cursor.interaction.update(firstRender);
  } else {
    await cursor.interaction.reply({
      ...firstRender,
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
    await clicked.update({
      content: buildContent(),
      components: buildComponents(),
    });
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
export async function notifyNewMemberToOnboard(
  member: GuildMember,
): Promise<void> {
  const guild = await db.guild.findUnique({
    where: { discordGuildId: member.guild.id },
  });
  if (!guild) return;

  const hint = guild.onboardingChannelId
    ? `head to <#${guild.onboardingChannelId}> and click "Start Onboarding"`
    : "run `/onboarding`";
  await member
    .send(`Welcome to ${member.guild.name}! To get set up, ${hint}.`)
    .catch(() => {
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

// Shared tail end of onboarding — upserts a preferred-nickname override (if
// one was decided), runs matchRosterAndApply, and queues/clears the pending-
// roster-match retry. Used both by the normal happy-path completion (live
// interaction notifier) and by applyPartial's timeout-recovery path (DM
// notifier, no preferredNickname decided yet) below, so both apply the
// exact same matching/messaging logic instead of drifting apart.
async function finishOnboarding(
  member: GuildMember,
  guild: {
    id: string;
    rosterSource: string;
    wowRegion?: string | null;
    wowRealmSlug?: string | null;
    wowGuildName?: string | null;
    wowNamespaceFlavor?: string | null;
  },
  characters: NamedCharacter[],
  includeAltsInNickname: boolean,
  preferredNickname: string | null,
  options: {
    chooseNicknameNames?: (names: string[]) => Promise<string[]>;
    notify?: (message: string) => Promise<void>;
  } = {},
): Promise<void> {
  const mainName = characters[0]!.name;
  const allNames = characters.map((c) => c.name);
  const notify =
    options.notify ??
    (async (message: string) => {
      // Prefixed with the server name — a plain DM (this fallback, used by
      // applyPartial's timeout-recovery path) gives no other clue which of
      // a person's possibly-several GuildThing servers it's about.
      await member.send(`**${member.guild.name}** — ${message}`).catch(() => {
        // Best-effort.
      });
    });

  if (preferredNickname != null) {
    await db.guildMemberNickname.upsert({
      where: {
        guildId_discordUserId: { guildId: guild.id, discordUserId: member.id },
      },
      create: {
        guildId: guild.id,
        discordUserId: member.id,
        discordUserTag: member.user.tag,
        // Placeholder — matchRosterAndApply below overwrites this with the
        // real computed name right after, without touching preferredNickname
        // (partial update).
        computedName: mainName,
        preferredNickname,
      },
      update: { preferredNickname },
    });
  }

  const { matchedCount, unmatchedCount, confirmedCount } =
    await matchRosterAndApply(member, guild, characters, includeAltsInNickname, {
      chooseNicknameNames: options.chooseNicknameNames,
      notify,
    });

  if (unmatchedCount > 0) {
    // At least one name (could be the main, could just be an alt) wasn't
    // found in the roster — not a claim dispute, just data that hasn't
    // been (re-)imported since they joined (matchRosterAndApply already
    // sent its own confident message for any Battle.net-confirmed names —
    // see confirmedCount below). Queue this for the daily role-sync job to
    // retry automatically (see pendingMatches.ts) instead of that name
    // being stuck as plain text forever. Whatever DID match already got
    // claimed/applied above regardless.
    await db.guildPendingRosterMatch.upsert({
      where: {
        guildId_discordUserId: { guildId: guild.id, discordUserId: member.id },
      },
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

    const uncertainCount = unmatchedCount - confirmedCount;
    if (uncertainCount > 0) {
      await notify(
        matchedCount > 0 || confirmedCount > 0
          ? `Heads up — ${uncertainCount === 1 ? "one more name wasn't" : `${uncertainCount} more names weren't`} found on our guild's member list yet. I'll keep checking automatically for up to 42 hours.`
          : `I couldn't find "${mainName}" on our guild's member list yet — that's most likely because the list just hasn't been updated recently, not a mistake on your end. I'll automatically re-check for the next 42 hours and set your roles the moment it shows up there. Still nothing after that? Ping an officer.`,
      );
    }
  } else {
    await db.guildPendingRosterMatch.deleteMany({
      where: { guildId: guild.id, discordUserId: member.id },
    });
  }
}

// The nickname-display choice (multiple names / just one / custom, or the
// simpler standard-vs-custom pick when there's only one name) — shared by
// the normal onboarding flow and the "Change nickname" shortcut for someone
// who's already onboarded (see runOnboarding's known-characters menu).
// Mutates `cursor` as clicks/submits land, same convention as
// askNicknameSelectionInteractive. Returns null on timeout — the caller
// decides what "nothing decided" means for its situation (fall back to
// partial-save, or just report no changes).
async function chooseNicknameFlow(
  cursor: { interaction: ChoiceInteraction },
  mainName: string,
  allNames: string[],
): Promise<string | null> {
  if (allNames.length > 1) {
    const modeResult = await askChoice(
      cursor.interaction,
      "How should your nickname look in Discord?",
      [
        { id: "multi", label: "Multiple names", primary: true },
        { id: "single", label: "Just one name" },
        { id: "custom", label: "Custom nickname" },
      ],
    );
    if (modeResult == null) return null;
    cursor.interaction = modeResult.interaction;

    if (modeResult.value === "multi") {
      const chosen = await askNicknameSelectionInteractive(
        cursor,
        allNames,
        "Choose which alts to include alongside your main",
      );
      return chosen.join("/");
    }

    if (modeResult.value === "single") {
      const singleResult = await askChoice(
        cursor.interaction,
        "Which character should show as your nickname?",
        allNames.map((n) => ({ id: n, label: n })),
      );
      if (singleResult == null) return null;
      cursor.interaction = singleResult.interaction;
      return singleResult.value;
    }

    const nickResult = await askTextModal(
      modeResult.interaction,
      "Custom nickname",
      "Nickname (must relate to char name)",
      "e.g. a shorter form or common spelling of your character name.",
    );
    if (nickResult == null) return null;
    cursor.interaction = nickResult.interaction;
    return nickResult.value;
  }

  // Only one name known — the only meaningful choice is standard vs. custom.
  const customResult = await askChoice(
    cursor.interaction,
    `Do you want a custom nickname instead of "${mainName}"?`,
    [
      { id: "yes", label: "Yes" },
      { id: "no", label: `No, use "${mainName}"`, primary: true },
    ],
  );
  if (customResult == null) return null;
  cursor.interaction = customResult.interaction;

  if (customResult.value !== "yes") return mainName;

  const nickResult = await askTextModal(
    customResult.interaction,
    "Custom nickname",
    "Nickname (must relate to char name)",
    "e.g. a shorter form or common spelling of your character name.",
  );
  if (nickResult == null) return null;
  cursor.interaction = nickResult.interaction;
  return nickResult.value;
}

async function runOnboarding(
  triggerInteraction: ModalTriggerInteraction,
): Promise<void> {
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
        content:
          "This Discord server isn't registered with GuildThing — nothing for me to do here.",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  // Someone who's already onboarded as a guild member gets a shortcut menu
  // instead of being forced through the whole flow again just to add one
  // alt or tweak their nickname. Pure-PUG history doesn't trigger this —
  // that flow is already a single question, redoing it costs nothing.
  const knownRosterRows = await db.guildRosterMember.findMany({
    where: { guildId: guild.id, claimedByDiscordUserId: member.id },
    select: { name: true, class: true },
  });
  const knownExternalRows = await db.guildExternalCharacter.findMany({
    where: { guildId: guild.id, discordUserId: member.id },
    select: { name: true, class: true },
  });
  const pendingMatch = await db.guildPendingRosterMatch.findUnique({
    where: {
      guildId_discordUserId: { guildId: guild.id, discordUserId: member.id },
    },
  });

  const knownCharacters: NamedCharacter[] = [
    ...knownRosterRows,
    ...knownExternalRows,
  ];
  // Kept separate from knownCharacters (which flattens everything to a
  // plain name/class list for the roster-matching flows below) purely so
  // the "Show characters" button can tell the person which of their names
  // are actually confirmed vs. still waiting on a roster (re-)import.
  const pendingNames: string[] = [];
  if (pendingMatch) {
    for (const name of JSON.parse(pendingMatch.names) as string[]) {
      if (
        !knownCharacters.some(
          (c) => c.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        knownCharacters.push({ name, class: null });
        pendingNames.push(name);
      }
    }
  }

  let entryInteraction: ModalTriggerInteraction = triggerInteraction;

  if (knownCharacters.length > 0) {
    const menuResult = await askChoice(
      triggerInteraction,
      "You've already onboarded here. What would you like to do?",
      [
        { id: "add", label: "Add an alt", primary: true },
        { id: "nickname", label: "Change nickname" },
        { id: "show", label: "Show characters" },
        { id: "update", label: "Update characters" },
        { id: "reset", label: "Reset everything" },
        { id: "cancel", label: "Nevermind" },
      ],
      true,
    );
    if (menuResult == null) return;

    if (menuResult.value === "cancel") {
      await menuResult.interaction
        .update({ content: "No changes made.", components: [] })
        .catch(() => {});
      return;
    }

    if (menuResult.value === "show") {
      const lines = knownCharacters.map((c) => {
        const isPending = pendingNames.includes(c.name);
        const classSuffix = c.class ? ` (${c.class})` : "";
        return isPending
          ? `⏳ **${c.name}** — still looking for this in the roster`
          : `✅ **${c.name}**${classSuffix}`;
      });
      await menuResult.interaction
        .update({
          content: `Your characters so far:\n${lines.join("\n")}`,
          components: [],
        })
        .catch(() => {});
      return;
    }

    if (menuResult.value === "add") {
      const altResult = await askTextModal(
        menuResult.interaction,
        "Alt's exact character name ingame",
        "Must be a real in-game character",
        "Not a nickname people call you",
      );
      if (altResult == null) {
        await member
          .send(
            `**${member.guild.name}** — Didn't hear back in time — no alt was added.`,
          )
          .catch(() => {});
        return;
      }

      let altClass: string | null = null;
      let trigger: ChoiceInteraction = altResult.interaction;
      if (guild.rosterSource === "onboarding") {
        const altClassResult = await askChoice(
          altResult.interaction,
          `What class is **${altResult.value}**?`,
          WOW_CLASS_CHOICES,
        );
        if (altClassResult != null) {
          altClass = altClassResult.value;
          trigger = altClassResult.interaction;
        }
      }

      const cursor = { interaction: trigger };
      if (!cursor.interaction.deferred && !cursor.interaction.replied) {
        await cursor.interaction.deferUpdate();
      }
      await cursor.interaction.editReply({
        content: "Adding your alt…",
        components: [],
      });
      await finishOnboarding(
        member,
        guild,
        [...knownCharacters, { name: altResult.value, class: altClass }],
        true,
        null,
        { notify: createNotifier(cursor) },
      );
      return;
    }

    if (menuResult.value === "nickname") {
      const allKnownNames = knownCharacters.map((c) => c.name);
      const cursor = { interaction: menuResult.interaction as ChoiceInteraction };
      const preferredNickname = await chooseNicknameFlow(
        cursor,
        allKnownNames[0]!,
        allKnownNames,
      );
      if (preferredNickname == null) {
        await member
          .send(
            `**${member.guild.name}** — Didn't hear back in time — no changes made to your nickname.`,
          )
          .catch(() => {});
        return;
      }
      if (!cursor.interaction.deferred && !cursor.interaction.replied) {
        await cursor.interaction.deferUpdate();
      }
      await cursor.interaction.editReply({
        content: "Updating your nickname…",
        components: [],
      });
      await finishOnboarding(member, guild, knownCharacters, true, preferredNickname, {
        notify: createNotifier(cursor),
      });
      return;
    }

    if (menuResult.value === "reset") {
      const confirmResult = await askChoice(
        menuResult.interaction,
        "⚠️ This unclaims all your characters here, clears your nickname override, and removes any roles/channel access granted from them. This can't be undone — you'd need to run `/onboarding` again from scratch afterward. Are you sure?",
        [
          { id: "yes", label: "Yes, reset everything" },
          { id: "no", label: "Cancel", primary: true },
        ],
      );
      if (confirmResult == null) {
        await member
          .send(
            `**${member.guild.name}** — Didn't hear back in time — nothing was reset.`,
          )
          .catch(() => {});
        return;
      }
      if (confirmResult.value !== "yes") {
        await confirmResult.interaction
          .update({ content: "No changes made.", components: [] })
          .catch(() => {});
        return;
      }

      const cursor = { interaction: confirmResult.interaction };
      await cursor.interaction.deferUpdate();
      await cursor.interaction.editReply({
        content: "Resetting…",
        components: [],
      });

      await db.guildRosterMember.updateMany({
        where: { guildId: guild.id, claimedByDiscordUserId: member.id },
        data: { claimedByDiscordUserId: null, claimedByDiscordTag: null },
      });
      await db.guildExternalCharacter.deleteMany({
        where: { guildId: guild.id, discordUserId: member.id },
      });
      await db.guildMemberNickname.deleteMany({
        where: { guildId: guild.id, discordUserId: member.id },
      });
      await db.guildPendingRosterMatch.deleteMany({
        where: { guildId: guild.id, discordUserId: member.id },
      });
      await db.guildPugMember.deleteMany({
        where: { guildId: guild.id, discordUserId: member.id },
      });

      const notify = createNotifier(cursor);
      // Strips every managed role/channel-grant immediately (desired: [])
      // rather than waiting for tomorrow's daily sync to notice the roster
      // rows are unclaimed now — same functions the normal flow uses, just
      // called directly since there's no nickname to set here.
      await applyManagedRoles(member, guild.id, [], { notify });
      await applyChannelGrants(member, guild.id, [], { notify });
      // Best-effort, same server-owner limitation as everywhere else — not
      // worth a dedicated notice here, the reset itself already covers it.
      await member.setNickname(null).catch(() => {});

      await notify(
        "Done — everything's been reset. Run `/onboarding` again anytime to start fresh.",
      );
      return;
    }

    // "update" — fall through to the full flow below, starting from this
    // click instead of the original trigger. Additive: whatever's typed
    // this run gets claimed/matched on top of what's already there — use
    // "Reset everything" first if the goal is actually starting clean.
    entryInteraction = menuResult.interaction;
  }

  // Asked first, before any name — so the name modal right after can be
  // worded correctly for whichever path they're on (a PUG doesn't need to
  // be told "must be a member of this guild"). Only asked at all if the
  // guild has PUGs turned on — otherwise there's no meaningful choice to
  // make (nowhere to route a "PUG" answer to), so skip straight into the
  // guild-member flow instead of asking a question with only one real
  // answer.
  let affiliationTrigger: ModalTriggerInteraction = entryInteraction;
  let isPug = false;
  if (guild.pugEnabled) {
    const affiliationResult = await askChoice(
      entryInteraction,
      "Are you a guild member, or are you here to join a PUG?",
      [
        { id: "guild", label: "Guild member", primary: true },
        { id: "pug", label: "PUG" },
      ],
      entryInteraction === triggerInteraction,
    );
    if (affiliationResult == null) return;
    isPug = affiliationResult.value === "pug";
    affiliationTrigger = affiliationResult.interaction;
  }

  if (isPug) {
    // No Battle.net verification here — PUGs aren't tracked against the
    // roster or granted anything beyond a flat role, so there's nothing a
    // lookup would change; just take the name as typed.
    const pugNameResult = await askTextModal(
      affiliationTrigger,
      "Please enter exact ingame character name",
      "Must be a real in-game character",
      "Not a nickname people call you",
    );
    if (pugNameResult == null) return;

    const cursor = { interaction: pugNameResult.interaction };
    await applyNicknameAndRoles(
      member,
      guild.id,
      [pugNameResult.value],
      guild.pugRoleId ? [guild.pugRoleId] : [],
      [],
      { notify: createNotifier(cursor) },
    );
    // The authoritative "chose PUG" record — independent of whether a PUG
    // role is even configured, or whether the role assignment above
    // actually succeeded — so the site's "hasn't claimed a character" view
    // can correctly exclude them either way.
    await db.guildPugMember.upsert({
      where: {
        guildId_discordUserId: {
          guildId: guild.id,
          discordUserId: member.id,
        },
      },
      create: {
        guildId: guild.id,
        discordUserId: member.id,
        discordUserTag: member.user.tag,
      },
      update: { discordUserTag: member.user.tag },
    });
    return;
  }

  // They're onboarding as a guild member now — clear any stale "chose PUG"
  // record from a previous run, since that's no longer true.
  await db.guildPugMember
    .deleteMany({ where: { guildId: guild.id, discordUserId: member.id } })
    .catch(() => {});

  const mainNameResult = await askTextModal(
    affiliationTrigger,
    "Enter exact character name",
    "Must be a member of this guild",
    "Not a nickname people call you",
  );
  if (mainNameResult == null) return;
  const mainName = mainNameResult.value;
  const alts: NamedCharacter[] = [];
  let mainClass: string | null = null;

  // A play group with no in-game guild has no addon to read class from —
  // ask for it directly instead. Addon-sourced guilds get class from the
  // roster row once matched, so this is skipped entirely for them.
  const onboardingBuildsRoster = guild.rosterSource === "onboarding";

  // From here on, a person has already told us their real character
  // name(s) — a 5-minute timeout on some later question (an alt's class, a
  // nickname preference, etc.) shouldn't throw all of that away. Applies
  // whatever's been collected so far (DM-based notifier, since the
  // interaction that would've been used is dead by the time this runs) and
  // tells them what happened, instead of silently going nowhere.
  const applyPartial = async (): Promise<void> => {
    const partialCharacters: NamedCharacter[] = [
      { name: mainName, class: mainClass },
      ...alts,
    ];
    await member
      .send(
        `**${member.guild.name}** — Heads up — you didn't respond in time, so I stopped there. I saved what you had so far (${partialCharacters
          .map((c) => `"${c.name}"`)
          .join(", ")}) and set up your nickname/roles for it. Run \`/onboarding\` again anytime to add more alts or change your nickname.`,
      )
      .catch(() => {
        // Best-effort.
      });
    await finishOnboarding(member, guild, partialCharacters, true, null);
  };

  let classTrigger: ChoiceInteraction = mainNameResult.interaction;
  if (onboardingBuildsRoster) {
    const classResult = await askChoice(
      mainNameResult.interaction,
      `What class is **${mainName}**?`,
      WOW_CLASS_CHOICES,
    );
    if (classResult == null) {
      await applyPartial();
      return;
    }
    mainClass = classResult.value;
    classTrigger = classResult.interaction;
  }

  const hasAltsResult = await askChoice(classTrigger, "Do you have any alts?", [
    { id: "yes", label: "Yes", primary: true },
    { id: "no", label: "No" },
  ]);
  if (hasAltsResult == null) {
    await applyPartial();
    return;
  }

  let lastChoice = hasAltsResult.interaction;
  if (hasAltsResult.value === "yes") {
    let addingAlts = true;
    while (addingAlts) {
      const altResult = await askTextModal(
        lastChoice,
        "Alt's exact character name ingame",
        "Must be a real in-game character",
        "Not a nickname people call you",
      );
      if (altResult == null) {
        await applyPartial();
        return;
      }

      let altClass: string | null = null;
      let addAnotherTrigger: ChoiceInteraction = altResult.interaction;
      if (onboardingBuildsRoster) {
        const altClassResult = await askChoice(
          altResult.interaction,
          `What class is **${altResult.value}**?`,
          WOW_CLASS_CHOICES,
        );
        if (altClassResult == null) {
          // Got the name, not the class — still worth keeping (class stays
          // unset) rather than losing this alt entirely.
          alts.push({ name: altResult.value, class: null });
          await applyPartial();
          return;
        }
        altClass = altClassResult.value;
        addAnotherTrigger = altClassResult.interaction;
      }
      alts.push({ name: altResult.value, class: altClass });

      const addAnotherResult = await askChoice(
        addAnotherTrigger,
        `Added \`${altResult.value}\`. Add another alt?`,
        [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No, I'm done", primary: true },
        ],
      );
      if (addAnotherResult == null) {
        await applyPartial();
        return;
      }
      lastChoice = addAnotherResult.interaction;
      addingAlts = addAnotherResult.value === "yes";
    }
  }

  const characters: NamedCharacter[] = [
    { name: mainName, class: mainClass },
    ...alts,
  ];
  const allNames = characters.map((c) => c.name);

  // includeAltsInNickname is kept only as pendingMatches.ts's stored
  // fallback if the preferredNickname override somehow doesn't apply —
  // matchRosterAndApply keeps refreshing "computedName" (the full real
  // main+alts name) underneath regardless, so an officer can always see/
  // reset to it from the site (guild-member-nicknames.tsx).
  const includeAltsInNickname = true;
  const cursor = { interaction: lastChoice as ChoiceInteraction };
  const preferredNickname = await chooseNicknameFlow(cursor, mainName, allNames);
  if (preferredNickname == null) {
    await applyPartial();
    return;
  }

  // Nickname/role/channel changes below are a handful of sequential
  // Discord API calls each (see applyChannelGrants looping every managed
  // channel) — easily enough to blow past Discord's 3-second first-response
  // window, which turns the eventual reply into an "Unknown interaction"
  // (10062) and shows the user "did not respond in time" even though the
  // bot's still working. Acknowledging now buys the full ~15min follow-up
  // window instead; createNotifier already sends via followUp once
  // interaction.deferred is set, so no change needed there. The "multi"
  // branch above already acknowledged cursor.interaction itself (its own
  // Confirm click), so only defer here if that hasn't happened yet.
  if (!cursor.interaction.deferred && !cursor.interaction.replied) {
    await cursor.interaction.deferUpdate();
  }
  await cursor.interaction.editReply({
    content: "Setting up your roles and nickname…",
    components: [],
  });
  await finishOnboarding(member, guild, characters, includeAltsInNickname, preferredNickname, {
    chooseNicknameNames: (names) =>
      askNicknameSelectionInteractive(
        cursor,
        names,
        "Your name list is too long to fit Discord's 32-character nickname limit. Choose which alts to include",
      ),
    notify: createNotifier(cursor),
  });
}
