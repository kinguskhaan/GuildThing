"use client";

import { useMemo, useState } from "react";

import { GuildClaimCharacter, type ClaimPrefill } from "~/app/_components/guild-claim-character";
import { GuildMemberDetail } from "~/app/_components/guild-member-detail";
import { classColor, relativeTime } from "~/lib/format";
import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";

type Member = RouterOutputs["guild"]["rosterMembers"][number];
type NicknameRow = RouterOutputs["guild"]["memberNicknames"][number];
type UnclaimedMember = RouterOutputs["guild"]["unclaimedMembers"][number];
type Row =
  | { kind: "character"; data: Member }
  | { kind: "unclaimed"; data: UnclaimedMember };
type SortKey = "name" | "rank" | "level";
type ClaimStatus = "claimed" | "unclaimed" | "conflict" | "skipped" | "noCharacter";
type Activity = "7" | "14" | "30" | "never";

const ALL = "__all__";

function ariaSortFor(sortKey: SortKey, key: SortKey, sortDesc: boolean) {
  if (sortKey !== key) return "none" as const;
  return sortDesc ? ("descending" as const) : ("ascending" as const);
}

function sortIndicator(sortKey: SortKey, key: SortKey, sortDesc: boolean) {
  if (sortKey !== key) return null;
  return sortDesc ? " ▼" : " ▲";
}

function playerName(nickname: NicknameRow | undefined, fallback: string) {
  return nickname?.preferredNickname ?? nickname?.computedName ?? fallback;
}

function unclaimedPlayerName(u: UnclaimedMember) {
  return u.preferredNickname ?? u.computedName ?? u.tag;
}

