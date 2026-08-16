"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { classColor, relativeTime } from "~/lib/format";
import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";

type Member = RouterOutputs["guild"]["rosterMembers"][number];
type SortKey = "name" | "rank" | "level";

const ALL = "__all__";

function sortIndicator(sortKey: SortKey, key: SortKey, sortDesc: boolean) {
  if (sortKey !== key) return null;
  return sortDesc ? " ▼" : " ▲";
}

export function GuildRosterTable({
  guildId,
  members,
  isAdmin,
}: {
  guildId: string;
  members: Member[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState(ALL);
  const [rankFilter, setRankFilter] = useState(ALL);
  const [sortKey, setSortKey] = useState<SortKey>("level");
  const [sortDesc, setSortDesc] = useState(true);

  const clearClaim = api.guild.clearRosterClaim.useMutation({
    onSuccess: () => router.refresh(),
  });

  const classes = useMemo(
    () =>
      [...new Set(members.map((m) => m.class).filter((c): c is string => !!c))].sort(),
    [members],
  );
  const ranks = useMemo(
    () => [...new Set(members.map((m) => m.rank))].sort(),
    [members],
  );

  // Searching a name also pulls in every other character claimed by the
  // same Discord account (their alts) — not just an exact/substring name
  // match — so e.g. searching "Bubblekingen" surfaces their whole roster
  // footprint, not just that one row. Only meaningful for admins, since
  // claimedByDiscordUserId is stripped for everyone else.
  const { searchResults, altIds } = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return { searchResults: members, altIds: new Set<string>() };

    const nameMatches = members.filter((m) => m.name.toLowerCase().includes(query));
    if (!isAdmin) return { searchResults: nameMatches, altIds: new Set<string>() };

    const claimIds = new Set(
      nameMatches
        .map((m) => m.claimedByDiscordUserId)
        .filter((id): id is string => id != null),
    );
    const nameMatchIds = new Set(nameMatches.map((m) => m.id));
    const alts = members.filter(
      (m) =>
        m.claimedByDiscordUserId != null &&
        claimIds.has(m.claimedByDiscordUserId) &&
        !nameMatchIds.has(m.id),
    );
    return { searchResults: [...nameMatches, ...alts], altIds: new Set(alts.map((m) => m.id)) };
  }, [members, search, isAdmin]);

  const filtered = useMemo(
    () =>
      searchResults.filter(
        (m) =>
          (classFilter === ALL || m.class === classFilter) &&
          (rankFilter === ALL || m.rank === rankFilter),
      ),
    [searchResults, classFilter, rankFilter],
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

  const hasActiveFilters = search.trim() !== "" || classFilter !== ALL || rankFilter !== ALL;

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={
            isAdmin ? "Search name (shows their claimed alts too)" : "Search name"
          }
          className="rounded-full bg-discord-elevated px-3 py-1.5 text-sm text-discord-text placeholder:text-discord-text-muted"
        />
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
              setSearch("");
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
        // A bounded box that scrolls on both axes, not a container that
        // just grows the whole page taller — max-h caps vertical growth
        // (long rosters were stretching the page indefinitely), overflow-
        // auto scrolls whichever axis actually overflows, and the table
        // drops w-full so it can size to its content and exceed this box's
        // width when it needs to (a width-capped table has nowhere to grow
        // but into its own cells). Header cells are sticky so they stay
        // visible while scrolling down through a long roster.
        <div className="w-full max-h-[70vh] overflow-auto rounded-xl bg-discord-elevated">
          <table className="text-left text-sm">
            <thead>
              <tr className="border-b border-black/20 text-xs whitespace-nowrap text-discord-text-muted uppercase">
                <th className="sticky top-0 left-0 bg-discord-elevated px-4 py-2 text-right font-semibold">
                  #
                </th>
                <th
                  className="sticky top-0 cursor-pointer bg-discord-elevated px-4 py-2 font-semibold select-none"
                  onClick={() => toggleSort("name")}
                >
                  Name{sortIndicator(sortKey, "name", sortDesc)}
                </th>
                <th
                  className="sticky top-0 cursor-pointer bg-discord-elevated px-4 py-2 font-semibold select-none"
                  onClick={() => toggleSort("rank")}
                >
                  Rank{sortIndicator(sortKey, "rank", sortDesc)}
                </th>
                <th
                  className="sticky top-0 cursor-pointer bg-discord-elevated px-4 py-2 font-semibold select-none"
                  onClick={() => toggleSort("level")}
                >
                  Level{sortIndicator(sortKey, "level", sortDesc)}
                </th>
                <th className="sticky top-0 bg-discord-elevated px-4 py-2 font-semibold">
                  Professions
                </th>
                <th className="sticky top-0 bg-discord-elevated px-4 py-2 font-semibold">
                  Note
                </th>
                {isAdmin && (
                  <>
                    <th className="sticky top-0 bg-discord-elevated px-4 py-2 font-semibold">
                      Officer note
                    </th>
                    <th className="sticky top-0 bg-discord-elevated px-4 py-2 font-semibold">
                      Claimed by
                    </th>
                    <th className="sticky top-0 bg-discord-elevated px-4 py-2 font-semibold">
                      Last active
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {sorted.map((member, i) => (
                <tr
                  key={member.id}
                  className="border-b border-black/10 last:border-0"
                >
                  <td className="bg-discord-elevated sticky left-0 px-4 py-2 text-right text-discord-text-muted whitespace-nowrap">
                    {i + 1}
                  </td>
                  <td
                    className="px-4 py-2 font-semibold whitespace-nowrap"
                    style={{ color: classColor(member.class) }}
                  >
                    {member.name}
                    {altIds.has(member.id) && (
                      <span
                        title="Claimed by the same Discord account as one of your search matches."
                        className="ml-2 rounded-full bg-discord-elevated-hover px-2 py-0.5 text-xs font-normal text-discord-text-muted"
                      >
                        🔗 alt match
                      </span>
                    )}
                    {member.hasClaimConflict && (
                      <span
                        title="More than one Discord account has claimed to be this character during onboarding — only the first claim was granted roles."
                        className="ml-2 rounded-full bg-discord-red/20 px-2 py-0.5 text-xs font-normal text-discord-red"
                      >
                        ⚠ claim conflict
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap text-discord-text-muted">
                    {member.rank}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap text-discord-text-muted">
                    {member.level}
                  </td>
                  <td
                    className="max-w-[200px] truncate px-4 py-2 text-discord-text-muted"
                    title={member.professions.join(", ")}
                  >
                    {member.professions.length > 0
                      ? member.professions.join(", ")
                      : "—"}
                  </td>
                  <td
                    className="max-w-[200px] truncate px-4 py-2 text-discord-text-muted"
                    title={member.note ?? undefined}
                  >
                    {member.note}
                  </td>
                  {isAdmin && (
                    <>
                      <td
                        className="max-w-[200px] truncate px-4 py-2 text-discord-text-muted"
                        title={member.officerNote ?? undefined}
                      >
                        {member.officerNote}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-discord-text-muted">
                        {member.claimedByDiscordTag ? (
                          <div className="flex items-center gap-2">
                            <span>{member.claimedByDiscordTag}</span>
                            <button
                              type="button"
                              onClick={() =>
                                clearClaim.mutate({ guildId, rosterMemberId: member.id })
                              }
                              disabled={
                                clearClaim.isPending &&
                                clearClaim.variables?.rosterMemberId === member.id
                              }
                              className="rounded-full bg-discord-base px-2 py-0.5 text-xs hover:bg-discord-elevated-hover"
                              title="Un-claim this character so someone can claim it correctly via /onboarding"
                            >
                              Clear
                            </button>
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-discord-text-muted">
                        {member.lastActiveAt
                          ? relativeTime(new Date(member.lastActiveAt))
                          : "—"}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sorted.length > 0 && (
        <p className="text-xs text-discord-text-muted">{sorted.length} total</p>
      )}
    </div>
  );
}
