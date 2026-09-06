"use client";

// Canvas node components for the onboarding flow workspace — one generic
// step card (badged by step type, quick-add "+" underneath) plus the fixed
// Start pill and the selectable "End flow" dead-end marker. Positions come
// from an auto-layout pass (see layout in guild-flow-editor.tsx), never
// from stored coordinates or manual dragging — a "condition" is a real
// step node whose OUTGOING connections carry the conditions (see
// GuildFlowEdgePanel).

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useState } from "react";

import type { StepDraft } from "./guild-flow-editor";

const TYPE_KICKERS: Record<StepDraft["type"], string> = {
  question: "QUESTION",
  condition: "BRANCH",
  action: "ACTION",
  loop: "LOOP",
};

// Canvas fallback titles for non-question steps — questions show their
// prompt instead.
const TYPE_TITLES: Record<StepDraft["type"], string> = {
  question: "Question",
  condition: "Branch",
  action: "Action",
  loop: "Loop",
};

// The step palette, shared by the toolbar chips, the rail's Add step
// grid and the nodes' quick-add "+" menu — one list, one vocabulary.
export const NEW_STEP_TYPES: { value: StepDraft["type"]; label: string }[] = [
  { value: "question", label: "Question" },
  { value: "condition", label: "Branch" },
  { value: "action", label: "Action" },
  { value: "loop", label: "Loop" },
];

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

// The title shown on a step's card and in From/To pickers — questions show
// their prompt, other types fall back to their label or generic type name.
export function titleFor(step: StepDraft): string {
  if (step.type === "question") return step.prompt.trim() || "Untitled question";
  return step.label.trim() || TYPE_TITLES[step.type];
}

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
      return "Branch — outgoing connections carry the conditions";
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

export function GuildFlowStepNode({
  data,
  selected,
}: NodeProps) {
  const { step, hovered, onQuickAdd } = data as {
    step: StepDraft;
    hovered?: boolean;
    onQuickAdd?: (type: StepDraft["type"]) => void;
  };
  const title = titleFor(step);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      className={`group/node relative bg-discord-elevated w-56 rounded-xl border px-3 py-2.5 text-sm text-discord-text transition-shadow ${
        selected
          ? "border-discord-brand shadow-[0_0_0_1px_#5865f2,0_4px_16px_rgba(88,101,242,0.25)]"
          : hovered
            ? "border-[color:var(--schem-line)] shadow-[0_0_12px_rgba(159,212,245,0.3)]"
            : "border-black/20"
      }`}
    >
      <Handle type="target" position={Position.Top} />
      <span className="schem-kicker text-[10px] text-discord-text-muted">
        {TYPE_KICKERS[step.type]}
      </span>
      <div className="mt-0.5 line-clamp-2 leading-snug font-semibold">{title}</div>
      <div className="text-discord-text-muted mt-1 line-clamp-1 text-xs">
        {stepSummary(step)}
      </div>
      <Handle type="source" position={Position.Bottom} />

      {/* Quick-add: the next step, one click from the node it follows —
          the same append a palette drop onto this node performs. */}
      {onQuickAdd && (
        <div className="pointer-events-none absolute top-full left-1/2 z-10 -translate-x-1/2 pt-3">
          {menuOpen ? (
            <div
              className="bg-discord-elevated pointer-events-auto flex w-32 flex-col gap-0.5 rounded-lg border border-black/20 p-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
              onMouseLeave={() => setMenuOpen(false)}
            >
              {NEW_STEP_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onQuickAdd(t.value);
                  }}
                  className="hover:bg-discord-elevated-hover rounded-md px-2 py-1 text-left text-xs font-semibold"
                >
                  + {t.label}
                </button>
              ))}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              className="bg-discord-elevated text-discord-text-muted hover:text-discord-text hover:border-[color:var(--schem-line)] pointer-events-auto invisible flex h-6 w-6 items-center justify-center rounded-full border border-black/20 text-sm font-bold group-hover/node:visible hover:visible"
              aria-label="Next step"
            >
              +
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function GuildFlowStartNode() {
  return (
    <div className="border-[color:var(--schem-green)] text-[color:var(--schem-green)] bg-discord-elevated rounded-full border px-4 py-1.5 text-sm font-semibold shadow-[0_0_10px_rgba(35,165,90,0.25)]">
      Start
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

// A dead-end marker for a question option nothing wires up (e.g. a bare
// "No" answer). Selectable: the inspector's morph panel converts it into a
// real step wired where the stub was (see convertStub in the editor).
export function GuildFlowEndNode({ data, selected }: NodeProps) {
  const { label } = data as { label?: string };
  return (
    <div
      className={`bg-discord-base cursor-pointer rounded-full border border-dashed px-3 py-1.5 text-xs font-semibold transition ${
        selected
          ? "border-[color:var(--schem-line)] text-[color:var(--schem-line)] shadow-[0_0_10px_rgba(159,212,245,0.3)]"
          : "border-discord-text-muted/40 text-discord-text-muted hover:border-[color:var(--schem-line)] hover:text-[color:var(--schem-line)]"
      }`}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      {label ? `${label} → End flow` : "End flow"}
    </div>
  );
}
