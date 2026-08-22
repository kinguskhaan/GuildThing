"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import type { QuestionDraft } from "./guild-onboarding-questions-form";

const TYPE_LABELS: Record<QuestionDraft["type"], string> = {
  single_select: "Single choice",
  multi_select: "Multiple choice",
  free_text: "Free text",
};

export function GuildOnboardingQuestionNode({ data, selected }: NodeProps) {
  const question = (data as { question: QuestionDraft }).question;

  return (
    <div
      className={`bg-discord-base min-w-[190px] max-w-[220px] rounded-xl border px-3 py-2 text-sm text-discord-text ${
        selected ? "border-discord-brand" : "border-black/20"
      }`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="truncate font-semibold">
        {question.prompt.trim() || "Untitled question"}
      </div>
      <div className="text-discord-text-muted mt-1 text-xs">
        {TYPE_LABELS[question.type]}
        {question.type !== "free_text" &&
          ` · ${question.options.length} option${question.options.length === 1 ? "" : "s"}`}
        {!question.required && " · Optional"}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

// A condition — deliberately small and pill-shaped, not sized like a
// question box, since it's just a gate on a wire ("Always" / "= Tank" /
// "Class: Mage" / "Level 10-20"), not a step someone answers. Two handles:
// drag a question (or Start) into the left one, a question out the right
// one, to wire it into the graph yourself.
export function GuildOnboardingConditionNode({ data, selected }: NodeProps) {
  const { label } = data as { label: string };
  return (
    <div
      className={`bg-discord-base max-w-[160px] truncate rounded-full border px-3 py-1 text-xs font-medium text-discord-text ${
        selected ? "border-discord-brand" : "border-black/30"
      }`}
    >
      <Handle type="target" position={Position.Left} />
      {label}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function GuildOnboardingStartNode() {
  return (
    <div className="border-discord-green text-discord-green bg-discord-base rounded-full border px-4 py-2 text-sm font-semibold">
      {/* Receives the vertical waterfall of fixed steps from above... */}
      <Handle type="target" position={Position.Top} isConnectable={false} />
      Start
      {/* ...then branches out sideways into the admin-built question graph. */}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

// Read-only stand-ins for the fixed onboarding steps that happen outside
// this admin-built graph (name/class/PUG-or-member always come from
// runOnboarding in the bot, never from here) — shown as a top-to-bottom
// waterfall so it's unambiguous these run in order, ending at Start, not
// something an admin can add, edit, connect, or delete.
export function GuildOnboardingBuiltinNode({ data }: NodeProps) {
  const { label, muted } = data as { label: string; muted?: boolean };
  return (
    <div
      className={`min-w-[170px] rounded-xl border border-dashed px-3 py-2 text-sm ${
        muted
          ? "border-transparent bg-transparent text-discord-text-muted/70 italic"
          : "border-black/30 bg-black/10 text-discord-text-muted"
      }`}
    >
      {!muted && (
        <Handle
          type="target"
          position={Position.Top}
          isConnectable={false}
          style={{ visibility: "hidden" }}
        />
      )}
      {label}
      {!muted && (
        <Handle
          type="source"
          position={Position.Bottom}
          isConnectable={false}
          style={{ visibility: "hidden" }}
        />
      )}
    </div>
  );
}
