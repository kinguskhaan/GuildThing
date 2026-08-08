"use client";

import { useMemo, useState } from "react";

import { classColor } from "~/lib/format";
import type { RouterOutputs } from "~/trpc/react";

type Member = RouterOutputs["guild"]["rosterMembers"][number];
type SortKey = "name" | "rank" | "level";

const ALL = "__all__";

function sortIndicator(sortKey: SortKey, key: SortKey, sortDesc: boolean) {
  if (sortKey !== key) return null;
  return sortDesc ? " ▼" : " ▲";
}

export function GuildRosterTable({
  members,
  isAdmin,
}: {
  members: Member[];
  isAdmin: boolean;
}) {
  const [classFilter, setClassFilter] = useState(ALL);
  const [rankFilter, setRankFilter] = useState(ALL);
  const [sortKey, setSortKey] = useState<SortKey>("level");
  const [sortDesc, setSortDesc] = useState(true);

  const classes = useMemo(
    () =>
      [...new Set(members.map((m) => m.class).filter((c): c is string => !!c))].sort(),
    [members],
  );
  const ranks = useMemo(
    () => [...new Set(members.map((m) => m.rank))].sort(),
    [members],
  );

  const filtered = useMemo(
    () =>
      members.filter(
        (m) =>
          (classFilter === ALL || m.class === classFilter) &&
          (rankFilter === ALL || m.rank === rankFilter),
      ),
    [members, classFilter, rankFilter],
  );

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const cmp =
        sortKey === "name"
          ? a.name.localeCompare(b.name)
          : sortKey === "rank"
            ? a.rank.localeCompare(b.rank)
            : a.level - b.level;
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

  const hasActiveFilters = classFilter !== ALL || rankFilter !== ALL;

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded-full bg-discord-elevated px-3 py-1.5 text-sm text-discord-text"
          value={classFilter}
          onChange={(e) => setClassFilter(e.target.value)}
        >
          <option value={ALL}>All classes</option>
          {classes.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
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
        {hasActiveFilters && (
          <button
            type="button"
            onClick={() => {
              setClassFilter(ALL);
              setRankFilter(ALL);
            }}
            className="rounded-full bg-discord-elevated px-3 py-1.5 text-sm text-discord-text-muted transition hover:bg-discord-elevated-hover"
          >
            Clear filters
          </button>
        )}
        <span className="ml-auto text-xs text-discord-text-muted">
          {sorted.length} of {members.length}
        </span>
      </div>

      {sorted.length === 0 ? (
        <div className="w-full rounded-xl bg-discord-elevated p-6 text-center text-discord-text-muted">
          No members match these filters.
        </div>
      ) : (
        <div className="w-full overflow-hidden rounded-xl bg-discord-elevated">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-black/20 text-xs uppercase text-discord-text-muted">
                <th
                  className="cursor-pointer select-none px-4 py-2 font-semibold"
                  onClick={() => toggleSort("name")}
                >
                  Name{sortIndicator(sortKey, "name", sortDesc)}
                </th>
                <th
                  className="cursor-pointer select-none px-4 py-2 font-semibold"
                  onClick={() => toggleSort("rank")}
                >
                  Rank{sortIndicator(sortKey, "rank", sortDesc)}
                </th>
                <th
                  className="cursor-pointer select-none px-4 py-2 font-semibold"
                  onClick={() => toggleSort("level")}
                >
                  Level{sortIndicator(sortKey, "level", sortDesc)}
                </th>
                <th className="px-4 py-2 font-semibold">Note</th>
                {isAdmin && (
                  <th className="px-4 py-2 font-semibold">Officer note</th>
                )}
              </tr>
            </thead>
            <tbody>
              {sorted.map((member) => (
                <tr
                  key={member.id}
                  className="border-b border-black/10 last:border-0"
                >
                  <td
                    className="px-4 py-2 font-semibold"
                    style={{ color: classColor(member.class) }}
                  >
                    {member.name}
                  </td>
                  <td className="px-4 py-2 text-discord-text-muted">
                    {member.rank}
                  </td>
                  <td className="px-4 py-2 text-discord-text-muted">
                    {member.level}
                  </td>
                  <td className="px-4 py-2 text-discord-text-muted">
                    {member.note}
                  </td>
                  {isAdmin && (
                    <td className="px-4 py-2 text-discord-text-muted">
                      {member.officerNote}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
