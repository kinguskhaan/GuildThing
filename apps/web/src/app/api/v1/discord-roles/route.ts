import type { NextRequest } from "next/server";

import { resolveApiKey, unauthorizedResponse } from "~/server/api-key-auth";
import { db } from "~/server/db";
import { getGuildRolesSnapshot } from "~/server/discord";

// Read-only counterpart to the POST roster/characters routes — apps/sync
// pulls this down and writes it into the addon's own SavedVariables (see
// mergeSavedVariablesText in apps/sync/src/luaWriter.ts) the addon reads
// on its next login/reload (WoW addons have no network access of their
// own). Keyed by roster member NAME, not Discord user id, since that's the
// only identifier the addon itself has. Carries nick/tag alongside role
// names — same three fields the web admin table's discordRolesTable query
// shows — so the addon's own Discord Roles tab can show the same columns.
export async function GET(request: NextRequest) {
  const auth = await resolveApiKey(request);
  if (!auth) return unauthorizedResponse();

  const guild = await db.guild.findUnique({
    where: { id: auth.guildId },
    select: {
      discordGuildId: true,
      rosterMembers: {
        where: { claimedByDiscordUserId: { not: null } },
        select: { name: true, claimedByDiscordUserId: true },
      },
    },
  });
  if (!guild) {
    return Response.json({ error: "Guild not found." }, { status: 404 });
  }

  const snapshot = await getGuildRolesSnapshot(guild.discordGuildId);

  const members: Record<
    string,
    { nick: string | null; tag: string | null; roleNames: string[] }
  > = {};
  for (const m of guild.rosterMembers) {
    const entry = m.claimedByDiscordUserId
      ? snapshot[m.claimedByDiscordUserId]
      : undefined;
    members[m.name] = {
      nick: entry?.nick ?? null,
      tag: entry?.tag ?? null,
      roleNames: entry?.roleNames ?? [],
    };
  }

  return Response.json({ members });
}
