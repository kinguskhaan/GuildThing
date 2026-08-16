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

import { lookupCharacter } from "./battlenetApi.js";
import {
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

  if (interaction.isButton()) {
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

  const mainNameResult = await askTextModal(
    triggerInteraction,
    `Welcome to ${discordGuild.name}!`,
    "Exact character name (this guild)",
    "Not a nickname — the real character name in-game, must be a member of this guild.",
  );
  if (mainNameResult == null) return;
  const mainName = mainNameResult.value;

  // Only asked at all if the guild has PUGs turned on — otherwise there's
  // no meaningful choice to make (nowhere to route a "PUG" answer to), so
  // skip straight into the guild-member flow instead of asking a question
  // with only one real answer.
  let hasAltsTrigger: ChoiceInteraction = mainNameResult.interaction;

  if (guild.pugEnabled) {
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
      let pugName = mainName;
      let pugCursor: ChoiceInteraction = affiliationResult.interaction;

      // A character must actually exist in-game to join as a PUG — same
      // "must be the exact character name, not a nickname" enforcement as
      // guild members get, just gating entry outright here instead of
      // just flagging it. Only possible when the guild has armory lookup
      // configured (see Guild.wowRegion etc.); otherwise falls back to
      // trusting what they typed, same as before this existed.
      const armoryConfig =
        guild.wowRegion &&
        guild.wowRealmSlug &&
        guild.wowGuildName &&
        guild.wowNamespaceFlavor
          ? {
              region: guild.wowRegion,
              realmSlug: guild.wowRealmSlug,
              guildName: guild.wowGuildName,
              flavor: guild.wowNamespaceFlavor,
            }
          : null;

      if (armoryConfig) {
        for (;;) {
          const lookup = await lookupCharacter(
            armoryConfig.region,
            armoryConfig.realmSlug,
            pugName,
            armoryConfig.flavor,
            armoryConfig.guildName,
          );
          if (lookup.status === "unavailable") break; // can't verify right now — don't block on an outage
          if (lookup.status !== "not_found") {
            pugName = lookup.name; // Battle.net's canonical spelling/casing
            break;
          }

          const retryResult = await askChoice(
            pugCursor,
            `I couldn't find a character named "${pugName}" in-game. Want to try a different name?`,
            [
              { id: "retry", label: "Try again", primary: true },
              { id: "cancel", label: "Cancel" },
            ],
          );
          if (retryResult == null) return;
          if (retryResult.value === "cancel") {
            await retryResult.interaction
              .update({
                content:
                  "No problem — run `/onboarding` again whenever you're ready.",
                components: [],
              })
              .catch(() => {});
            return;
          }
          const nameResult = await askTextModal(
            retryResult.interaction,
            "Character name",
            "Exact character name",
            "Not a nickname — the real character name as it appears in-game.",
          );
          if (nameResult == null) return;
          pugName = nameResult.value;
          pugCursor = nameResult.interaction;
        }
      }

      const cursor = { interaction: pugCursor };
      await applyNicknameAndRoles(
        member,
        guild.id,
        [pugName],
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

    hasAltsTrigger = affiliationResult.interaction;
  }

  // They're onboarding as a guild member now — clear any stale "chose PUG"
  // record from a previous run, since that's no longer true.
  await db.guildPugMember
    .deleteMany({ where: { guildId: guild.id, discordUserId: member.id } })
    .catch(() => {});

  // A play group with no in-game guild has no addon to read class from —
  // ask for it directly instead. Addon-sourced guilds get class from the
  // roster row once matched, so this is skipped entirely for them.
  const onboardingBuildsRoster = guild.rosterSource === "onboarding";

  let mainClass: string | null = null;
  let classTrigger: ChoiceInteraction = hasAltsTrigger;
  if (onboardingBuildsRoster) {
    const classResult = await askChoice(
      hasAltsTrigger,
      `What class is **${mainName}**?`,
      WOW_CLASS_CHOICES,
    );
    if (classResult == null) return;
    mainClass = classResult.value;
    classTrigger = classResult.interaction;
  }

  const hasAltsResult = await askChoice(classTrigger, "Do you have any alts?", [
    { id: "yes", label: "Yes", primary: true },
    { id: "no", label: "No" },
  ]);
  if (hasAltsResult == null) return;

  const alts: NamedCharacter[] = [];
  let lastChoice = hasAltsResult.interaction;
  if (hasAltsResult.value === "yes") {
    let addingAlts = true;
    while (addingAlts) {
      const altResult = await askTextModal(
        lastChoice,
        "Add an alt",
        "Exact alt character name (this guild)",
        "Not a nickname — the real character name in-game, must be a member of this guild.",
      );
      if (altResult == null) return;

      let altClass: string | null = null;
      let addAnotherTrigger: ChoiceInteraction = altResult.interaction;
      if (onboardingBuildsRoster) {
        const altClassResult = await askChoice(
          altResult.interaction,
          `What class is **${altResult.value}**?`,
          WOW_CLASS_CHOICES,
        );
        if (altClassResult == null) return;
        altClass = altClassResult.value;
        addAnotherTrigger = altClassResult.interaction;
      }
      alts.push({ name: altResult.value, class: altClass });

      const addAnotherResult = await askChoice(
        addAnotherTrigger,
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

  const characters: NamedCharacter[] = [
    { name: mainName, class: mainClass },
    ...alts,
  ];
  const allNames = characters.map((c) => c.name);

  // Unified nickname-display choice — one 3-way (or, with no alts, 2-way)
  // pick instead of separate "include alts?" and "preferred nickname?"
  // questions. Every branch resolves to a definite preferredNickname
  // override (see GuildMemberNickname in schema.prisma) — matchRosterAndApply
  // keeps refreshing "computedName" (the full real main+alts name)
  // underneath regardless, so an officer can always see/reset to it from
  // the site (guild-member-nicknames.tsx), and includeAltsInNickname below
  // is kept only as pendingMatches.ts's stored fallback if the override
  // somehow doesn't apply.
  const includeAltsInNickname = true;
  const cursor = { interaction: lastChoice as ChoiceInteraction };
  let preferredNickname: string;

  if (alts.length > 0) {
    const modeResult = await askChoice(
      cursor.interaction,
      "How should your nickname look in Discord?",
      [
        { id: "multi", label: "Multiple names", primary: true },
        { id: "single", label: "Just one name" },
        { id: "custom", label: "Custom nickname" },
      ],
    );
    if (modeResult == null) return;
    cursor.interaction = modeResult.interaction;

    if (modeResult.value === "multi") {
      const chosen = await askNicknameSelectionInteractive(
        cursor,
        allNames,
        "Choose which alts to include alongside your main",
      );
      preferredNickname = chosen.join("/");
    } else if (modeResult.value === "single") {
      const singleResult = await askChoice(
        cursor.interaction,
        "Which character should show as your nickname?",
        allNames.map((n) => ({ id: n, label: n })),
      );
      if (singleResult == null) return;
      cursor.interaction = singleResult.interaction;
      preferredNickname = singleResult.value;
    } else {
      const nickResult = await askTextModal(
        modeResult.interaction,
        "Custom nickname",
        "Nickname (must relate to char name)",
        "e.g. a shorter form or common spelling of your character name.",
      );
      if (nickResult == null) return;
      cursor.interaction = nickResult.interaction;
      preferredNickname = nickResult.value;
    }
  } else {
    // No alts — the only meaningful choice is standard vs. custom.
    const customResult = await askChoice(
      cursor.interaction,
      `Do you want a custom nickname instead of "${mainName}"?`,
      [
        { id: "yes", label: "Yes" },
        { id: "no", label: `No, use "${mainName}"`, primary: true },
      ],
    );
    if (customResult == null) return;
    cursor.interaction = customResult.interaction;

    if (customResult.value === "yes") {
      const nickResult = await askTextModal(
        customResult.interaction,
        "Custom nickname",
        "Nickname (must relate to char name)",
        "e.g. a shorter form or common spelling of your character name.",
      );
      if (nickResult == null) return;
      cursor.interaction = nickResult.interaction;
      preferredNickname = nickResult.value;
    } else {
      preferredNickname = mainName;
    }
  }

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
  const notify = createNotifier(cursor);
  const { matchedCount, unmatchedCount, confirmedCount } =
    await matchRosterAndApply(member, guild, characters, includeAltsInNickname, {
      chooseNicknameNames: (names) =>
        askNicknameSelectionInteractive(
          cursor,
          names,
          "Your name list is too long to fit Discord's 32-character nickname limit. Choose which alts to include",
        ),
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
