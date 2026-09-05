// The onboarding-flow interpreter — walks a guild's admin-built
// GuildOnboardingStep* graph (question/condition/action/loop nodes, see
// schema.prisma) and drives the live Discord conversation through it. Two
// halves, per the design brief (local://plan-onboarding-roles.md §2):
//
//   (a) A pure graph-walking core (buildFlowGraph/edgeSatisfied/FlowWalker)
//       that takes plain step/edge/variable/class/level data and returns
//       frontier decisions — no discord.js, no DB, fully unit-testable.
//   (b) An execution layer (loadFlowGraph/runFlow/claimAndSync and the
//       per-action executors) that drives real Discord interactions and
//       Prisma writes on top of the pure core.
import {
  ChannelType,
  PermissionFlagsBits,
  type GuildMember,
} from "discord.js";

import { db } from "@guildthing/db";

import {
  askChoice,
  askNicknameSelectionInteractive,
  createNotifier,
  type ChoiceInteraction,
  type FlowCursor,
  type ModalTriggerInteraction,
} from "./onboarding.js";
import { askFreeTextAnswer, askMultiSelect, SKIP_ID } from "./onboardingQuestions.js";
import {
  applyChannelGrants,
  applyManagedRoles,
  getManagedChannelGrants,
  getManagedRoleIds,
  matchRosterAndApply,
  setDiscordNickname,
  truncateNickname,
  type ChannelGrant,
  type NamedCharacter,
} from "./roleLogic.js";

// =============================================================================
// (a) Pure graph-walking core
// =============================================================================

export type StepType = "question" | "condition" | "action" | "loop";
export type QuestionType = "single_select" | "multi_select" | "free_text";
export type ActionType = "claim_characters" | "set_nickname" | "grant" | "dm";
export type EdgeConditionType =
  | "always"
  | "answer_equals"
  | "var_equals"
  | "class_equals"
  | "level_between";

export interface FlowOption {
  id: string;
  label: string;
  sortOrder: number;
}

export interface FlowGrant {
  discordRoleId: string | null;
  discordChannelId: string | null;
  channelType: string | null;
}

export interface FlowStep {
  id: string;
  type: StepType;
  label: string | null;
  prompt: string | null;
  questionType: QuestionType | null;
  varName: string | null;
  varType: string | null;
  required: boolean;
  appendList: boolean;
  actionType: ActionType | null;
  nicknameTemplate: string | null;
  textTemplate: string | null;
  namesVariable: string | null;
  classesVariable: string | null;
  listVariable: string | null;
  options: FlowOption[];
  grants: FlowGrant[];
}

export interface FlowEdge {
  id: string;
  fromStepId: string | null;
  toStepId: string;
  conditionType: EdgeConditionType;
  conditionMinLevel: number | null;
  conditionMaxLevel: number | null;
  conditionOptionIds: string[];
  conditionValues: string[];
  conditionClasses: string[];
}

export interface FlowGraph {
  stepsById: Map<string, FlowStep>;
  // Keyed by fromStepId, or START for the synthetic Start node (edges with
  // fromStepId === null).
  outgoingByFrom: Map<string, FlowEdge[]>;
}

// The synthetic "Start" node's key in outgoingByFrom — never a real cuid,
// so it can't collide with a step id.
const START = "__start__";

// Safety cap on loop iterations (see the design brief's loop semantics) —
// after this many iterations the loop aborts with a warning rather than
// looping forever on a malformed or adversarial answer sequence.
const MAX_LOOP_ITERATIONS = 50;

export function buildFlowGraph(steps: FlowStep[], edges: FlowEdge[]): FlowGraph {
  const stepsById = new Map<string, FlowStep>();
  for (const step of steps) stepsById.set(step.id, step);

  const outgoingByFrom = new Map<string, FlowEdge[]>();
  for (const edge of edges) {
    const key = edge.fromStepId ?? START;
    const list = outgoingByFrom.get(key) ?? [];
    list.push(edge);
    outgoingByFrom.set(key, list);
  }
  return { stepsById, outgoingByFrom };
}

