"use client";

import { useMemo, useState } from "react";

import { api } from "~/trpc/react";

type SortKey = "characterName" | "rank" | "discordNick" | "discordTag";

const ALL = "__all__";

function sortIndicator(sortKey: SortKey, key: SortKey, sortDesc: boolean) {
  if (sortKey !== key) return null;
  return sortDesc ? " ▼" : " ▲";
}

// Searchable/sortable/filterable table of every claimed roster character
// joined against their live Discord nickname/account name/roles — separate
// from the read-only roster table (guild-roster-table.tsx), which is about
// in-game data, not Discord identity. Purely a view: no mutations here.
export function GuildDiscordRolesTable({ guildId }: { guildId: string }) {
  const rows = api.guild.discordRolesTable.useQuery({ guildId });

  const [search, setSearch] = useState("");
  const [rankFilter, setRankFilter] = useState(ALL);
  const [roleFilter, setRoleFilter] = useState(ALL);
  const [sortKey, setSortKey] = useState<SortKey>("characterName");
  const [sortDesc, setSortDesc] = useState(false);

  const data = useMemo(() => rows.data ?? [], [rows.data]);

  const ranks = useMemo(() => [...new Set(data.map((r) => r.rank))].sort(), [data]);
  const roles = useMemo(
    () => [...new Set(data.flatMap((r) => r.roleNames))].sort(),
    [data],
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return data.filter((r) => {
      if (rankFilter !== ALL && r.rank !== rankFilter) return false;
      if (roleFilter !== ALL && !r.roleNames.includes(roleFilter)) return false;
      if (!query) return true;
      return (
        r.characterName.toLowerCase().includes(query) ||
        (r.discordNick?.toLowerCase().includes(query) ?? false) ||
        (r.discordTag?.toLowerCase().includes(query) ?? false)
      );
    });
  }, [data, search, rankFilter, roleFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = a[sortKey] ?? "";
      const bv = b[sortKey] ?? "";
      const cmp = av.localeCompare(bv);
      return sortDesc ? -cmp : cmp;
    });
    return copy;
  }, [filtered, sortKey, sortDesc]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(false);
    }
  }

  const hasActiveFilters = search.trim() !== "" || rankFilter !== ALL || roleFilter !== ALL;

  if (rows.isLoading) return null;
  if (data.length === 0) {
    return (
      <p className="text-discord-text-muted text-sm">
        No claimed characters yet — nothing to show here until someone runs /onboarding.
      </p>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search character, nick, or account name"
          className="rounded-full bg-discord-elevated px-3 py-1.5 text-sm text-discord-text placeholder:text-discord-text-muted"
        />
        <select
          className="rounded-full bg-discord-elevated px-3 py-1.5 text-sm text-discord-text"
          value={rankFilter}
          onChange={(e) => setRankFilter(e.target.value)}
        >
          <option value={ALL}>All ranks</option>
          {ranks.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select
          className="rounded-full bg-discord-elevated px-3 py-1.5 text-sm text-discord-text"
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
        >
          <option value={ALL}>All roles</option>
          {roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setRankFilter(ALL);
              setRoleFilter(ALL);
            }}
            className="rounded-full bg-discord-elevated px-3 py-1.5 text-sm text-discord-text-muted transition hover:bg-discord-elevated-hover"
          >
            Clear filters
          </button>
        )}
        <span className="ml-auto text-xs text-discord-text-muted">
          {sorted.length} of {data.length}
        </span>
      </div>

      {sorted.length === 0 ? (
        <div className="w-full rounded-xl bg-discord-elevated p-6 text-center text-discord-text-muted">
          No members match these filters.
        </div>
      ) : (
        <div className="w-full max-h-[70vh] overflow-auto rounded-xl bg-discord-elevated">
          <table className="text-left text-sm">
            <thead>
              <tr className="border-b border-black/20 text-xs whitespace-nowrap text-discord-text-muted uppercase">
                <th
                  className="sticky top-0 cursor-pointer bg-discord-elevated px-4 py-2 font-semibold select-none"
                  onClick={() => toggleSort("characterName")}
                >
                  Ing Name{sortIndicator(sortKey, "characterName", sortDesc)}
                </th>
                <th
                  className="sticky top-0 cursor-pointer bg-discord-elevated px-4 py-2 font-semibold select-none"
                  onClick={() => toggleSort("rank")}
                >
                  Guild Rank{sortIndicator(sortKey, "rank", sortDesc)}
                </th>
                <th
                  className="sticky top-0 cursor-pointer bg-discord-elevated px-4 py-2 font-semibold select-none"
                  onClick={() => toggleSort("discordNick")}
                >
                  Disc Nick{sortIndicator(sortKey, "discordNick", sortDesc)}
                </th>
                <th
                  className="sticky top-0 cursor-pointer bg-discord-elevated px-4 py-2 font-semibold select-none"
                  onClick={() => toggleSort("discordTag")}
                >
                  Disc Acc{sortIndicator(sortKey, "discordTag", sortDesc)}
                </th>
                <th className="sticky top-0 bg-discord-elevated px-4 py-2 font-semibold">
                  Disc Roles
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={row.id} className="border-b border-black/10 last:border-0">
                  <td className="px-4 py-2 font-semibold whitespace-nowrap">
                    {row.characterName}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap text-discord-text-muted">
                    {row.rank}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap text-discord-text-muted">
                    {row.discordNick ?? "—"}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap text-discord-text-muted">
                    {row.discordTag ?? "—"}
                  </td>
                  <td
                    className="max-w-[300px] truncate px-4 py-2 text-discord-text-muted"
                    title={row.roleNames.join(", ")}
                  >
                    {row.roleNames.length > 0 ? row.roleNames.join(", ") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
