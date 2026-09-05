import { hashApiKey } from "@guildthing/db";

import { db } from "~/server/db";

// Resolves the `Authorization: Bearer <key>` header on a request against
// /api/v1/* to the guild it belongs to. There's no session/cookie involved
// here at all — the key itself is both authentication and authorization
// (only a guild admin can ever mint one, see guild.createApiKey), which is
// why these endpoints are plain Route Handlers instead of tRPC procedures.
export async function resolveApiKey(
  request: Request,
): Promise<{ guildId: string; keyId: string } | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;

  const raw = header.slice("Bearer ".length).trim();
  if (!raw) return null;

  const key = await db.guildApiKey.findUnique({
    where: { keyHash: hashApiKey(raw) },
    select: { id: true, guildId: true, revokedAt: true },
  });
  if (!key || key.revokedAt) return null;

  // Fire-and-forget — a slightly stale lastUsedAt is fine, no request
  // should wait on it. Still logged on failure: an unawaited rejection
  // here is otherwise invisible (no request fails, nothing shows up in
  // the logs), which is exactly how a stale generated Prisma client
  // silently stopped writing this column in prod once already.
  db.guildApiKey
    .update({
      where: { id: key.id },
      data: { lastUsedAt: new Date() },
    })
    .catch((err: unknown) => {
      console.error("[api-key-auth] failed to update lastUsedAt:", err);
    });

  return { guildId: key.guildId, keyId: key.id };
}

export function unauthorizedResponse() {
  return Response.json(
    { error: "Missing or invalid API key." },
    { status: 401 },
  );
}
