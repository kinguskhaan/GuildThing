import type { NextRequest } from "next/server";

import { resolveApiKey, unauthorizedResponse } from "~/server/api-key-auth";
import { db } from "~/server/db";

// API-key-authenticated equivalent of the website's "Sync now" button
// (guild.requestSync tRPC mutation) — sets the exact same field, picked up
// by the bot's existing checkForceSyncRequests poll (apps/bot/src/index.ts,
// every ~15s). Lets apps/sync relay an in-game "Request sync" click
// without a Discord session — see DiscordRolesUI.lua / GuildThing.lua's
// syncRequestedAt flag for the (reload-gated, not live) chain this is one
// link in.
export async function POST(request: NextRequest) {
  const auth = await resolveApiKey(request);
  if (!auth) return unauthorizedResponse();

  await db.guild.update({
    where: { id: auth.guildId },
    data: { forceSyncRequestedAt: new Date() },
  });
  return Response.json({ ok: true });
}