// A walk's collected state: answers (in-memory, as they're given) plus the
// resolved class/level used by class_equals/level_between edges. Mutated
// in place by the execution layer as the walk progresses.
export interface WalkContext {
  variables: Record<string, string | string[]>;
  resolvedClass: string | null;
  resolvedLevel: number | null;
  // stepId -> selected option ids, for answer_equals edges AND for
  // evaluateRules' "answer" field rule conditions (roleLogic.ts) — same
  // shape, reused directly by the claim_characters action executor below.
  answersByStep: Map<string, string[]>;
}

// field/operator meanings match GuildOnboardingStepEdge (schema.prisma):
// always is unconditional; answer_equals/var_equals/class_equals OR their
// option/value/class list; level_between is an inclusive range.
export function edgeSatisfied(
  edge: FlowEdge,
  graph: FlowGraph,
  ctx: WalkContext,
): boolean {
  if (edge.conditionType === "always") return true;

  if (edge.conditionType === "answer_equals") {
    if (edge.fromStepId == null) return false;
    const given = ctx.answersByStep.get(edge.fromStepId) ?? [];
    return edge.conditionOptionIds.some((id) => given.includes(id));
  }

  if (edge.conditionType === "var_equals") {
    if (edge.fromStepId == null) return false;
    const fromStep = graph.stepsById.get(edge.fromStepId);
    if (!fromStep?.varName) return false;
    const value = ctx.variables[fromStep.varName];
    if (value == null) return false;
    const values = (Array.isArray(value) ? value : [value]).map((v) => v.toLowerCase());
    return edge.conditionValues.some((cv) => values.includes(cv.toLowerCase()));
  }

  if (edge.conditionType === "class_equals") {
    return ctx.resolvedClass != null && edge.conditionClasses.includes(ctx.resolvedClass);
  }

  if (edge.conditionType === "level_between") {
    return (
      ctx.resolvedLevel != null &&
      edge.conditionMinLevel != null &&
      edge.conditionMaxLevel != null &&
      ctx.resolvedLevel >= edge.conditionMinLevel &&
      ctx.resolvedLevel <= edge.conditionMaxLevel
    );
  }

  return false;
}

// A walk scope: the global top-level walk, or one loop's current
// iteration. Steps are deduped per-scope (`visited`) — a loop's scope gets
// a fresh, empty `visited` every time it iterates, which is exactly what
// lets its body steps be re-asked on the next iteration while everything
// outside the loop is still asked at most once.
interface Scope {
  parent: Scope | null;
  visited: Set<string>;
  loopStepId: string | null;
  bodyStartId: string | null;
}

export type WalkResult =
  | { kind: "question" | "action"; step: FlowStep }
  | { kind: "done" };

// The pure walker: given a graph and a WalkContext that the caller updates
// between calls, decides which step to visit next. Call start() once, then
// advance() after each yielded question/action has been handled (answer
// recorded into ctx, or action executed) — mirrors the same "cursor" idiom
// the rest of onboarding.ts uses for live Discord interactions, just for
// graph position instead. See the design brief §2 for the loop-iteration
// semantics this implements.
export class FlowWalker {
  private readonly graph: FlowGraph;
  private readonly queue: { stepId: string; scope: Scope }[] = [];
  private readonly globalScope: Scope = {
    parent: null,
    visited: new Set(),
    loopStepId: null,
    bodyStartId: null,
  };
  private readonly loopIterations = new Map<string, number>();
  private loopCapWarnings: FlowStep[] = [];
  private pending: { step: FlowStep; scope: Scope } | null = null;

  constructor(graph: FlowGraph) {
    this.graph = graph;
  }

  start(ctx: WalkContext): WalkResult {
    for (const edge of this.graph.outgoingByFrom.get(START) ?? []) {
      if (edgeSatisfied(edge, this.graph, ctx)) {
        this.queue.push({ stepId: edge.toStepId, scope: this.globalScope });
      }
    }
    return this.pump(ctx);
  }

