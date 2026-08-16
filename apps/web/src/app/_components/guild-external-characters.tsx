"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";

type ExternalCharacter = RouterOutputs["guild"]["externalCharacters"][number];

// Real, Battle.net-verified characters someone typed during onboarding that
// aren't a member of THIS guild (wrong guild, or none) — see the "real
// character(s), but not a member of this guild" admin notices. They don't
// show up anywhere in rosterMembers/unclaimedMembers (those are strictly
// this guild's own roster), so this is the only place to see them: who typed
// them, their level/class, and where they actually are (if anywhere).
export function GuildExternalCharacters({
  guildId,
  rows,
}: {
  guildId: string;
  rows: ExternalCharacter[];
}) {
  const [collapsed, setCollapsed] = useState(true);
  const utils = api.useUtils();
  const dismiss = api.guild.dismissExternalCharacter.useMutation({
    onSuccess: async () =>
      utils.guild.externalCharacters.invalidate({ guildId }),
  });

  if (rows.length === 0) return null;

  return (
    <div className="bg-discord-elevated flex w-full flex-col gap-2 rounded-xl p-4">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center justify-between text-left"
      >
        <h3 className="font-bold">External characters ({rows.length})</h3>
        <span className="text-discord-text-muted">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <>
          <p className="text-discord-text-muted text-sm">
            Real characters (Battle.net-verified) typed during onboarding
            that aren&apos;t a member of this guild — granted level-range
            channel access only, no roles. Auto-promotes to a full claim if
            the character ever shows up in an addon import.
          </p>
          <div className="max-h-96 overflow-auto rounded-lg">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                    Discord account
                  </th>
                  <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                    Character
                  </th>
                  <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                    Level
                  </th>
                  <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                    Class
                  </th>
                  <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                    Actual guild
                  </th>
                  <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                    Seen
                  </th>
                  <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-discord-base">
                    <td className="px-3 py-1.5 whitespace-nowrap font-semibold">
                      {row.discordUserTag}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {row.name}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {row.level}
                    </td>
                    <td className="text-discord-text-muted px-3 py-1.5 whitespace-nowrap">
                      {row.class ?? "—"}
                    </td>
                    <td className="text-discord-text-muted px-3 py-1.5 whitespace-nowrap">
                      {row.actualGuildName ?? "No guild"}
                    </td>
                    <td className="text-discord-text-muted px-3 py-1.5 whitespace-nowrap">
                      {new Date(row.claimedAt).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => dismiss.mutate({ guildId, id: row.id })}
                        disabled={dismiss.isPending}
                        className="text-discord-text-muted hover:text-discord-red text-xs underline disabled:opacity-50"
                        title="Stop tracking this character"
                      >
                        Dismiss
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
