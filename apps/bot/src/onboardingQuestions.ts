import {
  ActionRowBuilder,
  ComponentType,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";

import { db } from "@guildthing/db";

import { askChoice, QUESTION_TIMEOUT_MS, type ChoiceInteraction } from "./onboarding.js";

// Any interaction this flow can chain off of — same idea as ChoiceInteraction
// in onboarding.ts, widened to also include a StringSelectMenuInteraction
// (a prior multi-select question's answer).
type QuestionCursor = ChoiceInteraction | StringSelectMenuInteraction;

// Discord doesn't need a dedicated "skip" component for multi-select or
// free-text (setMinValues(0) / setRequired(false) already let someone
// submit nothing) — only single_select's buttons need an explicit extra
// choice, since a button question otherwise always produces some value.
const SKIP_ID = "__skip__";

// Native multi-select, mirroring askChoice's structure exactly (ephemeral
// reply/update branching, same timeout) but with a StringSelectMenuBuilder
// instead of buttons — this is the first place the bot uses min/max values
// for a genuine multi-pick rather than a single-select dropdown. minValues
// 0 (only for optional questions) lets someone submit with nothing picked,
// same as an empty free-text answer or a "Skip" button click below.
async function askMultiSelect(
  interaction: QuestionCursor,
  content: string,
  choices: { id: string; label: string }[],
  minValues: 0 | 1,
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

  if (interaction.isButton() || interaction.isStringSelectMenu()) {
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
// cap, fixed wording). Custom questions are open-ended admin-written text,
// so this uses a longer Paragraph-style field instead (same style events.ts
// already uses for longer free text elsewhere in the bot).
async function askFreeTextAnswer(
  interaction: QuestionCursor,
  prompt: string,
  required: boolean,
): Promise<{ value: string; interaction: ModalSubmitInteraction } | null> {
  // A modal can't be shown directly in response to another modal's submit
  // — the only place this matters is two free-text questions chained back
  // to back — so bridge with a single button click in that case, reusing
  // askChoice rather than duplicating its reply/update logic.
  let modalTrigger: ButtonInteraction | StringSelectMenuInteraction;
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

// Skipping an optional question means "no answer" — clears any prior one
// too, so redoing questions via the shortcut menu's "Update answers" and
// choosing to skip this time actually removes the old answer rather than
// leaving it stale.
async function clearAnswer(params: {
  guildId: string;
  discordUserId: string;
  questionId: string;
}): Promise<void> {
  // Cascades to GuildOnboardingAnswerOption automatically.
  await db.guildOnboardingAnswer.deleteMany({ where: params });
}

async function persistAnswer(params: {
  guildId: string;
  discordUserId: string;
  discordUserTag: string;
  questionId: string;
  textValue: string | null;
  optionIds: string[];
}): Promise<void> {
  const { guildId, discordUserId, discordUserTag, questionId, textValue, optionIds } = params;
  const answer = await db.guildOnboardingAnswer.upsert({
    where: {
      guildId_discordUserId_questionId: { guildId, discordUserId, questionId },
    },
    create: { guildId, discordUserId, discordUserTag, questionId, textValue },
    update: { discordUserTag, textValue },
  });
  // Small per-answer full-replace of selections — scoped to one row, not
  // the whole guild's flow, so this is safe/cheap regardless of how many
  // other answers exist (unlike a blind replace of the question graph).
  await db.guildOnboardingAnswerOption.deleteMany({ where: { answerId: answer.id } });
  if (optionIds.length > 0) {
    await db.guildOnboardingAnswerOption.createMany({
      data: optionIds.map((optionId) => ({ answerId: answer.id, optionId })),
    });
  }
}

// Walks a guild's admin-built onboarding question graph from Start,
// evaluating each edge's condition against the player's WoW class and
// whatever answers have been collected so far, asking every question it
// reaches (a visited-set stops a question that's reachable via more than
// one edge from being asked twice) and persisting each answer immediately
// — so a later timeout still keeps whatever was already answered, the same
// "save what you have" behavior applyPartial gives the rest of onboarding.
// Returns the next unacknowledged interaction to keep chaining onboarding's
// own cursor through (or null on a mid-question timeout, same convention
// askChoice/askTextModal use).
export async function runCustomQuestionFlow(params: {
  guildId: string;
  discordUserId: string;
  discordUserTag: string;
  mainName: string;
  // As already resolved in runOnboarding — null for addon-sourced guilds,
  // which don't ask class in-wizard.
  mainClass: string | null;
  entryInteraction: QuestionCursor;
}): Promise<QuestionCursor | null> {
  const { guildId, discordUserId, discordUserTag, mainName, entryInteraction } = params;

  const questions = await db.guildOnboardingQuestion.findMany({
    where: { guildId },
    include: { options: { orderBy: { sortOrder: "asc" } } },
  });
  // Zero-question guilds are the common case (feature unused) — complete
  // no-op, zero behavior change from today.
  if (questions.length === 0) return entryInteraction;

  const edges = await db.guildOnboardingEdge.findMany({
    where: { guildId },
    include: { conditionOptions: true, conditionClasses: true },
  });

  // Level is never asked in-wizard (only class sometimes is), so this
  // lookup always runs regardless of whether mainClass is already known.
  // Addon-sourced guilds don't ask class in-wizard either — look it up
  // from the already-imported roster row too in that case. SQLite has no
  // case-insensitive query mode, so this matches matchRosterAndApply's own
  // approach (roleLogic.ts): fetch and compare lowercased in JS.
  const rosterRows = await db.guildRosterMember.findMany({
    where: { guildId },
    select: { name: true, class: true, level: true },
  });
  const lowerName = mainName.toLowerCase();
  const rosterRow = rosterRows.find((r) => r.name.toLowerCase() === lowerName) ?? null;
  const resolvedClass = params.mainClass ?? rosterRow?.class ?? null;
  // Meaningless (always 1) for rosterSource "onboarding" guilds — a
  // level_between edge just never fires there, same as an unresolved class.
  const resolvedLevel = rosterRow?.level ?? null;

  const questionsById = new Map(questions.map((q) => [q.id, q]));
  const outgoingByQuestionId = new Map<string, typeof edges>();
  for (const edge of edges) {
    const key = edge.fromQuestionId ?? "start";
    const list = outgoingByQuestionId.get(key) ?? [];
    list.push(edge);
    outgoingByQuestionId.set(key, list);
  }

  // questionId -> selected option ids given so far (empty for free_text).
  const answersGiven = new Map<string, string[]>();

  function edgeSatisfied(edge: (typeof edges)[number]): boolean {
    if (edge.conditionType === "always") return true;
    if (edge.conditionType === "class_equals") {
      // OR — fires if the resolved class is ANY of the edge's classes.
      return (
        resolvedClass != null &&
        edge.conditionClasses.some((c) => c.class === resolvedClass)
      );
    }
    if (edge.conditionType === "level_between") {
      return (
        resolvedLevel != null &&
        edge.conditionMinLevel != null &&
        edge.conditionMaxLevel != null &&
        resolvedLevel >= edge.conditionMinLevel &&
        resolvedLevel <= edge.conditionMaxLevel
      );
    }
    // answer_equals — only valid from a real question, never from Start
    // (enforced at save time too, this is just defense in depth). OR —
    // fires if the given answer includes ANY of the edge's options.
    if (!edge.fromQuestionId || edge.conditionOptions.length === 0) return false;
    const given = answersGiven.get(edge.fromQuestionId) ?? [];
    return edge.conditionOptions.some((co) => given.includes(co.optionId));
  }

  const visited = new Set<string>();
  const frontier: string[] = (outgoingByQuestionId.get("start") ?? [])
    .filter(edgeSatisfied)
    .map((e) => e.toQuestionId);

  let cursor: QuestionCursor = entryInteraction;

  while (frontier.length > 0) {
    const questionId = frontier.shift()!;
    if (visited.has(questionId)) continue;
    visited.add(questionId);
    const question = questionsById.get(questionId);
    if (!question) continue;

    if (question.type === "free_text") {
      const result = await askFreeTextAnswer(cursor, question.prompt, question.required);
      if (result == null) return null;
      if (result.value === "") {
        // Only reachable when !question.required — a required field's
        // modal already refuses to submit empty.
        await clearAnswer({ guildId, discordUserId, questionId });
      } else {
        await persistAnswer({
          guildId,
          discordUserId,
          discordUserTag,
          questionId,
          textValue: result.value,
          optionIds: [],
        });
      }
      answersGiven.set(questionId, []);
      cursor = result.interaction;
    } else if (question.type === "multi_select") {
      const result = await askMultiSelect(
        cursor,
        question.prompt,
        question.options.map((o) => ({ id: o.id, label: o.label })),
        question.required ? 1 : 0,
      );
      if (result == null) return null;
      if (result.values.length === 0) {
        await clearAnswer({ guildId, discordUserId, questionId });
      } else {
        await persistAnswer({
          guildId,
          discordUserId,
          discordUserTag,
          questionId,
          textValue: null,
          optionIds: result.values,
        });
      }
      answersGiven.set(questionId, result.values);
      cursor = result.interaction;
    } else {
      // single_select
      const choices = question.options.map((o) => ({ id: o.id, label: o.label }));
      if (!question.required) choices.push({ id: SKIP_ID, label: "Skip" });
      const result = await askChoice(cursor, question.prompt, choices);
      if (result == null) return null;
      if (result.value === SKIP_ID) {
        await clearAnswer({ guildId, discordUserId, questionId });
        answersGiven.set(questionId, []);
      } else {
        await persistAnswer({
          guildId,
          discordUserId,
          discordUserTag,
          questionId,
          textValue: null,
          optionIds: [result.value],
        });
        answersGiven.set(questionId, [result.value]);
      }
      cursor = result.interaction;
    }

    for (const edge of outgoingByQuestionId.get(questionId) ?? []) {
      if (!visited.has(edge.toQuestionId) && edgeSatisfied(edge)) {
        frontier.push(edge.toQuestionId);
      }
    }
  }

  return cursor;
}