  // Call after handling the step from the previous start()/advance() call
  // (its answer is in ctx, or its action ran) to get the next one.
  advance(ctx: WalkContext): WalkResult {
    if (!this.pending) return { kind: "done" };
    const { step, scope } = this.pending;
    this.pending = null;
    this.expandChildren(step, scope, ctx);
    return this.pump(ctx);
  }

  // Drains and returns any loop steps that hit MAX_LOOP_ITERATIONS since
  // the last call — the execution layer DMs a warning for each and then
  // keeps going (the loop itself is already abandoned; whatever step
  // follows the walk's other branches, if any, still runs).
  takeLoopCapWarnings(): FlowStep[] {
    const warnings = this.loopCapWarnings;
    this.loopCapWarnings = [];
    return warnings;
  }

  private pump(ctx: WalkContext): WalkResult {
    for (;;) {
      const item = this.queue.shift();
      if (!item) return { kind: "done" };
      const { stepId, scope } = item;
      if (scope.visited.has(stepId)) continue;
      scope.visited.add(stepId);

      const step = this.graph.stepsById.get(stepId);
      if (!step) continue;

      if (step.type === "condition") {
        this.expandChildren(step, scope, ctx);
        continue;
      }

      if (step.type === "loop") {
        // Validated at save time to have exactly one outgoing ("always")
        // edge — its body-start. No satisfied edge (a malformed/legacy
        // graph) just makes the loop a dead end.
        const bodyEdge = (this.graph.outgoingByFrom.get(stepId) ?? []).find((e) =>
          edgeSatisfied(e, this.graph, ctx),
        );
        if (!bodyEdge) continue;
        const loopScope: Scope = {
          parent: scope,
          visited: new Set(),
          loopStepId: stepId,
          bodyStartId: bodyEdge.toStepId,
        };
        this.loopIterations.set(stepId, 1);
        this.queue.push({ stepId: bodyEdge.toStepId, scope: loopScope });
        continue;
      }

      // question | action — yield to the caller.
      this.pending = { step, scope };
      return { kind: step.type, step };
    }
  }

  private expandChildren(step: FlowStep, scope: Scope, ctx: WalkContext): void {
    for (const edge of this.graph.outgoingByFrom.get(step.id) ?? []) {
      if (!edgeSatisfied(edge, this.graph, ctx)) continue;
      this.routeAndEnqueue(step.id, scope, edge.toStepId, ctx);
    }
  }

  // Decides where a satisfied edge from `fromStepId` (currently in `scope`)
  // actually lands: back into the loop for another iteration, deeper into
  // the same loop's body, or out into the enclosing scope. See the design
  // brief: "a body step's outgoing edge pointing back to the loop node ->
  // next iteration; otherwise -> exit" — "otherwise" only applies to the
  // specific step whose edges include that back-edge (the loop's decision
  // node); every other body step's edges just continue within the body.
  private routeAndEnqueue(
    fromStepId: string,
    scope: Scope,
    targetId: string,
    ctx: WalkContext,
  ): void {
    if (scope.loopStepId != null && targetId === scope.loopStepId) {
      const iteration = (this.loopIterations.get(scope.loopStepId) ?? 1) + 1;
      if (iteration > MAX_LOOP_ITERATIONS) {
        const loopStep = this.graph.stepsById.get(scope.loopStepId);
        if (loopStep) this.loopCapWarnings.push(loopStep);
        return; // Abort this loop — no further steps from this branch.
      }
      this.loopIterations.set(scope.loopStepId, iteration);
      scope.visited = new Set();
      if (scope.bodyStartId) this.queue.push({ stepId: scope.bodyStartId, scope });
      return;
    }

    if (scope.loopStepId != null) {
      const hasBackEdge = (this.graph.outgoingByFrom.get(fromStepId) ?? []).some(
        (e) => e.toStepId === scope.loopStepId,
      );
      if (hasBackEdge && scope.parent) {
        // fromStepId is this loop's decision node and this edge isn't the
        // loop-back one — it exits into the enclosing scope. Recurse (not
        // just enqueue) so a target that also happens to be an *outer*
        // loop's own id, or that outer loop's own decision node, is
        // routed correctly too.
        this.routeAndEnqueue(fromStepId, scope.parent, targetId, ctx);
        return;
      }
    }

    this.queue.push({ stepId: targetId, scope });
  }
}

