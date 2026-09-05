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
  type StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

import { db } from "@guildthing/db";
import { EXPANSIONS, getExpansion } from "@guildthing/wowhead-data";

import {
  applyChannelGrants,
  applyManagedRoles,
  MAX_NICKNAME_LENGTH,
  type NamedCharacter,
} from "./roleLogic.js";
import { claimAndSync, runFlow } from "./onboardingFlowEngine.js";

// Exported for onboardingQuestions.ts/onboardingFlowEngine.ts — every flow
// question chains through the same askChoice/timeout/cursor idioms as
// everything else here.
export const QUESTION_TIMEOUT_MS = 5 * 60_000;

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
export type ChoiceInteraction = ButtonInteraction | ModalSubmitInteraction;
export type ModalTriggerInteraction = ButtonInteraction | ChatInputCommandInteraction;
// Widened cursor type for onboardingFlowEngine.ts's flow-question walk —
// same idioms as ChoiceInteraction, plus a StringSelectMenuInteraction (a
// prior multi-select question's answer) and a ChatInputCommandInteraction
// (a flow question step reached as the very first step of a run, before
// anything's been asked yet — same as ModalTriggerInteraction above).
export type FlowCursor = ChoiceInteraction | StringSelectMenuInteraction | ChatInputCommandInteraction;

// Shows a single-field modal and waits for it to be submitted. Must be
// called on an interaction that hasn't been responded to yet — showModal()
// itself is the acknowledgement, same constraint as reply()/update().
export async function askTextModal(
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
export async function askChoice(
  interaction:
    | ChoiceInteraction
    | ChatInputCommandInteraction
    // A custom onboarding question's multi-select answer (see
    // onboardingQuestions.ts) can also be the interaction this chains off
    // of — same "editable ephemeral message" shape as a button click.
    | StringSelectMenuInteraction,
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

  if ((interaction.isButton() || interaction.isStringSelectMenu()) && !freshEntry) {
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
export function createNotifier(cursor: { interaction: FlowCursor }) {
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
export async function askNicknameSelectionInteractive(
  cursor: { interaction: FlowCursor },
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

  // Only offered as a shortcut-menu choice when this guild's flow actually
  // has a question step to re-answer — always true once migrated (the
  // main-name question always exists), but this stays guarded rather than
  // assumed in case a guild's flow is ever emptied out entirely.
  const hasQuestions =
    (await db.guildOnboardingStep.count({
      where: { guildId: guild.id, type: "question" },
    })) > 0;

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
        ...(hasQuestions ? [{ id: "answers", label: "Update answers" }] : []),
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

    if (menuResult.value === "answers") {
      // Re-walking the whole flow from Start naturally re-asks everything
      // reachable under this person's current answers — each persisted
      // answer just overwrites the prior row, actions re-run idempotently
      // (claim re-matches, nick recomputes) — see runFlow.
      await runFlow({
        member,
        guild,
        discordUserTag: member.user.tag,
        entryInteraction: menuResult.interaction,
        freshEntry: false,
      });
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
        const expansion = getExpansion(guild.expansion) ?? EXPANSIONS.tbc;
        const altClassResult = await askChoice(
          altResult.interaction,
          `What class is **${altResult.value}**?`,
          expansion.classes.map((c) => ({ id: c.token, label: c.label })),
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
      await claimAndSync(
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
      await claimAndSync(member, guild, knownCharacters, true, preferredNickname, {
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
      // Cascades to GuildOnboardingStepAnswerOption automatically.
      await db.guildOnboardingStepAnswer.deleteMany({
        where: { guildId: guild.id, discordUserId: member.id },
      });

      const notify = createNotifier(cursor);
      // Strips every managed role/channel-grant immediately (desired: [])
      // rather than waiting for tomorrow's daily sync to notice the roster
      // rows are unclaimed now — same functions the normal flow uses, just
      // called directly since there's no nickname to set here. Flow "grant"
      // action roles are included in getManagedRoleIds now too, so this
      // already strips those as well.
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

  // Everything else — the affiliation/PUG branch, main name, class, custom
  // questions, alts loop, and nickname/role application — now lives in the
  // guild's onboarding-flow graph (see onboardingFlowEngine.ts), walked
  // from Start. freshEntry guards against update()'ing the public "Start
  // Onboarding" message in place when this is the very first prompt of a
  // brand new run (entryInteraction is still the raw trigger); a shortcut-
  // menu click has already turned this into an ephemeral message chain, so
  // it doesn't need that guard.
  await runFlow({
    member,
    guild,
    discordUserTag: member.user.tag,
    entryInteraction,
    freshEntry: entryInteraction === triggerInteraction,
  });
}
