// Shared one-time migration from the LEGACY onboarding question graph
// (GuildOnboardingQuestion/QuestionOption/Edge/EdgeCondition*/Answer*) into
// the GuildOnboardingStep* flow tables, wrapping the copied questions in
// the standard fixed flow (affiliation/PUG branch, main name, class for
// rosterSource "onboarding" guilds, alts loop, nickname action).
//
// Idempotent via Guild.onboardingFlowMigratedAt: the flag is claimed with
// an atomic UPDATE ... WHERE onboardingFlowMigratedAt IS NULL inside the
// same transaction that builds the graph — 0 updated rows means another
// caller (bot startup racing the web's onboardingFlow query, or an
// earlier run) already migrated, and we return early. A crash rolls the
// flag back together with the data, so the next caller retries cleanly.
//
// Called from the bot (every guild, serialized, at startup) and from the
// web app's onboardingFlow query (one guild). After this runs, the bot
// and web read/write ONLY the new step tables; the legacy tables stay
// untouched (read-only) until a later cleanup stage drops them.
import { type Prisma, type PrismaClient } from "../generated/prisma";
import { WOW_CLASS_TOKENS } from "./wowClasses";

type Db = PrismaClient;
export async function ensureOnboardingFlowMigrated(
  prisma: Db,
  guildId?: string,
): Promise<void> {
  const guilds = await prisma.guild.findMany({
    where: guildId ? { id: guildId } : undefined,
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  for (const { id } of guilds) {
    await migrateGuild(prisma, id);
  }
}

async function migrateGuild(prisma: Db, guildId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Atomic idempotency claim — see the file comment. 0 rows = already
    // migrated (by us earlier or by a concurrent caller): done.
    const claimed = await tx.guild.updateMany({
      where: { id: guildId, onboardingFlowMigratedAt: null },
      data: { onboardingFlowMigratedAt: new Date() },
    });
    if (claimed.count === 0) return;

    const guild = await tx.guild.findUniqueOrThrow({
      where: { id: guildId },
      select: { pugRoleId: true, rosterSource: true },
    });

    // --- Legacy source data (read-only tables, never modified here) ---
    const legacyQuestions = await tx.guildOnboardingQuestion.findMany({
      where: { guildId },
      include: { options: true },
    });
    const legacyEdges = await tx.guildOnboardingEdge.findMany({
      where: { guildId },
      include: { conditionOptions: true, conditionClasses: true },
    });
    const legacyAnswers = await tx.guildOnboardingAnswer.findMany({
      where: { guildId },
      include: { selectedOptions: true },
    });

    // --- 1. Legacy questions -> question steps (SAME row ids) ---
    // Keeping question/option ids means every FK that pointed at a legacy
    // question or option (persisted answers, edge conditions) keeps
    // pointing at the migrated step. Legacy questions predate variables:
    // give each a stable derived varName ("legacy_" + the question id with
    // non-alphanumerics stripped — cuid-style question ids contain hyphens
    // that would trip save validation's ^[a-z][a-z0-9_]*$ rule; unique per
    // guild either way) so the migrated flow can be re-saved, and map the
    // old question type onto the closest varType.
    if (legacyQuestions.length > 0) {
      await tx.guildOnboardingStep.createMany({
        data: legacyQuestions.map((q) => ({
          id: q.id,
          guildId,
          type: "question",
          prompt: q.prompt,
          questionType: q.type,
          varName: `legacy_${q.id.replace(/[^a-z0-9]/gi, "").toLowerCase()}`,
          varType: q.type === "free_text" ? "text" : "choice",
          required: q.required,
        })),
      });
      const legacyOptions = legacyQuestions.flatMap((q) =>
        q.options.map((o) => ({
          id: o.id,
          stepId: q.id,
          label: o.label,
          sortOrder: o.sortOrder,
        })),
      );
      if (legacyOptions.length > 0) {
        await tx.guildOnboardingStepOption.createMany({ data: legacyOptions });
      }
    }

    // --- 2. Standard fixed-flow steps (new ids) ---
    const stepIds: Record<string, string> = {};
    const addStep = async (
      key: string,
      data: Prisma.GuildOnboardingStepUncheckedCreateInput,
    ): Promise<string> => {
      const created = await tx.guildOnboardingStep.create({ data });
      stepIds[key] = created.id;
      return created.id;
    };
    const addOption = async (
      stepId: string,
      label: string,
      sortOrder: number,
    ): Promise<string> =>
      (
        await tx.guildOnboardingStepOption.create({
          data: { stepId, label, sortOrder },
        })
      ).id;
    const addEdge = async (
      fromStepId: string | null,
      toStepId: string,
      optionIds?: string[],
    ): Promise<void> => {
      const edge = await tx.guildOnboardingStepEdge.create({
        data: { guildId, fromStepId, toStepId, conditionType: "always" },
      });
      if (optionIds && optionIds.length > 0) {
        await tx.guildOnboardingStepEdgeConditionOption.createMany({
          data: optionIds.map((optionId) => ({
            edgeId: edge.id,
            optionId,
          })),
        });
      }
    };
    const addAnswerEqualsEdge = async (
      fromStepId: string,
      toStepId: string,
      optionIds: string[],
    ): Promise<void> => {
      const edge = await tx.guildOnboardingStepEdge.create({
        data: {
          guildId,
          fromStepId,
          toStepId,
          conditionType: "answer_equals",
        },
      });
      await tx.guildOnboardingStepEdgeConditionOption.createMany({
        data: optionIds.map((optionId) => ({ edgeId: edge.id, optionId })),
      });
    };

    // Affiliation question + PUG branch — always seeded; an admin who
    // doesn't want it can delete the branch from the flow canvas
    // afterward, same as any other step (there's no separate toggle for
    // it once the flow is admin-editable).
    const affiliationId = await addStep("affiliation", {
      guildId,
      type: "question",
      prompt: "Are you a guild member, or are you here to join a PUG?",
      questionType: "single_select",
      varName: "affiliation",
      varType: "choice",
    });
    const guildMemberOptionId = await addOption(
      affiliationId,
      "Guild member",
      0,
    );
    const pugOptionId = await addOption(affiliationId, "PUG", 1);

    const pugNameId = await addStep("pug_name", {
      guildId,
      type: "question",
      prompt: "Please enter exact ingame character name",
      questionType: "free_text",
      varName: "pug_name",
      varType: "character",
    });
    const pugActionId = await addStep("pug_action", {
      guildId,
      type: "action",
      actionType: "grant",
      label: "Set role/channel",
    });
    if (guild.pugRoleId) {
      await tx.guildOnboardingActionGrant.create({
        data: { stepId: pugActionId, discordRoleId: guild.pugRoleId },
      });
    }
    const pugNickId = await addStep("pug_nick", {
      guildId,
      type: "action",
      actionType: "set_nickname",
      nicknameTemplate: "{pug_name}",
      label: "Set nickname",
    });

    await addEdge(null, affiliationId); // Start -> affiliation
    await addAnswerEqualsEdge(affiliationId, pugNameId, [pugOptionId]);
    await addEdge(pugNameId, pugActionId);
    await addEdge(pugActionId, pugNickId);
    // The guild-member edge hangs off the main-name question below.
    stepIds.affiliation = affiliationId;
    stepIds.guildMemberOption = guildMemberOptionId;

    // Guild-member branch: main name -> (class for rosterSource
    // "onboarding") -> claim main -> [existing question graph] -> alts.
    const mainId = await addStep("main", {
      guildId,
      type: "question",
      prompt: "Enter exact character name",
      questionType: "free_text",
      varName: "main",
      varType: "character",
    });

    // Class question only for rosterSource "onboarding" guilds — there is
    // no addon roster to read the class from, so onboarding itself asks.
    let preGraphTailId = mainId;
    if (guild.rosterSource === "onboarding") {
      const classId = await addStep("class", {
        guildId,
        type: "question",
        prompt: "What class is **{main}**?",
        questionType: "single_select",
        varName: "class",
        varType: "class",
      });
      for (const [i, wowClass] of WOW_CLASS_TOKENS.entries()) {
        await addOption(classId, wowClass.label, i);
      }
      await addEdge(mainId, classId);
      preGraphTailId = classId;
    }

    // Claims the main against the roster (matchRosterAndApply per name)
    // BEFORE the legacy question graph — class_equals/level_between edges
    // evaluate against the resolved roster row this action creates/claims.
    const claimMainId = await addStep("claim_main", {
      guildId,
      type: "action",
      actionType: "claim_characters",
      namesVariable: "main",
      label: "Claim main character",
    });

    // --- 3. Wire the standard flow together ---
    await addAnswerEqualsEdge(stepIds.affiliation!, mainId, [
      stepIds.guildMemberOption!,
    ]);
    await addEdge(preGraphTailId, claimMainId);

    // Existing question graph: the legacy Start edges (fromQuestionId
    // null) now originate from the claim-main action instead — copied
    // below, after claimMainId exists.
    const hasLegacyStartEdges = legacyEdges.some(
      (e) => e.fromQuestionId === null,
    );

    // --- 4. Alts tail (shared by every guild) ---
    const hasAltsId = await addStep("has_alts", {
      guildId,
      type: "question",
      prompt: "Do you have any alts?",
      questionType: "single_select",
      varName: "has_alts",
      varType: "choice",
    });
    const hasAltsYesOptionId = await addOption(hasAltsId, "Yes", 0);
    const hasAltsNoOptionId = await addOption(hasAltsId, "No", 1);
    if (!hasLegacyStartEdges) {
      // No legacy Start edges (or no legacy graph at all) — the flow goes
      // straight from claiming the main into the alts tail.
      await addEdge(claimMainId, hasAltsId);
    }


    const loopId = await addStep("alt_loop", {
      guildId,
      type: "loop",
      label: "Alt loop",
      listVariable: "alts",
    });
    const altNameId = await addStep("alt_name", {
      guildId,
      type: "question",
      prompt: "Alt's exact character name ingame",
      questionType: "free_text",
      varName: "alt_name",
      varType: "character",
      appendList: true,
    });
    const addAnotherId = await addStep("add_another", {
      guildId,
      type: "question",
      prompt: "Add another alt?",
      questionType: "single_select",
      varName: "add_another",
      varType: "choice",
    });
    const addAnotherYesOptionId = await addOption(addAnotherId, "Yes", 0);
    const addAnotherNoOptionId = await addOption(addAnotherId, "No, I'm done", 1);

    // rosterSource "onboarding" guilds also ask the ALT's class inside
    // the loop body (appendList onto alt_classes, index-aligned with the
    // alts list for the claim action below). Addon-sourced guilds read
    // alt classes from the roster, so alt_name chains straight into
    // "Add another alt?" for them.
    let preAddAnotherId: string = addAnotherId;
    if (guild.rosterSource === "onboarding") {
      const altClassId = await addStep("alt_class", {
        guildId,
        type: "question",
        prompt: "What class is **{alt_name}**?",
        questionType: "single_select",
        varName: "alt_classes",
        varType: "class",
        appendList: true,
      });
      for (const [i, wowClass] of WOW_CLASS_TOKENS.entries()) {
        await addOption(altClassId, wowClass.label, i);
      }
      preAddAnotherId = altClassId;
    }

    const claimAltsId = await addStep("claim_alts", {
      guildId,
      type: "action",
      actionType: "claim_characters",
      namesVariable: "alts",
      classesVariable: guild.rosterSource === "onboarding" ? "alt_classes" : null,
      label: "Claim alts",
    });
    const nickId = await addStep("nick", {
      guildId,
      type: "action",
      actionType: "set_nickname",
      nicknameTemplate: "{main}/{alts}",
      label: "Set nickname",
    });

    // Legacy questions with no outgoing edges flow into the alts tail.
    const questionsWithOutEdges = new Set(
      legacyEdges
        .filter((e) => e.fromQuestionId !== null)
        .map((e) => e.fromQuestionId!),
    );
    for (const q of legacyQuestions) {
      if (!questionsWithOutEdges.has(q.id)) {
        await addEdge(q.id, hasAltsId);
      }
    }

    await addAnswerEqualsEdge(hasAltsId, loopId, [hasAltsYesOptionId]);
    await addAnswerEqualsEdge(hasAltsId, claimAltsId, [hasAltsNoOptionId]);
    await addEdge(loopId, altNameId); // loop's single 'always' edge = body start
    await addEdge(altNameId, preAddAnotherId);
    await addAnswerEqualsEdge(addAnotherId, loopId, [addAnotherYesOptionId]); // next iteration
    await addAnswerEqualsEdge(addAnotherId, claimAltsId, [addAnotherNoOptionId]); // exit
    await addEdge(claimAltsId, nickId);

    // --- 5. Legacy edges -> step edges (SAME row ids) ---
    if (legacyEdges.length > 0) {
      await tx.guildOnboardingStepEdge.createMany({
        data: legacyEdges.map((e) => ({
          id: e.id,
          guildId,
          // Start edges re-anchor onto the claim-main action; question
          // edges keep their (unchanged) from-step id.
          fromStepId: e.fromQuestionId ?? claimMainId,
          toStepId: e.toQuestionId,
          conditionType: e.conditionType,
          conditionMinLevel: e.conditionMinLevel,
          conditionMaxLevel: e.conditionMaxLevel,
        })),
      });
      const edgeConditionOptions = legacyEdges.flatMap((e) =>
        e.conditionOptions.map((c) => ({
          id: c.id,
          edgeId: c.edgeId,
          optionId: c.optionId,
        })),
      );
      if (edgeConditionOptions.length > 0) {
        await tx.guildOnboardingStepEdgeConditionOption.createMany({
          data: edgeConditionOptions,
        });
      }
      const edgeConditionClasses = legacyEdges.flatMap((e) =>
        e.conditionClasses.map((c) => ({
          id: c.id,
          edgeId: c.edgeId,
          class: c.class,
        })),
      );
      if (edgeConditionClasses.length > 0) {
        await tx.guildOnboardingStepEdgeConditionClass.createMany({
          data: edgeConditionClasses,
        });
      }
    }

    // --- 6. Legacy answers -> step answers (SAME row ids) ---
    if (legacyAnswers.length > 0) {
      await tx.guildOnboardingStepAnswer.createMany({
        data: legacyAnswers.map((a) => ({
          id: a.id,
          guildId,
          discordUserId: a.discordUserId,
          discordUserTag: a.discordUserTag,
          stepId: a.questionId,
          textValue: a.textValue,
          updatedAt: a.updatedAt,
        })),
      });
      const answerOptions = legacyAnswers.flatMap((a) =>
        a.selectedOptions.map((ao) => ({
          id: ao.id,
          answerId: ao.answerId,
          optionId: ao.optionId,
        })),
      );
      if (answerOptions.length > 0) {
        await tx.guildOnboardingStepAnswerOption.createMany({
          data: answerOptions,
        });
      }
    }
  });
}

