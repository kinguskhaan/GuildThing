"use client";

import { useRouter } from "next/navigation";

import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";

// Mirrors PENDING_MATCH_RETENTION_MS in apps/bot/src/pendingMatches.ts —
// keep these in sync if that ever changes.
const RETENTION_HOURS = 42;

type PendingMatch = RouterOutputs["guild"]["pendingRosterMatches"][number];

function hoursAgo(date: Date): number {
  return (Date.now() - date.getTime()) / (60 * 60_000);
}

export function GuildPendingMatches({
  guildId,
  entries,
}: {
  guildId: string;
  entries: PendingMatch[];
}) {
  const router = useRouter();
  const dismiss = api.guild.dismissPendingRosterMatch.useMutation({
    onSuccess: () => router.refresh(),
  });

  if (entries.length === 0) return null;

  return (
    <div className="flex w-full flex-col gap-2 rounded-xl bg-discord-elevated p-4">
      <h3 className="font-bold">
        Waiting on roster ({entries.length})
      </h3>
      <p className="text-sm text-discord-text-muted">
        These people onboarded with a name the bot couldn&apos;t find in the
        roster yet — it keeps retrying automatically for {RETENTION_HOURS}h,
        no action needed unless a name will never show up.
      </p>
      <ul className="flex flex-col gap-2">
        {entries.map((entry) => {
          const age = hoursAgo(entry.createdAt);
          const remaining = Math.max(0, RETENTION_HOURS - age);
          return (
            <li
              key={entry.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-discord-base px-3 py-2 text-sm"
            >
              <span>
                <span className="font-semibold">{entry.discordUserTag}</span>{" "}
                <span className="text-discord-text-muted">
                  typed {entry.names.map((n) => `\`${n}\``).join(", ")}
                </span>
              </span>
              <span className="flex items-center gap-2 text-discord-text-muted">
                {remaining > 0
                  ? `retrying for ~${Math.ceil(remaining)}h more`
                  : "expiring soon"}
                <button
                  type="button"
                  onClick={() => dismiss.mutate({ guildId, id: entry.id })}
                  disabled={dismiss.isPending && dismiss.variables?.id === entry.id}
                  className="rounded-full bg-discord-elevated px-2 py-0.5 text-xs hover:bg-discord-elevated-hover"
                  title="Stop retrying this one"
                >
                  Dismiss
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
