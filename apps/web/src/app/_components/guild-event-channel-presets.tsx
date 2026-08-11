"use client";

import { useState } from "react";

import { api } from "~/trpc/react";

// Same channel picker as GuildEventsForm's ChannelSelect — not shared from
// there since it's a local, unexported component in that file.
function ChannelSelect({
  value,
  onChange,
  channels,
}: {
  value: string;
  onChange: (value: string) => void;
  channels: { id: string; name: string; type: "text" | "forum" }[] | undefined;
}) {
  if (!channels || channels.length === 0) {
    return (
      <input
        className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Discord channel ID"
      />
    );
  }
  return (
    <select
      className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Which channel?</option>
      {channels.map((c) => (
        <option key={c.id} value={c.id}>
          {c.type === "forum" ? "📋" : "#"} {c.name}
        </option>
      ))}
    </select>
  );
}

export function GuildEventChannelPresets({ guildId }: { guildId: string }) {
  const [collapsed, setCollapsed] = useState(true);
  const [channelId, setChannelId] = useState("");
  const [roles, setRoles] = useState("");
  const [buttonEnabled, setButtonEnabled] = useState(false);

  const channels = api.guild.discordChannelsForEvents.useQuery(
    { guildId },
    { enabled: !collapsed },
  );
  const presets = api.event.channelPresets.useQuery(
    { guildId },
    { enabled: !collapsed },
  );

  const utils = api.useUtils();
  const savePreset = api.event.setChannelPreset.useMutation({
    onSuccess: async () => {
      await utils.event.channelPresets.invalidate({ guildId });
      setChannelId("");
      setRoles("");
      setButtonEnabled(false);
    },
  });
  const deletePreset = api.event.deleteChannelPreset.useMutation({
    onSuccess: async () => utils.event.channelPresets.invalidate({ guildId }),
  });
  const repostButton = api.event.repostChannelButton.useMutation({
    onSuccess: async () => utils.event.channelPresets.invalidate({ guildId }),
  });

  // Flips just the button toggle on an existing row, keeping its roles
  // preset (if any) untouched.
  function toggleButton(p: {
    discordChannelId: string;
    roles: string | null;
    buttonEnabled: boolean;
  }) {
    savePreset.mutate({
      guildId,
      discordChannelId: p.discordChannelId,
      roles: p.roles ?? undefined,
      buttonEnabled: !p.buttonEnabled,
    });
  }

  function channelName(id: string): string {
    const channel = channels.data?.find((c) => c.id === id);
    return channel ? `#${channel.name}` : id;
  }

  return (
    <div className="bg-discord-elevated flex w-full flex-col gap-2 rounded-xl p-4">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center justify-between text-left"
      >
        <h3 className="font-bold">Channel role presets</h3>
        <span className="text-discord-text-muted">{collapsed ? "▸" : "▾"}</span>
      </button>

      {!collapsed && (
        <div className="flex flex-col gap-3 pt-2">
          <p className="text-discord-text-muted text-sm">
            A dungeon-specific channel (e.g. Wailing Caverns) can have a default
            role composition — pre-fills the Roles field in{" "}
            <code>/guildthing event</code> when run there, instead of retyping
            it every time (still editable per event) — and/or a standing
            &quot;Create new event&quot; button for people who&apos;d rather
            click than type a command. Either part is optional.
          </p>

          {presets.data && presets.data.length > 0 && (
            <ul className="flex flex-col gap-2">
              {presets.data.map((p) => (
                <li
                  key={p.id}
                  className="bg-discord-base flex items-center justify-between gap-2 rounded-lg px-4 py-2"
                >
                  <div className="flex flex-col">
                    <span className="font-semibold">
                      {channelName(p.discordChannelId)}
                    </span>
                    {p.roles && (
                      <span className="text-discord-text-muted text-sm">
                        {p.roles}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="text-discord-text-muted flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={p.buttonEnabled}
                        onChange={() => toggleButton(p)}
                        disabled={savePreset.isPending}
                      />
                      Button
                    </label>
                    {p.buttonEnabled && (
                      <button
                        type="button"
                        onClick={() =>
                          repostButton.mutate({ guildId, id: p.id })
                        }
                        disabled={repostButton.isPending}
                        className="text-discord-text-muted hover:text-discord-text text-xs underline disabled:opacity-50"
                        title="Move the button back to the bottom of the channel"
                      >
                        ↓ Move to bottom
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => deletePreset.mutate({ guildId, id: p.id })}
                      disabled={deletePreset.isPending}
                      className="text-discord-text-muted hover:text-discord-red px-2 disabled:opacity-50"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-2">
            <ChannelSelect
              value={channelId}
              onChange={setChannelId}
              channels={channels.data}
            />
            <input
              className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2"
              value={roles}
              onChange={(e) => setRoles(e.target.value)}
              placeholder="Roles (optional): Tank:1:🛡️, Healer:1:✨, DPS:3"
            />
          </div>
          <label className="text-discord-text-muted flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={buttonEnabled}
              onChange={(e) => setButtonEnabled(e.target.checked)}
            />
            Show a &quot;Create new event&quot; button in this channel
          </label>
          <button
            type="button"
            onClick={() =>
              savePreset.mutate({
                guildId,
                discordChannelId: channelId,
                roles: roles.trim() || undefined,
                buttonEnabled,
              })
            }
            disabled={savePreset.isPending || channelId.trim() === ""}
            className="bg-discord-brand self-start rounded-full px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {savePreset.isPending ? "Saving..." : "Save preset"}
          </button>
          {savePreset.error && (
            <span className="text-discord-red text-sm">
              {savePreset.error.message}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
