"use client";

import { WOW_CLASS_TOKENS } from "~/lib/format";
import type { EdgeDraft, QuestionDraft } from "./guild-onboarding-questions-form";

export function GuildOnboardingEdgePanel({
  edge,
  questions,
  fromQuestion,
  onChange,
  onDelete,
}: {
  edge: EdgeDraft;
  // Full question list, for the From/To pickers — lets a condition be
  // built entirely from this panel, without needing to drag a connection
  // on the canvas first.
  questions: QuestionDraft[];
  // null when the edge starts at the synthetic Start node — there's no
  // prior answer to compare against in that case.
  fromQuestion: QuestionDraft | null;
  onChange: (patch: Partial<EdgeDraft>) => void;
  onDelete: () => void;
}) {
  function changeConditionType(conditionType: EdgeDraft["conditionType"]) {
    onChange({
      conditionType,
      conditionOptionIds: conditionType === "answer_equals" ? edge.conditionOptionIds : [],
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

  function changeFrom(fromQuestionId: string | null) {
    const patch: Partial<EdgeDraft> = { fromQuestionId };
    // Start has no prior answer to compare against, so "answer includes"
    // stops making sense the moment From becomes Start.
    if (edge.conditionType === "answer_equals") {
      if (fromQuestionId == null) {
        patch.conditionType = "always";
        patch.conditionOptionIds = [];
      } else {
        const newFrom = questions.find((q) => q.id === fromQuestionId);
        patch.conditionOptionIds = edge.conditionOptionIds.filter((id) =>
          newFrom?.options.some((o) => o.id === id),
        );
      }
    }
    // A question can't lead to itself — bump To to something else if this
    // change would otherwise create a self-loop.
    if (edge.toQuestionId === fromQuestionId) {
      const fallback = questions.find((q) => q.id !== fromQuestionId);
      patch.toQuestionId = fallback?.id;
    }
    onChange(patch);
  }

  const START_VALUE = "__start__";
  // Only ever shown while a freshly-dropped condition still has this side
  // unwired — picking any real option below replaces it, so it never
  // reappears as a selectable choice once set.
  const UNWIRED_VALUE = "__unwired__";

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
          value={
            edge.fromQuestionId === undefined
              ? UNWIRED_VALUE
              : (edge.fromQuestionId ?? START_VALUE)
          }
          onChange={(e) => {
            const v = e.target.value;
            changeFrom(v === START_VALUE ? null : v);
          }}
          className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
        >
          {edge.fromQuestionId === undefined && (
            <option value={UNWIRED_VALUE} disabled>
              Not connected yet
            </option>
          )}
          <option value={START_VALUE}>Start</option>
          {questions.map((q) => (
            <option key={q.id} value={q.id}>
              {q.prompt.trim() || "(untitled question)"}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-discord-text-muted text-xs">To</span>
        <select
          value={edge.toQuestionId ?? UNWIRED_VALUE}
          onChange={(e) => onChange({ toQuestionId: e.target.value })}
          className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
        >
          {edge.toQuestionId === undefined && (
            <option value={UNWIRED_VALUE} disabled>
              Not connected yet
            </option>
          )}
          {questions
            .filter((q) => q.id !== edge.fromQuestionId)
            .map((q) => (
              <option key={q.id} value={q.id}>
                {q.prompt.trim() || "(untitled question)"}
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
          {fromQuestion && fromQuestion.type !== "free_text" && (
            <option value="answer_equals">Previous answer includes...</option>
          )}
          <option value="class_equals">Player&apos;s class is...</option>
          <option value="level_between">Player&apos;s level is between...</option>
        </select>
      </label>

      {edge.conditionType === "answer_equals" && fromQuestion && (
        <div className="flex flex-col gap-1">
          <span className="text-discord-text-muted text-xs">
            Any of these options (OR)
          </span>
          <div className="flex flex-col gap-1">
            {fromQuestion.options.map((o) => (
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
