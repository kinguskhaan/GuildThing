"use client";

import { ChannelGrantSelect, RoleSelect } from "./guild-role-rules-form";
import type { GrantDraft, StepDraft } from "./guild-flow-editor";

const ACTION_TYPE_LABELS: Record<StepDraft["actionType"], string> = {
  claim_characters: "Claim characters",
  set_nickname: "Set nickname",
  grant: "Set role/channel",
  dm: "Send DM",
};

// Every varName collected anywhere in the flow — shown as insertable
// chips under a template field. Whether a given variable is actually
// collected BEFORE this action in the graph is validated server-side on
// save (saveOnboardingFlow); this list is just the convenience picker.
function collectVariables(steps: StepDraft[]): string[] {
  const names = steps
    .filter((s) => s.type === "question" && s.varName.trim() !== "")
    .map((s) => s.varName.trim());
  return [...new Set(names)];
}

function TemplateField({
  label,
  value,
  onChange,
  variables,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  variables: string[];
  placeholder: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-discord-text-muted text-xs">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        placeholder={placeholder}
        className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
      />
      {variables.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {variables.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onChange(`${value}{${v}}`)}
              className="bg-discord-base hover:bg-discord-elevated-hover rounded-full px-2 py-0.5 text-xs"
              title={`Insert {${v}}`}
            >
              {`{${v}}`}
            </button>
          ))}
        </div>
      )}
    </label>
  );
}

function emptyGrant(): GrantDraft {
  return { id: crypto.randomUUID(), discordRoleId: null, discordChannelId: null, channelType: null };
}

export function GuildFlowActionPanel({
  step,
  steps,
  discordRoles,
  channelsForGrants,
  onChange,
  onDelete,
}: {
  step: StepDraft;
  steps: StepDraft[];
  discordRoles: { id: string; name: string }[] | undefined;
  channelsForGrants: { id: string; name: string; type: "text" | "voice" }[] | undefined;
  onChange: (patch: Partial<StepDraft>) => void;
  onDelete: () => void;
}) {
  const variables = collectVariables(steps);

  function updateGrant(index: number, patch: Partial<GrantDraft>) {
    onChange({
      grants: step.grants.map((g, i) => (i === index ? { ...g, ...patch } : g)),
    });
  }

  return (
    <div className="bg-discord-elevated flex w-72 shrink-0 flex-col gap-3 rounded-xl p-4 text-sm">
      <div className="flex items-center justify-between">
        <h4 className="font-bold">Edit action</h4>
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
          placeholder={ACTION_TYPE_LABELS[step.actionType]}
          className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-discord-text-muted text-xs">Action</span>
        <select
          value={step.actionType}
          onChange={(e) =>
            onChange({ actionType: e.target.value as StepDraft["actionType"] })
          }
          className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
        >
          {Object.entries(ACTION_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      {step.actionType === "claim_characters" && (
        <label className="flex flex-col gap-1">
          <span className="text-discord-text-muted text-xs">
            Names variable
          </span>
          <input
            value={step.namesVariable}
            onChange={(e) => onChange({ namesVariable: e.target.value })}
            placeholder="main"
            className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
          />
          <span className="text-discord-text-muted text-xs">
            A single value, or a list where the first element is the main.
          </span>
        </label>
      )}

      {step.actionType === "claim_characters" && (
        <label className="flex flex-col gap-1">
          <span className="text-discord-text-muted text-xs">
            Classes variable (optional)
          </span>
          <input
            value={step.classesVariable}
            onChange={(e) => onChange({ classesVariable: e.target.value })}
            placeholder="alt_classes"
            className="bg-discord-base text-discord-text rounded-lg px-2 py-1"
          />
          <span className="text-discord-text-muted text-xs">
            Parallel list, index-aligned with the names variable — a length
            mismatch leaves that character&apos;s class unset.
          </span>
        </label>
      )}

      {step.actionType === "set_nickname" && (
        <TemplateField
          label="Nickname template"
          value={step.nicknameTemplate}
          onChange={(value) => onChange({ nicknameTemplate: value })}
          variables={variables}
          placeholder="{main}/{alts}"
        />
      )}

      {step.actionType === "dm" && (
        <TemplateField
          label="Message template"
          value={step.textTemplate}
          onChange={(value) => onChange({ textTemplate: value })}
          variables={variables}
          placeholder="Thanks {main}, you're all set!"
        />
      )}

      {step.actionType === "grant" && (
        <div className="flex flex-col gap-2">
          <span className="text-discord-text-muted text-xs">
            Roles / channels to grant
          </span>
          {step.grants.map((g, i) => (
            <div key={g.id} className="flex flex-col gap-1 rounded-lg bg-discord-base p-2">
              <div className="flex items-center gap-2">
                <select
                  value={g.discordChannelId != null ? "channel" : "role"}
                  onChange={(e) =>
                    updateGrant(i, {
                      discordRoleId: e.target.value === "role" ? "" : null,
                      discordChannelId: e.target.value === "channel" ? "" : null,
                      channelType: e.target.value === "channel" ? "text" : null,
                    })
                  }
                  className="bg-discord-elevated text-discord-text rounded-full px-2 py-1 text-xs"
                >
                  <option value="role">Role</option>
                  <option value="channel">Channel</option>
                </select>
                <button
                  type="button"
                  onClick={() =>
                    onChange({ grants: step.grants.filter((_, k) => k !== i) })
                  }
                  className="bg-discord-elevated hover:bg-discord-elevated-hover rounded-full px-2 py-1 text-xs"
                >
                  ✕
                </button>
              </div>
              {g.discordChannelId != null ? (
                <ChannelGrantSelect
                  value={g.discordChannelId}
                  onChange={(v) => {
                    const channelType =
                      channelsForGrants?.find((c) => c.id === v)?.type ?? "text";
                    updateGrant(i, { discordChannelId: v, channelType });
                  }}
                  channels={channelsForGrants}
                  placeholder="Select a channel"
                />
              ) : (
                <RoleSelect
                  value={g.discordRoleId ?? ""}
                  onChange={(v) => updateGrant(i, { discordRoleId: v })}
                  roles={discordRoles}
                  placeholder="Select a role"
                />
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => onChange({ grants: [...step.grants, emptyGrant()] })}
            className="bg-discord-base hover:bg-discord-elevated-hover self-start rounded-full px-3 py-1 text-xs"
          >
            + Add grant
          </button>
        </div>
      )}
    </div>
  );
}