// {var} template interpolation. Templates: nicknameTemplate/textTemplate
// use `keepUnknown: false` (unknown/empty var -> empty string, i.e. the
// token just disappears); question prompts use `keepUnknown: true`
// (unknown var -> prompt left untouched, so a typo in an admin's template
// shows up as a literal "{typo}" rather than silently vanishing). List
// variables join with "/".
export function interpolateTemplate(
  template: string,
  variables: Record<string, string | string[]>,
  options: { keepUnknown?: boolean } = {},
): string {
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, name: string) => {
    const value = variables[name];
    if (value == null) return options.keepUnknown ? match : "";
    return Array.isArray(value) ? value.join("/") : value;
  });
}

// =============================================================================
// (b) Execution layer
// =============================================================================

function optionLabel(step: FlowStep, optionId: string): string {
  return step.options.find((o) => o.id === optionId)?.label ?? "";
}

// Sets ctx.variables[step.varName] from a just-given answer's values
// (already resolved to their display form — free text as typed, select
// options as their label, never raw option ids). appendList pushes onto
// the existing list instead of replacing it (loop-body accumulation, e.g.
// "alts"); multi_select always stores a list even with one selection.
function setVariableFromAnswer(ctx: WalkContext, step: FlowStep, values: string[]): void {
  if (!step.varName) return;
  const alwaysList = step.questionType === "multi_select";
  if (step.appendList) {
    const existing = ctx.variables[step.varName];
    const arr = Array.isArray(existing) ? existing.slice() : existing != null ? [existing] : [];
    arr.push(...values);
    ctx.variables[step.varName] = arr;
  } else {
    ctx.variables[step.varName] = alwaysList ? values : (values[0] ?? "");
  }
  // The main character's resolved class drives class_equals edges — set it
  // once, from the first "class" varType question answered (the migrated
  // flow's "class" step, asked before any alt's class). Never overwritten
  // afterward, so a later alt_class question can't clobber it.
  if (step.varType === "class" && ctx.resolvedClass == null && values[0]) {
    ctx.resolvedClass = values[0];
  }
}


async function persistStepAnswer(params: {
  guildId: string;
  discordUserId: string;
  discordUserTag: string;
  stepId: string;
  textValue: string | null;
  optionIds: string[];
}): Promise<void> {
  const { guildId, discordUserId, discordUserTag, stepId, textValue, optionIds } = params;
  const answer = await db.guildOnboardingStepAnswer.upsert({
    where: { guildId_discordUserId_stepId: { guildId, discordUserId, stepId } },
    create: { guildId, discordUserId, discordUserTag, stepId, textValue },
    update: { discordUserTag, textValue },
  });
  await db.guildOnboardingStepAnswerOption.deleteMany({ where: { answerId: answer.id } });
  if (optionIds.length > 0) {
    await db.guildOnboardingStepAnswerOption.createMany({
      data: optionIds.map((optionId) => ({ answerId: answer.id, optionId })),
    });
  }
}

async function clearStepAnswer(
  guildId: string,
  discordUserId: string,
  stepId: string,
): Promise<void> {
  await db.guildOnboardingStepAnswer.deleteMany({ where: { guildId, discordUserId, stepId } });
}

