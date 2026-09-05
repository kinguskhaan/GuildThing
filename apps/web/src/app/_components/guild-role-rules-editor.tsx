"use client";

import { useEffect, useMemo, useState } from "react";

import { ChannelGrantSelect, RoleSelect } from "./guild-role-rules-form";
import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";

type Config = NonNullable<RouterOutputs["guild"]["discordRoleConfig"]>;
type RuleConfig = Config["rules"][number];
type OnboardingQuestion =
  RouterOutputs["guild"]["onboardingFlow"]["onboardingQuestions"][number];

// One editable rule: server shape flattened to input state. id is
// undefined for a not-yet-saved rule — upsertRoleRule creates it.
interface RuleDraft {
  id?: string;
  label: string;
  conditions: {
    field: "rank" | "level" | "class" | "answer";
    textValue: string;
    minNumber: string;
    maxNumber: string;
    onboardingStepId: string;
    optionIds: string[];
  }[];
  roleIds: string[];
  channelIds: string[];
}

function draftFromConfig(rule: RuleConfig): RuleDraft {
  return {
    id: rule.id,
    label: rule.label ?? "",
    conditions: rule.conditions.map((c) => ({
      field: c.field as RuleDraft["conditions"][number]["field"],
      textValue: c.textValue ?? "",
      minNumber: c.minNumber != null ? String(c.minNumber) : "",
      maxNumber: c.maxNumber != null ? String(c.maxNumber) : "",
      onboardingStepId: c.onboardingStepId ?? "",
      optionIds: c.optionIds,
    })),
    roleIds: rule.grantedRoles.map((g) => g.discordRoleId),
    channelIds: rule.grantedChannels.map((g) => g.discordChannelId),
  };
}

// The rule as one readable sentence — also the chip's label.
function ruleSentence(
  draft: RuleDraft,
  roleName: (id: string) => string,
  channelName: (id: string) => string,
  onboardingQuestions: OnboardingQuestion[],
): string {
  const cond = draft.conditions[0];
  const grantNames = draft.roleIds
    .filter((id) => id !== "")
    .map((id) => `@${roleName(id)}`);
  const channelNames = draft.channelIds
    .filter((id) => id !== "")
    .map((id) => `#${channelName(id)}`);
  const grants = [...grantNames, ...channelNames];
  const grantText =
    grants.length > 0 ? grants.join(" + ") : "nothing granted yet";
  let condText: string;
  if (!cond) {
    condText = "every member";
  } else if (cond.field === "level") {
    condText = `members at level ${cond.minNumber || "?"}–${cond.maxNumber || "?"}`;
  } else if (cond.field === "class") {
    condText = `members whose class is ${cond.textValue || "?"}`;
  } else if (cond.field === "answer") {
    const question = onboardingQuestions.find((q) => q.id === cond.onboardingStepId);
    const labels = cond.optionIds
      .map((id) => question?.options.find((o) => o.id === id)?.label)
      .filter((label): label is string => !!label);
    condText = `members who answered "${question?.prompt ?? "?"}" with ${
      labels.length > 0 ? labels.join(", ") : "?"
    }`;
  } else {
    condText = `members with rank ${cond.textValue || "?"}`;
  }
  return `${condText} get ${grantText}`;
}

