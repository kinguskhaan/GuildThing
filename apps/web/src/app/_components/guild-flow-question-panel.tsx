"use client";

import type { StepDraft, StepOptionDraft } from "./guild-flow-editor";

export function GuildFlowQuestionPanel({
  step,
  onChange,
  onDelete,
}: {
  step: StepDraft;
  onChange: (patch: Partial<StepDraft>) => void;
  onDelete: () => void;
}) {
  function updateOption(index: number, patch: Partial<StepOptionDraft>) {
    onChange({
      options: step.options.map((o, i) => (i === index ? { ...o, ...patch } : o)),
    });
  }

  function changeType(questionType: StepDraft["questionType"]) {
    if (questionType === "free_text") {
      onChange({ questionType, options: [] });
      return;
    }
    onChange({
      questionType,
      options:
        step.options.length >= 2
          ? step.options
          : [
              { id: crypto.randomUUID(), label: "", sortOrder: 0 },
              { id: crypto.randomUUID(), label: "", sortOrder: 1 },
            ],
    });
  }

  return (
    <div className="bg-discord-elevated flex w-72 shrink-0 flex-col gap-3 rounded-xl p-4 text-sm">
      <div className="flex items-center justify-between">
        <h4 className="font-bold">Edit question</h4>
        <button
          type="button"
          onClick={onDelete}
          className="text-discord-red text-xs hover:underline"
        >
          Delete
        </button>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-discord-text-muted text-xs">Prompt</span>
        <textarea
          value={step.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
          rows={2}
          placeholder="What role do you play?"
          className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-discord-text-muted text-xs">Answer type</span>
        <select
          value={step.questionType}
          onChange={(e) =>
            changeType(e.target.value as StepDraft["questionType"])
          }
          className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
        >
          <option value="single_select">Single choice</option>
          <option value="multi_select">Multiple choice</option>
          <option value="free_text">Free text</option>
        </select>
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-discord-text-muted text-xs">Variable name</span>
          <input
            value={step.varName}
            onChange={(e) => onChange({ varName: e.target.value })}
            placeholder="main"
            className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-discord-text-muted text-xs">Variable type</span>
          <select
            value={step.varType}
            onChange={(e) =>
              onChange({ varType: e.target.value as StepDraft["varType"] })
            }
            className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
          >
            <option value="text">Text</option>
            <option value="choice">Choice</option>
            <option value="class">Class</option>
            <option value="number">Number</option>
            <option value="character">Character</option>
          </select>
        </label>
      </div>
      <p className="text-discord-text-muted text-xs">
        Lowercase letters/digits/underscore, e.g. &quot;main&quot; or
        &quot;alts&quot; — later steps reference it as{" "}
        <code>{`{${step.varName.trim() || "varname"}}`}</code>.
      </p>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={step.required}
          onChange={(e) => onChange({ required: e.target.checked })}
        />
        <span>Required</span>
      </label>
      {!step.required && (
        <p className="text-discord-text-muted text-xs">
          Shown with a Skip option — if skipped, nothing is saved for it and
          the flow moves on.
        </p>
      )}

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={step.appendList}
          onChange={(e) => onChange({ appendList: e.target.checked })}
        />
        <span>Appends to list (loop body)</span>
      </label>
      {step.appendList && (
        <p className="text-discord-text-muted text-xs">
          Each pass through a loop appends this answer onto the variable
          instead of overwriting it — use inside a loop&apos;s body.
        </p>
      )}

      {step.questionType !== "free_text" && (
        <div className="flex flex-col gap-2">
          <span className="text-discord-text-muted text-xs">Options</span>
          {step.options.map((o, i) => (
            <div key={o.id} className="flex gap-2">
              <input
                value={o.label}
                onChange={(e) => updateOption(i, { label: e.target.value })}
                placeholder={`Option ${i + 1}`}
                className="bg-discord-base text-discord-text flex-1 rounded-lg px-2 py-1"
              />
              {step.options.length > 2 && (
                <button
                  type="button"
                  onClick={() =>
                    onChange({ options: step.options.filter((_, k) => k !== i) })
                  }
                  className="bg-discord-base hover:bg-discord-elevated-hover rounded-full px-2 text-xs"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          {step.options.length < 24 && (
            <button
              type="button"
              onClick={() =>
                onChange({
                  options: [
                    ...step.options,
                    { id: crypto.randomUUID(), label: "", sortOrder: step.options.length },
                  ],
                })
              }
              className="bg-discord-base hover:bg-discord-elevated-hover self-start rounded-full px-3 py-1 text-xs"
            >
              + Add option
            </button>
          )}
        </div>
      )}
    </div>
  );
}