export async function loadFlowGraph(guildId: string): Promise<FlowGraph> {
  const [steps, edges] = await Promise.all([
    db.guildOnboardingStep.findMany({
      where: { guildId },
      include: { options: { orderBy: { sortOrder: "asc" } }, grants: true },
    }),
    db.guildOnboardingStepEdge.findMany({
      where: { guildId },
      include: { conditionOptions: true, conditionValues: true, conditionClasses: true },
    }),
  ]);

  const flowSteps: FlowStep[] = steps.map((s) => ({
    id: s.id,
    type: s.type as StepType,
    label: s.label,
    prompt: s.prompt,
    questionType: s.questionType as QuestionType | null,
    varName: s.varName,
    varType: s.varType,
    required: s.required,
    appendList: s.appendList,
    actionType: s.actionType as ActionType | null,
    nicknameTemplate: s.nicknameTemplate,
    textTemplate: s.textTemplate,
    namesVariable: s.namesVariable,
    classesVariable: s.classesVariable,
    listVariable: s.listVariable,
    options: s.options.map((o) => ({ id: o.id, label: o.label, sortOrder: o.sortOrder })),
    grants: s.grants.map((g) => ({
      discordRoleId: g.discordRoleId,
      discordChannelId: g.discordChannelId,
      channelType: g.channelType,
    })),
  }));

  const flowEdges: FlowEdge[] = edges.map((e) => ({
    id: e.id,
    fromStepId: e.fromStepId,
    toStepId: e.toStepId,
    conditionType: e.conditionType as EdgeConditionType,
    conditionMinLevel: e.conditionMinLevel,
    conditionMaxLevel: e.conditionMaxLevel,
    conditionOptionIds: e.conditionOptions.map((c) => c.optionId),
    conditionValues: e.conditionValues.map((c) => c.value),
    conditionClasses: e.conditionClasses.map((c) => c.class),
  }));

  return buildFlowGraph(flowSteps, flowEdges);
}

// The subset of Guild fields the action executors and matchRosterAndApply
// need — same shape onboarding.ts's `guild` variable already has.
export interface FlowGuild {
  id: string;
  rosterSource: string;
  wowRegion?: string | null;
  wowRealmSlug?: string | null;
  wowGuildName?: string | null;
  wowNamespaceFlavor?: string | null;
}

// Asks one question step via the right Discord component for its
// questionType, persists the answer, and updates ctx (variables,
// answersByStep, resolvedClass). Returns null on timeout, same convention
// as askChoice/askTextModal elsewhere in this codebase.
async function askQuestionStep(
  step: FlowStep,
  cursor: FlowCursor,
  ctx: WalkContext,
  guildId: string,
  discordUserId: string,
  discordUserTag: string,
  freshEntry: boolean,
): Promise<FlowCursor | null> {
  const prompt = interpolateTemplate(step.prompt ?? "", ctx.variables, { keepUnknown: true });

  if (step.questionType === "free_text") {
    const result = await askFreeTextAnswer(cursor, prompt, step.required);
    if (result == null) return null;
    if (result.value === "") {
      await clearStepAnswer(guildId, discordUserId, step.id);
      ctx.answersByStep.set(step.id, []);
    } else {
      await persistStepAnswer({
        guildId,
        discordUserId,
        discordUserTag,
        stepId: step.id,
        textValue: result.value,
        optionIds: [],
      });
      ctx.answersByStep.set(step.id, []);
      setVariableFromAnswer(ctx, step, [result.value]);
    }
    return result.interaction;
  }

  if (step.questionType === "multi_select") {
    const result = await askMultiSelect(
      cursor,
      prompt,
      step.options.map((o) => ({ id: o.id, label: o.label })),
      step.required ? 1 : 0,
      freshEntry,
    );
    if (result == null) return null;
    if (result.values.length === 0) {
      await clearStepAnswer(guildId, discordUserId, step.id);
      ctx.answersByStep.set(step.id, []);
    } else {
      await persistStepAnswer({
        guildId,
        discordUserId,
        discordUserTag,
        stepId: step.id,
        textValue: null,
        optionIds: result.values,
      });
      ctx.answersByStep.set(step.id, result.values);
      setVariableFromAnswer(
        ctx,
        step,
        result.values.map((id) => optionLabel(step, id)),
      );
    }
    return result.interaction;
  }

  // single_select
  const choices = step.options.map((o) => ({ id: o.id, label: o.label }));
  if (!step.required) choices.push({ id: SKIP_ID, label: "Skip" });
  const result = await askChoice(cursor, prompt, choices, freshEntry);
  if (result == null) return null;
  if (result.value === SKIP_ID) {
    await clearStepAnswer(guildId, discordUserId, step.id);
    ctx.answersByStep.set(step.id, []);
  } else {
    await persistStepAnswer({
      guildId,
      discordUserId,
      discordUserTag,
      stepId: step.id,
      textValue: null,
      optionIds: [result.value],
    });
    ctx.answersByStep.set(step.id, [result.value]);
    setVariableFromAnswer(ctx, step, [optionLabel(step, result.value)]);
  }
  return result.interaction;
}

