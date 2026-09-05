"use client";

import { WOW_CLASS_TOKENS } from "~/lib/format";
import type { EdgeDraft, StepDraft } from "./guild-flow-editor";

const START_VALUE = "__start__";

export function GuildFlowEdgePanel({
  edge,
  steps,
  fromStep,
  onChange,
  onDelete,
}: {
  edge: EdgeDraft;
  // Full step list, for the From/To pickers.
  steps: StepDraft[];
  // null when the edge starts at the synthetic Start node — there's no
  // prior answer or variable to compare against in that case.
  fromStep: StepDraft | null;
  onChange: (patch: Partial<EdgeDraft>) => void;
  onDelete: () => void;
}) {
  function changeConditionType(conditionType: EdgeDraft["conditionType"]) {
    onChange({
      conditionType,
      conditionOptionIds: conditionType === "answer_equals" ? edge.conditionOptionIds : [],
      conditionValues: conditionType === "var_equals" ? edge.conditionValues : [],
      conditionClasses: conditionType === "class_equals" ? edge.conditionClasses : [],
      conditionMinLevel: conditionType === "level_between" ? edge.conditionMinLevel : undefined,
      conditionMaxLevel: conditionType === "level_between" ? edge.conditionMaxLevel : undefined,
    });
  }

  function toggleOption(optionId: string) {
    onChange({
      conditionOptionIds: edge.conditionOptionIds.includes(optionId)
        ? edge.conditionOptionIds.filter((id) => id !== optionId)
        : [...edge.conditionOptionIds, optionId],
    });
  }

  function toggleClass(cls: string) {
    onChange({
      conditionClasses: edge.conditionClasses.includes(cls)
        ? edge.conditionClasses.filter((c) => c !== cls)
        : [...edge.conditionClasses, cls],
    });
  }

  function addValue(raw: string) {
    const value = raw.trim();
    if (value === "" || edge.conditionValues.includes(value)) return;
    onChange({ conditionValues: [...edge.conditionValues, value] });
  }

  function removeValue(value: string) {
    onChange({ conditionValues: edge.conditionValues.filter((v) => v !== value) });
  }

  function changeFrom(fromStepId: string | null) {
    const patch: Partial<EdgeDraft> = { fromStepId };
    if (edge.conditionType === "answer_equals") {
      if (fromStepId == null) {
        patch.conditionType = "always";
        patch.conditionOptionIds = [];
      } else {
        const newFrom = steps.find((s) => s.id === fromStepId);
        patch.conditionOptionIds = edge.conditionOptionIds.filter((id) =>
          newFrom?.options.some((o) => o.id === id),
        );
      }
    }
    // A step can't lead to itself.
    if (edge.toStepId === fromStepId) {
      const fallback = steps.find((s) => s.id !== fromStepId);
      if (fallback) patch.toStepId = fallback.id;
    }
    onChange(patch);
  }

  return (
    <div className="bg-discord-elevated flex w-72 shrink-0 flex-col gap-3 rounded-xl p-4 text-sm">
      <div className="flex items-center justify-between">
        <h4 className="font-bold">Edit connection</h4>
        <button
          type="button"
          onClick={onDelete}
          className="text-discord-red text-xs hover:underline"
        >
          Delete
        </button>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-discord-text-muted text-xs">From</span>
        <select
          value={edge.fromStepId ?? START_VALUE}
          onChange={(e) => {
            const v = e.target.value;
            changeFrom(v === START_VALUE ? null : v);
          }}
          className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
        >
          <option value={START_VALUE}>Start</option>
          {steps.map((s) => (
            <option key={s.id} value={s.id}>
              {s.type === "question" ? s.prompt.trim() || "(untitled question)" : s.label.trim() || s.type}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-discord-text-muted text-xs">To</span>
        <select
          value={edge.toStepId}
          onChange={(e) => onChange({ toStepId: e.target.value })}
          className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
        >
          {steps
            .filter((s) => s.id !== edge.fromStepId)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.type === "question" ? s.prompt.trim() || "(untitled question)" : s.label.trim() || s.type}
              </option>
            ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-discord-text-muted text-xs">
          Only follow this connection if...
        </span>
        <select
          value={edge.conditionType}
          onChange={(e) =>
            changeConditionType(e.target.value as EdgeDraft["conditionType"])
          }
          className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
        >
          <option value="always">Always (no condition)</option>
          {fromStep?.type === "question" && fromStep.questionType !== "free_text" && (
            <option value="answer_equals">Previous answer includes...</option>
          )}
          {fromStep?.varName.trim() !== "" && (
            <option value="var_equals">Collected variable equals...</option>
          )}
          <option value="class_equals">Player&apos;s class is...</option>
          <option value="level_between">Player&apos;s level is between...</option>
        </select>
      </label>

      {edge.conditionType === "answer_equals" && fromStep && (
        <div className="flex flex-col gap-1">
          <span className="text-discord-text-muted text-xs">
            Any of these options (OR)
          </span>
          <div className="flex flex-col gap-1">
            {fromStep.options.map((o) => (
              <label key={o.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={edge.conditionOptionIds.includes(o.id)}
                  onChange={() => toggleOption(o.id)}
                />
                <span>{o.label || "(untitled)"}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {edge.conditionType === "var_equals" && (
        <div className="flex flex-col gap-1">
          <span className="text-discord-text-muted text-xs">
            Any of these values (OR, case-insensitive)
          </span>
          <div className="flex flex-wrap gap-1">
            {edge.conditionValues.map((v) => (
              <span
                key={v}
                className="bg-discord-base flex items-center gap-1 rounded-full px-2 py-1 text-xs"
              >
                {v}
                <button
                  type="button"
                  onClick={() => removeValue(v)}
                  className="text-discord-text-muted hover:text-discord-text"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
          <input
            placeholder="Type a value, press Enter"
            className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              addValue(e.currentTarget.value);
              e.currentTarget.value = "";
            }}
          />
          {fromStep && (
            <span className="text-discord-text-muted text-xs">
              Compared against {`{${fromStep.varName.trim() || "?"}}`}
              {fromStep.appendList ? " (any list element)" : ""}.
            </span>
          )}
        </div>
      )}

      {edge.conditionType === "class_equals" && (
        <div className="flex flex-col gap-1">
          <span className="text-discord-text-muted text-xs">
            Any of these classes (OR)
          </span>
          <div className="grid grid-cols-2 gap-1">
            {WOW_CLASS_TOKENS.map((c) => (
              <label key={c} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={edge.conditionClasses.includes(c)}
                  onChange={() => toggleClass(c)}
                />
                <span>{c}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {edge.conditionType === "level_between" && (
        <div className="flex flex-col gap-1">
          <span className="text-discord-text-muted text-xs">Level range</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              value={edge.conditionMinLevel ?? ""}
              onChange={(e) =>
                onChange({
                  conditionMinLevel: e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
              placeholder="Min"
              className="bg-discord-base text-discord-text w-full rounded-lg px-2 py-1"
            />
            <span className="text-discord-text-muted">–</span>
            <input
              type="number"
              min={1}
              value={edge.conditionMaxLevel ?? ""}
              onChange={(e) =>
                onChange({
                  conditionMaxLevel: e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
              placeholder="Max"
              className="bg-discord-base text-discord-text w-full rounded-lg px-2 py-1"
            />
          </div>
          <p className="text-discord-text-muted text-xs">
            Level comes from the guild&apos;s imported roster — never fires for
            guilds without an addon-imported roster, since level there is
            always 1.
          </p>
        </div>
      )}
    </div>
  );
}
