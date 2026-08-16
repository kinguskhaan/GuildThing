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
    <div className="flex w-full flex-col gap-2 rounded-xl bg-discord-elevated p-4">
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
          <p className="text-sm text-discord-text-muted">
            &quot;Computed&quot; is what onboarding would set with no
            override (main + included alts). &quot;Override&quot; replaces
            just the main-name slot — set by the member during onboarding, or
            here. Clearing it reverts them to the computed name.
          </p>
          <div className="flex flex-col gap-2">
            {rows.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center gap-2 rounded-lg bg-discord-base px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                  {row.discordUserTag}
                </span>
                <span
                  className="max-w-[160px] truncate text-xs text-discord-text-muted"
                  title={row.computedName}
                >
                  computed: {row.computedName}
                </span>
                <span
                  className="max-w-[140px] truncate text-xs text-discord-text-muted"
                  title={row.currentDiscordNick ?? "No server nickname set"}
                >
                  in Discord: {row.currentDiscordNick ?? "—"}
                </span>
                <span
                  className="text-xs text-discord-text-muted"
                  title={
                    row.lastActiveAt
                      ? new Date(row.lastActiveAt).toLocaleString()
                      : "No activity tracked yet"
                  }
                >
                  last active:{" "}
                  {row.lastActiveAt
                    ? new Date(row.lastActiveAt).toLocaleDateString()
                    : "—"}
                </span>
                <input
                  className="w-40 rounded-full bg-discord-elevated px-3 py-1 text-sm text-discord-text"
                  value={draftFor(row)}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [row.id]: e.target.value }))
                  }
                  placeholder="No override"
                />
                <button
                  type="button"
                  onClick={() =>
                    setOverride.mutate({
                      guildId,
                      discordUserId: row.discordUserId,
                      nickname:
                        draftFor(row).trim() === "" ? null : draftFor(row).trim(),
                    })
                  }
                  disabled={
                    setOverride.isPending &&
                    setOverride.variables?.discordUserId === row.discordUserId
                  }
                  className="rounded-full bg-discord-elevated-hover px-3 py-1 text-xs font-semibold"
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
                      setOverride.variables?.discordUserId === row.discordUserId
                    }
                    className="rounded-full bg-discord-base px-3 py-1 text-xs text-discord-text-muted hover:bg-discord-elevated-hover"
                    title="Revert to the computed name"
                  >
                    Reset
                  </button>
                )}
              </div>
            ))}
          </div>
          {setOverride.error && (
            <p className="text-sm text-discord-red">
              {setOverride.error.message}
            </p>
          )}
          {setOverride.isSuccess && setOverride.data.applied === false && (
            <p className="text-sm text-discord-red">
              Saved, but couldn&apos;t apply it on Discord — check my role
              position, or the name may be too long.
            </p>
          )}
        </>
      )}
    </div>
  );
}
