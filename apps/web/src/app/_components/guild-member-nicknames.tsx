"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";

type NicknameRow = RouterOutputs["guild"]["memberNicknames"][number];

export function GuildMemberNicknames({
  guildId,
  rows,
}: {
  guildId: string;
  rows: NicknameRow[];
}) {
  const [collapsed, setCollapsed] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const utils = api.useUtils();
  const setOverride = api.guild.setMemberNicknameOverride.useMutation({
    onSuccess: async () => utils.guild.memberNicknames.invalidate({ guildId }),
  });

  if (rows.length === 0) return null;

  function draftFor(row: NicknameRow): string {
    return drafts[row.id] ?? row.preferredNickname ?? "";
  }

  return (
    <div className="bg-discord-elevated flex w-full flex-col gap-2 rounded-xl p-4">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center justify-between text-left"
      >
        <h3 className="font-bold">Nicknames ({rows.length})</h3>
        <span className="text-discord-text-muted">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <>
          <p className="text-discord-text-muted text-sm">
            &quot;Computed&quot; is what onboarding would set with no
            override (main + included alts). &quot;Override&quot; replaces
            just the main-name slot — set by the member during onboarding, or
            here. Clearing it reverts them to the computed name.
          </p>
          <div className="max-h-96 overflow-auto rounded-lg">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="bg-discord-base sticky top-0 left-0 z-10 px-3 py-2 text-left font-semibold">
                    Discord account
                  </th>
                  <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                    Discord nickname
                  </th>
                  <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                    Computed
                  </th>
                  <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                    Override
                  </th>
                  <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                    Last active
                  </th>
                  <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                    {/* actions */}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-discord-base">
                    <td className="px-3 py-1.5 whitespace-nowrap font-semibold">
                      {row.discordUserTag}
                    </td>
                    <td
                      className="text-discord-text-muted max-w-[160px] truncate px-3 py-1.5"
                      title={row.currentDiscordNick ?? "No server nickname set"}
                    >
                      {row.currentDiscordNick ?? "—"}
                    </td>
                    <td
                      className="text-discord-text-muted max-w-[180px] truncate px-3 py-1.5"
                      title={row.computedName}
                    >
                      {row.computedName}
                    </td>
                    <td className="px-3 py-1.5">
                      <input
                        className="bg-discord-elevated text-discord-text w-40 rounded-full px-3 py-1"
                        value={draftFor(row)}
                        onChange={(e) =>
                          setDrafts((d) => ({ ...d, [row.id]: e.target.value }))
                        }
                        placeholder="No override"
                      />
                    </td>
                    <td
                      className="text-discord-text-muted px-3 py-1.5 whitespace-nowrap"
                      title={
                        row.lastActiveAt
                          ? new Date(row.lastActiveAt).toLocaleString()
                          : "No activity tracked yet"
                      }
                    >
                      {row.lastActiveAt
                        ? new Date(row.lastActiveAt).toLocaleDateString()
                        : "—"}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() =>
                            setOverride.mutate({
                              guildId,
                              discordUserId: row.discordUserId,
                              nickname:
                                draftFor(row).trim() === ""
                                  ? null
                                  : draftFor(row).trim(),
                            })
                          }
                          disabled={
                            setOverride.isPending &&
                            setOverride.variables?.discordUserId ===
                              row.discordUserId
                          }
                          className="bg-discord-elevated-hover rounded-full px-3 py-1 text-xs font-semibold"
                        >
                          Save
                        </button>
                        {row.preferredNickname && (
                          <button
                            type="button"
                            onClick={() => {
                              setDrafts((d) => ({ ...d, [row.id]: "" }));
                              setOverride.mutate({
                                guildId,
                                discordUserId: row.discordUserId,
                                nickname: null,
                              });
                            }}
                            disabled={
                              setOverride.isPending &&
                              setOverride.variables?.discordUserId ===
                                row.discordUserId
                            }
                            className="bg-discord-base hover:bg-discord-elevated-hover text-discord-text-muted rounded-full px-3 py-1 text-xs"
                            title="Revert to the computed name"
                          >
                            Reset
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {setOverride.error && (
            <p className="text-discord-red text-sm">
              {setOverride.error.message}
            </p>
          )}
          {setOverride.isSuccess && setOverride.data.applied === false && (
            <p className="text-discord-red text-sm">
              Saved, but couldn&apos;t apply it on Discord — check my role
              position, or the name may be too long.
            </p>
          )}
        </>
      )}
    </div>
  );
}