// One-time backfill for the "pug" -> "grant" actionType rename (see the
// onboarding flow engine's ActionType union) — a guild that ran the
// migration above BEFORE that rename shipped still has an actionType:"pug"
// step sitting in its live flow, which the current engine's
// executeActionStep no longer recognizes (silently does nothing on that
// step — the PUG role stops being granted). Also seeds
// GuildNonClaimableRole from the guild's pugRoleId so "unclaimed members"
// keeps excluding PUGs the same way GuildPugMember (removed) used to.
// Naturally idempotent — nothing left to touch on a second run once every
// "pug" step and every pugRoleId has been carried over — so unlike
// ensureOnboardingFlowMigrated above, no onboardingFlowMigratedAt-style
// claim guard is needed. Called alongside it: bot startup (every guild)
// and the web app's onboardingFlow query (one guild).
const LEGACY_PUG_STEP_LABEL = "Mark as PUG";

export async function ensurePugActionStepsMigrated(
  prisma: Db,
  guildId?: string,
): Promise<void> {
  const pugSteps = await prisma.guildOnboardingStep.findMany({
    where: { actionType: "pug", ...(guildId ? { guildId } : {}) },
    select: { id: true, guildId: true, label: true },
  });

  for (const step of pugSteps) {
    const guild = await prisma.guild.findUnique({
      where: { id: step.guildId },
      select: { pugRoleId: true },
    });

    await prisma.guildOnboardingStep.update({
      where: { id: step.id },
      data: {
        actionType: "grant",
        // Only replace the auto-generated label — leave an admin's own
        // rename alone.
        label: step.label === LEGACY_PUG_STEP_LABEL ? "Set role/channel" : step.label,
      },
    });

    if (guild?.pugRoleId) {
      const existingGrant = await prisma.guildOnboardingActionGrant.findFirst({
        where: { stepId: step.id },
      });
      if (!existingGrant) {
        await prisma.guildOnboardingActionGrant.create({
          data: { stepId: step.id, discordRoleId: guild.pugRoleId },
        });
      }
    }
  }

  const guildsWithPugRole = await prisma.guild.findMany({
    where: { pugRoleId: { not: null }, ...(guildId ? { id: guildId } : {}) },
    select: { id: true, pugRoleId: true },
  });
  for (const guild of guildsWithPugRole) {
    await prisma.guildNonClaimableRole.upsert({
      where: {
        guildId_discordRoleId: { guildId: guild.id, discordRoleId: guild.pugRoleId! },
      },
      create: { guildId: guild.id, discordRoleId: guild.pugRoleId! },
      update: {},
    });
  }
}