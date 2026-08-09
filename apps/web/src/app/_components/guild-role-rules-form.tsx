"use client";

import { useEffect, useState } from "react";

import { api } from "~/trpc/react";

type Field = "rank" | "level" | "class";

interface ConditionDraft {
  field: Field;
  textValue: string;
  minNumber: string;
  maxNumber: string;
}

interface RuleDraft {
  id?: string;
  label: string;
  discordRoleIds: string[];
  grantedChannelIds: string[];
  conditions: ConditionDraft[];
}

function emptyCondition(): ConditionDraft {
  return { field: "rank", textValue: "", minNumber: "", maxNumber: "" };
}

function emptyRule(): RuleDraft {
  return {
    label: "",
    discordRoleIds: [""],
    grantedChannelIds: [],
    conditions: [emptyCondition()],
  };
}

// Falls back to a plain text input if the bot hasn't been invited to the
// server yet (or the role list is still loading) — the admin isn't blocked
// from pasting a raw ID in the meantime, just doesn't get the nicer picker.
function RoleSelect({
  value,
  onChange,
  roles,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  roles: { id: string; name: string }[] | undefined;
  placeholder: string;
}) {
  if (!roles || roles.length === 0) {
    return (
      <input
        className="flex-1 rounded-full bg-discord-base px-4 py-2 text-discord-text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Discord role ID (invite the bot to pick from a list instead)"
      />
    );
  }
  return (
    <select
      className="flex-1 rounded-full bg-discord-base px-4 py-2 text-discord-text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {roles.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </select>
  );
}

// Same fallback-to-text-input idea as RoleSelect, for picking the channel
// the bot posts admin notices to.
function ChannelSelect({
  value,
  onChange,
  channels,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  channels: { id: string; name: string }[] | undefined;
  placeholder: string;
}) {
  if (!channels || channels.length === 0) {
    return (
      <input
        className="flex-1 rounded-full bg-discord-base px-4 py-2 text-discord-text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Discord channel ID (invite the bot to pick from a list instead)"
      />
    );
  }
  return (
    <select
      className="flex-1 rounded-full bg-discord-base px-4 py-2 text-discord-text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {channels.map((c) => (
        <option key={c.id} value={c.id}>
          #{c.name}
        </option>
      ))}
    </select>
  );
}

