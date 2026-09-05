import {
  ActionRowBuilder,
  ComponentType,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";

import { askChoice, QUESTION_TIMEOUT_MS, type ChoiceInteraction } from "./onboarding.js";

// Any interaction a flow question step can chain off of — same idea as
// ChoiceInteraction in onboarding.ts, widened to also include a
// StringSelectMenuInteraction (a prior multi-select question's answer) and
// a ChatInputCommandInteraction (a question step reached as the very first
// step of a /onboarding run, before anything's been asked yet).
export type QuestionCursor = ChoiceInteraction | StringSelectMenuInteraction | ChatInputCommandInteraction;

// Discord doesn't need a dedicated "skip" component for multi-select or
// free-text (setMinValues(0) / setRequired(false) already let someone
// submit nothing) — only single_select's buttons need an explicit extra
// choice, since a button question otherwise always produces some value.
// Exported so onboardingFlowEngine.ts's single_select handling (which
// injects this same choice for optional question steps) can recognize it.
export const SKIP_ID = "__skip__";

// Native multi-select, mirroring askChoice's structure exactly (ephemeral
// reply/update branching, same timeout, same freshEntry guard against
// update()'ing the public "Start Onboarding" message when this happens to
// be the very first prompt of a run) but with a StringSelectMenuBuilder
// instead of buttons — this is the first place the bot uses min/max values
// for a genuine multi-pick rather than a single-select dropdown. minValues
// 0 (only for optional questions) lets someone submit with nothing picked,
// same as an empty free-text answer or a "Skip" button click below.
export async function askMultiSelect(
  interaction: QuestionCursor,
  content: string,
  choices: { id: string; label: string }[],
  minValues: 0 | 1,
  freshEntry = false,
): Promise<{ values: string[]; interaction: StringSelectMenuInteraction } | null> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("answer")
    .setPlaceholder(minValues === 0 ? "Select one or more (optional)" : "Select one or more")
    .setMinValues(minValues)
    .setMaxValues(choices.length)
    .addOptions(
      choices.map((c) => ({ label: c.label.slice(0, 100) || "(untitled)", value: c.id })),
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

  if ((interaction.isButton() || interaction.isStringSelectMenu()) && !freshEntry) {
    await interaction.update({ content, components: [row] });
  } else {
    await interaction.reply({
      content,
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    const message = await interaction.fetchReply();
    const selected = await message.awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      time: QUESTION_TIMEOUT_MS,
      filter: (i) => i.user.id === interaction.user.id,
    });
    return { values: selected.values, interaction: selected };
  } catch (err) {
    console.log(
      `[bot] ${interaction.user.tag} didn't answer in time (or an error occurred) on: "${content}"`,
      err,
    );
    return null;
  }
}

// Free-text answer via modal — deliberately separate from onboarding.ts's
// askTextModal, which is tailored to short exact character names (32-char
// cap, fixed wording). Flow question steps are open-ended admin-written
// text, so this uses a longer Paragraph-style field instead (same style
// events.ts already uses for longer free text elsewhere in the bot).
export async function askFreeTextAnswer(
  interaction: QuestionCursor,
  prompt: string,
  required: boolean,
): Promise<{ value: string; interaction: ModalSubmitInteraction } | null> {
  // A modal can't be shown directly in response to another modal's submit
  // — the only place this matters is two free-text questions chained back
  // to back — so bridge with a single button click in that case, reusing
  // askChoice rather than duplicating its reply/update logic.
  let modalTrigger: ButtonInteraction | StringSelectMenuInteraction | ChatInputCommandInteraction;
  if (interaction.isModalSubmit()) {
    const bridge = await askChoice(interaction, prompt, [
      { id: "continue", label: "Continue", primary: true },
    ]);
    if (bridge == null) return null;
    modalTrigger = bridge.interaction;
  } else {
    modalTrigger = interaction;
  }

  const modalId = `onboard-question-${modalTrigger.id}`;
  const textInput = new TextInputBuilder()
    .setCustomId("value")
    .setLabel(prompt.slice(0, 45))
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000)
    .setRequired(required);
  if (!required) {
    textInput.setPlaceholder("Leave blank to skip");
  }
  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle(prompt.slice(0, 45))
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(textInput));

  await modalTrigger.showModal(modal);
  try {
    const submitted = await modalTrigger.awaitModalSubmit({
      time: QUESTION_TIMEOUT_MS,
      filter: (i) => i.user.id === modalTrigger.user.id && i.customId === modalId,
    });
    return {
      value: submitted.fields.getTextInputValue("value").trim(),
      interaction: submitted,
    };
  } catch (err) {
    console.log(
      `[bot] ${modalTrigger.user.tag} didn't submit the "${prompt}" question in time (or an error occurred):`,
      err,
    );
    return null;
  }
}
