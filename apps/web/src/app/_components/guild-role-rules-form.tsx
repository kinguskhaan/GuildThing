"use client";

import { useEffect, useState } from "react";

import { api } from "~/trpc/react";

type Tab = "general" | "onboarding" | "rules" | "inactivity";

const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "onboarding", label: "Onboarding" },
  { id: "rules", label: "Role rules" },
  { id: "inactivity", label: "Inactivity" },
];

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
    discordRoleIds: [],
    grantedChannelIds: [],
    conditions: [emptyCondition()],
  };
}

// One-line "what does this rule actually do" for the rules list, so an
// admin can tell rules apart without opening each one.
function ruleSummary(rule: RuleDraft): string {
  const roleCount = rule.discordRoleIds.filter((id) => id.trim() !== "").length;
  const channelCount = rule.grantedChannelIds.filter(
    (id) => id.trim() !== "",
  ).length;
  const grants: string[] = [];
  if (roleCount > 0)
    grants.push(`${roleCount} role${roleCount === 1 ? "" : "s"}`);
  if (channelCount > 0) {
    grants.push(`${channelCount} channel${channelCount === 1 ? "" : "s"}`);
  }
  const conditionCount = rule.conditions.length;
  return `${conditionCount} condition${conditionCount === 1 ? "" : "s"} → ${
    grants.length > 0 ? grants.join(", ") : "nothing yet"
  }`;
}

