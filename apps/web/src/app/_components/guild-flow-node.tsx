"use client";

// Canvas node components for the onboarding flow editor — one generic step
// card (badged by step type) plus the fixed Start pill. The old builtin
// waterfall nodes and the separate condition-box node are gone: the flow is
// fully admin-built now, and a "condition" is a real step node whose
// OUTGOING WIRES carry the conditions (see GuildFlowEdgePanel).

import { Handle, Position, type NodeProps } from "@xyflow/react";

import type { StepDraft } from "./guild-flow-editor";

const TYPE_KICKERS: Record<StepDraft["type"], string> = {
  question: "QUESTION",
  condition: "CONDITION",
  action: "ACTION",
  loop: "LOOP",
};

// Canvas fallback titles for non-question steps — questions show their
// prompt instead.
const TYPE_TITLES: Record<StepDraft["type"], string> = {
  question: "Question",
  condition: "Condition",
  action: "Action",
  loop: "Loop",
};

const QUESTION_TYPE_LABELS: Record<StepDraft["questionType"], string> = {
  single_select: "Single choice",
  multi_select: "Multiple choice",
  free_text: "Free text",
};

const ACTION_TYPE_LABELS: Record<StepDraft["actionType"], string> = {
  claim_characters: "Claim characters",
  set_nickname: "Set nickname",
  grant: "Set role/channel",
  dm: "Send DM",
};

// One muted line under the card title summarizing the step's config —
// alternative count for questions, the action type (and its key variable)
// for actions, the iterated list for loops.
export function stepSummary(step: StepDraft): string {
  switch (step.type) {
    case "question": {
      const bits = [QUESTION_TYPE_LABELS[step.questionType]];
      if (step.questionType !== "free_text") {
        bits.push(
          `${step.options.length} option${step.options.length === 1 ? "" : "s"}`,
        );
      }
      if (step.varName.trim() !== "") bits.push(`→ ${step.varName}`);
      if (!step.required) bits.push("optional");
      if (step.appendList) bits.push("appends to list");
      return bits.join(" · ");
    }
    case "condition":
      return "Branch — outgoing wires carry the conditions";
    case "action": {
      const bits = [ACTION_TYPE_LABELS[step.actionType]];
      if (
        step.actionType === "claim_characters" &&
        step.namesVariable.trim() !== ""
      ) {
        bits.push(`names: ${step.namesVariable}`);
      }
      if (
        step.actionType === "claim_characters" &&
        step.classesVariable.trim() !== ""
      ) {
        bits.push(`classes: ${step.classesVariable}`);
      }
      if (step.actionType === "set_nickname") {
        bits.push(step.nicknameTemplate.trim() || "no template");
      }
      return bits.join(" · ");
    }
    case "loop":
      return `Loops over ${step.listVariable.trim() || "?"}`;
  }
}

export function GuildFlowStepNode({ data, selected }: NodeProps) {
  const step = (data as { step: StepDraft }).step;
  const title =
    step.type === "question"
      ? (step.prompt.trim() || "Untitled question")
      : (step.label.trim() || TYPE_TITLES[step.type]);

  return (
    <div
      className={`bg-discord-base min-w-[200px] max-w-[240px] rounded-xl border px-3 py-2 text-sm text-discord-text ${
        selected ? "border-discord-brand" : "border-black/20"
      }`}
    >
      <Handle type="target" position={Position.Left} />
      <span className="schem-kicker text-discord-text-muted" style={{ fontSize: 10 }}>
        {TYPE_KICKERS[step.type]}
      </span>
      <div className="truncate font-semibold">{title}</div>
      <div className="text-discord-text-muted mt-1 text-xs">
        {stepSummary(step)}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function GuildFlowStartNode() {
  return (
    <div className="border-discord-green text-discord-green bg-discord-base rounded-full border px-4 py-2 text-sm font-semibold">
      {/* Flow entry point — the bot's walk starts here. Not deletable. */}
      <Handle type="target" position={Position.Top} isConnectable={false} />
      Start
      <Handle type="source" position={Position.Right} />
    </div>
  );
}