"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { absoluteTime } from "~/lib/format";
import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";

const ALL = "__all__";

type AuditEntry = RouterOutputs["guild"]["auditLog"][number];

// Falls back to a plain text input if the bot hasn't been invited to the
// server yet (or the role list is still loading) — the admin isn't blocked
// from pasting a raw ID in the meantime, just doesn't get the nicer picker.
export function RoleSelect({
  value,
  onChange,
  roles,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  roles: { id: string; name: string }[] | undefined;
  placeholder: string;
  disabled?: boolean;
}) {
  if (!roles || roles.length === 0) {
    return (
      <input
        className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2 disabled:opacity-50"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Discord role ID (invite the bot to pick from a list instead)"
        disabled={disabled}
      />
    );
  }
  return (
    <select
      className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2 disabled:opacity-50"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    >
      <option value="">{placeholder}</option>
      {roles.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </select>
  );
}

// Same fallback-to-text-input idea as RoleSelect, for picking the channel
// the bot posts admin notices to.
export function ChannelSelect({
  value,
  onChange,
  channels,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  channels: { id: string; name: string }[] | undefined;
  placeholder: string;
}) {
  if (!channels || channels.length === 0) {
    return (
      <input
        className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Discord channel ID (invite the bot to pick from a list instead)"
      />
    );
  }
  return (
    <select
      className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {channels.map((c) => (
        <option key={c.id} value={c.id}>
          #{c.name}
        </option>
      ))}
    </select>
  );
}

// Like ChannelSelect, but for the role-rule "channels to grant" picker,
// which needs both text AND voice channels (grouped) since a rule can
// grant direct access to either kind.
export function ChannelGrantSelect({
  value,
  onChange,
  channels,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  channels: { id: string; name: string; type: "text" | "voice" }[] | undefined;
  placeholder: string;
}) {
  if (!channels || channels.length === 0) {
    return (
      <input
        className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Discord channel ID (invite the bot to pick from a list instead)"
      />
    );
  }
  const textChannels = channels.filter((c) => c.type === "text");
  const voiceChannels = channels.filter((c) => c.type === "voice");
  return (
    <select
      className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {textChannels.length > 0 && (
        <optgroup label="Text channels">
          {textChannels.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </optgroup>
      )}
      {voiceChannels.length > 0 && (
        <optgroup label="Voice channels">
          {voiceChannels.map((c) => (
            <option key={c.id} value={c.id}>
              🔊 {c.name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

// Members by role — the role triage grid, merged with the full character
// table: filter by role (default: the first role the sync manages), search
// across character/nick/account, and stage role changes per cell. Nothing
// hits Discord until "Apply" — confirmed through a diff dialog — and a
// change only sticks if no rule still grants that role/person; otherwise
// the next sync reverts it. Clicking a Discord name opens that member's
// own audit history; the header pill opens the full audit log.
export function MembersByRolePanel({
  guildId,
  roles,
}: {
  guildId: string;
  roles: { id: string; name: string }[] | undefined;
}) {
  const [filterRoleId, setFilterRoleId] = useState("");
  const [search, setSearch] = useState("");
  const [rankFilter, setRankFilter] = useState(ALL);
  // Staged desired state: memberId -> Set of roleIds they should end up
  // with. Absent memberId = "use their current roles unmodified" (the
  // common case — most cells never get touched). Reset whenever the filter
  // changes or an apply completes, since both invalidate the baseline.
  const [desired, setDesired] = useState<Map<string, Set<string>>>(new Map());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmDialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = confirmDialogRef.current;
    if (!dialog) return;
    if (confirmOpen && !dialog.open) dialog.showModal();
    if (!confirmOpen && dialog.open) dialog.close();
  }, [confirmOpen]);
  const [auditMember, setAuditMember] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [auditLogOpen, setAuditLogOpen] = useState(false);

  const utils = api.useUtils();
  const members = api.guild.membersWithRole.useQuery(
    { guildId, discordRoleId: filterRoleId },
    { enabled: filterRoleId !== "" },
  );
  const apply = api.guild.applyMemberRoleChanges.useMutation({
    onSuccess: async () => {
      setDesired(new Map());
      await utils.guild.membersWithRole.invalidate({
        guildId,
        discordRoleId: filterRoleId,
      });
    },
  });

  // Rank comes from the roster table (character-level), joined client-side
  // by character name; the Discord-side query above carries no rank.
  const rosterTable = api.guild.discordRolesTable.useQuery({ guildId });
  const rankByCharacter = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rosterTable.data ?? []) map.set(r.characterName, r.rank);
    return map;
  }, [rosterTable.data]);

  // Managed role columns: the filter role plus every role the sync owns
  // (granted by a rule or protected) and the PUG role — staging a change on
  // a role the member does not hold yet is the point of this grid.
  const config = api.guild.discordRoleConfig.useQuery({ guildId });

  // Land pre-filtered on the role the sync manages most directly, so the
  // grid is never an empty "pick something" screen.
  useEffect(() => {
    if (filterRoleId !== "") return;
    const firstManaged = config.data?.rules[0]?.grantedRoles[0]?.discordRoleId;
    if (firstManaged) setFilterRoleId(firstManaged);
  }, [config.data, filterRoleId]);

  const columnIds = useMemo(() => {
    const wanted = new Set<string>([filterRoleId]);
    for (const r of config.data?.rules ?? []) {
      for (const g of r.grantedRoles) wanted.add(g.discordRoleId);
    }
    for (const id of config.data?.protectedRoleIds ?? []) wanted.add(id);
    if (config.data?.pugRoleId) wanted.add(config.data.pugRoleId);
    return (roles ?? []).map((r) => r.id).filter((id) => wanted.has(id));
  }, [config.data, roles, filterRoleId]);

  function selectFilterRole(id: string) {
    setFilterRoleId(id);
    setDesired(new Map());
  }

  function currentRoles(memberId: string, actual: string[]): Set<string> {
    return desired.get(memberId) ?? new Set(actual);
  }

  function toggleCell(memberId: string, roleId: string, actual: string[]) {
    setDesired((prev) => {
      const next = new Map(prev);
      const roleSet = new Set(currentRoles(memberId, actual));
      if (roleSet.has(roleId)) roleSet.delete(roleId);
      else roleSet.add(roleId);
      next.set(memberId, roleSet);
      return next;
    });
  }

  // Column order = the guild's own role order (roles is position-sorted);
  // managed columns keep that order regardless of who holds them.
  function columnState(roleId: string): "all" | "none" | "mixed" {
    const rows = members.data ?? [];
    if (rows.length === 0) return "none";
    let checked = 0;
    for (const m of rows) {
      if (currentRoles(m.id, m.roleIds).has(roleId)) checked++;
    }
    if (checked === 0) return "none";
    if (checked === rows.length) return "all";
    return "mixed";
  }

  function toggleColumn(roleId: string) {
    const rows = members.data ?? [];
    const setTo = columnState(roleId) !== "all"; // mixed or none -> check all; all -> uncheck all
    setDesired((prev) => {
      const next = new Map(prev);
      for (const m of rows) {
        const roleSet = new Set(currentRoles(m.id, m.roleIds));
        if (setTo) roleSet.add(roleId);
        else roleSet.delete(roleId);
        next.set(m.id, roleSet);
      }
      return next;
    });
  }

  const filterRoleName = roles?.find((r) => r.id === filterRoleId)?.name;
  const roleName = (id: string) => roles?.find((r) => r.id === id)?.name ?? id;

  const ranks = useMemo(
    () =>
      [
        ...new Set(
          (members.data ?? []).flatMap((m) =>
            m.characterNames
              .map((name) => rankByCharacter.get(name))
              .filter(Boolean),
          ),
        ),
      ].sort() as string[],
    [members.data, rankByCharacter],
  );

  const searchQuery = search.trim().toLowerCase();
  const visibleRows = useMemo(() => {
    return (members.data ?? []).filter((m) => {
      if (rankFilter !== ALL) {
        const matches = m.characterNames.some(
          (name) => rankByCharacter.get(name) === rankFilter,
        );
        if (!matches) return false;
      }
      if (!searchQuery) return true;
      return (
        m.tag.toLowerCase().includes(searchQuery) ||
        (m.nick?.toLowerCase().includes(searchQuery) ?? false) ||
        m.characterNames.some((name) =>
          name.toLowerCase().includes(searchQuery),
        )
      );
    });
  }, [members.data, rankFilter, rankByCharacter, searchQuery]);

  // Snapshots exactly what's currently on screen — staged checkbox state
  // included, not just what Discord has right now — as a Markdown table,
  // and saves it via a plain browser download (no server round-trip).
  function downloadMarkdown() {
    const rows = visibleRows;
    const header = [
      "Discord account",
      "Discord nickname",
      "Character(s)",
      ...columnIds.map(roleName),
    ];
    const lines = [
      `| ${header.join(" | ")} |`,
      `| ${header.map(() => "---").join(" | ")} |`,
      ...rows.map((m) => {
        const cells = [
          m.tag,
          m.nick ?? "",
          m.characterNames.join(", "),
          ...columnIds.map((roleId) =>
            currentRoles(m.id, m.roleIds).has(roleId) ? "x" : "",
          ),
        ];
        return `| ${cells.join(" | ")} |`;
      }),
    ];
    const blob = new Blob([lines.join("\n") + "\n"], {
      type: "text/markdown",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `members-by-role-${filterRoleName ?? "export"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Every (member, role) cell whose staged state differs from what Discord
  // actually has — this IS the change set apply sends, one entry per cell.
  const changes = (members.data ?? []).flatMap((m) => {
    const staged = desired.get(m.id);
    if (!staged) return [];
    const actual = new Set(m.roleIds);
    const diffs: { discordUserId: string; discordRoleId: string; add: boolean }[] =
      [];
    for (const roleId of columnIds) {
      const wants = staged.has(roleId);
      const has = actual.has(roleId);
      if (wants !== has) {
        diffs.push({ discordUserId: m.id, discordRoleId: roleId, add: wants });
      }
    }
    return diffs;
  });

  const changeSummary = changes.map((c) => {
    const member = (members.data ?? []).find((m) => m.id === c.discordUserId);
    return {
      who: member?.nick ?? member?.tag ?? c.discordUserId,
      role: roleName(c.discordRoleId),
      add: c.add,
    };
  });

  const memberAuditRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = memberAuditRef.current;
    if (!dialog) return;
    if (auditMember && !dialog.open) dialog.showModal();
    if (!auditMember && dialog.open) dialog.close();
  }, [auditMember]);

  const auditLogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = auditLogRef.current;
    if (!dialog) return;
    if (auditLogOpen && !dialog.open) dialog.showModal();
    if (!auditLogOpen && dialog.open) dialog.close();
  }, [auditLogOpen]);

  return (
    <div className="bg-discord-elevated flex flex-col gap-3 rounded-xl p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-bold">Members by role</h3>
          <p className="text-discord-text-muted mt-1 max-w-2xl text-sm">
            Filter to everyone holding a role, see (and edit) everything else
            they hold alongside it. Toggle a column header to check/uncheck
            that role for every row at once. Nothing changes in Discord until
            you apply — and a change only sticks if no rule still grants that
            role/person combination; otherwise the next sync reverts it.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAuditLogOpen(true)}
          className="bg-discord-base hover:bg-discord-elevated-hover flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold"
        >
          Audit log
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <RoleSelect
          value={filterRoleId}
          onChange={selectFilterRole}
          roles={roles}
          placeholder="Filter by role"
        />
        {ranks.length > 1 && (
          <select
            className="bg-discord-base text-discord-text rounded-full px-3 py-2 text-sm"
            value={rankFilter}
            onChange={(e) => setRankFilter(e.target.value)}
            aria-label="Filter by rank"
          >
            <option value={ALL}>All ranks</option>
            {ranks.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        )}
        <input
          className="bg-discord-base text-discord-text placeholder:text-discord-text-muted rounded-full px-4 py-2 text-sm"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search character, nick, account…"
        />
      </div>

      {filterRoleId !== "" && members.isLoading && (
        <p className="text-discord-text-muted text-sm">Loading...</p>
      )}
      {filterRoleId !== "" && members.data?.length === 0 && (
        <p className="text-discord-text-muted text-sm">
          Nobody currently holds {filterRoleName ?? "this role"}.
        </p>
      )}
      {visibleRows.length > 0 && (
        <>
          <div className="max-h-[70vh] overflow-auto rounded-lg">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="bg-discord-base sticky top-0 left-0 z-10 px-3 py-2 text-right font-semibold">
                    #
                  </th>
                  <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                    Discord account
                  </th>
                  <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                    Discord nickname
                  </th>
                  <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                    Character(s)
                  </th>
                  <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                    Rank
                  </th>
                  {columnIds.map((roleId) => {
                    const state = columnState(roleId);
                    return (
                      <th
                        key={roleId}
                        className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold whitespace-nowrap"
                      >
                        <label className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={state === "all"}
                            ref={(el) => {
                              if (el) el.indeterminate = state === "mixed";
                            }}
                            onChange={() => toggleColumn(roleId)}
                          />
                          {roleName(roleId)}
                        </label>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((m, i) => (
                  <tr key={m.id} className="hover:bg-discord-base">
                    <td className="bg-discord-elevated text-discord-text-muted sticky left-0 px-3 py-1.5 text-right whitespace-nowrap">
                      {i + 1}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <button
                        type="button"
                        className="text-discord-link hover:underline"
                        title={`Audit history for ${m.tag}`}
                        onClick={() =>
                          setAuditMember({ id: m.id, label: m.nick ?? m.tag })
                        }
                      >
                        {m.tag}
                      </button>
                    </td>
                    <td className="text-discord-text-muted px-3 py-1.5 whitespace-nowrap">
                      {m.nick ?? "—"}
                    </td>
                    <td className="text-discord-text-muted px-3 py-1.5 whitespace-nowrap">
                      {m.characterNames.length > 0
                        ? m.characterNames
                            .map(
                              (name) =>
                                `${name}${
                                  rankByCharacter.get(name)
                                    ? ` (${rankByCharacter.get(name)})`
                                    : ""
                                }`,
                            )
                            .join(", ")
                        : "—"}
                    </td>
                    <td className="text-discord-text-muted px-3 py-1.5 whitespace-nowrap">
                      {[...new Set(m.characterNames.map((name) => rankByCharacter.get(name)).filter(Boolean))].join(", ") || "—"}
                    </td>
                    {columnIds.map((roleId) => (
                      <td key={roleId} className="px-3 py-1.5">
                        <input
                          type="checkbox"
                          checked={currentRoles(m.id, m.roleIds).has(roleId)}
                          onChange={() => toggleCell(m.id, roleId, m.roleIds)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-discord-text-muted text-xs">
            {visibleRows.length} shown of {members.data?.length ?? 0}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              disabled={apply.isPending || changes.length === 0}
              className="bg-discord-brand self-start rounded-full px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {apply.isPending
                ? "Applying..."
                : changes.length > 0
                  ? `Apply changes (${changes.length})`
                  : "Apply changes"}
            </button>
            <button
              type="button"
              onClick={downloadMarkdown}
              className="bg-discord-base hover:bg-discord-elevated-hover self-start rounded-full px-4 py-1.5 text-sm font-semibold"
            >
              Download as Markdown
            </button>
          </div>
        </>
      )}
      {apply.error && (
        <p className="text-discord-red text-sm">{apply.error.message}</p>
      )}
      {apply.isSuccess && (
        <p className="text-discord-green text-sm">
          Applied {apply.data.succeeded}
          {apply.data.failed > 0 ? `, ${apply.data.failed} failed` : ""}.
        </p>
      )}

      {/* staged-changes confirm dialog */}
      <dialog
        ref={confirmDialogRef}
        onClose={() => setConfirmOpen(false)}
        className="bg-discord-elevated text-discord-text fixed inset-0 m-auto w-96 rounded-xl p-6 backdrop:bg-black/60"
      >
        <h4 className="font-bold">
          Apply {changes.length} role change{changes.length === 1 ? "" : "s"}?
        </h4>
        <p className="text-discord-text-muted mt-1 text-sm">
          This changes real Discord roles. Rules still own their granted
          roles — those come back on the next sync.
        </p>
        <ul className="my-3 max-h-64 overflow-auto rounded-lg bg-discord-base p-2 text-sm">
          {changeSummary.map((c, i) => (
            <li key={i} className={c.add ? "text-discord-green" : "text-discord-red"}>
              {c.add ? "+" : "−"} @{c.role}: {c.who}
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setConfirmOpen(false)}
            className="bg-discord-elevated-hover rounded-full px-4 py-1.5 text-sm font-semibold"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirmOpen(false);
              apply.mutate({ guildId, changes });
            }}
            className="bg-discord-brand rounded-full px-4 py-1.5 text-sm font-semibold text-white"
          >
            Apply
          </button>
        </div>
      </dialog>

      {/* one member's own audit history */}
      <dialog
        ref={memberAuditRef}
        onClose={() => setAuditMember(null)}
        className="bg-discord-elevated text-discord-text fixed inset-0 m-auto w-[32rem] max-w-[90vw] rounded-xl p-6 backdrop:bg-black/60"
      >
        {auditMember && (
          <>
            <div className="flex items-start justify-between gap-3">
              <h4 className="font-bold">
                Audit history — {auditMember.label}
              </h4>
              <button
                type="button"
                className="text-discord-text-muted hover:text-discord-text text-lg"
                onClick={() => setAuditMember(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <p className="text-discord-text-muted mt-1 text-sm">
              Rank transitions, role changes and claims for this Discord
              account.
            </p>
            <div className="my-3 flex max-h-96 flex-col gap-1.5 overflow-auto rounded-lg bg-discord-base p-3 text-sm">
              <MemberAuditFeed
                guildId={guildId}
                discordUserId={auditMember.id}
                enabled
              />
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setAuditMember(null)}
                className="bg-discord-elevated-hover rounded-full px-4 py-1.5 text-sm font-semibold"
              >
                Close
              </button>
            </div>
          </>
        )}
      </dialog>

      {/* full audit log */}
      <dialog
        ref={auditLogRef}
        onClose={() => setAuditLogOpen(false)}
        className="bg-discord-elevated text-discord-text fixed inset-0 m-auto h-[80vh] w-[40rem] max-w-[92vw] rounded-xl p-6 backdrop:bg-black/60"
      >
        <div className="flex items-start justify-between gap-3">
          <h4 className="font-bold">Audit log</h4>
          <button
            type="button"
            className="text-discord-text-muted hover:text-discord-text text-lg"
            onClick={() => setAuditLogOpen(false)}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="mt-3 flex max-h-[calc(80vh-6rem)] flex-col gap-1.5 overflow-auto rounded-lg bg-discord-base p-3 text-sm">
          <MemberAuditFeed guildId={guildId} enabled={auditLogOpen} />
        </div>
      </dialog>
    </div>
  );
}

// One line of human-readable detail per audit entry kind — same phrasing
// the audit log component uses, so an event reads identically everywhere.
function auditLine(entry: AuditEntry): { what: string; cls: "" | "add" | "rem" } {
  if (entry.kind === "rank_change") {
    return { what: `rank ${entry.oldRank ?? "?"} → ${entry.newRank}`, cls: "" };
  }
  if (entry.kind === "claim") {
    return { what: "claimed", cls: "" };
  }
  const added =
    entry.addedRoleNames.length > 0 ? `+${entry.addedRoleNames.join(", ")}` : "";
  const removed =
    entry.removedRoleNames.length > 0
      ? `-${entry.removedRoleNames.join(", ")}`
      : "";
  const by = entry.source === "bot" ? "the bot" : (entry.executorTag ?? "someone");
  return {
    what: `${[added, removed].filter(Boolean).join(" ")} → ${entry.characterName} — ${by}`,
    cls: added ? "add" : "rem",
  };
}

// Compact audit feed used by the two modals: full guild feed by default,
// scoped to one Discord account when discordUserId is set.
function MemberAuditFeed({
  guildId,
  discordUserId,
  enabled,
}: {
  guildId: string;
  discordUserId?: string;
  enabled: boolean;
}) {
  const audit = api.guild.auditLog.useQuery(
    { guildId, discordUserId: discordUserId ?? undefined },
    { enabled: enabled && !!guildId },
  );
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();

  const filtered = useMemo(() => {
    const list = audit.data ?? [];
    if (!query) return list;
    return list.filter((e) => {
      const line = auditLine(e).what.toLowerCase();
      return (
        e.characterName.toLowerCase().includes(query) ||
        (e.discordNick?.toLowerCase().includes(query) ?? false) ||
        (e.discordTag?.toLowerCase().includes(query) ?? false) ||
        line.includes(query)
      );
    });
  }, [audit.data, query]);

  if (audit.isLoading) {
    return <p className="text-discord-text-muted text-sm">Loading…</p>;
  }
  if (filtered.length === 0) {
    return (
      <p className="text-discord-text-muted text-sm">
        {audit.data?.length === 0
          ? "No events yet — the log prints when the bot or an officer acts."
          : "No events match that search."}
      </p>
    );
  }
  return (
    <>
      {discordUserId === undefined && (
        <input
          className="bg-discord-elevated text-discord-text placeholder:text-discord-text-muted sticky top-0 mb-1 w-full rounded-full px-3 py-1.5 text-sm"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search the log…"
        />
      )}
      {filtered.map((e, i) => {
        const line = auditLine(e);
        return (
          <div
            key={`${e.id}-${i}`}
            className="flex gap-3 whitespace-nowrap"
          >
            <span
              className="schem-mono text-discord-text-muted"
              style={{ width: 150, flex: "none" }}
            >
              {absoluteTime(new Date(e.detectedAt)).slice(0, 16)}
            </span>
            <span
              className={
                line.cls === "add"
                  ? "text-discord-green"
                  : line.cls === "rem"
                    ? "text-discord-red"
                    : "text-discord-text"
              }
            >
              {line.what}
            </span>
          </div>
        );
      })}
    </>
  );
}
// Bulk counterpart to the daily inactivity filter and /reactivate — see
// runInactivityFilter/handleReactivate in apps/bot/src/activityTracking.ts,
// which this mirrors exactly (additive role grant, not a wipe; reactivate
// just removes that one role). Exists because the daily pass and the
// per-person slash command don't cover "I want to act on 40 people right
// now" — a guild reorganizing after a raid tier, say.
// Whole days since a date, floored — the granularity the inactivity
// filter itself works in.
function daysAgo(date: string | Date): number {
  return Math.floor((Date.now() - new Date(date).getTime()) / (24 * 60 * 60_000));
}

export function InactivityManager({ guildId }: { guildId: string }) {
  const [collapsed, setCollapsed] = useState(true);
  const [search, setSearch] = useState("");
  const [onlyTargetRole, setOnlyTargetRole] = useState(true);
  const [onlyNeverTracked, setOnlyNeverTracked] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const utils = api.useUtils();
  const overview = api.guild.inactivityOverview.useQuery(
    { guildId },
    { enabled: !collapsed },
  );
  const invalidate = () => utils.guild.inactivityOverview.invalidate({ guildId });
  const resetActivity = api.guild.bulkResetActivity.useMutation({
    onSuccess: async () => {
      setSelected(new Set());
      await invalidate();
    },
  });
  const markInactive = api.guild.bulkMarkInactive.useMutation({
    onSuccess: async () => {
      setSelected(new Set());
      await invalidate();
    },
  });
  const reactivate = api.guild.bulkReactivateMembers.useMutation({
    onSuccess: async () => {
      setSelected(new Set());
      await invalidate();
    },
  });

  const rows = (overview.data?.members ?? []).filter((m) => {
    if (onlyTargetRole && !m.hasTargetRole) return false;
    if (onlyNeverTracked && m.lastActiveAt !== null) return false;
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return (
      m.tag.toLowerCase().includes(query) ||
      (m.nick ?? "").toLowerCase().includes(query)
    );
  });

  function toggleRow(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((s) =>
      s.size === rows.length ? new Set() : new Set(rows.map((r) => r.id)),
    );
  }

  const anyPending =
    resetActivity.isPending || markInactive.isPending || reactivate.isPending;
  const hasInactiveRole = !!overview.data?.inactivityRoleId;

  return (
    <div className="bg-discord-elevated flex w-full flex-col gap-2 rounded-xl p-4">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center justify-between text-left"
      >
        <h3 className="font-bold">Bulk manage inactivity</h3>
        <span className="text-discord-text-muted">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <>
          <p className="text-discord-text-muted text-sm">
            Act on many members at once: reset someone&apos;s activity clock
            to right now (also fixes anyone who joined but never sent a
            tracked message — they get today as a starting point), mark
            people inactive immediately instead of waiting for the daily
            pass, or bulk-reactivate. Role changes are additive/subtractive
            for just the inactive role — nothing else is touched.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="bg-discord-base text-discord-text rounded-full px-4 py-2"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name/nickname"
            />
            <label className="text-discord-text-muted flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={onlyTargetRole}
                onChange={(e) => setOnlyTargetRole(e.target.checked)}
              />
              Only members with a tracked role
            </label>
            <label className="text-discord-text-muted flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={onlyNeverTracked}
                onChange={(e) => setOnlyNeverTracked(e.target.checked)}
              />
              Only never tracked (last active: never)
            </label>
          </div>
          {overview.isLoading && (
            <p className="text-discord-text-muted text-sm">Loading...</p>
          )}
          {!overview.isLoading && rows.length === 0 && (
            <p className="text-discord-text-muted text-sm">No members match.</p>
          )}
          {rows.length > 0 && (
            <>
              <div className="max-h-[70vh] overflow-auto rounded-lg">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr>
                      <th className="bg-discord-base sticky top-0 left-0 z-10 px-3 py-2 text-right font-semibold">
                        #
                      </th>
                      <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                        <input
                          type="checkbox"
                          checked={selected.size === rows.length}
                          ref={(el) => {
                            if (el) {
                              el.indeterminate =
                                selected.size > 0 && selected.size < rows.length;
                            }
                          }}
                          onChange={toggleAll}
                        />
                      </th>
                      <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                        Discord account
                      </th>
                      <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                        Discord nickname
                      </th>
                      <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                        Tracked role
                      </th>
                      <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                        Inactive now
                      </th>
                      <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                        Last active
                      </th>
                      <th className="bg-discord-base sticky top-0 px-3 py-2 text-left font-semibold">
                        Joined
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m, i) => (
                      <tr key={m.id} className="hover:bg-discord-base">
                        <td className="bg-discord-elevated text-discord-text-muted sticky left-0 px-3 py-1.5 text-right whitespace-nowrap">
                          {i + 1}
                        </td>
                        <td className="px-3 py-1.5">
                          <input
                            type="checkbox"
                            checked={selected.has(m.id)}
                            onChange={() => toggleRow(m.id)}
                          />
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap">{m.tag}</td>
                        <td className="text-discord-text-muted px-3 py-1.5 whitespace-nowrap">
                          {m.nick ?? "—"}
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          {m.hasTargetRole ? "✓" : ""}
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          {m.isMarkedInactive ? "💤" : ""}
                        </td>
                        <td
                          className="text-discord-text-muted px-3 py-1.5 whitespace-nowrap"
                          title={
                            m.lastActiveAt
                              ? new Date(m.lastActiveAt).toLocaleString()
                              : "Never tracked"
                          }
                        >
                          {m.lastActiveAt
                            ? `${daysAgo(m.lastActiveAt)}d ago`
                            : "never"}
                        </td>
                        <td className="text-discord-text-muted px-3 py-1.5 whitespace-nowrap">
                          {m.joinedAt
                            ? new Date(m.joinedAt).toLocaleDateString()
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-discord-text-muted text-xs">
                {rows.length} total, {selected.size} selected
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    resetActivity.mutate({
                      guildId,
                      discordUserIds: [...selected],
                    })
                  }
                  disabled={anyPending || selected.size === 0}
                  className="bg-discord-brand rounded-full px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {resetActivity.isPending
                    ? "Resetting..."
                    : `Reset activity to now (${selected.size})`}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    markInactive.mutate({
                      guildId,
                      discordUserIds: [...selected],
                    })
                  }
                  disabled={anyPending || selected.size === 0 || !hasInactiveRole}
                  title={
                    hasInactiveRole
                      ? undefined
                      : "Set an inactive role above first"
                  }
                  className="bg-discord-base hover:bg-discord-elevated-hover rounded-full px-4 py-1.5 text-sm font-semibold disabled:opacity-50"
                >
                  {markInactive.isPending
                    ? "Marking..."
                    : `Mark inactive (${selected.size})`}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    reactivate.mutate({
                      guildId,
                      discordUserIds: [...selected],
                    })
                  }
                  disabled={anyPending || selected.size === 0 || !hasInactiveRole}
                  title={
                    hasInactiveRole
                      ? undefined
                      : "Set an inactive role above first"
                  }
                  className="bg-discord-base hover:bg-discord-elevated-hover rounded-full px-4 py-1.5 text-sm font-semibold disabled:opacity-50"
                >
                  {reactivate.isPending
                    ? "Reactivating..."
                    : `Reactivate (${selected.size})`}
                </button>
              </div>
            </>
          )}
          {(resetActivity.error ?? markInactive.error ?? reactivate.error) && (
            <p className="text-discord-red text-sm">
              {(resetActivity.error ?? markInactive.error ?? reactivate.error)
                ?.message}
            </p>
          )}
        </>
      )}
    </div>
  );
}