// Shared by claimAndSync (below, used by onboarding.ts's "add"/"nickname"
// shortcut-menu handlers) and the claim_characters action executor — same
// unmatched -> GuildPendingRosterMatch bookkeeping matchRosterAndApply's
// old (now-removed) finishOnboarding wrapper used to do.
async function trackPendingMatch(
  member: GuildMember,
  guildId: string,
  allNames: string[],
  includeAltsInNickname: boolean,
  matchedCount: number,
  unmatchedCount: number,
  confirmedCount: number,
  notify: (message: string) => Promise<void>,
): Promise<void> {
  if (unmatchedCount > 0) {
    await db.guildPendingRosterMatch.upsert({
      where: { guildId_discordUserId: { guildId, discordUserId: member.id } },
      create: {
        guildId,
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

    const mainName = allNames[0] ?? "";
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
      where: { guildId, discordUserId: member.id },
    });
  }
}

// Claims `characters` against the roster and applies the resulting
// nickname/roles — the same matchRosterAndApply + pending-match-tracking
// tail the old (now-removed) finishOnboarding used to run. Exported for
// onboarding.ts's "add an alt"/"change nickname" shortcut-menu handlers,
// which still claim/reapply directly rather than through a flow action.
export async function claimAndSync(
  member: GuildMember,
  guild: FlowGuild,
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
      await member.send(`**${member.guild.name}** — ${message}`).catch(() => {
        // Best-effort.
      });
    });

  if (preferredNickname != null) {
    await db.guildMemberNickname.upsert({
      where: { guildId_discordUserId: { guildId: guild.id, discordUserId: member.id } },
      create: {
        guildId: guild.id,
        discordUserId: member.id,
        discordUserTag: member.user.tag,
        // Placeholder — matchRosterAndApply below overwrites this with the
        // real computed name right after, without touching preferredNickname.
        computedName: mainName,
        preferredNickname,
      },
      update: { preferredNickname },
    });
  }

  const { matchedCount, unmatchedCount, confirmedCount } = await matchRosterAndApply(
    member,
    guild,
    characters,
    includeAltsInNickname,
    { chooseNicknameNames: options.chooseNicknameNames, notify },
  );

  await trackPendingMatch(
    member,
    guild.id,
    allNames,
    includeAltsInNickname,
    matchedCount,
    unmatchedCount,
    confirmedCount,
    notify,
  );
}

// Looks up the class/level a name resolves to in the guild's roster —
// case-insensitively, same "fetch and compare in JS" approach the rest of
// this codebase uses (SQLite has no case-insensitive query mode). Used to
// seed ctx.resolvedClass/resolvedLevel for addon-rosterSource guilds,
// which never ask class in-wizard.
async function lookupRosterClassAndLevel(
  guildId: string,
  name: string,
): Promise<{ class: string | null; level: number } | null> {
  const rows = await db.guildRosterMember.findMany({
    where: { guildId },
    select: { name: true, class: true, level: true },
  });
  const lowerName = name.toLowerCase();
  const row = rows.find((r) => r.name.toLowerCase() === lowerName);
  return row ? { class: row.class, level: row.level } : null;
}

