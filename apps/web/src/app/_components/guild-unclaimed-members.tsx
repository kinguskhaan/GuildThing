"use client";

import { useState } from "react";

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
  const discordRoles = api.guild.discordRoles.useQuery(
    { guildId },
    { enabled: !collapsed },
  );

  const remind = api.guild.remindUnclaimedMembers.useMutation();
  const assignRole = api.guild.assignRoleToMembers.useMutation();

  if (members.length === 0) return null;

  const memberIds = members.map((m) => m.id);

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
            name was in the roster.
          </p>
          <ul className="flex flex-wrap gap-2">
            {members.map((m) => (
              <li
                key={m.id}
                className="rounded-full bg-discord-base px-3 py-1 text-sm"
              >
                {m.tag}
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-2 border-t border-black/10 pt-3">
            <button
              type="button"
              onClick={() => remind.mutate({ guildId, memberIds })}
              disabled={remind.isPending}
              className="rounded-full bg-discord-elevated-hover px-4 py-1.5 text-sm font-semibold"
            >
              {remind.isPending ? "Sending..." : `DM all ${members.length} a reminder`}
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
              <option value="">Select a role to assign to all</option>
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
              disabled={assignRole.isPending || assignRoleId.trim() === ""}
              className="rounded-full bg-discord-elevated-hover px-4 py-1.5 text-sm font-semibold"
            >
              {assignRole.isPending ? "Assigning..." : "Assign to all"}
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
