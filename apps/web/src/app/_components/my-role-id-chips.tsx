"use client";

import { api } from "~/trpc/react";

/**
 * Discord's user-OAuth API has no endpoint for a server's full role list
 * with names (that needs a bot) — the one thing it does give us is which
 * role IDs *you* personally hold. No names, just raw IDs, but clicking one
 * beats copy-pasting a snowflake by hand.
 */
export function MyRoleIdChips({
  discordGuildId,
  exclude,
  onPick,
}: {
  discordGuildId: string;
  exclude: string[];
  onPick: (roleId: string) => void;
}) {
  const roleIds = api.guild.myRoleIds.useQuery(
    { discordGuildId },
    { enabled: discordGuildId.length > 0 },
  );

  if (!discordGuildId) return null;

  const available = (roleIds.data ?? []).filter((id) => !exclude.includes(id));
  if (roleIds.isLoading || available.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-discord-text-muted">Your roles here:</span>
      {available.map((roleId) => (
        <button
          key={roleId}
          type="button"
          onClick={() => onPick(roleId)}
          className="rounded-full bg-discord-elevated px-2.5 py-1 font-mono text-xs text-discord-text-muted hover:bg-discord-elevated-hover hover:text-discord-text"
          title="Click to add"
        >
          {roleId}
        </button>
      ))}
    </div>
  );
}