export function GuildRoleRulesEditor({
  guildId,
  roles,
  channels,
}: {
  guildId: string;
  roles: { id: string; name: string }[] | undefined;
  channels: { id: string; name: string }[] | undefined;
}) {
  const utils = api.useUtils();
  const invalidate = () => void utils.guild.discordRoleConfig.invalidate({ guildId });

  const config = api.guild.discordRoleConfig.useQuery({ guildId });
  const flow = api.guild.onboardingFlow.useQuery({ guildId });
  const channelsForGrants = api.guild.discordChannelsForGrants.useQuery({
    guildId,
  });
  const rankOptions = api.guild.rosterRankOptions.useQuery({ guildId });
  const classOptions = api.guild.rosterClassOptions.useQuery({ guildId });
  const onboardingQuestions = flow.data?.onboardingQuestions ?? [];

  const roleName = (id: string) =>
    roles?.find((r) => r.id === id)?.name ?? "unknown role";
  const channelName = (id: string) =>
    channels?.find((c) => c.id === id)?.name ?? "unknown channel";

  const [drafts, setDrafts] = useState<RuleDraft[]>([]);
  const [selectedRuleIndex, setSelectedRuleIndex] = useState<number | null>(
    null,
  );
  const [hasAutoSelected, setHasAutoSelected] = useState(false);
  const [justSavedIndex, setJustSavedIndex] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!config.data) return;
    setDrafts(config.data.rules.map(draftFromConfig));
    if (!hasAutoSelected) {
      setHasAutoSelected(true);
      if (config.data.rules.length > 0) setSelectedRuleIndex(0);
    }
  }, [config.data, hasAutoSelected]);

  const selectedDraft =
    selectedRuleIndex != null ? drafts[selectedRuleIndex] : undefined;

  const upsertRule = api.guild.upsertRoleRule.useMutation({
    onSuccess: () => {
      setJustSavedIndex(selectedRuleIndex);
      invalidate();
    },
  });
  const deleteRule = api.guild.deleteRoleRule.useMutation({
    onSuccess: invalidate,
  });

  function updateDraft(index: number, patch: Partial<RuleDraft>) {
    setDrafts((ds) => ds.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }

  function updateCondition(
    index: number,
    condIndex: number,
    patch: Partial<RuleDraft["conditions"][number]>,
  ) {
    setDrafts((ds) =>
      ds.map((d, i) =>
        i === index
          ? {
              ...d,
              conditions: d.conditions.map((c, k) =>
                k === condIndex ? { ...c, ...patch } : c,
              ),
            }
          : d,
      ),
    );
  }

  function saveDraft(index: number) {
    const draft = drafts[index];
    if (!draft) return;
    upsertRule.mutate(
      {
        id: draft.id,
        guildId,
        label: draft.label.trim() === "" ? undefined : draft.label,
        discordRoleIds: draft.roleIds.filter((id) => id !== ""),
        grantedChannels: draft.channelIds
          .filter((id) => id !== "")
          .map((discordChannelId) => ({
            discordChannelId,
            channelType:
              channelsForGrants.data?.find((c) => c.id === discordChannelId)
                ?.type ?? "text",
          })),
        conditions: draft.conditions.map((c) =>
          c.field === "level"
            ? {
                field: "level" as const,
                operator: "between" as const,
                minNumber: Number(c.minNumber || 0),
                maxNumber: Number(c.maxNumber || 0),
              }
            : c.field === "answer"
              ? {
                  field: "answer" as const,
                  operator: "includes" as const,
                  onboardingStepId: c.onboardingStepId,
                  optionIds: c.optionIds,
                }
              : {
                  field: c.field,
                  operator: "equals" as const,
                  textValue: c.textValue,
                },
        ),
      },
      { onSuccess: invalidate },
    );
  }

  function removeDraft(index: number) {
    const draft = drafts[index];
    if (draft?.id) deleteRule.mutate({ guildId, id: draft.id });
    setDrafts((ds) => ds.filter((_, i) => i !== index));
    setSelectedRuleIndex((cur) =>
      cur === null ? null : cur === index ? null : cur > index ? cur - 1 : cur,
    );
    setJustSavedIndex((cur) =>
      cur === null || cur === index ? null : cur > index ? cur - 1 : cur,
    );
  }

  function addDraftRule() {
    setDrafts((ds) => [
      ...ds,
      {
        label: "",
        conditions: [
          {
            field: "rank",
            textValue: "",
            minNumber: "",
            maxNumber: "",
            onboardingStepId: "",
            optionIds: [],
          },
        ],
        roleIds: [""],
        channelIds: [],
      },
    ]);
    setSelectedRuleIndex(drafts.length);
    setJustSavedIndex(null);
  }

  const [deleteArm, setDeleteArm] = useState(false);
  useEffect(() => {
    setDeleteArm(false);
  }, [selectedRuleIndex]);

  // Unsaved rule drafts: compare each draft against the server's rule. A
  // draft counts as saved when it maps back to exactly the stored rule.
  const unsavedIndexes = useMemo(() => {
    const saved = (config.data?.rules ?? []).map(draftFromConfig);
    return drafts
      .map((d, i) => {
        if (!d.id) return i;
        const server = saved.find((r) => r.id === d.id);
        if (!server) return i;
        return JSON.stringify(d) === JSON.stringify(server) ? -1 : i;
      })
      .filter((i) => i !== -1);
  }, [drafts, config.data]);

  useEffect(() => {
    if (unsavedIndexes.length === 0) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [unsavedIndexes.length]);

  return (
    <div className="bg-discord-elevated flex flex-col gap-4 rounded-xl p-6">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="flex items-center justify-between text-left"
      >
        <div>
          <h3 className="font-bold">Role rules</h3>
          <p className="text-discord-text-muted mt-1 text-sm">
            Each rule grants a Discord role, direct channel access, or both,
            when every condition matches at least one of the person&apos;s
            characters — or their onboarding answers. A rule needs a role
            grant, a channel grant, or both.
          </p>
        </div>
        <span aria-hidden="true" className="text-discord-text-muted">
          {collapsed ? "▸" : "▾"}
        </span>
      </button>
      {!collapsed && (
        <>
          {/* sentence chips */}
          <div className="flex flex-wrap gap-2">
            {drafts.map((d, i) => (
              <button
                key={d.id ?? `draft-${i}`}
                type="button"
                onClick={() => setSelectedRuleIndex(i)}
                className={`schem-mono schem-chip text-xs ${
                  i === selectedRuleIndex ? "schem-chip-hot" : ""
                }`}
              >
                <span
                  className="schem-kicker"
                  style={{ fontSize: 12, marginRight: 8 }}
                >
                  R{i + 1}
                  {unsavedIndexes.includes(i) ? " · unsaved" : ""}
                </span>
                {ruleSentence(d, roleName, channelName, onboardingQuestions)}
              </button>
            ))}
            <button
              type="button"
              onClick={addDraftRule}
              className="bg-discord-base hover:bg-discord-elevated-hover rounded-lg px-3 py-2 text-xs font-semibold"
            >
              + Add rule
            </button>
          </div>

          {/* editor */}
          {selectedRuleIndex != null && selectedDraft && (
            <div className="flex flex-col gap-4 rounded-lg bg-discord-base p-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="schem-kicker">{`R${selectedRuleIndex + 1}`}</span>
                <input
                  className="bg-discord-elevated text-discord-text min-w-64 flex-1 rounded-full px-4 py-2 text-sm"
                  value={selectedDraft.label}
                  onChange={(e) =>
                    updateDraft(selectedRuleIndex, { label: e.target.value })
                  }
                  placeholder="Label (optional, e.g. 'Wailing Caverns raiders')"
                />
                <button
                  type="button"
                  onClick={() =>
                    deleteArm
                      ? removeDraft(selectedRuleIndex)
                      : setDeleteArm(true)
                  }
                  onBlur={() => setDeleteArm(false)}
                  className={`rounded-full px-4 py-1.5 text-sm font-semibold ${
                    deleteArm
                      ? "bg-discord-red-hover text-white"
                      : "bg-discord-red hover:bg-discord-red-hover text-white"
                  }`}
                >
                  {deleteArm ? "Confirm delete?" : "Delete rule"}
                </button>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <span className="schem-kicker">Conditions (all must match)</span>
                  {selectedDraft.conditions.map((cond, j) => (
                    <div key={j} className="flex flex-col gap-2 rounded-lg bg-discord-elevated p-2">
                      <div className="flex items-center gap-2">
                        <select
                          className="bg-discord-base text-discord-text rounded-full px-3 py-1.5 text-sm"
                          value={cond.field}
                          onChange={(e) =>
                            updateCondition(selectedRuleIndex, j, {
                              field: e.target.value as RuleDraft["conditions"][number]["field"],
                              onboardingStepId:
                                e.target.value === "answer"
                                  ? (onboardingQuestions[0]?.id ?? "")
                                  : cond.onboardingStepId,
                              optionIds: e.target.value === "answer" ? [] : cond.optionIds,
                            })
                          }
                          aria-label="Condition field"
                        >
                          <option value="rank">Rank</option>
                          <option value="level">Level</option>
                          <option value="class">Class</option>
                          <option value="answer">Onboarding answer</option>
                        </select>
                        {cond.field === "level" ? (
                          <>
                            <input
                              type="number"
                              className="bg-discord-base text-discord-text w-20 rounded-full px-3 py-1.5 text-sm"
                              value={cond.minNumber}
                              onChange={(e) =>
                                updateCondition(selectedRuleIndex, j, {
                                  minNumber: e.target.value,
                                })
                              }
                              placeholder="Min"
                            />
                            <span className="text-discord-text-muted">–</span>
                            <input
                              type="number"
                              className="bg-discord-base text-discord-text w-20 rounded-full px-3 py-1.5 text-sm"
                              value={cond.maxNumber}
                              onChange={(e) =>
                                updateCondition(selectedRuleIndex, j, {
                                  maxNumber: e.target.value,
                                })
                              }
                              placeholder="Max"
                            />
                          </>
                        ) : cond.field === "answer" ? (
                          <select
                            className="bg-discord-base text-discord-text min-w-0 flex-1 rounded-full px-3 py-1.5 text-sm"
                            value={cond.onboardingStepId}
                            onChange={(e) =>
                              updateCondition(selectedRuleIndex, j, {
                                onboardingStepId: e.target.value,
                                optionIds: [],
                              })
                            }
                          >
                            {onboardingQuestions.length === 0 && (
                              <option value="">No onboarding questions yet</option>
                            )}
                            {onboardingQuestions.map((q) => (
                              <option key={q.id} value={q.id}>
                                {q.prompt.trim() || "(untitled question)"}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            list={
                              cond.field === "rank" ? "rank-options" : "class-options"
                            }
                            className="bg-discord-base text-discord-text min-w-0 flex-1 rounded-full px-3 py-1.5 text-sm"
                            value={cond.textValue}
                            onChange={(e) =>
                              updateCondition(selectedRuleIndex, j, {
                                textValue: e.target.value,
                              })
                            }
                            placeholder={
                              cond.field === "rank"
                                ? "Exact rank name"
                                : "Exact class (e.g. WARRIOR)"
                            }
                          />
                        )}
                        {selectedDraft.conditions.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              updateDraft(selectedRuleIndex, {
                                conditions: selectedDraft.conditions.filter(
                                  (_, k) => k !== j,
                                ),
                              })
                            }
                            className="bg-discord-base hover:bg-discord-elevated-hover rounded-full px-3 py-1.5 text-sm"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                      {cond.field === "answer" && (
                        <div className="flex flex-wrap gap-2 pl-1">
                          {(onboardingQuestions.find((q) => q.id === cond.onboardingStepId)?.options ?? []).map((o) => (
                            <label key={o.id} className="flex items-center gap-1.5 text-xs">
                              <input
                                type="checkbox"
                                checked={cond.optionIds.includes(o.id)}
                                onChange={() =>
                                  updateCondition(selectedRuleIndex, j, {
                                    optionIds: cond.optionIds.includes(o.id)
                                      ? cond.optionIds.filter((id) => id !== o.id)
                                      : [...cond.optionIds, o.id],
                                  })
                                }
                              />
                              {o.label || "(untitled)"}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() =>
                      updateDraft(selectedRuleIndex, {
                        conditions: [
                          ...selectedDraft.conditions,
                          {
                            field: "rank",
                            textValue: "",
                            minNumber: "",
                            maxNumber: "",
                            onboardingStepId: "",
                            optionIds: [],
                          },
                        ],
                      })
                    }
                    className="bg-discord-elevated hover:bg-discord-elevated-hover self-start rounded-full px-3 py-1 text-xs"
                  >
                    + Add condition
                  </button>
                </div>

                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <span className="schem-kicker">Roles to grant (optional)</span>
                    {selectedDraft.roleIds.map((roleId, j) => (
                      <div key={j} className="flex gap-2">
                        <RoleSelect
                          value={roleId}
                          onChange={(v) =>
                            updateDraft(selectedRuleIndex, {
                              roleIds: selectedDraft.roleIds.map((id, k) =>
                                k === j ? v : id,
                              ),
                            })
                          }
                          roles={roles}
                          placeholder="Select a role to grant"
                        />
                        {selectedDraft.roleIds.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              updateDraft(selectedRuleIndex, {
                                roleIds: selectedDraft.roleIds.filter(
                                  (_, k) => k !== j,
                                ),
                              })
                            }
                            className="bg-discord-elevated hover:bg-discord-elevated-hover rounded-full px-3 text-sm"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        updateDraft(selectedRuleIndex, {
                          roleIds: [...selectedDraft.roleIds, ""],
                        })
                      }
                      className="bg-discord-elevated hover:bg-discord-elevated-hover self-start rounded-full px-3 py-1 text-xs"
                    >
                      + Add role
                    </button>
                  </div>

                  <div className="flex flex-col gap-2">
                    <span className="schem-kicker">
                      Channels to grant direct access to (optional)
                    </span>
                    {selectedDraft.channelIds.map((channelId, j) => (
                      <div key={j} className="flex gap-2">
                        <ChannelGrantSelect
                          value={channelId}
                          onChange={(v) =>
                            updateDraft(selectedRuleIndex, {
                              channelIds: selectedDraft.channelIds.map(
                                (id, k) => (k === j ? v : id),
                              ),
                            })
                          }
                          channels={channelsForGrants.data}
                          placeholder="Select a channel to grant access to"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            updateDraft(selectedRuleIndex, {
                              channelIds: selectedDraft.channelIds.filter(
                                (_, k) => k !== j,
                              ),
                            })
                          }
                          className="bg-discord-elevated hover:bg-discord-elevated-hover rounded-full px-3 text-sm"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        updateDraft(selectedRuleIndex, {
                          channelIds: [...selectedDraft.channelIds, ""],
                        })
                      }
                      className="bg-discord-elevated hover:bg-discord-elevated-hover self-start rounded-full px-3 py-1 text-xs"
                    >
                      + Add channel
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => saveDraft(selectedRuleIndex)}
                  disabled={
                    upsertRule.isPending ||
                    (!selectedDraft.roleIds.some((id) => id !== "") &&
                      !selectedDraft.channelIds.some((id) => id !== ""))
                  }
                  className="bg-discord-brand rounded-full px-6 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {upsertRule.isPending ? "Saving…" : "Save rule"}
                </button>
                {upsertRule.error && (
                  <p className="text-discord-red text-sm">
                    {upsertRule.error.message}
                  </p>
                )}
                {justSavedIndex === selectedRuleIndex && upsertRule.isSuccess && (
                  <p className="text-discord-green text-sm">Saved!</p>
                )}
              </div>
            </div>
          )}
          {selectedRuleIndex == null && (
            <p className="text-discord-text-muted text-sm">
              No rules yet — add one, or pick a chip above to edit it.
            </p>
          )}

          <datalist id="rank-options">
            {rankOptions.data?.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
          <datalist id="class-options">
            {classOptions.data?.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </>
      )}
    </div>
  );
}
