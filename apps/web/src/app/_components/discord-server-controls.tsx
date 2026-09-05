"use client";

// Discord Server Controls — Discord hosts, schematic inside.
// The page is a fluid stack of Discord panels inside the guild shell; the
// Cabinet Schematic survives as content: the bot breaker, status lamps,
// sealed protected-role latches, and mono kickers. All six old tabs'
// functionality is ported here.

import { useEffect, useState } from "react";

import {
  ChannelSelect,
  InactivityManager,
  MembersByRolePanel,
  RoleSelect,
} from "~/app/_components/guild-role-rules-form";
import { GuildFlowEditor } from "~/app/_components/guild-flow-editor";
import { GuildRoleRulesEditor } from "~/app/_components/guild-role-rules-editor";
import { api } from "~/trpc/react";

export function DiscordServerControls({
  guildId,
  initialBotEnabled,
  lastRosterImportedAt,
}: {
  guildId: string;
  initialBotEnabled: boolean;
  lastRosterImportedAt: Date | null;
}) {
  const utils = api.useUtils();
  const invalidate = () => {
    void utils.guild.discordRoleConfig.invalidate({ guildId });
    void utils.guild.get.invalidate({ guildId });
  };

  const config = api.guild.discordRoleConfig.useQuery({ guildId });
  const roles = api.guild.discordRoles.useQuery({ guildId });
  const channels = api.guild.discordChannels.useQuery({ guildId });
  const guild = api.guild.get.useQuery({ guildId });

  const roleName = (id: string) =>
    roles.data?.find((r) => r.id === id)?.name ?? "unknown role";

  // ---- bot kill switch ----
  const botEnabled = guild.data?.botEnabled ?? initialBotEnabled;
  // Optimistic flip: the kill switch must respond instantly, not after the
  // guild refetch round-trip.
  const setBotEnabled = api.guild.setBotEnabled.useMutation({
    onMutate: async (input) => {
      await utils.guild.get.cancel({ guildId });
      utils.guild.get.setData({ guildId }, (old) =>
        old ? { ...old, botEnabled: input.enabled } : old,
      );
    },
    onSuccess: invalidate,
    onError: invalidate,
  });

  // ---- general state (roster source, armory, PUG, admin notices, sync) ----
  const [rosterSource, setRosterSource] = useState<"addon" | "onboarding">(
    "addon",
  );
  const [wowRegion, setWowRegion] = useState("");
  const [wowRealmSlug, setWowRealmSlug] = useState("");
  const [wowGuildName, setWowGuildName] = useState("");
  const [wowNamespaceFlavor, setWowNamespaceFlavor] = useState("classic");
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
  const [nonClaimableRoleIds, setNonClaimableRoleIds] = useState<string[]>([
    "",
  ]);

  useEffect(() => {
    if (!config.data) return;
    setRosterSource(
      config.data.rosterSource === "onboarding" ? "onboarding" : "addon",
    );
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
    setNonClaimableRoleIds(
      config.data.nonClaimableRoleIds.length > 0
        ? config.data.nonClaimableRoleIds
        : [""],
    );
    setWowRegion(config.data.wowRegion ?? "");
    // A real realm value only ever shows up once someone's imported a
    // character (see suggestedRealm in discordRoleConfig) — prefill with it
    // rather than leaving the field blank, same "prefill, still editable"
    // convention as the create-guild wizard's name-from-server autofill.
    setWowRealmSlug(config.data.wowRealmSlug ?? config.data.suggestedRealm ?? "");
    setWowGuildName(config.data.wowGuildName ?? "");
    setWowNamespaceFlavor(config.data.wowNamespaceFlavor ?? "classic");
  }, [config.data]);

  const saveRosterSource = api.guild.setRosterSource.useMutation({
    onSuccess: invalidate,
  });
  const setPugRole = api.guild.setPugRole.useMutation({ onSuccess: invalidate });
  const saveArmoryConfig = api.guild.setArmoryConfig.useMutation({
    onSuccess: invalidate,
  });
  const setAdminNotifyChannel = api.guild.setAdminNotifyChannel.useMutation({
    onSuccess: invalidate,
  });
  const setOnboardingChannel = api.guild.setOnboardingChannel.useMutation({
    onSuccess: invalidate,
  });
  const saveOnboardingMessageText =
    api.guild.setOnboardingMessageText.useMutation({ onSuccess: invalidate });
  const repostOnboardingButton = api.guild.repostOnboardingButton.useMutation();
  const requestSync = api.guild.requestSync.useMutation();
  const saveInactivitySettings = api.guild.setInactivitySettings.useMutation({
    onSuccess: invalidate,
  });
  const saveNonClaimableRoles = api.guild.setNonClaimableRoles.useMutation({
    onSuccess: invalidate,
  });

  // ---- protected roles (sealed latches, 2-step unseal) ----
  const saveProtectedRoles = api.guild.setProtectedRoles.useMutation({
    onSuccess: invalidate,
  });
  const protectedIds = config.data?.protectedRoleIds ?? [];
  const [sealOpen, setSealOpen] = useState(false);
  const [unsealArm, setUnsealArm] = useState<string | null>(null);

  // ---- mutually exclusive priority chain ----
  const [rolePriorityIds, setRolePriorityIds] = useState<string[]>([]);
  useEffect(() => {
    if (config.data) setRolePriorityIds(config.data.rolePriorityIds);
  }, [config.data]);

  function movePriorityRole(index: number, direction: -1 | 1) {
    setRolePriorityIds((ids) => {
      const target = index + direction;
      if (target < 0 || target >= ids.length) return ids;
      const next = [...ids];
      const a = next[index];
      const b = next[target];
      if (a == null || b == null) return ids;
      next[index] = b;
      next[target] = a;
      return next;
    });
  }

  const saveRolePriorities = api.guild.setRolePriorities.useMutation({
    onSuccess: invalidate,
  });

  const loading = config.isLoading || roles.isLoading;

  // ---- sub-nav: one section at a time (Discord settings pattern) ----
  type SectionId = "sync" | "flow" | "inactivity" | "audit";
  const NAV: { id: SectionId; label: string }[] = [
    { id: "sync", label: "Bot & sync" },
    { id: "flow", label: "Onboarding & rollregler" },
    { id: "inactivity", label: "Inactivity" },
    { id: "audit", label: "Roles & audit" },
  ];
  // SSR-safe: "use client" components still render on the server, so no
  // window access in the initializer — the mount effect below applies the
  // current hash once the client takes over (covers direct #flow loads).
  const [section, setSection] = useState<SectionId>("sync");
  function switchSection(id: SectionId) {
    setSection(id);
    window.history.replaceState(null, "", `#${id}`);
  }
  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash.slice(1) as SectionId;
      if (NAV.some((n) => n.id === hash)) setSection(hash);
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex w-full max-w-6xl flex-col gap-6">
      <div>
        <h2 className="text-xl font-bold">Discord Server Controls</h2>
        <p className="text-discord-text-muted mt-1 text-sm">
          Everything the GuildThing Roster bot manages on the Discord server:
          sync, onboarding, role rules, inactivity — and the log of what it
          did. For the bot to notice manual role changes (and skip
          overwriting them on resync), give it the{" "}
          <strong>View Audit Log</strong> permission in Server Settings →
          Roles.
        </p>
      </div>
      {/* ---- Sub-nav: Discord-settings pattern, one section at a time ---- */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:items-start">
        <nav
          aria-label="Discord Server Controls sections"
          className="flex gap-1 overflow-x-auto pb-1 lg:sticky lg:top-4 lg:flex-col lg:pb-0"
        >
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => switchSection(item.id)}
              aria-current={section === item.id ? "true" : undefined}
              className={`whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm font-semibold transition ${
                section === item.id
                  ? "bg-discord-elevated text-discord-text"
                  : "text-discord-text-muted hover:bg-discord-elevated hover:text-discord-text"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-col gap-6">

      {section === "sync" && (
        <>
      {/* ---- Bot & sync ---- */}
      <section className="bg-discord-elevated flex flex-col gap-4 rounded-xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <h3 className="font-bold">Bot automation</h3>
            <p className="text-discord-text-muted mt-1 text-sm">
              Pauses the bot&apos;s background automation (role sync, channel
              grants, inactivity filter). Live slash commands keep working —
              this is not an outage switch.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className="schem-mono text-sm"
              style={{
                color: botEnabled ? "var(--schem-green)" : "var(--schem-amber)",
                letterSpacing: "0.08em",
              }}
            >
              ● {botEnabled ? "ENABLED" : "PAUSED"}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={botEnabled}
              aria-label="Bot automation"
              disabled={setBotEnabled.isPending || loading}
              data-paused={!botEnabled}
              className="schem-breaker-track"
              onClick={() => setBotEnabled.mutate({ guildId, enabled: !botEnabled })}
            >
              <span
                className="schem-breaker-knob"
                style={{ [botEnabled ? "right" : "left"]: 2 }}
              />
            </button>
          </div>
          {setBotEnabled.error && (
            <p className="text-discord-red text-sm">
              {setBotEnabled.error.message}
            </p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <span className="schem-kicker">Discord API</span>
            <span className="flex items-center gap-2 text-sm">
              <span
                className="schem-lamp-dot"
                style={{
                  background: roles.isError ? "#f23f42" : "var(--schem-green)",
                  boxShadow: roles.isError
                    ? "0 0 6px rgba(242,63,66,.7)"
                    : "0 0 6px rgba(35,165,90,.7)",
                }}
              />
              {roles.isFetching ? "checking…" : roles.isError ? "unreachable" : "ok"}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="schem-kicker">Last roster import</span>
            <span className="schem-mono text-sm">
              {lastRosterImportedAt
                ? new Date(lastRosterImportedAt).toLocaleString()
                : "never"}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="schem-kicker">Sync now</span>
            <button
              type="button"
              onClick={() => requestSync.mutate({ guildId })}
              disabled={requestSync.isPending}
              className="bg-discord-elevated-hover hover:bg-discord-base self-start rounded-full px-4 py-1.5 text-sm font-semibold"
            >
              {requestSync.isPending ? "Requesting…" : "Trigger resync"}
            </button>
            {requestSync.error && (
              <p className="text-discord-red text-sm">
                {requestSync.error.message}
              </p>
            )}
            {requestSync.isSuccess && (
              <p className="text-discord-green text-sm">
                Requested — runs within ~15 seconds.
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="schem-kicker">Admin notifications channel</span>
          <p className="text-discord-text-muted text-sm">
            The bot posts notices here — e.g. when two different Discord
            accounts claim the same roster character. Officers + bot only.
            Leave unset to skip.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <ChannelSelect
              value={adminNotifyChannelId}
              onChange={setAdminNotifyChannelId}
              channels={channels.data}
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
              className="bg-discord-elevated-hover rounded-full px-4 py-1.5 text-sm font-semibold"
            >
              {setAdminNotifyChannel.isPending ? "Saving…" : "Save"}
            </button>
            {setAdminNotifyChannel.error && (
              <p className="text-discord-red text-sm">
                {setAdminNotifyChannel.error.message}
              </p>
            )}
            {setAdminNotifyChannel.isSuccess && (
              <p className="text-discord-green text-sm">Saved!</p>
            )}
          </div>
        </div>
      </section>

      {/* ---- Roster source & PUG ---- */}
      <section className="bg-discord-elevated flex flex-col gap-4 rounded-xl p-6">
        <div className="flex flex-col gap-2">
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
                  An in-game guild — paste the roster addon&apos;s export on
                  the Members page. Onboarding only matches/claims characters
                  already in it.
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
                  A play group with no in-game guild — no import; onboarding
                  builds the roster from claims directly.
                </span>
              </span>
            </label>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => saveRosterSource.mutate({ guildId, rosterSource })}
              disabled={saveRosterSource.isPending}
              className="bg-discord-elevated-hover rounded-full px-4 py-1.5 text-sm font-semibold"
            >
              {saveRosterSource.isPending ? "Saving…" : "Save"}
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
        </div>

        {rosterSource === "addon" && (
          <div className="flex flex-col gap-2">
            <h4 className="font-semibold">Character lookup (optional)</h4>
            <p className="text-discord-text-muted text-sm">
              When set, onboarding checks an unmatched name against
              Battle.net directly instead of treating every miss the same.
              Leave blank to skip.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                className="bg-discord-base text-discord-text rounded-full px-4 py-2 text-sm"
                value={wowRegion}
                onChange={(e) => setWowRegion(e.target.value)}
                placeholder="Region (e.g. eu)"
              />
              <input
                className="bg-discord-base text-discord-text rounded-full px-4 py-2 text-sm"
                value={wowRealmSlug}
                onChange={(e) => setWowRealmSlug(e.target.value)}
                placeholder="Realm slug (e.g. spineshatter)"
              />
              <input
                className="bg-discord-base text-discord-text rounded-full px-4 py-2 text-sm"
                value={wowGuildName}
                onChange={(e) => setWowGuildName(e.target.value)}
                placeholder='In-game guild name (e.g. "Socialism")'
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="schem-kicker">Realm track</span>
              <p className="text-discord-text-muted text-xs">
                Which Classic realm family this guild plays on — Progression
                and Anniversary can both be at the same content patch, so
                this can&apos;t be guessed from the raid comp tool&apos;s
                Expansion setting above.
              </p>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    { id: "classic1x", label: "Era" },
                    { id: "classic", label: "Progression" },
                    { id: "classicann", label: "Anniversary" },
                  ] as const
                ).map((track) => (
                  <button
                    key={track.id}
                    type="button"
                    onClick={() => setWowNamespaceFlavor(track.id)}
                    className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                      wowNamespaceFlavor === track.id
                        ? "bg-discord-brand text-white"
                        : "bg-discord-elevated-hover text-discord-text hover:bg-discord-brand/40"
                    }`}
                  >
                    {track.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-3">
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
                className="bg-discord-elevated-hover rounded-full px-4 py-1.5 text-sm font-semibold"
              >
                {saveArmoryConfig.isPending ? "Saving…" : "Save"}
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
          </div>
        )}

        <div className="flex flex-col gap-2">
          <h4 className="font-semibold">PUG role</h4>
          <p className="text-discord-text-muted text-sm">
            The role the onboarding flow&apos;s PUG branch grants — edit or
            remove that branch in the Flow tab if you don&apos;t want to
            offer a PUG path at all. Also scoped into the bot&apos;s managed
            roles so role sync treats it as bot-owned.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <RoleSelect
              value={pugRoleId}
              onChange={setPugRoleId}
              roles={roles.data}
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
              className="bg-discord-elevated-hover rounded-full px-4 py-1.5 text-sm font-semibold"
            >
              {setPugRole.isPending ? "Saving…" : "Save"}
            </button>
            {setPugRole.error && (
              <p className="text-discord-red text-sm">
                {setPugRole.error.message}
              </p>
            )}
            {setPugRole.isSuccess && (
              <p className="text-discord-green text-sm">Saved!</p>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h4 className="font-semibold">Non-claimable roles</h4>
          <p className="text-discord-text-muted text-sm">
            Members holding any of these roles are left off the
            &quot;unclaimed members&quot; list — PUGs and anyone else who
            isn&apos;t meant to claim a roster character.
          </p>
          <div className="flex flex-col gap-2">
            {nonClaimableRoleIds.map((roleId, i) => (
              <div key={i} className="flex gap-2">
                <RoleSelect
                  value={roleId}
                  onChange={(v) =>
                    setNonClaimableRoleIds((ids) =>
                      ids.map((id, k) => (k === i ? v : id)),
                    )
                  }
                  roles={roles.data}
                  placeholder="Select a role to exclude"
                />
                {nonClaimableRoleIds.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      setNonClaimableRoleIds((ids) =>
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
              onClick={() => setNonClaimableRoleIds((ids) => [...ids, ""])}
              className="bg-discord-base hover:bg-discord-elevated-hover self-start rounded-full px-3 py-1 text-xs"
            >
              + Add role
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                saveNonClaimableRoles.mutate({
                  guildId,
                  roleIds: nonClaimableRoleIds.filter((id) => id.trim() !== ""),
                })
              }
              disabled={saveNonClaimableRoles.isPending}
              className="bg-discord-elevated-hover rounded-full px-4 py-1.5 text-sm font-semibold"
            >
              {saveNonClaimableRoles.isPending ? "Saving…" : "Save"}
            </button>
            {saveNonClaimableRoles.error && (
              <p className="text-discord-red text-sm">
                {saveNonClaimableRoles.error.message}
              </p>
            )}
            {saveNonClaimableRoles.isSuccess && (
              <p className="text-discord-green text-sm">Saved!</p>
            )}
          </div>
        </div>
      </section>

      </>
      )}
      {section === "flow" && (
        <>
      {/* ---- Onboarding flow ---- */}
      <GuildFlowEditor guildId={guildId} />

      <GuildRoleRulesEditor
        guildId={guildId}
        roles={roles.data}
        channels={channels.data}
      />

      {/* ---- Interlock cards: mutex chain + protected latches ---- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="bg-discord-elevated flex flex-col gap-3 rounded-xl p-6">
          <h3 className="font-bold">Mutually exclusive roles</h3>
          <p className="text-discord-text-muted text-sm">
            A person can qualify for several rules via different characters —
            listed roles, highest tier first, mean they only ever get the
            topmost one that applies. Leave empty to grant them all.
          </p>
          <div className="flex flex-col gap-2">
            {rolePriorityIds.map((roleId, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="schem-mono text-discord-text-muted w-5 text-right text-sm">
                  {i + 1}
                </span>
                <RoleSelect
                  value={roleId}
                  onChange={(v) =>
                    setRolePriorityIds((ids) =>
                      ids.map((id, k) => (k === i ? v : id)),
                    )
                  }
                  roles={roles.data}
                  placeholder="Select a role"
                />
                <button
                  type="button"
                  onClick={() => movePriorityRole(i, -1)}
                  disabled={i === 0}
                  className="bg-discord-base hover:bg-discord-elevated-hover rounded-full px-2.5 py-1.5 text-sm disabled:opacity-30"
                  title="Move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => movePriorityRole(i, 1)}
                  disabled={i === rolePriorityIds.length - 1}
                  className="bg-discord-base hover:bg-discord-elevated-hover rounded-full px-2.5 py-1.5 text-sm disabled:opacity-30"
                  title="Move down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setRolePriorityIds((ids) => ids.filter((_, k) => k !== i))
                  }
                  className="bg-discord-base hover:bg-discord-elevated-hover rounded-full px-3 py-1.5 text-sm"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setRolePriorityIds((ids) => [...ids, ""])}
              className="bg-discord-base hover:bg-discord-elevated-hover self-start rounded-full px-3 py-1 text-xs"
            >
              + Add role
            </button>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() =>
                saveRolePriorities.mutate({
                  guildId,
                  discordRoleIds: rolePriorityIds.filter((id) => id !== ""),
                })
              }
              disabled={saveRolePriorities.isPending}
              className="bg-discord-elevated-hover rounded-full px-4 py-1.5 text-sm font-semibold"
            >
              {saveRolePriorities.isPending ? "Saving…" : "Save"}
            </button>
            {saveRolePriorities.error && (
              <p className="text-discord-red text-sm">
                {saveRolePriorities.error.message}
              </p>
            )}
            {saveRolePriorities.isSuccess && (
              <p className="text-discord-green text-sm">Saved!</p>
            )}
          </div>
        </section>

        <section className="bg-discord-elevated flex flex-col gap-3 rounded-xl p-6">
          <h3 className="font-bold">Protected roles — sealed</h3>
          <p className="text-discord-text-muted text-sm">
            Sealed roles are never added or removed by the bot, even if a rule
            grants them — for roles meant to stay human-assigned. A resync
            never fights a manual assignment on these.
          </p>
          <div className="flex flex-col gap-2">
            {protectedIds.map((id) => (
              <div key={id} className="schem-latch">
                <span className="schem-mono text-sm">@{roleName(id)}</span>
                {unsealArm === id ? (
                  <span className="flex items-center gap-2">
                    <span className="text-discord-text-muted text-xs">
                      resync may rewrite it
                    </span>
                    <button
                      type="button"
                      className="schem-stamp"
                      onClick={() => {
                        saveProtectedRoles.mutate({
                          guildId,
                          roleIds: protectedIds.filter((x) => x !== id),
                        });
                        setUnsealArm(null);
                      }}
                    >
                      CONFIRM UNSEAL
                    </button>
                    <button
                      type="button"
                      className="text-discord-text-muted text-sm"
                      onClick={() => setUnsealArm(null)}
                    >
                      ✕
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="schem-stamp"
                    title="Click twice to unseal"
                    onClick={() => setUnsealArm(unsealArm === id ? null : id)}
                  >
                    SEALED
                  </button>
                )}
              </div>
            ))}
            {protectedIds.length === 0 && (
              <p className="text-discord-text-muted text-sm">
                Nothing sealed — the resync may rewrite any role a rule also
                grants.
              </p>
            )}
            {sealOpen ? (
              <select
                className="bg-discord-base text-discord-text rounded-full px-3 py-1.5 text-sm"
                defaultValue=""
                aria-label="Seal a role"
                onBlur={() => setSealOpen(false)}
                onChange={(e) => {
                  if (e.target.value) {
                    saveProtectedRoles.mutate({
                      guildId,
                      roleIds: [...protectedIds, e.target.value],
                    });
                  }
                  setSealOpen(false);
                }}
              >
                <option value="">seal a role…</option>
                {(roles.data ?? [])
                  .filter((r) => !protectedIds.includes(r.id))
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      @{r.name}
                    </option>
                  ))}
              </select>
            ) : (
              <button
                type="button"
                onClick={() => setSealOpen(true)}
                className="bg-discord-base hover:bg-discord-elevated-hover self-start rounded-full px-3 py-1 text-xs"
              >
                + Seal a role
              </button>
            )}
            {saveProtectedRoles.error && (
              <p className="text-discord-red text-sm">
                {saveProtectedRoles.error.message}
              </p>
            )}
            {saveProtectedRoles.isSuccess && (
              <p className="text-discord-green text-sm">Saved!</p>
            )}
          </div>
        </section>
      </div>

      </>
      )}
      {section === "inactivity" && (
        <>
      {/* ---- Inactivity ---- */}
      <section className="bg-discord-elevated flex flex-col gap-2 rounded-xl p-6">
        <h3 className="font-bold">Inactivity filter</h3>
        <p className="text-discord-text-muted text-sm">
          Members holding any of the tracked roles who haven&apos;t sent a
          message in this many days get the inactive role added on top —
          existing roles are untouched, nobody&apos;s kicked. They can remove
          it themselves any time with <code>/reactivate</code>.
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
                roles={roles.data}
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
            className="bg-discord-base text-discord-text w-24 rounded-full px-4 py-2 text-sm"
          />
          <RoleSelect
            value={inactivityRoleId}
            onChange={setInactivityRoleId}
            roles={roles.data}
            placeholder="Swap to this role when inactive"
          />
          <button
            type="button"
            onClick={() =>
              saveInactivitySettings.mutate({
                guildId,
                enabled: inactivityEnabled,
                days:
                  inactivityDays.trim() === "" ? null : Number(inactivityDays),
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
            {saveInactivitySettings.isPending ? "Saving…" : "Save"}
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
      </section>
      <InactivityManager guildId={guildId} />

      {/* ---- Onboarding ---- */}
      <section className="bg-discord-elevated flex flex-col gap-3 rounded-xl p-6">
        <h3 className="font-bold">Onboarding button channel</h3>
        <p className="text-discord-text-muted text-sm">
          The bot posts (and keeps up) a standing &quot;Start Onboarding&quot;
          button message here — a public channel like #welcome works well.
          Anyone can click it to run onboarding privately. Leave unset to
          skip.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <ChannelSelect
            value={onboardingChannelId}
            onChange={setOnboardingChannelId}
            channels={channels.data}
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
            className="bg-discord-elevated-hover rounded-full px-4 py-1.5 text-sm font-semibold"
          >
            {setOnboardingChannel.isPending ? "Saving…" : "Save"}
          </button>
          {setOnboardingChannel.error && (
            <p className="text-discord-red text-sm">
              {setOnboardingChannel.error.message}
            </p>
          )}
          {setOnboardingChannel.isSuccess && (
            <p className="text-discord-green text-sm">Saved!</p>
          )}
        </div>
        <textarea
          value={onboardingMessageText}
          onChange={(e) => setOnboardingMessageText(e.target.value)}
          placeholder="Click below to start (or redo) onboarding — I'll ask a few quick questions right here (only you can see them) to get your nickname and roles set up."
          rows={3}
          className="bg-discord-base text-discord-text placeholder:text-discord-text-muted rounded-2xl px-4 py-2 text-sm"
        />
        <div className="flex flex-wrap items-center gap-2">
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
            {saveOnboardingMessageText.isPending ? "Saving…" : "Save message text"}
          </button>
          <button
            type="button"
            onClick={() => repostOnboardingButton.mutate({ guildId })}
            disabled={repostOnboardingButton.isPending || !onboardingChannelId}
            title="If new messages were posted above the button since it went up, this moves it back to the bottom of the channel."
            className="bg-discord-base hover:bg-discord-elevated-hover rounded-full px-4 py-1.5 text-sm"
          >
            {repostOnboardingButton.isPending ? "Moving…" : "Move to bottom of channel"}
          </button>
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
      </section>

      </>
      )}
      {section === "audit" && (
        <>
      {/* ---- Members & roles: one datatable, filters, audit access ---- */}
      <MembersByRolePanel guildId={guildId} roles={roles.data} />
      </>
      )}
      </div>
      </div>
    </div>
  );
}