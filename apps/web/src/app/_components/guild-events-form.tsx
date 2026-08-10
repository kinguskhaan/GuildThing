"use client";

import { useState } from "react";

import { api } from "~/trpc/react";

interface RoleSlotDraft {
  roleName: string;
  capacity: string;
  emoji: string;
}

function emptyRoleSlot(): RoleSlotDraft {
  return { roleName: "", capacity: "1", emoji: "" };
}

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

// Same fallback-to-text-input idea as ChannelSelect/RoleSelect in
// guild-role-rules-form.tsx — not shared from there since it's a local,
// unexported component in that file. Labels forum channels distinctly since
// the bot posts a text-channel event as a thread but a forum-channel one as
// a post — either works, but it's worth the admin knowing which they picked.
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
      <option value="">Post to which channel?</option>
      {channels.map((c) => (
        <option key={c.id} value={c.id}>
          {c.type === "forum" ? "📋" : "#"} {c.name}
        </option>
      ))}
    </select>
  );
}

export function GuildEventsForm({ guildId }: { guildId: string }) {
  const [collapsed, setCollapsed] = useState(true);
  const [title, setTitle] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [date, setDate] = useState(todayISODate);
  const [description, setDescription] = useState("");
  const [channelId, setChannelId] = useState("");
  const [roleSlots, setRoleSlots] = useState<RoleSlotDraft[]>([
    emptyRoleSlot(),
  ]);
  const [timeOptions, setTimeOptions] = useState<string[]>([""]);

  const channels = api.guild.discordChannelsForEvents.useQuery(
    { guildId },
    { enabled: !collapsed },
  );

  const utils = api.useUtils();
  const create = api.event.create.useMutation({
    onSuccess: async () => {
      await utils.event.list.invalidate({ guildId });
      setTitle("");
      setImageUrl("");
      setDate(todayISODate());
      setDescription("");
      setRoleSlots([emptyRoleSlot()]);
      setTimeOptions([""]);
      setCollapsed(true);
    },
  });

  function updateRoleSlot(index: number, patch: Partial<RoleSlotDraft>) {
    setRoleSlots((rs) =>
      rs.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    );
  }

  function updateTimeOption(index: number, value: string) {
    setTimeOptions((ts) => ts.map((t, i) => (i === index ? value : t)));
  }

  function submit() {
    const parsedRoleSlots = roleSlots
      .filter((r) => r.roleName.trim() !== "")
      .map((r) => ({
        roleName: r.roleName.trim(),
        capacity: Math.max(1, Math.trunc(Number(r.capacity) || 1)),
        emoji: r.emoji.trim() || undefined,
      }));
    if (parsedRoleSlots.length === 0 || channelId.trim() === "") return;

    create.mutate({
      guildId,
      title: title.trim(),
      imageUrl: imageUrl.trim() || undefined,
      date: date || undefined,
      description: description.trim() || undefined,
      discordChannelId: channelId.trim(),
      roleSlots: parsedRoleSlots,
      timeOptionLabels: timeOptions.map((t) => t.trim()).filter(Boolean),
    });
  }

  return (
    <div className="bg-discord-elevated flex w-full flex-col gap-2 rounded-xl p-4">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center justify-between text-left"
      >
        <h3 className="font-bold">Create an event</h3>
        <span className="text-discord-text-muted">{collapsed ? "▸" : "▾"}</span>
      </button>

      {!collapsed && (
        <div className="flex flex-col gap-3 pt-2">
          <input
            className="bg-discord-base text-discord-text rounded-full px-4 py-2"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (e.g. Wailing Caverns)"
          />
          <input
            className="bg-discord-base text-discord-text rounded-full px-4 py-2"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="Image URL (optional)"
          />
          <input
            className="bg-discord-base text-discord-text rounded-full px-4 py-2"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <textarea
            className="bg-discord-base text-discord-text rounded-2xl px-4 py-2"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={3}
          />
          <ChannelSelect
            value={channelId}
            onChange={setChannelId}
            channels={channels.data}
          />

          <div className="flex flex-col gap-2">
            <span className="text-sm font-semibold">Roles needed</span>
            {roleSlots.map((slot, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2"
                  value={slot.roleName}
                  onChange={(e) =>
                    updateRoleSlot(i, { roleName: e.target.value })
                  }
                  placeholder="Role (e.g. Tank)"
                />
                <input
                  className="bg-discord-base text-discord-text w-20 rounded-full px-4 py-2"
                  type="number"
                  min={1}
                  value={slot.capacity}
                  onChange={(e) =>
                    updateRoleSlot(i, { capacity: e.target.value })
                  }
                />
                <input
                  className="bg-discord-base text-discord-text w-24 rounded-full px-4 py-2"
                  value={slot.emoji}
                  onChange={(e) => updateRoleSlot(i, { emoji: e.target.value })}
                  placeholder="🛡️ (paste)"
                  title="Paste a unicode emoji. For a custom server emoji, create the event with /guildthing event in Discord instead — its modal can pick one."
                />
                <button
                  type="button"
                  onClick={() =>
                    setRoleSlots((rs) => rs.filter((_, j) => j !== i))
                  }
                  className="text-discord-text-muted hover:text-discord-red px-2"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setRoleSlots((rs) => [...rs, emptyRoleSlot()])}
              className="text-discord-text-muted hover:text-discord-text self-start text-sm underline"
            >
              + Add role
            </button>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-semibold">
              Proposed times (optional — can also be added later in Discord)
            </span>
            {timeOptions.map((t, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2"
                  value={t}
                  onChange={(e) => updateTimeOption(i, e.target.value)}
                  placeholder="e.g. 19:00-21:00"
                />
                <button
                  type="button"
                  onClick={() =>
                    setTimeOptions((ts) => ts.filter((_, j) => j !== i))
                  }
                  className="text-discord-text-muted hover:text-discord-red px-2"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setTimeOptions((ts) => [...ts, ""])}
              className="text-discord-text-muted hover:text-discord-text self-start text-sm underline"
            >
              + Add time option
            </button>
          </div>

          <button
            type="button"
            onClick={submit}
            disabled={
              create.isPending ||
              title.trim() === "" ||
              channelId.trim() === "" ||
              roleSlots.every((r) => r.roleName.trim() === "")
            }
            className="bg-discord-brand self-start rounded-full px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {create.isPending ? "Creating..." : "Create event"}
          </button>
          {create.error && (
            <span className="text-discord-red text-sm">
              {create.error.message}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
