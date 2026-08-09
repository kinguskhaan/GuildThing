"use client";

import { useEffect, useState } from "react";

import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";

type UnclaimedMember = RouterOutputs["guild"]["unclaimedMembers"][number];

export function GuildUnclaimedMembers({
  guildId,
  members,
}: {
  guildId: string;
  members: UnclaimedMember[];
}) {
  const [collapsed, setCollapsed] = useState(true);
  const [assignRoleId, setAssignRoleId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(members.map((m) => m.id)),
  );
  const discordRoles = api.guild.discordRoles.useQuery(
    { guildId },
    { enabled: !collapsed },
  );

  // Selection defaults to "everyone" whenever the underlying list changes
  // (e.g. after a reminder/role-assign refreshes the page) — matches the
  // old "act on all" behavior unless someone actually deselects people.
  useEffect(() => {
    setSelected(new Set(members.map((m) => m.id)));
  }, [members]);

  const remind = api.guild.remindUnclaimedMembers.useMutation();
  const assignRole = api.guild.assignRoleToMembers.useMutation();

  if (members.length === 0) return null;

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const memberIds = [...selected];

  return (
    <div className="flex w-full flex-col gap-2 rounded-xl bg-discord-elevated p-4">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center justify-between text-left"
      >
        <h3 className="font-bold">
          Haven&apos;t claimed a character ({members.length})
        </h3>
        <span className="text-discord-text-muted">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <>
          <p className="text-sm text-discord-text-muted">
            Server members (excluding PUGs and bots) who don&apos;t have a
            roster character claimed to their Discord account yet —
            probably haven&apos;t run onboarding, or ran it before their
            name was in the roster. Click a name to include/exclude it from
            the actions below.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <ul className="flex flex-wrap gap-2">
              {members.map((m) => {
                const isSelected = selected.has(m.id);
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => toggle(m.id)}
                      aria-pressed={isSelected}
                      className={
                        isSelected
                          ? "rounded-full bg-discord-brand px-3 py-1 text-sm text-white"
                          : "rounded-full bg-discord-base px-3 py-1 text-sm text-discord-text-muted line-through"
                      }
                    >
                      {m.tag}
                    </button>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              onClick={() => setSelected(new Set(members.map((m) => m.id)))}
              className="text-xs text-discord-text-muted underline hover:text-discord-text"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-xs text-discord-text-muted underline hover:text-discord-text"
            >
              Select none
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-black/10 pt-3">
            <button
              type="button"
              onClick={() => remind.mutate({ guildId, memberIds })}
              disabled={remind.isPending || memberIds.length === 0}
              className="rounded-full bg-discord-elevated-hover px-4 py-1.5 text-sm font-semibold"
            >
              {remind.isPending
                ? "Sending..."
                : `DM ${memberIds.length} selected a reminder`}
            </button>
            {remind.isSuccess && (
              <span className="text-sm text-discord-text-muted">
                Sent to {remind.data.sent}, failed for {remind.data.failed} (DMs
                likely closed).
              </span>
            )}
            {remind.error && (
              <span className="text-sm text-discord-red">{remind.error.message}</span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              className="rounded-full bg-discord-base px-4 py-1.5 text-sm text-discord-text"
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
                assignRole.mutate({ guildId, memberIds, discordRoleId: assignRoleId })
              }
              disabled={
                assignRole.isPending || assignRoleId.trim() === "" || memberIds.length === 0
              }
              className="rounded-full bg-discord-elevated-hover px-4 py-1.5 text-sm font-semibold"
            >
              {assignRole.isPending
                ? "Assigning..."
                : `Assign to ${memberIds.length} selected`}
            </button>
            {assignRole.isSuccess && (
              <span className="text-sm text-discord-text-muted">
                Assigned to {assignRole.data.succeeded}, failed for{" "}
                {assignRole.data.failed} (check my role position).
              </span>
            )}
            {assignRole.error && (
              <span className="text-sm text-discord-red">{assignRole.error.message}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
