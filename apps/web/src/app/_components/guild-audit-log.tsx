"use client";

import { useMemo, useState } from "react";

import { absoluteTime } from "~/lib/format";
import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";

type Entry = RouterOutputs["guild"]["auditLog"][number];

// One line of human-readable detail per entry kind — what actually
// happened, independent of the columns (which are about WHO it happened
// to, not what).
function eventText(entry: Entry): string {
  if (entry.kind === "rank_change") {
    return `Rank ${entry.oldRank ?? "?"} → ${entry.newRank}`;
  }
  if (entry.kind === "claim") {
    return `Claimed by ${entry.discordUserTag ?? "someone"}`;
  }
  const added = entry.addedRoleNames.length > 0 ? `+${entry.addedRoleNames.join(", ")}` : "";
  const removed = entry.removedRoleNames.length > 0 ? `-${entry.removedRoleNames.join(", ")}` : "";
  const by = entry.source === "bot" ? "the bot" : (entry.executorTag ?? "someone");
  return [added, removed].filter(Boolean).join(" ") + ` by ${by}`;
}

// Read-only — the unified feed exists for visibility, not for undoing
// anything here. Merges three sources chronologically: in-game rank
// transitions (GuildRankChangeEvent, from roster imports), every Discord
// role add/remove GuildThing has made — bot-driven or a human's manual
// edit the resync deliberately left alone ("senaste ändringen vinner" in
// roleSync.ts / roleLogic.ts) — (GuildRoleChangeEvent), and roster claims
// (GuildRosterMember.claimedAt). Also relayed into the addon's own Audit
// Log tab via apps/sync. Every entry carries characterName/discordNick/
// discordTag regardless of which side it originated from (resolved
// server-side in guild.auditLog), so search/columns work uniformly here.
export function GuildAuditLog({ guildId }: { guildId: string }) {
  const log = api.guild.auditLog.useQuery({ guildId });
  const [search, setSearch] = useState("");

  const data = useMemo(() => log.data ?? [], [log.data]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return data;
    return data.filter(
      (e) =>
        e.characterName.toLowerCase().includes(query) ||
        (e.discordNick?.toLowerCase().includes(query) ?? false) ||
        (e.discordTag?.toLowerCase().includes(query) ?? false),
    );
  }, [data, search]);

  if (data.length === 0) return null;

  return (
    <details className="bg-discord-elevated rounded-xl p-4 text-sm">
      <summary className="cursor-pointer font-bold">Audit log ({data.length})</summary>
      <p className="text-discord-text-muted mt-2 text-xs">
        Rank changes from roster imports, every Discord role change
        GuildThing has made (bot or human), and roster claims.
      </p>

      <div className="mt-3 flex items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search in-game name, Discord nick, or account"
          className="rounded-full bg-discord-base px-3 py-1.5 text-sm text-discord-text placeholder:text-discord-text-muted"
        />
        <span className="ml-auto text-xs text-discord-text-muted">
          {filtered.length} of {data.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="text-discord-text-muted mt-3 text-xs">No entries match that search.</p>
      ) : (
        <div className="mt-3 w-full max-h-[60vh] overflow-auto rounded-lg bg-discord-base">
          <table className="text-left text-sm">
            <thead>
              <tr className="border-b border-black/20 text-xs whitespace-nowrap text-discord-text-muted uppercase">
                <th className="sticky top-0 bg-discord-base px-3 py-2 font-semibold">When</th>
                <th className="sticky top-0 bg-discord-base px-3 py-2 font-semibold">Ing Name</th>
                <th className="sticky top-0 bg-discord-base px-3 py-2 font-semibold">Disc Nick</th>
                <th className="sticky top-0 bg-discord-base px-3 py-2 font-semibold">Disc Acc</th>
                <th className="sticky top-0 bg-discord-base px-3 py-2 font-semibold">Event</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => (
                <tr key={entry.id} className="border-b border-black/10 last:border-0">
                  <td className="font-[family-name:var(--font-arcade-mono)] px-3 py-2 text-xs whitespace-nowrap text-discord-text-muted">
                    {absoluteTime(new Date(entry.detectedAt))}
                  </td>
                  <td className="px-3 py-2 font-semibold whitespace-nowrap">
                    {entry.characterName}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-discord-text-muted">
                    {entry.discordNick ?? "—"}
                  </td>
                  <td className="font-[family-name:var(--font-arcade-mono)] px-3 py-2 text-xs whitespace-nowrap text-discord-text-muted">
                    {entry.discordTag ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-discord-text-muted">{eventText(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
