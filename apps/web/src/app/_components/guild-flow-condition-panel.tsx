"use client";

import type { StepDraft } from "./guild-flow-editor";

// A condition step has no config of its own — its OUTGOING wires carry
// the branching (see GuildFlowEdgePanel). This panel is just the canvas
// label + delete, same as the other step panels.
export function GuildFlowConditionPanel({
  step,
  onChange,
  onDelete,
}: {
  step: StepDraft;
  onChange: (patch: Partial<StepDraft>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="bg-discord-elevated flex w-72 shrink-0 flex-col gap-3 rounded-xl p-4 text-sm">
      <div className="flex items-center justify-between">
        <h4 className="font-bold">Edit condition</h4>
        <button
          type="button"
          onClick={onDelete}
          className="text-discord-red text-xs hover:underline"
        >
          Delete
        </button>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-discord-text-muted text-xs">
          Canvas label (optional)
        </span>
        <input
          value={step.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Condition"
          className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
        />
      </label>

      <p className="text-discord-text-muted text-xs">
        A condition step doesn&apos;t ask anything itself — it&apos;s a
        branch point. Click each of its outgoing wires to set what makes
        the bot follow it. It needs at least two outgoing wires to be a
        valid branch when you save.
      </p>
    </div>
  );
}
