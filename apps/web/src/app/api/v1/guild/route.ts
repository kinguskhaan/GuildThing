import type { NextRequest } from "next/server";

import { resolveApiKey, unauthorizedResponse } from "~/server/api-key-auth";
import { db } from "~/server/db";

// Lets API-key consumers (apps/sync and the desktop app) resolve which
// guild a key belongs to. The roster scan stored by the addon is keyed by
// guild name, so the sync side needs the key's guild name to pick the
// right roster out of a multi-guild SavedVariables file.
export async function GET(request: NextRequest) {
  const auth = await resolveApiKey(request);
  if (!auth) return unauthorizedResponse();

  const guild = await db.guild.findUnique({
    where: { id: auth.guildId },
    select: { id: true, name: true, slug: true },
  });
  if (!guild) return unauthorizedResponse();

  return Response.json(guild);
}