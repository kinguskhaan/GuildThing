"use client";

import type { OptionDraft, QuestionDraft } from "./guild-onboarding-questions-form";

export function GuildOnboardingQuestionPanel({
  question,
  onChange,
  onDelete,
}: {
  question: QuestionDraft;
  onChange: (patch: Partial<QuestionDraft>) => void;
  onDelete: () => void;
}) {
  function updateOption(index: number, patch: Partial<OptionDraft>) {
    onChange({
      options: question.options.map((o, i) => (i === index ? { ...o, ...patch } : o)),
    });
  }

  function addOption() {
    onChange({
      options: [
        ...question.options,
        { id: crypto.randomUUID(), label: "", sortOrder: question.options.length },
      ],
    });
  }

  function removeOption(index: number) {
    onChange({ options: question.options.filter((_, i) => i !== index) });
  }

  function changeType(type: QuestionDraft["type"]) {
    if (type === "free_text") {
      onChange({ type, options: [] });
      return;
    }
    onChange({
      type,
      options:
        question.options.length >= 2
          ? question.options
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
          value={question.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
          rows={2}
          placeholder="What role do you play?"
          className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-discord-text-muted text-xs">Answer type</span>
        <select
          value={question.type}
          onChange={(e) => changeType(e.target.value as QuestionDraft["type"])}
          className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
        >
          <option value="single_select">Single choice</option>
          <option value="multi_select">Multiple choice</option>
          <option value="free_text">Free text</option>
        </select>
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={question.required}
          onChange={(e) => onChange({ required: e.target.checked })}
        />
        <span>Required</span>
      </label>
      {!question.required && (
        <p className="text-discord-text-muted text-xs">
          Shown with a Skip option — if skipped, nothing is saved for it and
          the flow moves on.
        </p>
      )}

      {question.type !== "free_text" && (
        <div className="flex flex-col gap-2">
          <span className="text-discord-text-muted text-xs">Options</span>
          {question.options.map((o, i) => (
            <div key={o.id} className="flex gap-2">
              <input
                value={o.label}
                onChange={(e) => updateOption(i, { label: e.target.value })}
                placeholder={`Option ${i + 1}`}
                className="bg-discord-base text-discord-text flex-1 rounded-lg px-2 py-1"
              />
              {question.options.length > 2 && (
                <button
                  type="button"
                  onClick={() => removeOption(i)}
                  className="bg-discord-base hover:bg-discord-elevated-hover rounded-full px-2 text-xs"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          {question.options.length < 24 && (
            <button
              type="button"
              onClick={addOption}
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
