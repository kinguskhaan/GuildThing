"use client";

import type { Dispatch, SetStateAction } from "react";

export interface RoleSlotDraft {
  roleName: string;
  capacity: string;
  emoji: string;
}

export function emptyRoleSlot(): RoleSlotDraft {
  return { roleName: "", capacity: "1", emoji: "" };
}

export function todayISODate(): string {
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

// The full set of fields shared by "create an event" (guild-events-form.tsx)
// and "edit an event" (guild-event-edit-form.tsx) — factored out so the two
// forms can never silently drift apart on what's editable. Purely
// presentational: all state lives in the caller, this just renders
// controlled inputs against it.
export function EventFormFields({
  title,
  setTitle,
  imageUrl,
  setImageUrl,
  date,
  setDate,
  repeatEnabled,
  setRepeatEnabled,
  repeatDays,
  setRepeatDays,
  description,
  setDescription,
  channelId,
  setChannelId,
  channels,
  roleSlots,
  setRoleSlots,
  timeOptions,
  setTimeOptions,
  allowTimeSuggestions,
  setAllowTimeSuggestions,
}: {
  title: string;
  setTitle: (v: string) => void;
  imageUrl: string;
  setImageUrl: (v: string) => void;
  date: string;
  setDate: (v: string) => void;
  repeatEnabled: boolean;
  setRepeatEnabled: (v: boolean) => void;
  repeatDays: string;
  setRepeatDays: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  channelId: string;
  setChannelId: (v: string) => void;
  channels: { id: string; name: string; type: "text" | "forum" }[] | undefined;
  roleSlots: RoleSlotDraft[];
  setRoleSlots: Dispatch<SetStateAction<RoleSlotDraft[]>>;
  timeOptions: string[];
  setTimeOptions: Dispatch<SetStateAction<string[]>>;
  allowTimeSuggestions: boolean;
  setAllowTimeSuggestions: (v: boolean) => void;
}) {
  function updateRoleSlot(index: number, patch: Partial<RoleSlotDraft>) {
    setRoleSlots((rs) =>
      rs.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    );
  }

  function updateTimeOption(index: number, value: string) {
    setTimeOptions((ts) => ts.map((t, i) => (i === index ? value : t)));
  }

  return (
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
      <label className="text-discord-text-muted flex items-center gap-1.5 text-sm">
        <input
          type="checkbox"
          checked={repeatEnabled}
          onChange={(e) => setRepeatEnabled(e.target.checked)}
        />
        Repeat every
        <input
          className="bg-discord-base text-discord-text w-16 rounded-full px-3 py-1 disabled:opacity-50"
          type="number"
          min={1}
          max={365}
          disabled={!repeatEnabled}
          value={repeatDays}
          onChange={(e) => setRepeatDays(e.target.value)}
        />
        days (spawns the next one automatically once this one expires)
      </label>
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
        channels={channels}
      />

      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold">Roles needed</span>
        {roleSlots.map((slot, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2"
              value={slot.roleName}
              onChange={(e) => updateRoleSlot(i, { roleName: e.target.value })}
              placeholder="Role (e.g. Tank)"
            />
            <input
              className="bg-discord-base text-discord-text w-20 rounded-full px-4 py-2"
              type="number"
              min={1}
              value={slot.capacity}
              onChange={(e) => updateRoleSlot(i, { capacity: e.target.value })}
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
              onClick={() => setRoleSlots((rs) => rs.filter((_, j) => j !== i))}
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
        <label className="text-discord-text-muted flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={allowTimeSuggestions}
            onChange={(e) => setAllowTimeSuggestions(e.target.checked)}
          />
          Allow people to suggest additional time options
        </label>
      </div>
    </div>
  );
}