function roleSyncSkipText(reason: NonNullable<Member["roleSyncSkipReason"]>): string {
  const changes = [
    reason.addedRoleNames.length > 0 ? `+${reason.addedRoleNames.join(", ")}` : "",
    reason.removedRoleNames.length > 0 ? `-${reason.removedRoleNames.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const who = reason.executorTag ?? "someone";
  return `Kept because ${who} manually changed roles (${changes}) ${relativeTime(new Date(reason.detectedAt))} — the automatic resync won't override that. Click for full history.`;
}

export function GuildRosterTable({
  guildId,
  members,
  isAdmin,
  lastRosterImportedAt,
  nicknameRows,
  unclaimedMembers,
}: {
  guildId: string;
  members: Member[];
  isAdmin: boolean;
  lastRosterImportedAt: Date | null;
  /** Admin-only; empty for everyone else. */
  nicknameRows: NicknameRow[];
  /** Admin-only; empty for everyone else. Rendered as synthetic "Unclaimed" rows. */
  unclaimedMembers: UnclaimedMember[];
}) {
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState(ALL);
  const [rankFilter, setRankFilter] = useState(ALL);
  const [professionFilter, setProfessionFilter] = useState(ALL);
  const [claimStatusFilter, setClaimStatusFilter] = useState<typeof ALL | ClaimStatus>(ALL);
  const [answerQuestion, setAnswerQuestion] = useState(ALL);
  const [answerValue, setAnswerValue] = useState(ALL);
  const [activityFilter, setActivityFilter] = useState<typeof ALL | Activity>(ALL);
  const [unclaimedRoleFilter, setUnclaimedRoleFilter] = useState("");
  const [assignRoleId, setAssignRoleId] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("level");
  const [sortDesc, setSortDesc] = useState(true);
  const [detailDiscordUserId, setDetailDiscordUserId] = useState<string | null>(null);
  const [claimOpen, setClaimOpen] = useState(false);
  const [claimPrefill, setClaimPrefill] = useState<ClaimPrefill>(null);

  const discordRoles = api.guild.discordRoles.useQuery(
    { guildId },
    { enabled: isAdmin && claimStatusFilter === "noCharacter" },
  );
  const remind = api.guild.remindUnclaimedMembers.useMutation();
  const assignRole = api.guild.assignRoleToMembers.useMutation();

  const nicknameByDiscordId = useMemo(
    () => new Map(nicknameRows.map((r) => [r.discordUserId, r])),
    [nicknameRows],
  );
  const altsByDiscordId = useMemo(() => {
    const map = new Map<string, Member[]>();
    for (const m of members) {
      if (!m.claimedByDiscordUserId) continue;
      const list = map.get(m.claimedByDiscordUserId) ?? [];
      list.push(m);
      map.set(m.claimedByDiscordUserId, list);
    }
    return map;
  }, [members]);

  const allRows = useMemo<Row[]>(
    () => [
      ...members.map((data): Row => ({ kind: "character", data })),
      ...unclaimedMembers.map((data): Row => ({ kind: "unclaimed", data })),
    ],
    [members, unclaimedMembers],
  );

  const classes = useMemo(
    () =>
      [...new Set(members.map((m) => m.class).filter((c): c is string => !!c))].sort(),
    [members],
  );
  const ranks = useMemo(
    () => [...new Set(members.map((m) => m.rank))].sort(),
    [members],
  );
  const professions = useMemo(
    () => [...new Set(members.flatMap((m) => m.professions))].sort(),
    [members],
  );

  // One column per distinct custom onboarding question that at least one
  // displayed member has answered — ordered by first appearance across
  // members (stable regardless of the current sort/filter), not by
  // creation date, since a question with zero answers yet just doesn't
  // show a column at all.
  const questionPrompts = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const m of members) {
      for (const a of m.customAnswers) {
        if (!seen.has(a.prompt)) {
          seen.add(a.prompt);
          ordered.push(a.prompt);
        }
      }
    }
    return ordered;
  }, [members]);

  const answerValues = useMemo(() => {
    if (answerQuestion === ALL) return [];
    return [
      ...new Set(
        members.flatMap((m) =>
          m.customAnswers.filter((a) => a.prompt === answerQuestion).map((a) => a.value),
        ),
      ),
    ].sort();
  }, [members, answerQuestion]);

  // Searching a name also pulls in every other character claimed by the
  // same Discord account (their alts) — not just an exact/substring name
  // match — so e.g. searching "Bubblekingen" surfaces their whole roster
  // footprint, not just that one row. Only meaningful for admins, since
  // claimedByDiscordUserId is stripped for everyone else. Unclaimed rows
  // match on their Discord tag/nickname instead of a character name.
  const { searchResults, altIds } = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return { searchResults: allRows, altIds: new Set<string>() };

    const directMatches = allRows.filter((r) =>
      r.kind === "character"
        ? r.data.name.toLowerCase().includes(query)
        : r.data.tag.toLowerCase().includes(query) ||
          (r.data.computedName?.toLowerCase().includes(query) ?? false) ||
          (r.data.preferredNickname?.toLowerCase().includes(query) ?? false),
    );
    if (!isAdmin) return { searchResults: directMatches, altIds: new Set<string>() };

    const claimIds = new Set(
      directMatches
        .filter((r): r is Extract<Row, { kind: "character" }> => r.kind === "character")
        .map((r) => r.data.claimedByDiscordUserId)
        .filter((id): id is string => id != null),
    );
    const matchIds = new Set(directMatches.map((r) => r.data.id));
    const alts = allRows.filter(
      (r) =>
        r.kind === "character" &&
        r.data.claimedByDiscordUserId != null &&
        claimIds.has(r.data.claimedByDiscordUserId) &&
        !matchIds.has(r.data.id),
    );
    return {
      searchResults: [...directMatches, ...alts],
      altIds: new Set(alts.map((r) => r.data.id)),
    };
  }, [allRows, search, isAdmin]);

  const filtered = useMemo(
    () =>
      searchResults.filter((r) => {
        if (r.kind === "unclaimed") {
          if (claimStatusFilter !== ALL && claimStatusFilter !== "noCharacter") return false;
          if (classFilter !== ALL || rankFilter !== ALL || professionFilter !== ALL) return false;
          if (answerQuestion !== ALL || activityFilter !== ALL) return false;
          if (unclaimedRoleFilter && !r.data.roleIds.includes(unclaimedRoleFilter)) return false;
          return true;
        }
        if (claimStatusFilter === "noCharacter") return false;
        const m = r.data;
        if (classFilter !== ALL && m.class !== classFilter) return false;
        if (rankFilter !== ALL && m.rank !== rankFilter) return false;
        if (professionFilter !== ALL && !m.professions.includes(professionFilter)) return false;
        if (claimStatusFilter !== ALL) {
          if (claimStatusFilter === "claimed" && !m.claimedByDiscordUserId) return false;
          if (claimStatusFilter === "unclaimed" && m.claimedByDiscordUserId) return false;
          if (claimStatusFilter === "conflict" && !m.hasClaimConflict) return false;
          if (claimStatusFilter === "skipped" && !m.roleSyncSkipReason) return false;
        }
        if (answerQuestion !== ALL) {
          const answer = m.customAnswers.find((a) => a.prompt === answerQuestion);
          if (!answer) return false;
          if (answerValue !== ALL && answer.value !== answerValue) return false;
        }
        if (activityFilter !== ALL) {
          if (activityFilter === "never") {
            if (m.lastActiveAt) return false;
          } else {
            if (!m.lastActiveAt) return false;
            const days = Number(activityFilter);
            const inactiveDays = (Date.now() - new Date(m.lastActiveAt).getTime()) / 86_400_000;
            if (inactiveDays < days) return false;
          }
        }
        return true;
      }),
    [
      searchResults,
      classFilter,
      rankFilter,
      professionFilter,
      claimStatusFilter,
      answerQuestion,
      answerValue,
      activityFilter,
      unclaimedRoleFilter,
    ],
  );

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const aName = a.kind === "character" ? a.data.name : "Unclaimed";
      const bName = b.kind === "character" ? b.data.name : "Unclaimed";
      const aRank = a.kind === "character" ? a.data.rank : "";
      const bRank = b.kind === "character" ? b.data.rank : "";
      const aLevel = a.kind === "character" ? a.data.level : -1;
      const bLevel = b.kind === "character" ? b.data.level : -1;
      const cmp =
        sortKey === "name"
          ? aName.localeCompare(bName)
          : sortKey === "rank"
            ? aRank.localeCompare(bRank)
            : aLevel - bLevel;
      return sortDesc ? -cmp : cmp;
    });
    return copy;
  }, [filtered, sortKey, sortDesc]);

  const unclaimedInView = useMemo(
    () => sorted.flatMap((r) => (r.kind === "unclaimed" ? [r.data] : [])),
    [sorted],
  );

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(false);
    }
  }

  function openClaim(prefill: ClaimPrefill) {
    setClaimPrefill(prefill);
    setClaimOpen(true);
  }

  const hasActiveFilters =
    search.trim() !== "" ||
    classFilter !== ALL ||
    rankFilter !== ALL ||
    professionFilter !== ALL ||
    claimStatusFilter !== ALL ||
    answerQuestion !== ALL ||
    activityFilter !== ALL;

  function clearFilters() {
    setSearch("");
    setClassFilter(ALL);
    setRankFilter(ALL);
    setProfessionFilter(ALL);
    setClaimStatusFilter(ALL);
    setAnswerQuestion(ALL);
    setAnswerValue(ALL);
    setActivityFilter(ALL);
    setUnclaimedRoleFilter("");
  }

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
        {professions.length > 0 && (
          <select
            className="rounded-full bg-discord-elevated px-3 py-1.5 text-sm text-discord-text"
            value={professionFilter}
            onChange={(e) => setProfessionFilter(e.target.value)}
          >
            <option value={ALL}>All professions</option>
            {professions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
        {isAdmin && (
          <select
            className="rounded-full bg-discord-elevated px-3 py-1.5 text-sm text-discord-text"
            value={claimStatusFilter}
            onChange={(e) => setClaimStatusFilter(e.target.value as typeof ALL | ClaimStatus)}
          >
            <option value={ALL}>Any claim status</option>
            <option value="claimed">Claimed</option>
            <option value="unclaimed">Unclaimed</option>
            <option value="conflict">Claim conflict</option>
            <option value="skipped">Role sync skipped</option>
            <option value="noCharacter">No character yet ({unclaimedMembers.length})</option>
          </select>
        )}
        {questionPrompts.length > 0 && (
          <>
            <select
              className="rounded-full bg-discord-elevated px-3 py-1.5 text-sm text-discord-text"
              value={answerQuestion}
              onChange={(e) => {
                setAnswerQuestion(e.target.value);
                setAnswerValue(ALL);
              }}
            >
              <option value={ALL}>Any onboarding answer</option>
              {questionPrompts.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            {answerQuestion !== ALL && (
              <select
                className="rounded-full bg-discord-elevated px-3 py-1.5 text-sm text-discord-text"
                value={answerValue}
                onChange={(e) => setAnswerValue(e.target.value)}
              >
                <option value={ALL}>Any answer</option>
                {answerValues.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
        {isAdmin && (
          <select
            className="rounded-full bg-discord-elevated px-3 py-1.5 text-sm text-discord-text"
            value={activityFilter}
            onChange={(e) => setActivityFilter(e.target.value as typeof ALL | Activity)}
          >
            <option value={ALL}>Any activity</option>
            <option value="7">Inactive 7+ days</option>
            <option value="14">Inactive 14+ days</option>
            <option value="30">Inactive 30+ days</option>
            <option value="never">Never active</option>
          </select>
        )}
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-full bg-discord-elevated px-3 py-1.5 text-sm text-discord-text-muted transition hover:bg-discord-elevated-hover"
          >
            Clear filters
          </button>
        )}
        {isAdmin && (
          <div className="flex flex-nowrap items-center gap-2 whitespace-nowrap">
            <button
              type="button"
              onClick={() => openClaim(null)}
              className="text-sm text-discord-link hover:underline"
            >
              + Claim a character
            </button>
            {claimStatusFilter === "noCharacter" ? (
              <button
                type="button"
                onClick={() => setClaimStatusFilter(ALL)}
                className="text-sm text-discord-link hover:underline"
              >
                Show whole roster
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setClaimStatusFilter("noCharacter")}
                title="Show who hasn't claimed a character yet — you can DM them a reminder"
                className="text-sm text-discord-text-muted hover:underline"
              >
                {unclaimedMembers.length} unclaimed
              </button>
            )}
          </div>
        )}
        <span className="ml-auto text-xs text-discord-text-muted">
          {sorted.length} of {allRows.length}
          {lastRosterImportedAt && (
            <> · Last synced {relativeTime(new Date(lastRosterImportedAt))}</>
          )}
        </span>
      </div>

      {isAdmin && claimStatusFilter === "noCharacter" && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-discord-elevated p-3">
          <span className="text-sm text-discord-text-muted">
            {unclaimedInView.length} haven&apos;t claimed a character
          </span>
          <select
            className="rounded-full bg-discord-base px-3 py-1.5 text-sm text-discord-text"
            value={unclaimedRoleFilter}
            onChange={(e) => setUnclaimedRoleFilter(e.target.value)}
          >
            <option value="">Filter by Discord role (all)</option>
            {discordRoles.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() =>
              remind.mutate({ guildId, memberIds: unclaimedInView.map((u) => u.id) })
            }
            disabled={remind.isPending || unclaimedInView.length === 0}
            className="rounded-full bg-discord-elevated-hover px-4 py-1.5 text-sm font-semibold"
          >
            {remind.isPending ? "Sending..." : `DM ${unclaimedInView.length} a reminder`}
          </button>
          {remind.isSuccess && (
            <span className="text-sm text-discord-text-muted">
              Sent to {remind.data.sent}, failed for {remind.data.failed}
            </span>
          )}
          <select
            className="rounded-full bg-discord-base px-3 py-1.5 text-sm text-discord-text"
            value={assignRoleId}
            onChange={(e) => setAssignRoleId(e.target.value)}
          >
            <option value="">Select a role to assign</option>
            {discordRoles.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() =>
              assignRole.mutate({
                guildId,
                memberIds: unclaimedInView.map((u) => u.id),
                discordRoleId: assignRoleId,
              })
            }
            disabled={
              assignRole.isPending || assignRoleId.trim() === "" || unclaimedInView.length === 0
            }
            className="rounded-full bg-discord-elevated-hover px-4 py-1.5 text-sm font-semibold"
          >
            {assignRole.isPending ? "Assigning..." : `Assign to ${unclaimedInView.length}`}
          </button>
          {assignRole.isSuccess && (
            <span className="text-sm text-discord-text-muted">
              Assigned to {assignRole.data.succeeded}, failed for {assignRole.data.failed}
            </span>
          )}
        </div>
      )}

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
                  aria-sort={ariaSortFor(sortKey, "name", sortDesc)}
                  className="sticky top-0 bg-discord-elevated px-4 py-2 font-semibold select-none"
                >
                  <button
                    type="button"
                    onClick={() => toggleSort("name")}
                    className="cursor-pointer bg-transparent p-0 font-semibold"
                  >
                    Name{sortIndicator(sortKey, "name", sortDesc)}
                  </button>
                </th>
                <th
                  aria-sort={ariaSortFor(sortKey, "rank", sortDesc)}
                  className="sticky top-0 bg-discord-elevated px-4 py-2 font-semibold select-none"
                >
                  <button
                    type="button"
                    onClick={() => toggleSort("rank")}
                    className="cursor-pointer bg-transparent p-0 font-semibold"
                  >
                    Rank{sortIndicator(sortKey, "rank", sortDesc)}
                  </button>
                </th>
                <th
                  aria-sort={ariaSortFor(sortKey, "level", sortDesc)}
                  className="sticky top-0 bg-discord-elevated px-4 py-2 font-semibold select-none"
                >
                  <button
                    type="button"
                    onClick={() => toggleSort("level")}
                    className="cursor-pointer bg-transparent p-0 font-semibold"
                  >
                    Level{sortIndicator(sortKey, "level", sortDesc)}
                  </button>
                </th>
                <th className="sticky top-0 bg-discord-elevated px-4 py-2 font-semibold">
                  Professions
                </th>
                <th className="sticky top-0 bg-discord-elevated px-4 py-2 font-semibold">
                  Note
                </th>
                {questionPrompts.map((prompt) => (
                  <th
                    key={prompt}
                    title={prompt}
                    className="sticky top-0 max-w-[160px] truncate bg-discord-elevated px-4 py-2 font-semibold normal-case"
                  >
                    {prompt}
                  </th>
                ))}
                {isAdmin && (
                  <>
                    <th className="sticky top-0 bg-discord-elevated px-4 py-2 font-semibold">
                      Officer note
                    </th>
                    <th className="sticky top-0 bg-discord-elevated px-4 py-2 font-semibold">
                      Player
                    </th>
                    <th className="sticky top-0 bg-discord-elevated px-4 py-2 font-semibold">
                      Last active
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => {
                if (row.kind === "unclaimed") {
                  const u = row.data;
                  return (
                    <tr key={`unclaimed-${u.id}`} className="border-b border-black/10 last:border-0">
                      <td className="bg-discord-elevated sticky left-0 px-4 py-2 text-right text-discord-text-muted whitespace-nowrap">
                        {i + 1}
                      </td>
                      <td className="px-4 py-2 text-discord-text-muted italic whitespace-nowrap">
                        Unclaimed
                      </td>
                      <td className="px-4 py-2 text-discord-text-muted">—</td>
                      <td className="px-4 py-2 text-discord-text-muted">—</td>
                      <td className="px-4 py-2 text-discord-text-muted">—</td>
                      <td className="px-4 py-2 text-discord-text-muted">—</td>
                      {questionPrompts.map((prompt) => (
                        <td key={prompt} className="px-4 py-2 text-discord-text-muted">
                          —
                        </td>
                      ))}
                      {isAdmin && (
                        <>
                          <td className="px-4 py-2 text-discord-text-muted">—</td>
                          <td className="px-4 py-2 whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() =>
                                openClaim({
                                  discordUserId: u.id,
                                  tag: u.tag,
                                  computedName: u.computedName,
                                  preferredNickname: u.preferredNickname,
                                })
                              }
                              title="Claim a character for this person"
                              className="flex items-center gap-1.5 rounded-full bg-discord-base px-2.5 py-1 font-medium text-discord-text transition hover:bg-discord-brand hover:text-white"
                            >
                              {unclaimedPlayerName(u)}
                            </button>
                          </td>
                          <td className="px-4 py-2 text-discord-text-muted">—</td>
                        </>
                      )}
                    </tr>
                  );
                }

                const member = row.data;
                return (
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
                    {member.roleSyncSkipReason &&
                      (isAdmin && member.claimedByDiscordUserId ? (
                        <button
                          type="button"
                          onClick={() =>
                            setDetailDiscordUserId(member.claimedByDiscordUserId)
                          }
                          title={roleSyncSkipText(member.roleSyncSkipReason)}
                          className="ml-2 rounded-full bg-discord-elevated-hover px-2 py-0.5 text-xs font-normal text-discord-text-muted underline decoration-dotted hover:bg-discord-brand hover:text-white hover:no-underline"
                        >
                          ✋ skipped: {member.roleSyncSkipReason.executorTag ?? "manual change"}
                        </button>
                      ) : (
                        <span
                          title="Someone manually changed this person's Discord roles more recently than their last rank change — the automatic resync is skipping them so it doesn't overwrite that."
                          className="ml-2 rounded-full bg-discord-elevated-hover px-2 py-0.5 text-xs font-normal text-discord-text-muted"
                        >
                          ✋ role sync skipped
                        </span>
                      ))}
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
                  {questionPrompts.map((prompt) => {
                    const answer = member.customAnswers.find(
                      (a) => a.prompt === prompt,
                    );
                    return (
                      <td
                        key={prompt}
                        className="max-w-[200px] truncate px-4 py-2 text-discord-text-muted"
                        title={answer?.value}
                      >
                        {answer?.value ?? "—"}
                      </td>
                    );
                  })}
                  {isAdmin && (
                    <>
                      <td
                        className="max-w-[200px] truncate px-4 py-2 text-discord-text-muted"
                        title={member.officerNote ?? undefined}
                      >
                        {member.officerNote}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {member.claimedByDiscordUserId ? (
                          <button
                            type="button"
                            onClick={() =>
                              setDetailDiscordUserId(member.claimedByDiscordUserId)
                            }
                            className="flex items-center gap-1.5 rounded-full bg-discord-base px-2.5 py-1 text-discord-text-muted transition hover:bg-discord-elevated-hover hover:text-discord-text"
                          >
                            <span className="font-medium text-discord-text">
                              {playerName(
                                nicknameByDiscordId.get(member.claimedByDiscordUserId),
                                member.claimedByDiscordTag ?? "?",
                              )}
                            </span>
                            {(altsByDiscordId.get(member.claimedByDiscordUserId)?.length ?? 0) >
                              1 && (
                              <span className="text-xs">
                                +
                                {altsByDiscordId.get(member.claimedByDiscordUserId)!.length - 1}
                              </span>
                            )}
                          </button>
                        ) : (
                          <span className="text-discord-text-muted">—</span>
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {isAdmin && (
        <GuildMemberDetail
          guildId={guildId}
          discordUserId={detailDiscordUserId}
          allMembers={members}
          nicknameRow={
            detailDiscordUserId ? nicknameByDiscordId.get(detailDiscordUserId) : undefined
          }
          onClose={() => setDetailDiscordUserId(null)}
        />
      )}

      {isAdmin && (
        <GuildClaimCharacter
          guildId={guildId}
          open={claimOpen}
          prefill={claimPrefill}
          onClose={() => {
            setClaimOpen(false);
            setClaimPrefill(null);
          }}
        />
      )}
    </div>
  );
}
