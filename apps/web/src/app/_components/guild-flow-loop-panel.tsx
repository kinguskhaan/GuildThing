"use client";

import type { StepDraft } from "./guild-flow-editor";

export function GuildFlowLoopPanel({
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
        <h4 className="font-bold">Edit loop</h4>
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
          placeholder="Alts"
          className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-discord-text-muted text-xs">List variable</span>
        <input
          value={step.listVariable}
          onChange={(e) => onChange({ listVariable: e.target.value })}
          placeholder="alts"
          className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
        />
      </label>

      <p className="text-discord-text-muted text-xs">
        The loop&apos;s one outgoing &quot;Always&quot; wire is the body&apos;s
        start — walk through the body&apos;s steps (question steps inside it
        with &quot;Appends to list&quot; checked build this variable), then
        wire the last body step&apos;s outgoing wire back to this loop node
        for the next pass, or onward to something else to exit. Capped at 50
        iterations.
      </p>
    </div>
  );
}