function resolveCharacterClasses(
  step: FlowStep,
  names: string[],
  ctx: WalkContext,
): (string | null)[] {
  if (step.classesVariable) {
    const raw = ctx.variables[step.classesVariable];
    const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
    return names.map((_, i) => list[i] ?? null);
  }
  // No per-name class list — fall back to whatever simple class variable
  // was already collected (the main's "class" question, for
  // rosterSource "onboarding" guilds; see setVariableFromAnswer).
  return names.map(() => ctx.resolvedClass);
}

async function executeClaimCharacters(
  step: FlowStep,
  member: GuildMember,
  guild: FlowGuild,
  ctx: WalkContext,
  notify: (message: string) => Promise<void>,
  cursorBox: { interaction: FlowCursor },
): Promise<void> {
  if (!step.namesVariable) return;
  const raw = ctx.variables[step.namesVariable];
  const names = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  if (names.length === 0) return;

  const classes = resolveCharacterClasses(step, names, ctx);
  const characters: NamedCharacter[] = names.map((name, i) => ({
    name,
    class: classes[i] ?? null,
  }));

  const { matchedCount, unmatchedCount, confirmedCount } = await matchRosterAndApply(
    member,
    guild,
    characters,
    true,
    {
      chooseNicknameNames: (names) => askNicknameSelectionInteractive(cursorBox, names),
      notify,
      answers: ctx.answersByStep,
    },
  );

  if (ctx.resolvedClass == null || ctx.resolvedLevel == null) {
    const resolved = await lookupRosterClassAndLevel(guild.id, names[0]!);
    if (resolved) {
      ctx.resolvedClass ??= resolved.class;
      ctx.resolvedLevel ??= resolved.level;
    }
  }

  await trackPendingMatch(
    member,
    guild.id,
    names,
    true,
    matchedCount,
    unmatchedCount,
    confirmedCount,
    notify,
  );
}

async function executeSetNickname(
  step: FlowStep,
  member: GuildMember,
  guildId: string,
  ctx: WalkContext,
  notify: (message: string) => Promise<void>,
): Promise<void> {
  if (!step.nicknameTemplate) return;
  const raw = interpolateTemplate(step.nicknameTemplate, ctx.variables);
  const nickname = truncateNickname(raw);
  await db.guildMemberNickname.upsert({
    where: { guildId_discordUserId: { guildId, discordUserId: member.id } },
    create: {
      guildId,
      discordUserId: member.id,
      discordUserTag: member.user.tag,
      computedName: raw,
      preferredNickname: nickname,
    },
    update: { discordUserTag: member.user.tag, preferredNickname: nickname },
  });
  await setDiscordNickname(member, guildId, nickname, notify);
}

async function executeGrant(
  step: FlowStep,
  member: GuildMember,
  guildId: string,
  notify: (message: string) => Promise<void>,
): Promise<void> {
  const roleIds = step.grants
    .map((g) => g.discordRoleId)
    .filter((id): id is string => id != null);
  const channelGrants: ChannelGrant[] = step.grants
    .filter((g) => g.discordChannelId != null)
    .map((g) => ({
      channelId: g.discordChannelId!,
      type: g.channelType === "voice" ? "voice" : "text",
    }));

  if (roleIds.length > 0) {
    // Additive — fold in whatever "managed" roles the member already
    // holds so this grant doesn't strip roles a rule or an earlier grant
    // action already gave them (applyManagedRoles otherwise treats its
    // desiredRoleIds as the FULL target state).
    const managedRoleIds = await getManagedRoleIds(guildId);
    const currentManaged = [...member.roles.cache.keys()].filter((id) =>
      managedRoleIds.has(id),
    );
    await applyManagedRoles(member, guildId, [...new Set([...currentManaged, ...roleIds])], {
      notify,
    });
  }

  if (channelGrants.length > 0) {
    const managedChannels = await getManagedChannelGrants(guildId);
    const currentlyGranted: ChannelGrant[] = [];
    for (const [channelId, type] of managedChannels) {
      const channel =
        member.guild.channels.cache.get(channelId) ??
        (await member.guild.channels.fetch(channelId).catch(() => null));
      if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildVoice)) {
        continue;
      }
      const overwrite = channel.permissionOverwrites.cache.get(member.id);
      if (overwrite?.allow.has(PermissionFlagsBits.ViewChannel)) {
        currentlyGranted.push({ channelId, type });
      }
    }
    await applyChannelGrants(member, guildId, [...currentlyGranted, ...channelGrants], {
      notify,
    });
  }
}

