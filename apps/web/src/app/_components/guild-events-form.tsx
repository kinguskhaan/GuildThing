"use client";

import { useState } from "react";

import { api } from "~/trpc/react";

import {
  EventFormFields,
  emptyRoleSlot,
  todayISODate,
  type RoleSlotDraft,
} from "~/app/_components/event-form-fields";

export function GuildEventsForm({ guildId }: { guildId: string }) {
  const [collapsed, setCollapsed] = useState(true);
  const [title, setTitle] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [date, setDate] = useState(todayISODate);
  const [description, setDescription] = useState("");
  const [allowTimeSuggestions, setAllowTimeSuggestions] = useState(true);
  const [repeatEnabled, setRepeatEnabled] = useState(false);
  const [repeatDays, setRepeatDays] = useState("7");
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
      setAllowTimeSuggestions(true);
      setRepeatEnabled(false);
      setRepeatDays("7");
      setRoleSlots([emptyRoleSlot()]);
      setTimeOptions([""]);
      setCollapsed(true);
    },
  });

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
      allowTimeSuggestions,
      recurrenceIntervalDays:
        repeatEnabled && Number(repeatDays) > 0
          ? Math.trunc(Number(repeatDays))
          : undefined,
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
        <>
          <EventFormFields
            title={title}
            setTitle={setTitle}
            imageUrl={imageUrl}
            setImageUrl={setImageUrl}
            date={date}
            setDate={setDate}
            repeatEnabled={repeatEnabled}
            setRepeatEnabled={setRepeatEnabled}
            repeatDays={repeatDays}
            setRepeatDays={setRepeatDays}
            description={description}
            setDescription={setDescription}
            channelId={channelId}
            setChannelId={setChannelId}
            channels={channels.data}
            roleSlots={roleSlots}
            setRoleSlots={setRoleSlots}
            timeOptions={timeOptions}
            setTimeOptions={setTimeOptions}
            allowTimeSuggestions={allowTimeSuggestions}
            setAllowTimeSuggestions={setAllowTimeSuggestions}
          />

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
        </>
      )}
    </div>
  );
}