// Falls back to a plain text input if the bot hasn't been invited to the
// server yet (or the role list is still loading) — the admin isn't blocked
// from pasting a raw ID in the meantime, just doesn't get the nicer picker.
function RoleSelect({
  value,
  onChange,
  roles,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  roles: { id: string; name: string }[] | undefined;
  placeholder: string;
  disabled?: boolean;
}) {
  if (!roles || roles.length === 0) {
    return (
      <input
        className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2 disabled:opacity-50"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Discord role ID (invite the bot to pick from a list instead)"
        disabled={disabled}
      />
    );
  }
  return (
    <select
      className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2 disabled:opacity-50"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
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
        className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Discord channel ID (invite the bot to pick from a list instead)"
      />
    );
  }
  return (
    <select
      className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2"
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
        className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2"
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
      className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2"
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
  const [activeTab, setActiveTab] = useState<Tab>("general");
  const utils = api.useUtils();
  const config = api.guild.discordRoleConfig.useQuery({ guildId });
  const rankOptions = api.guild.rosterRankOptions.useQuery({ guildId });
  const classOptions = api.guild.rosterClassOptions.useQuery({ guildId });
  const discordRoles = api.guild.discordRoles.useQuery({ guildId });
  const discordChannels = api.guild.discordChannels.useQuery({ guildId });
  const discordChannelsForGrants = api.guild.discordChannelsForGrants.useQuery({
    guildId,
  });

  const [rosterSource, setRosterSource] = useState<"addon" | "onboarding">(
    "addon",
  );
  const [wowRegion, setWowRegion] = useState("");
  const [wowRealmSlug, setWowRealmSlug] = useState("");
  const [wowGuildName, setWowGuildName] = useState("");
  const [wowNamespaceFlavor, setWowNamespaceFlavor] = useState("classicann");
  const [pugEnabled, setPugEnabled] = useState(true);
  const [pugRoleId, setPugRoleId] = useState("");
  const [adminNotifyChannelId, setAdminNotifyChannelId] = useState("");
  const [onboardingChannelId, setOnboardingChannelId] = useState("");
  const [onboardingMessageText, setOnboardingMessageText] = useState("");
  const [inactivityEnabled, setInactivityEnabled] = useState(false);
  const [inactivityDays, setInactivityDays] = useState("");
  const [inactivityTargetRoleIds, setInactivityTargetRoleIds] = useState<
    string[]
  >([""]);
  const [inactivityRoleId, setInactivityRoleId] = useState("");
  const [rules, setRules] = useState<RuleDraft[]>([]);
  // Index of the rule shown in the right-hand editor pane; null = none
  // selected (empty rule list, or not loaded yet).
  const [selectedRuleIndex, setSelectedRuleIndex] = useState<number | null>(
    null,
  );
  // Only auto-select the first rule on the initial load, so a later
  // refetch (e.g. after saving) doesn't yank the admin back to rule 0.
  const [hasAutoSelected, setHasAutoSelected] = useState(false);

  useEffect(() => {
    if (!config.data) return;
    setRosterSource(
      config.data.rosterSource === "onboarding" ? "onboarding" : "addon",
    );
    setPugEnabled(config.data.pugEnabled);
    setPugRoleId(config.data.pugRoleId ?? "");
    setAdminNotifyChannelId(config.data.adminNotifyChannelId ?? "");
    setOnboardingChannelId(config.data.onboardingChannelId ?? "");
    setOnboardingMessageText(config.data.onboardingMessageText ?? "");
    setInactivityEnabled(config.data.inactivityFilterEnabled);
    setInactivityDays(
      config.data.inactivityDays != null
        ? String(config.data.inactivityDays)
        : "",
    );
    setInactivityTargetRoleIds(
      config.data.inactivityTargetRoleIds.length > 0
        ? config.data.inactivityTargetRoleIds
        : [""],
    );
    setInactivityRoleId(config.data.inactivityRoleId ?? "");
    setWowRegion(config.data.wowRegion ?? "");
    setWowRealmSlug(config.data.wowRealmSlug ?? "");
    setWowGuildName(config.data.wowGuildName ?? "");
    setWowNamespaceFlavor(config.data.wowNamespaceFlavor ?? "classicann");
    setRules(
      config.data.rules.map((r) => ({
        id: r.id,
        label: r.label ?? "",
        discordRoleIds: r.grantedRoles.map((g) => g.discordRoleId),
        grantedChannelIds: r.grantedChannels.map((g) => g.discordChannelId),
        conditions: r.conditions.map((c) => ({
          field: c.field as Field,
          textValue: c.textValue ?? "",
          minNumber: c.minNumber != null ? String(c.minNumber) : "",
          maxNumber: c.maxNumber != null ? String(c.maxNumber) : "",
        })),
      })),
    );
    if (!hasAutoSelected) {
      setHasAutoSelected(true);
      if (config.data.rules.length > 0) setSelectedRuleIndex(0);
    }
  }, [config.data, hasAutoSelected]);

  const saveRosterSource = api.guild.setRosterSource.useMutation({
    onSuccess: async () =>
      utils.guild.discordRoleConfig.invalidate({ guildId }),
  });
  const setPugRole = api.guild.setPugRole.useMutation({
    onSuccess: async () =>
      utils.guild.discordRoleConfig.invalidate({ guildId }),
  });
  const saveArmoryConfig = api.guild.setArmoryConfig.useMutation({
    onSuccess: async () =>
      utils.guild.discordRoleConfig.invalidate({ guildId }),
  });
  const setAdminNotifyChannel = api.guild.setAdminNotifyChannel.useMutation({
    onSuccess: async () =>
      utils.guild.discordRoleConfig.invalidate({ guildId }),
  });
  const setOnboardingChannel = api.guild.setOnboardingChannel.useMutation({
    onSuccess: async () =>
      utils.guild.discordRoleConfig.invalidate({ guildId }),
  });
  const saveOnboardingMessageText =
    api.guild.setOnboardingMessageText.useMutation({
      onSuccess: async () =>
        utils.guild.discordRoleConfig.invalidate({ guildId }),
    });
  const repostOnboardingButton = api.guild.repostOnboardingButton.useMutation();
  const requestSync = api.guild.requestSync.useMutation();
  const saveInactivitySettings = api.guild.setInactivitySettings.useMutation({
    onSuccess: async () =>
      utils.guild.discordRoleConfig.invalidate({ guildId }),
  });
  const upsertRule = api.guild.upsertRoleRule.useMutation({
    onSuccess: async () =>
      utils.guild.discordRoleConfig.invalidate({ guildId }),
  });
  const deleteRule = api.guild.deleteRoleRule.useMutation({
    onSuccess: async () =>
      utils.guild.discordRoleConfig.invalidate({ guildId }),
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

  // Tracks which rule the "Saved!" confirmation belongs to, since
  // upsertRule is one shared mutation for every rule's save button.
  const [justSavedIndex, setJustSavedIndex] = useState<number | null>(null);

  function saveRule(index: number) {
    const rule = rules[index];
    if (!rule) return;
    upsertRule.mutate(
      {
        id: rule.id,
        guildId,
        label: rule.label.trim() === "" ? undefined : rule.label,
        discordRoleIds: rule.discordRoleIds.filter((id) => id.trim() !== ""),
        grantedChannels: rule.grantedChannelIds
          .filter((id) => id.trim() !== "")
          .map((discordChannelId) => ({
            discordChannelId,
            channelType:
              discordChannelsForGrants.data?.find(
                (c) => c.id === discordChannelId,
              )?.type ?? "text",
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
      },
      { onSuccess: () => setJustSavedIndex(index) },
    );
  }

  function removeRule(index: number) {
    const rule = rules[index];
    if (rule?.id) {
      deleteRule.mutate({ guildId, id: rule.id });
    }
    setRules((rs) => rs.filter((_, i) => i !== index));
    setSelectedRuleIndex((current) => {
      if (current === null) return null;
      if (current === index) return null;
      if (current > index) return current - 1;
      return current;
    });
    setJustSavedIndex((current) => {
      if (current === null) return null;
      if (current === index) return null;
      if (current > index) return current - 1;
      return current;
    });
  }

  return (
    <div
      className={`flex w-full flex-col gap-6 ${
        activeTab === "rules" ? "max-w-4xl" : "max-w-2xl"
      }`}
    >
      <div className="bg-discord-elevated flex gap-1 self-start rounded-full p-1">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
              activeTab === tab.id
                ? "bg-discord-brand text-white"
                : "text-discord-text-muted hover:bg-discord-elevated-hover hover:text-discord-text"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "general" && (
        <div className="bg-discord-elevated flex flex-col gap-2 rounded-xl p-6">
          <h3 className="font-bold">Sync now</h3>
          <p className="text-discord-text-muted text-sm">
            The bot normally re-checks roster/roles/channel access once a day.
            Trigger it right away instead — handy while debugging a rule or
            channel grant. Takes effect within about 15 seconds.
          </p>
          <button
            type="button"
            onClick={() => requestSync.mutate({ guildId })}
            disabled={requestSync.isPending}
            className="bg-discord-elevated-hover self-start rounded-full px-4 py-1.5 text-sm font-semibold"
          >
            {requestSync.isPending ? "Requesting..." : "Sync now"}
          </button>
          {requestSync.error && (
            <p className="text-discord-red text-sm">
              {requestSync.error.message}
            </p>
          )}
          {requestSync.isSuccess && (
            <p className="text-discord-green text-sm">
              Requested — should run within ~15 seconds.
            </p>
          )}
        </div>
      )}

      {activeTab === "general" && (
        <div className="bg-discord-elevated flex flex-col gap-2 rounded-xl p-6">
          <h3 className="font-bold">Roster source</h3>
          <p className="text-discord-text-muted text-sm">
            How this guild&apos;s roster gets built.
          </p>
          <div className="flex flex-col gap-2">
            <label className="hover:bg-discord-elevated-hover flex cursor-pointer items-start gap-2 rounded-lg p-2">
              <input
                type="radio"
                name="roster-source"
                checked={rosterSource === "addon"}
                onChange={() => setRosterSource("addon")}
                className="mt-1"
              />
              <span>
                <span className="block font-semibold">Addon export</span>
                <span className="text-discord-text-muted block text-sm">
                  An in-game guild — paste the roster addon&apos;s export on the
                  Members page. Onboarding only matches/claims characters that
                  are already in it.
                </span>
              </span>
            </label>
            <label className="hover:bg-discord-elevated-hover flex cursor-pointer items-start gap-2 rounded-lg p-2">
              <input
                type="radio"
                name="roster-source"
                checked={rosterSource === "onboarding"}
                onChange={() => setRosterSource("onboarding")}
                className="mt-1"
              />
              <span>
                <span className="block font-semibold">Discord onboarding</span>
                <span className="text-discord-text-muted block text-sm">
                  A play group with no in-game guild to scan — there&apos;s no
                  import. Onboarding asks for name and class and builds the
                  roster from claims directly.
                </span>
              </span>
            </label>
          </div>
          <button
            type="button"
            onClick={() => saveRosterSource.mutate({ guildId, rosterSource })}
            disabled={saveRosterSource.isPending}
            className="bg-discord-elevated-hover self-start rounded-full px-4 py-1.5 text-sm font-semibold"
          >
            {saveRosterSource.isPending ? "Saving..." : "Save"}
          </button>
          {saveRosterSource.error && (
            <p className="text-discord-red text-sm">
              {saveRosterSource.error.message}
            </p>
          )}
          {saveRosterSource.isSuccess && (
            <p className="text-discord-green text-sm">Saved!</p>
          )}
        </div>
      )}

      {activeTab === "general" && rosterSource === "addon" && (
        <div className="bg-discord-elevated flex flex-col gap-2 rounded-xl p-6">
          <h3 className="font-bold">Character lookup (optional)</h3>
          <p className="text-discord-text-muted text-sm">
            When set, onboarding checks a name that doesn&apos;t match the
            roster against Battle.net directly — telling apart a typo&apos;d
            or nickname-typed name (doesn&apos;t exist), a real character
            currently in a <em>different</em> guild, and one that just
            hasn&apos;t been (re-)imported yet, instead of treating all three
            the same. A real character in a different guild (or none) still
            gets level-range channel access, just no member roles. Leave
            blank to skip this entirely.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <input
              className="bg-discord-base text-discord-text rounded-full px-4 py-2"
              value={wowRegion}
              onChange={(e) => setWowRegion(e.target.value)}
              placeholder="Region (e.g. eu)"
            />
            <input
              className="bg-discord-base text-discord-text rounded-full px-4 py-2"
              value={wowRealmSlug}
              onChange={(e) => setWowRealmSlug(e.target.value)}
              placeholder="Realm slug (e.g. spineshatter)"
            />
            <input
              className="bg-discord-base text-discord-text rounded-full px-4 py-2"
              value={wowGuildName}
              onChange={(e) => setWowGuildName(e.target.value)}
              placeholder='In-game guild name (e.g. "Socialism")'
            />
            <input
              className="bg-discord-base text-discord-text rounded-full px-4 py-2"
              value={wowNamespaceFlavor}
              onChange={(e) => setWowNamespaceFlavor(e.target.value)}
              placeholder="Namespace flavor (e.g. classicann)"
            />
          </div>
          <button
            type="button"
            onClick={() =>
              saveArmoryConfig.mutate({
                guildId,
                wowRegion: wowRegion.trim() === "" ? null : wowRegion.trim(),
                wowRealmSlug:
                  wowRealmSlug.trim() === "" ? null : wowRealmSlug.trim(),
                wowGuildName:
                  wowGuildName.trim() === "" ? null : wowGuildName.trim(),
                wowNamespaceFlavor:
                  wowNamespaceFlavor.trim() === ""
                    ? null
                    : wowNamespaceFlavor.trim(),
              })
            }
            disabled={saveArmoryConfig.isPending}
            className="bg-discord-elevated-hover self-start rounded-full px-4 py-1.5 text-sm font-semibold"
          >
            {saveArmoryConfig.isPending ? "Saving..." : "Save"}
          </button>
          {saveArmoryConfig.error && (
            <p className="text-discord-red text-sm">
              {saveArmoryConfig.error.message}
            </p>
          )}
          {saveArmoryConfig.isSuccess && (
            <p className="text-discord-green text-sm">Saved!</p>
          )}
        </div>
      )}

      {activeTab === "general" && (
        <div className="bg-discord-elevated flex flex-col gap-2 rounded-xl p-6">
          <h3 className="font-bold">PUG role</h3>
          <p className="text-discord-text-muted text-sm">
            Given automatically when someone tells the bot they&apos;re here for
            a PUG, not as a guild member — no rules are evaluated for them.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={pugEnabled}
              onChange={(e) => setPugEnabled(e.target.checked)}
            />
            Enable PUG role
          </label>
          <p className="text-discord-text-muted text-sm">
            {pugEnabled
              ? "Onboarding asks “guild member or PUG?” for everyone."
              : "Onboarding skips that question entirely — everyone goes straight into the guild-member flow."}
          </p>
          <div className="flex gap-2">
            <RoleSelect
              value={pugRoleId}
              onChange={setPugRoleId}
              roles={discordRoles.data}
              placeholder="No PUG role"
              disabled={!pugEnabled}
            />
            <button
              type="button"
              onClick={() =>
                setPugRole.mutate({
                  guildId,
                  enabled: pugEnabled,
                  discordRoleId: pugRoleId.trim() === "" ? null : pugRoleId,
                })
              }
              disabled={setPugRole.isPending}
              className="bg-discord-elevated-hover rounded-full px-4 text-sm font-semibold"
            >
              {setPugRole.isPending ? "Saving..." : "Save"}
            </button>
          </div>
          {setPugRole.error && (
            <p className="text-discord-red text-sm">
              {setPugRole.error.message}
            </p>
          )}
          {setPugRole.isSuccess && (
            <p className="text-discord-green text-sm">Saved!</p>
          )}
        </div>
      )}

      {activeTab === "onboarding" && (
        <div className="bg-discord-elevated flex flex-col gap-2 rounded-xl p-6">
          <h3 className="font-bold">Onboarding button channel</h3>
          <p className="text-discord-text-muted text-sm">
            The bot posts (and keeps up) a standing &quot;Start Onboarding&quot;
            button message here — a public channel like #welcome works well.
            Anyone can click it to (re-)run onboarding, privately (only they see
            the questions), no need to know the /onboarding command. Leave unset
            to skip posting one.
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
                    onboardingChannelId.trim() === ""
                      ? null
                      : onboardingChannelId,
                })
              }
              disabled={setOnboardingChannel.isPending}
              className="bg-discord-elevated-hover rounded-full px-4 text-sm font-semibold"
            >
              {setOnboardingChannel.isPending ? "Saving..." : "Save"}
            </button>
          </div>
          {setOnboardingChannel.error && (
            <p className="text-discord-red text-sm">
              {setOnboardingChannel.error.message}
            </p>
          )}
          {setOnboardingChannel.isSuccess && (
            <p className="text-discord-green text-sm">Saved!</p>
          )}

          <textarea
            value={onboardingMessageText}
            onChange={(e) => setOnboardingMessageText(e.target.value)}
            placeholder="Click below to start (or redo) onboarding — I'll ask a few quick questions right here (only you can see them) to get your nickname and roles set up."
            rows={3}
            className="bg-discord-base text-discord-text placeholder:text-discord-text-muted rounded-2xl px-4 py-2 text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                saveOnboardingMessageText.mutate({
                  guildId,
                  text:
                    onboardingMessageText.trim() === ""
                      ? null
                      : onboardingMessageText,
                })
              }
              disabled={saveOnboardingMessageText.isPending}
              className="bg-discord-elevated-hover rounded-full px-4 py-1.5 text-sm font-semibold"
            >
              {saveOnboardingMessageText.isPending
                ? "Saving..."
                : "Save message text"}
            </button>
            <button
              type="button"
              onClick={() => repostOnboardingButton.mutate({ guildId })}
              disabled={
                repostOnboardingButton.isPending || !onboardingChannelId
              }
              title="If you've posted new messages above the button since it went up, this moves it back to the bottom of the channel."
              className="bg-discord-base hover:bg-discord-elevated-hover rounded-full px-4 py-1.5 text-sm"
            >
              {repostOnboardingButton.isPending
                ? "Moving..."
                : "Move to bottom of channel"}
            </button>
          </div>
          {saveOnboardingMessageText.error && (
            <p className="text-discord-red text-sm">
              {saveOnboardingMessageText.error.message}
            </p>
          )}
          {saveOnboardingMessageText.isSuccess && (
            <p className="text-discord-green text-sm">Saved!</p>
          )}
          {repostOnboardingButton.isSuccess && (
            <p className="text-discord-green text-sm">
              Done — check the channel in about a minute.
            </p>
          )}
        </div>
      )}

      {activeTab === "general" && (
        <div className="bg-discord-elevated flex flex-col gap-2 rounded-xl p-6">
          <h3 className="font-bold">Admin notifications channel</h3>
          <p className="text-discord-text-muted text-sm">
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
                    adminNotifyChannelId.trim() === ""
                      ? null
                      : adminNotifyChannelId,
                })
              }
              disabled={setAdminNotifyChannel.isPending}
              className="bg-discord-elevated-hover rounded-full px-4 text-sm font-semibold"
            >
              {setAdminNotifyChannel.isPending ? "Saving..." : "Save"}
            </button>
          </div>
          {setAdminNotifyChannel.error && (
            <p className="text-discord-red text-sm">
              {setAdminNotifyChannel.error.message}
            </p>
          )}
          {setAdminNotifyChannel.isSuccess && (
            <p className="text-discord-green text-sm">Saved!</p>
          )}
        </div>
      )}

      {activeTab === "inactivity" && (
        <div className="bg-discord-elevated flex flex-col gap-2 rounded-xl p-6">
          <h3 className="font-bold">Inactivity filter</h3>
          <p className="text-discord-text-muted text-sm">
            Members holding any of the tracked roles below who haven&apos;t sent
            a message in this many days get their other roles saved and swapped
            for the inactive role — not kicked. They can restore themselves any
            time with <code>/reactivate</code>.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={inactivityEnabled}
              onChange={(e) => setInactivityEnabled(e.target.checked)}
            />
            Enabled
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-discord-text-muted text-xs uppercase tracking-wide">
              Track members with any of these roles
            </span>
            {inactivityTargetRoleIds.map((roleId, i) => (
              <div key={i} className="flex gap-2">
                <RoleSelect
                  value={roleId}
                  onChange={(v) =>
                    setInactivityTargetRoleIds((ids) =>
                      ids.map((id, k) => (k === i ? v : id)),
                    )
                  }
                  roles={discordRoles.data}
                  placeholder="Select a role to track"
                />
                {inactivityTargetRoleIds.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      setInactivityTargetRoleIds((ids) =>
                        ids.filter((_, k) => k !== i),
                      )
                    }
                    className="bg-discord-base hover:bg-discord-elevated-hover rounded-full px-3 text-sm"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() => setInactivityTargetRoleIds((ids) => [...ids, ""])}
              className="bg-discord-base hover:bg-discord-elevated-hover self-start rounded-full px-3 py-1 text-xs"
            >
              + Add role
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="number"
              min={1}
              value={inactivityDays}
              onChange={(e) => setInactivityDays(e.target.value)}
              placeholder="Days"
              className="bg-discord-base text-discord-text w-24 rounded-full px-4 py-2"
            />
            <RoleSelect
              value={inactivityRoleId}
              onChange={setInactivityRoleId}
              roles={discordRoles.data}
              placeholder="Swap to this role when inactive"
            />
            <button
              type="button"
              onClick={() =>
                saveInactivitySettings.mutate({
                  guildId,
                  enabled: inactivityEnabled,
                  days:
                    inactivityDays.trim() === ""
                      ? null
                      : Number(inactivityDays),
                  targetRoleIds: inactivityTargetRoleIds.filter(
                    (id) => id.trim() !== "",
                  ),
                  inactiveRoleId:
                    inactivityRoleId.trim() === "" ? null : inactivityRoleId,
                })
              }
              disabled={saveInactivitySettings.isPending}
              className="bg-discord-elevated-hover rounded-full px-4 py-2 text-sm font-semibold"
            >
              {saveInactivitySettings.isPending ? "Saving..." : "Save"}
            </button>
          </div>
          {saveInactivitySettings.error && (
            <p className="text-discord-red text-sm">
              {saveInactivitySettings.error.message}
            </p>
          )}
          {saveInactivitySettings.isSuccess && (
            <p className="text-discord-green text-sm">Saved!</p>
          )}
        </div>
      )}

      {activeTab === "rules" && (
        <>
          <div className="flex flex-col gap-4">
            <div>
              <h3 className="font-bold">Role rules</h3>
              <p className="text-discord-text-muted text-sm">
                Each rule grants a Discord role, direct access to a channel,
                or both, when every one of its conditions is met by at least
                one of the person&apos;s characters (main or an alt) —
                different conditions can be matched by different characters.
                A channel grant doesn&apos;t require a role, and a role grant
                doesn&apos;t require a channel — pick either, or both. Pick a
                rule on the left to edit it.
              </p>
            </div>

            <div className="flex items-start gap-4">
              <div className="flex w-56 shrink-0 flex-col gap-2">
                {rules.length === 0 ? (
                  <div className="bg-discord-elevated text-discord-text-muted rounded-xl p-4 text-center text-sm">
                    No rules yet.
                  </div>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {rules.map((rule, i) => (
                      <li
                        key={rule.id ?? `new-${i}`}
                        className="flex items-center gap-1"
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedRuleIndex(i)}
                          title={ruleSummary(rule)}
                          className={`min-w-0 flex-1 truncate rounded-lg px-3 py-2 text-left text-sm font-semibold transition ${
                            selectedRuleIndex === i
                              ? "bg-discord-brand text-white"
                              : "bg-discord-elevated hover:bg-discord-elevated-hover text-discord-text"
                          }`}
                        >
                          {rule.label.trim() !== ""
                            ? rule.label
                            : `Rule ${i + 1}`}
                        </button>
                        <button
                          type="button"
                          onClick={() => removeRule(i)}
                          className="bg-discord-base hover:bg-discord-elevated-hover shrink-0 rounded-lg px-2.5 py-2 text-sm"
                          title="Delete rule"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setRules((rs) => [...rs, emptyRule()]);
                    setSelectedRuleIndex(rules.length);
                  }}
                  className="bg-discord-elevated hover:bg-discord-elevated-hover self-start rounded-full px-4 py-1.5 text-sm font-semibold transition"
                >
                  + Add rule
                </button>
              </div>

              <div className="min-w-0 flex-1">
                {selectedRuleIndex === null || !rules[selectedRuleIndex] ? (
                  <div className="bg-discord-elevated text-discord-text-muted rounded-xl p-6 text-center text-sm">
                    Select a rule on the left, or add a new one.
                  </div>
                ) : (
                  (() => {
                    const i = selectedRuleIndex;
                    const rule = rules[i]!;
                    return (
                      <div className="bg-discord-elevated flex flex-col gap-3 rounded-xl p-6">
                        <input
                          className="bg-discord-base text-discord-text rounded-full px-4 py-2"
                          value={rule.label}
                          onChange={(e) =>
                            updateRule(i, { label: e.target.value })
                          }
                          placeholder="Label (optional, e.g. 'Wailing Caverns raiders')"
                        />

                        <div className="flex flex-col gap-2">
                          <span className="text-discord-text-muted text-xs uppercase tracking-wide">
                            Roles to grant (optional)
                          </span>
                          {rule.discordRoleIds.map((roleId, j) => (
                            <div key={j} className="flex gap-2">
                              <RoleSelect
                                value={roleId}
                                onChange={(v) =>
                                  updateRule(i, {
                                    discordRoleIds: rule.discordRoleIds.map(
                                      (id, k) => (k === j ? v : id),
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
                                      discordRoleIds:
                                        rule.discordRoleIds.filter(
                                          (_, k) => k !== j,
                                        ),
                                    })
                                  }
                                  className="bg-discord-base hover:bg-discord-elevated-hover rounded-full px-3 text-sm"
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
                            className="bg-discord-base hover:bg-discord-elevated-hover self-start rounded-full px-3 py-1 text-xs"
                          >
                            + Add role
                          </button>
                        </div>

                        <div className="flex flex-col gap-2">
                          <span className="text-discord-text-muted text-xs uppercase tracking-wide">
                            Channels to grant direct access to (optional)
                          </span>
                          {rule.grantedChannelIds.map((channelId, j) => (
                            <div key={j} className="flex gap-2">
                              <ChannelGrantSelect
                                value={channelId}
                                onChange={(v) =>
                                  updateRule(i, {
                                    grantedChannelIds:
                                      rule.grantedChannelIds.map((id, k) =>
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
                                    grantedChannelIds:
                                      rule.grantedChannelIds.filter(
                                        (_, k) => k !== j,
                                      ),
                                  })
                                }
                                className="bg-discord-base hover:bg-discord-elevated-hover rounded-full px-3 text-sm"
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() =>
                              updateRule(i, {
                                grantedChannelIds: [
                                  ...rule.grantedChannelIds,
                                  "",
                                ],
                              })
                            }
                            className="bg-discord-base hover:bg-discord-elevated-hover self-start rounded-full px-3 py-1 text-xs"
                          >
                            + Add channel
                          </button>
                        </div>

                        <div className="flex flex-col gap-2">
                          <span className="text-discord-text-muted text-xs uppercase tracking-wide">
                            Conditions
                          </span>
                          {rule.conditions.map((cond, j) => (
                            <div key={j} className="flex items-center gap-2">
                              <select
                                className="bg-discord-base text-discord-text rounded-full px-3 py-1.5 text-sm"
                                value={cond.field}
                                onChange={(e) =>
                                  updateCondition(i, j, {
                                    field: e.target.value as Field,
                                  })
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
                                    className="bg-discord-base text-discord-text w-20 rounded-full px-3 py-1.5 text-sm"
                                    value={cond.minNumber}
                                    onChange={(e) =>
                                      updateCondition(i, j, {
                                        minNumber: e.target.value,
                                      })
                                    }
                                    placeholder="Min"
                                  />
                                  <span className="text-discord-text-muted">
                                    –
                                  </span>
                                  <input
                                    type="number"
                                    className="bg-discord-base text-discord-text w-20 rounded-full px-3 py-1.5 text-sm"
                                    value={cond.maxNumber}
                                    onChange={(e) =>
                                      updateCondition(i, j, {
                                        maxNumber: e.target.value,
                                      })
                                    }
                                    placeholder="Max"
                                  />
                                </>
                              ) : (
                                <input
                                  list={
                                    cond.field === "rank"
                                      ? "rank-options"
                                      : "class-options"
                                  }
                                  className="bg-discord-base text-discord-text flex-1 rounded-full px-3 py-1.5 text-sm"
                                  value={cond.textValue}
                                  onChange={(e) =>
                                    updateCondition(i, j, {
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

                              {rule.conditions.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    updateRule(i, {
                                      conditions: rule.conditions.filter(
                                        (_, k) => k !== j,
                                      ),
                                    })
                                  }
                                  className="bg-discord-base hover:bg-discord-elevated-hover rounded-full px-2 text-xs"
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
                                conditions: [
                                  ...rule.conditions,
                                  emptyCondition(),
                                ],
                              })
                            }
                            className="bg-discord-base hover:bg-discord-elevated-hover self-start rounded-full px-3 py-1 text-xs"
                          >
                            + Add condition
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() => saveRule(i)}
                          disabled={
                            upsertRule.isPending ||
                            (!rule.discordRoleIds.some(
                              (id) => id.trim() !== "",
                            ) &&
                              !rule.grantedChannelIds.some(
                                (id) => id.trim() !== "",
                              ))
                          }
                          className="bg-discord-brand self-start rounded-full px-6 py-2 text-sm font-semibold text-white disabled:opacity-50"
                        >
                          {upsertRule.isPending ? "Saving..." : "Save changes"}
                        </button>
                        {upsertRule.error && (
                          <p className="text-discord-red text-sm">
                            {upsertRule.error.message}
                          </p>
                        )}
                        {upsertRule.isSuccess && justSavedIndex === i && (
                          <p className="text-discord-green text-sm">Saved!</p>
                        )}
                      </div>
                    );
                  })()
                )}
              </div>
            </div>
          </div>

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