async function executeDm(
  step: FlowStep,
  ctx: WalkContext,
  notify: (message: string) => Promise<void>,
): Promise<void> {
  if (!step.textTemplate) return;
  await notify(interpolateTemplate(step.textTemplate, ctx.variables));
}

async function executeActionStep(
  step: FlowStep,
  member: GuildMember,
  guild: FlowGuild,
  ctx: WalkContext,
  notify: (message: string) => Promise<void>,
  cursorBox: { interaction: FlowCursor },
): Promise<void> {
  if (step.actionType === "claim_characters") {
    await executeClaimCharacters(step, member, guild, ctx, notify, cursorBox);
  } else if (step.actionType === "set_nickname") {
    await executeSetNickname(step, member, guild.id, ctx, notify);
  } else if (step.actionType === "grant") {
    await executeGrant(step, member, guild.id, notify);
  } else if (step.actionType === "dm") {
    await executeDm(step, ctx, notify);
  }
}

// Runs the full onboarding-flow graph for `member`, starting at
// `entryInteraction`. Empty flow (no steps configured at all) sends a
// simple "not configured" notice instead of walking anything. A mid-flow
// timeout stops the walk where it is — whatever actions already ran and
// answers already given are already persisted/applied (actions execute
// incrementally as the walk reaches them), so nothing further to save.
export async function runFlow(params: {
  member: GuildMember;
  guild: FlowGuild;
  discordUserTag: string;
  entryInteraction: ModalTriggerInteraction | ChoiceInteraction;
  freshEntry?: boolean;
}): Promise<void> {
  const { member, guild, discordUserTag, entryInteraction } = params;
  const graph = await loadFlowGraph(guild.id);

  const cursorBox: { interaction: FlowCursor } = { interaction: entryInteraction };
  const notify = createNotifier(cursorBox);

  if (graph.stepsById.size === 0) {
    await notify(
      "Onboarding isn't configured for this server yet — ask an officer to set it up.",
    );
    return;
  }

  const ctx: WalkContext = {
    variables: {},
    resolvedClass: null,
    resolvedLevel: null,
    answersByStep: new Map(),
  };
  const walker = new FlowWalker(graph);
  let freshEntry = params.freshEntry ?? true;
  let result = walker.start(ctx);

  while (result.kind !== "done") {
    if (result.kind === "question") {
      const nextCursor = await askQuestionStep(
        result.step,
        cursorBox.interaction,
        ctx,
        guild.id,
        member.id,
        discordUserTag,
        freshEntry,
      );
      freshEntry = false;
      if (nextCursor == null) {
        await member
          .send(
            `**${member.guild.name}** — Heads up — you didn't respond in time, so I stopped there. Whatever you'd already answered (and any roles/nickname already set up) were saved. Run \`/onboarding\` again anytime to pick back up.`,
          )
          .catch(() => {});
        return;
      }
      cursorBox.interaction = nextCursor;
      result = walker.advance(ctx);
    } else {
      await executeActionStep(result.step, member, guild, ctx, notify, cursorBox);
      result = walker.advance(ctx);
    }
  }

  for (const loopStep of walker.takeLoopCapWarnings()) {
    await notify(
      `Reached the maximum number of entries for "${loopStep.label ?? "that step"}" (50) — stopping there. Whatever you'd already added is saved.`,
    );
  }
}
