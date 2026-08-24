"use client";

import { useEffect, useState } from "react";

import { api } from "~/trpc/react";

import {
  EventFormFields,
  emptyRoleSlot,
  todayISODate,
  type RoleSlotDraft,
} from "~/app/_components/event-form-fields";

// Inline edit form for one existing event — GuildEventsList expands this in
// place of the row when its Edit button is clicked. Same field set and
// validation as GuildEventsForm's create flow (via the shared
// EventFormFields), just seeded from event.get instead of starting blank,
// and calling event.update instead of event.create.
export function GuildEventEditForm({
  guildId,
  eventId,
  onClose,
}: {
  guildId: string;
  eventId: string;
  onClose: () => void;
}) {
  const detail = api.event.get.useQuery({ guildId, id: eventId });

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

  // Seed local form state once detail.data arrives — a plain effect rather
  // than deriving render-time (this form owns its own edits from here on,
  // it shouldn't keep resetting if the query happens to refetch).
  useEffect(() => {
    if (!detail.data) return;
    const d = detail.data;
    setTitle(d.title);
    setImageUrl(d.imageUrl ?? "");
    setDate(d.date ?? todayISODate());
    setDescription(d.description ?? "");
    setAllowTimeSuggestions(d.allowTimeSuggestions);
    setRepeatEnabled(d.recurrenceIntervalDays != null);
    setRepeatDays(
      d.recurrenceIntervalDays ? String(d.recurrenceIntervalDays) : "7",
    );
    setChannelId(d.discordChannelId);
    setRoleSlots(
      d.roleSlots.length > 0
        ? d.roleSlots.map((r) => ({
            roleName: r.roleName,
            capacity: String(r.capacity),
            emoji: r.emoji ?? "",
          }))
        : [emptyRoleSlot()],
    );
    setTimeOptions(d.timeOptionLabels.length > 0 ? d.timeOptionLabels : [""]);
  }, [detail.data]);

  const channels = api.guild.discordChannelsForEvents.useQuery({ guildId });

  const utils = api.useUtils();
  const update = api.event.update.useMutation({
    onSuccess: async () => {
      await utils.event.list.invalidate({ guildId });
      onClose();
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

    update.mutate({
      guildId,
      id: eventId,
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

  if (detail.isPending) {
    return (
      <div className="bg-discord-elevated text-discord-text-muted w-full rounded-xl p-4 text-sm">
        Loading…
      </div>
    );
  }
  if (detail.error) {
    return (
      <div className="bg-discord-elevated text-discord-red w-full rounded-xl p-4 text-sm">
        {detail.error.message}
      </div>
    );
  }

  return (
    <div className="bg-discord-elevated flex w-full flex-col gap-2 rounded-xl p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-bold">Edit event</h3>
        <button
          type="button"
          onClick={onClose}
          className="text-discord-text-muted hover:text-discord-text text-sm"
        >
          ✕ Close
        </button>
      </div>

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

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={
            update.isPending ||
            title.trim() === "" ||
            channelId.trim() === "" ||
            roleSlots.every((r) => r.roleName.trim() === "")
          }
          className="bg-discord-brand self-start rounded-full px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {update.isPending ? "Saving..." : "Save changes"}
        </button>
        {update.error && (
          <span className="text-discord-red text-sm">
            {update.error.message}
          </span>
        )}
      </div>
    </div>
  );
}