// Like ChannelSelect, but for the role-rule "channels to grant" picker,
// which needs both text AND voice channels (grouped) since a rule can
// grant direct access to either kind.
function ChannelGrantSelect({
  value,
  onChange,
  channels,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  channels: { id: string; name: string; type: "text" | "voice" }[] | undefined;
  placeholder: string;
}) {
  if (!channels || channels.length === 0) {
    return (
      <input
        className="flex-1 rounded-full bg-discord-base px-4 py-2 text-discord-text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Discord channel ID (invite the bot to pick from a list instead)"
      />
    );
  }
  const textChannels = channels.filter((c) => c.type === "text");
  const voiceChannels = channels.filter((c) => c.type === "voice");
  return (
    <select
      className="flex-1 rounded-full bg-discord-base px-4 py-2 text-discord-text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {textChannels.length > 0 && (
        <optgroup label="Text channels">
          {textChannels.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </optgroup>
      )}
      {voiceChannels.length > 0 && (
        <optgroup label="Voice channels">
          {voiceChannels.map((c) => (
            <option key={c.id} value={c.id}>
              🔊 {c.name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

export function GuildRoleRulesForm({ guildId }: { guildId: string }) {
  const utils = api.useUtils();
  const config = api.guild.discordRoleConfig.useQuery({ guildId });
  const rankOptions = api.guild.rosterRankOptions.useQuery({ guildId });
  const classOptions = api.guild.rosterClassOptions.useQuery({ guildId });
  const discordRoles = api.guild.discordRoles.useQuery({ guildId });
  const discordChannels = api.guild.discordChannels.useQuery({ guildId });
  const discordChannelsForGrants = api.guild.discordChannelsForGrants.useQuery({ guildId });

  const [pugRoleId, setPugRoleId] = useState("");
  const [adminNotifyChannelId, setAdminNotifyChannelId] = useState("");
  const [onboardingChannelId, setOnboardingChannelId] = useState("");
  const [onboardingMessageText, setOnboardingMessageText] = useState("");
  const [rules, setRules] = useState<RuleDraft[]>([]);

  useEffect(() => {
    if (!config.data) return;
    setPugRoleId(config.data.pugRoleId ?? "");
    setAdminNotifyChannelId(config.data.adminNotifyChannelId ?? "");
    setOnboardingChannelId(config.data.onboardingChannelId ?? "");
    setOnboardingMessageText(config.data.onboardingMessageText ?? "");
    setRules(
      config.data.rules.map((r) => ({
        id: r.id,
        label: r.label ?? "",
        discordRoleIds:
          r.grantedRoles.length > 0
            ? r.grantedRoles.map((g) => g.discordRoleId)
            : [""],
        grantedChannelIds: r.grantedChannels.map((g) => g.discordChannelId),
        conditions: r.conditions.map((c) => ({
          field: c.field as Field,
          textValue: c.textValue ?? "",
          minNumber: c.minNumber != null ? String(c.minNumber) : "",
          maxNumber: c.maxNumber != null ? String(c.maxNumber) : "",
        })),
      })),
    );
  }, [config.data]);

  const setPugRole = api.guild.setPugRole.useMutation({
    onSuccess: async () => utils.guild.discordRoleConfig.invalidate({ guildId }),
  });
  const setAdminNotifyChannel = api.guild.setAdminNotifyChannel.useMutation({
    onSuccess: async () => utils.guild.discordRoleConfig.invalidate({ guildId }),
  });
  const setOnboardingChannel = api.guild.setOnboardingChannel.useMutation({
    onSuccess: async () => utils.guild.discordRoleConfig.invalidate({ guildId }),
  });
  const saveOnboardingMessageText = api.guild.setOnboardingMessageText.useMutation({
    onSuccess: async () => utils.guild.discordRoleConfig.invalidate({ guildId }),
  });
  const repostOnboardingButton = api.guild.repostOnboardingButton.useMutation();
  const requestSync = api.guild.requestSync.useMutation();
  const upsertRule = api.guild.upsertRoleRule.useMutation({
    onSuccess: async () => utils.guild.discordRoleConfig.invalidate({ guildId }),
  });
  const deleteRule = api.guild.deleteRoleRule.useMutation({
    onSuccess: async () => utils.guild.discordRoleConfig.invalidate({ guildId }),
  });

  function updateRule(index: number, patch: Partial<RuleDraft>) {
    setRules((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function updateCondition(
    ruleIndex: number,
    condIndex: number,
    patch: Partial<ConditionDraft>,
  ) {
    setRules((rs) =>
      rs.map((r, i) =>
        i === ruleIndex
          ? {
              ...r,
              conditions: r.conditions.map((c, j) =>
                j === condIndex ? { ...c, ...patch } : c,
              ),
            }
          : r,
      ),
    );
  }

  function saveRule(index: number) {
    const rule = rules[index];
    if (!rule) return;
    upsertRule.mutate({
      id: rule.id,
      guildId,
      label: rule.label.trim() === "" ? undefined : rule.label,
      discordRoleIds: rule.discordRoleIds.filter((id) => id.trim() !== ""),
      grantedChannels: rule.grantedChannelIds
        .filter((id) => id.trim() !== "")
        .map((discordChannelId) => ({
          discordChannelId,
          channelType:
            discordChannelsForGrants.data?.find((c) => c.id === discordChannelId)
              ?.type ?? "text",
        })),
      conditions: rule.conditions.map((c) =>
        c.field === "level"
          ? {
              field: "level" as const,
              operator: "between" as const,
              minNumber: Number(c.minNumber),
              maxNumber: Number(c.maxNumber),
            }
          : {
              field: c.field,
              operator: "equals" as const,
              textValue: c.textValue,
            },
      ),
    });
  }

  function removeRule(index: number) {
    const rule = rules[index];
    if (rule?.id) {
      deleteRule.mutate({ guildId, id: rule.id });
    }
    setRules((rs) => rs.filter((_, i) => i !== index));
  }

  return (
    <div className="flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-xl bg-discord-elevated p-6">
        <h3 className="font-bold">Sync now</h3>
        <p className="text-sm text-discord-text-muted">
          The bot normally re-checks roster/roles/channel access once a day.
          Trigger it right away instead — handy while debugging a rule or
          channel grant. Takes effect within about 15 seconds.
        </p>
        <button
          type="button"
          onClick={() => requestSync.mutate({ guildId })}
          disabled={requestSync.isPending}
          className="self-start rounded-full bg-discord-elevated-hover px-4 py-1.5 text-sm font-semibold"
        >
          {requestSync.isPending ? "Requesting..." : "Sync now"}
        </button>
        {requestSync.error && (
          <p className="text-sm text-discord-red">{requestSync.error.message}</p>
        )}
        {requestSync.isSuccess && (
          <p className="text-sm text-discord-green">
            Requested — should run within ~15 seconds.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2 rounded-xl bg-discord-elevated p-6">
        <h3 className="font-bold">PUG role</h3>
        <p className="text-sm text-discord-text-muted">
          Given automatically when someone tells the bot they&apos;re here
          for a PUG, not as a guild member — no rules are evaluated for them.
        </p>
        <div className="flex gap-2">
          <RoleSelect
            value={pugRoleId}
            onChange={setPugRoleId}
            roles={discordRoles.data}
            placeholder="No PUG role"
          />
          <button
            type="button"
            onClick={() =>
              setPugRole.mutate({
                guildId,
                discordRoleId: pugRoleId.trim() === "" ? null : pugRoleId,
              })
            }
            disabled={setPugRole.isPending}
            className="rounded-full bg-discord-elevated-hover px-4 text-sm font-semibold"
          >
            {setPugRole.isPending ? "Saving..." : "Save"}
          </button>
        </div>
        {setPugRole.error && (
          <p className="text-sm text-discord-red">{setPugRole.error.message}</p>
        )}
        {setPugRole.isSuccess && (
          <p className="text-sm text-discord-green">Saved!</p>
        )}
      </div>

      <div className="flex flex-col gap-2 rounded-xl bg-discord-elevated p-6">
        <h3 className="font-bold">Onboarding button channel</h3>
        <p className="text-sm text-discord-text-muted">
          The bot posts (and keeps up) a standing &quot;Start Onboarding&quot;
          button message here — a public channel like #welcome works well.
          Anyone can click it to (re-)run the onboarding DM, no need to know
          the /onboarding command. Leave unset to skip posting one.
        </p>
        <div className="flex gap-2">
          <ChannelSelect
            value={onboardingChannelId}
            onChange={setOnboardingChannelId}
            channels={discordChannels.data}
            placeholder="No onboarding button"
          />
          <button
            type="button"
            onClick={() =>
              setOnboardingChannel.mutate({
                guildId,
                discordChannelId:
                  onboardingChannelId.trim() === "" ? null : onboardingChannelId,
              })
            }
            disabled={setOnboardingChannel.isPending}
            className="rounded-full bg-discord-elevated-hover px-4 text-sm font-semibold"
          >
            {setOnboardingChannel.isPending ? "Saving..." : "Save"}
          </button>
        </div>
        {setOnboardingChannel.error && (
          <p className="text-sm text-discord-red">
            {setOnboardingChannel.error.message}
          </p>
        )}
        {setOnboardingChannel.isSuccess && (
          <p className="text-sm text-discord-green">Saved!</p>
        )}

        <textarea
          value={onboardingMessageText}
          onChange={(e) => setOnboardingMessageText(e.target.value)}
          placeholder="Click below to start (or redo) onboarding — I'll DM you a few quick questions to get your nickname and roles set up."
          rows={3}
          className="rounded-2xl bg-discord-base px-4 py-2 text-sm text-discord-text placeholder:text-discord-text-muted"
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() =>
              saveOnboardingMessageText.mutate({
                guildId,
                text: onboardingMessageText.trim() === "" ? null : onboardingMessageText,
              })
            }
            disabled={saveOnboardingMessageText.isPending}
            className="rounded-full bg-discord-elevated-hover px-4 py-1.5 text-sm font-semibold"
          >
            {saveOnboardingMessageText.isPending ? "Saving..." : "Save message text"}
          </button>
          <button
            type="button"
            onClick={() => repostOnboardingButton.mutate({ guildId })}
            disabled={repostOnboardingButton.isPending || !onboardingChannelId}
            title="If you've posted new messages above the button since it went up, this moves it back to the bottom of the channel."
            className="rounded-full bg-discord-base px-4 py-1.5 text-sm hover:bg-discord-elevated-hover"
          >
            {repostOnboardingButton.isPending ? "Moving..." : "Move to bottom of channel"}
          </button>
        </div>
        {saveOnboardingMessageText.error && (
          <p className="text-sm text-discord-red">
            {saveOnboardingMessageText.error.message}
          </p>
        )}
        {saveOnboardingMessageText.isSuccess && (
          <p className="text-sm text-discord-green">Saved!</p>
        )}
        {repostOnboardingButton.isSuccess && (
          <p className="text-sm text-discord-green">
            Done — check the channel in about a minute.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2 rounded-xl bg-discord-elevated p-6">
        <h3 className="font-bold">Admin notifications channel</h3>
        <p className="text-sm text-discord-text-muted">
          The bot posts notices here — e.g. when two different Discord
          accounts both claim to be the same roster character. Should be
          visible to officers and the bot only. Leave unset to skip posting.
        </p>
        <div className="flex gap-2">
          <ChannelSelect
            value={adminNotifyChannelId}
            onChange={setAdminNotifyChannelId}
            channels={discordChannels.data}
            placeholder="No notifications channel"
          />
          <button
            type="button"
            onClick={() =>
              setAdminNotifyChannel.mutate({
                guildId,
                discordChannelId:
                  adminNotifyChannelId.trim() === "" ? null : adminNotifyChannelId,
              })
            }
            disabled={setAdminNotifyChannel.isPending}
            className="rounded-full bg-discord-elevated-hover px-4 text-sm font-semibold"
          >
            {setAdminNotifyChannel.isPending ? "Saving..." : "Save"}
          </button>
        </div>
        {setAdminNotifyChannel.error && (
          <p className="text-sm text-discord-red">
            {setAdminNotifyChannel.error.message}
          </p>
        )}
        {setAdminNotifyChannel.isSuccess && (
          <p className="text-sm text-discord-green">Saved!</p>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <div>
          <h3 className="font-bold">Role rules</h3>
          <p className="text-sm text-discord-text-muted">
            Each rule grants its roles and/or channel access when every one
            of its conditions is met by at least one of the person&apos;s
            characters (main or an alt) — different conditions can be
            matched by different characters. Channel grants give direct
            per-member access to that channel, no role needed.
          </p>
        </div>

        {rules.map((rule, i) => (
          <div
            key={rule.id ?? `new-${i}`}
            className="flex flex-col gap-3 rounded-xl bg-discord-elevated p-6"
          >
            <div className="flex gap-2">
              <input
                className="flex-1 rounded-full bg-discord-base px-4 py-2 text-discord-text"
                value={rule.label}
                onChange={(e) => updateRule(i, { label: e.target.value })}
                placeholder="Label (optional, e.g. 'Wailing Caverns raiders')"
              />
              <button
                type="button"
                onClick={() => removeRule(i)}
                className="rounded-full bg-discord-base px-3 text-sm hover:bg-discord-elevated-hover"
              >
                ✕
              </button>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs uppercase tracking-wide text-discord-text-muted">
                Roles to grant
              </span>
              {rule.discordRoleIds.map((roleId, j) => (
                <div key={j} className="flex gap-2">
                  <RoleSelect
                    value={roleId}
                    onChange={(v) =>
                      updateRule(i, {
                        discordRoleIds: rule.discordRoleIds.map((id, k) =>
                          k === j ? v : id,
                        ),
                      })
                    }
                    roles={discordRoles.data}
                    placeholder="Select a role to grant"
                  />
                  {rule.discordRoleIds.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        updateRule(i, {
                          discordRoleIds: rule.discordRoleIds.filter(
                            (_, k) => k !== j,
                          ),
                        })
                      }
                      className="rounded-full bg-discord-base px-3 text-sm hover:bg-discord-elevated-hover"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  updateRule(i, {
                    discordRoleIds: [...rule.discordRoleIds, ""],
                  })
                }
                className="self-start rounded-full bg-discord-base px-3 py-1 text-xs hover:bg-discord-elevated-hover"
              >
                + Add role
              </button>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs uppercase tracking-wide text-discord-text-muted">
                Channels to grant direct access to (optional)
              </span>
              {rule.grantedChannelIds.map((channelId, j) => (
                <div key={j} className="flex gap-2">
                  <ChannelGrantSelect
                    value={channelId}
                    onChange={(v) =>
                      updateRule(i, {
                        grantedChannelIds: rule.grantedChannelIds.map((id, k) =>
                          k === j ? v : id,
                        ),
                      })
                    }
                    channels={discordChannelsForGrants.data}
                    placeholder="Select a channel to grant access to"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      updateRule(i, {
                        grantedChannelIds: rule.grantedChannelIds.filter(
                          (_, k) => k !== j,
                        ),
                      })
                    }
                    className="rounded-full bg-discord-base px-3 text-sm hover:bg-discord-elevated-hover"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  updateRule(i, {
                    grantedChannelIds: [...rule.grantedChannelIds, ""],
                  })
                }
                className="self-start rounded-full bg-discord-base px-3 py-1 text-xs hover:bg-discord-elevated-hover"
              >
                + Add channel
              </button>
            </div>

            <div className="flex flex-col gap-2 pl-4">
              {rule.conditions.map((cond, j) => (
                <div key={j} className="flex items-center gap-2">
                  <select
                    className="rounded-full bg-discord-base px-3 py-1.5 text-sm text-discord-text"
                    value={cond.field}
                    onChange={(e) =>
                      updateCondition(i, j, { field: e.target.value as Field })
                    }
                  >
                    <option value="rank">Rank</option>
                    <option value="level">Level</option>
                    <option value="class">Class</option>
                  </select>

                  {cond.field === "level" ? (
                    <>
                      <input
                        type="number"
                        className="w-20 rounded-full bg-discord-base px-3 py-1.5 text-sm text-discord-text"
                        value={cond.minNumber}
                        onChange={(e) =>
                          updateCondition(i, j, { minNumber: e.target.value })
                        }
                        placeholder="Min"
                      />
                      <span className="text-discord-text-muted">–</span>
                      <input
                        type="number"
                        className="w-20 rounded-full bg-discord-base px-3 py-1.5 text-sm text-discord-text"
                        value={cond.maxNumber}
                        onChange={(e) =>
                          updateCondition(i, j, { maxNumber: e.target.value })
                        }
                        placeholder="Max"
                      />
                    </>
                  ) : (
                    <input
                      list={cond.field === "rank" ? "rank-options" : "class-options"}
                      className="flex-1 rounded-full bg-discord-base px-3 py-1.5 text-sm text-discord-text"
                      value={cond.textValue}
                      onChange={(e) =>
                        updateCondition(i, j, { textValue: e.target.value })
                      }
                      placeholder={
                        cond.field === "rank"
                          ? "Exact rank name"
                          : "Exact class (e.g. WARRIOR)"
                      }
                    />
                  )}

                  {rule.conditions.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        updateRule(i, {
                          conditions: rule.conditions.filter((_, k) => k !== j),
                        })
                      }
                      className="rounded-full bg-discord-base px-2 text-xs hover:bg-discord-elevated-hover"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  updateRule(i, {
                    conditions: [...rule.conditions, emptyCondition()],
                  })
                }
                className="self-start rounded-full bg-discord-base px-3 py-1 text-xs hover:bg-discord-elevated-hover"
              >
                + Add condition
              </button>
            </div>

            <button
              type="button"
              onClick={() => saveRule(i)}
              disabled={
                upsertRule.isPending ||
                (!rule.discordRoleIds.some((id) => id.trim() !== "") &&
                  !rule.grantedChannelIds.some((id) => id.trim() !== ""))
              }
              className="self-start rounded-full bg-discord-elevated-hover px-6 py-2 text-sm font-semibold"
            >
              {upsertRule.isPending ? "Saving..." : "Save rule"}
            </button>
            {upsertRule.error && (
              <p className="text-sm text-discord-red">
                {upsertRule.error.message}
              </p>
            )}
          </div>
        ))}

        <button
          type="button"
          onClick={() => setRules((rs) => [...rs, emptyRule()])}
          className="self-start rounded-full bg-discord-elevated px-6 py-2 text-sm font-semibold transition hover:bg-discord-elevated-hover"
        >
          + Add rule
        </button>
      </div>

      <datalist id="rank-options">
        {rankOptions.data?.map((r) => <option key={r} value={r} />)}
      </datalist>
      <datalist id="class-options">
        {classOptions.data?.map((c) => <option key={c} value={c} />)}
      </datalist>
    </div>
  );
}
