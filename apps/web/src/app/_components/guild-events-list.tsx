"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";

import { GuildEventEditForm } from "~/app/_components/guild-event-edit-form";

type EventRow = RouterOutputs["event"]["list"][number];

function statusBadge(status: string): { text: string; className: string } {
  if (status === "cancelled") {
    return {
      text: "Cancelled",
      className: "bg-discord-red/20 text-discord-red",
    };
  }
  if (status === "locked") {
    return { text: "Locked in", className: "bg-green-900/40 text-green-400" };
  }
  return { text: "Open", className: "bg-discord-brand/20 text-discord-brand" };
}

export function GuildEventsList({
  guildId,
  events,
  isAdmin,
}: {
  guildId: string;
  events: EventRow[];
  isAdmin: boolean;
}) {
  const utils = api.useUtils();
  const cancel = api.event.cancel.useMutation({
    onSuccess: async () => utils.event.list.invalidate({ guildId }),
  });
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <ul className="flex w-full flex-col gap-2">
      {events.map((event) => {
        if (editingId === event.id) {
          return (
            <li key={event.id}>
              <GuildEventEditForm
                guildId={guildId}
                eventId={event.id}
                onClose={() => setEditingId(null)}
              />
            </li>
          );
        }

        const badge = statusBadge(event.status);
        return (
          <li
            key={event.id}
            className="bg-discord-elevated flex items-center justify-between gap-3 rounded-xl p-4"
          >
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{event.title}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${badge.className}`}
                >
                  {badge.text}
                </span>
              </div>
              <span className="text-discord-text-muted text-sm">
                {event.date ? `📅 ${event.date} — ` : ""}
                {event.totalSignups}/{event.totalCapacity} signed up
                {event.timeOptionCount > 0
                  ? `, ${event.timeOptionCount} time option${event.timeOptionCount === 1 ? "" : "s"}`
                  : ""}
                {event.recurrenceIntervalDays
                  ? ` — 🔁 every ${event.recurrenceIntervalDays}d`
                  : ""}
              </span>
              <span className="text-discord-text-muted text-xs">
                Created by {event.createdByDiscordTag} in{" "}
                <code>#{event.discordChannelId}</code>
              </span>
            </div>
            {isAdmin && event.status === "open" && (
              <div className="flex shrink-0 items-center gap-3">
                <button
                  type="button"
                  onClick={() => setEditingId(event.id)}
                  className="text-discord-text-muted hover:text-discord-text text-sm underline"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => cancel.mutate({ guildId, id: event.id })}
                  disabled={cancel.isPending}
                  className="text-discord-text-muted hover:text-discord-red text-sm underline disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
