import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";

import { hashApiKey } from "@guildthing/db";
import { getWowheadEntry, wowheadIconUrl, wowheadUrl } from "@guildthing/wowhead-data";

import { db } from "~/server/db";

// Same key as /api/v1/* (see api-key-auth.ts) — a guild admin mints these
// from the web UI, and the key alone is both auth and the guild scope, so
// every tool below reads authInfo.extra.guildId rather than taking a
// guildId argument the model could get wrong or use to reach another guild.
async function verifyToken(_req: Request, bearerToken?: string) {
  if (!bearerToken) return undefined;

  const key = await db.guildApiKey.findUnique({
    where: { keyHash: hashApiKey(bearerToken) },
    select: { id: true, guildId: true, revokedAt: true },
  });
  if (!key || key.revokedAt) return undefined;

  void db.guildApiKey.update({
    where: { id: key.id },
    data: { lastUsedAt: new Date() },
  });

  return { token: bearerToken, clientId: key.id, scopes: [], extra: { guildId: key.guildId } };
}

const DEFAULT_ROLE_CHANGE_LIMIT = 20;
const MAX_ROLE_CHANGE_LIMIT = 100;

const baseHandler = createMcpHandler(
  (server) => {
    server.registerTool(
      "list_characters",
      {
        title: "List guild characters",
        description:
          "Every character imported into this guild, with class and known professions.",
        inputSchema: {},
      },
      async (_args, extra) => {
        const guildId = extra.authInfo?.extra?.guildId as string;
        const characters = await db.guildCharacter.findMany({
          where: { guildId },
          select: { name: true, realm: true, class: true, professions: { select: { name: true } } },
          orderBy: { name: "asc" },
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                characters.map((c) => ({
                  name: c.name,
                  realm: c.realm,
                  class: c.class,
                  professions: c.professions.map((p) => p.name),
                })),
                null,
                2,
              ),
            },
          ],
        };
      },
    );

    server.registerTool(
      "craft_lookup",
      {
        title: "Find who can craft an item",
        description:
          "Look up a TBC recipe by item name (Wowhead data) and list which of this guild's characters can craft it, with reagents.",
        inputSchema: { itemName: z.string() },
      },
      async ({ itemName }, extra) => {
        const guildId = extra.authInfo?.extra?.guildId as string;
        const entry = getWowheadEntry(itemName);
        if (!entry) {
          return {
            content: [
              { type: "text", text: `No TBC recipe found for "${itemName}". Only exact names from the scraped Wowhead catalog match.` },
            ],
          };
        }

        const recipes = await db.recipe.findMany({
          where: { name: itemName, profession: { character: { guildId } } },
          include: { profession: { include: { character: true } } },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  name: entry.name,
                  url: wowheadUrl(entry),
                  icon: wowheadIconUrl(entry),
                  description: entry.description ?? null,
                  reagents: entry.reagents ?? [],
                  crafters: recipes.map((r) => r.profession.character.name),
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );

    server.registerTool(
      "recent_role_changes",
      {
        title: "Recent Discord role and rank changes",
        description:
          "The most recent role/rank changes GuildThing has recorded for this guild — both the bot's own rule-based resyncs and manual Discord edits it detected.",
        inputSchema: {
          limit: z.number().int().min(1).max(MAX_ROLE_CHANGE_LIMIT).optional(),
        },
      },
      async ({ limit }, extra) => {
        const guildId = extra.authInfo?.extra?.guildId as string;
        const take = limit ?? DEFAULT_ROLE_CHANGE_LIMIT;

        const [roleEvents, rankEvents] = await Promise.all([
          db.guildRoleChangeEvent.findMany({
            where: { guildId },
            orderBy: { detectedAt: "desc" },
            take,
          }),
          db.guildRankChangeEvent.findMany({
            where: { guildId },
            orderBy: { detectedAt: "desc" },
            take,
          }),
        ]);

        const entries = [
          ...roleEvents.map((r) => ({
            kind: "role" as const,
            discordUserTag: r.discordUserTag,
            source: r.source,
            executorTag: r.executorTag,
            added: JSON.parse(r.addedRoleNames) as string[],
            removed: JSON.parse(r.removedRoleNames) as string[],
            detectedAt: r.detectedAt.toISOString(),
          })),
          ...rankEvents.map((r) => ({
            kind: "rank" as const,
            characterName: r.characterName,
            oldRank: r.oldRank,
            newRank: r.newRank,
            detectedAt: r.detectedAt.toISOString(),
          })),
        ].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));

        return {
          content: [{ type: "text", text: JSON.stringify(entries.slice(0, take), null, 2) }],
        };
      },
    );
  },
  {},
  {
    basePath: "/api",
    disableSse: true,
    verboseLogs: process.env.NODE_ENV !== "production",
  },
);

const handler = withMcpAuth(baseHandler, verifyToken, { required: true });

export { handler as GET, handler as POST, handler as DELETE };
