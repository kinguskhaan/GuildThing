import { deflateSync } from "node:zlib";

import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { env } from "~/env";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import type { db as Db } from "~/server/db";
import { tbcProfessionRecipes, tbcRecipes } from "@guildthing/wowhead-data";
import {
  DiscordRateLimitedError,
  DiscordReauthRequiredError,
  fetchUserGuilds,
  getGuildIconUrl,
  getMyRoleIds,
  hasGuildRole,
  isGuildMember,
} from "~/server/discord";

async function safeGuildIconUrl(
  discordGuildId: string,
  userId: string,
): Promise<string | null> {
  try {
    return await getGuildIconUrl(discordGuildId, userId);
  } catch {
    return null;
  }
}

// Matches the JSON GuildThing Roster's /gtr export produces (Core.lua's
// GT.ExportRoster) — plain JSON, not the base64+zlib pipeline the older
// recipe export uses, since a roster scan is small enough not to need it.
const rosterExportSchema = z.object({
  guild: z.string().optional(),
  exportedAt: z.number().optional(),
  members: z.array(
    z.object({
      name: z.string().min(1),
      rank: z.string(),
      level: z.number(),
      class: z.string().nullable().optional(),
      note: z.string().nullable().optional(),
      officernote: z.string().nullable().optional(),
    }),
  ),
});

const wowImportSchema = z.object({
  name: z.string().min(1),
  realm: z.string().min(1),
  class: z.string().min(1).optional(),
  professions: z.record(
    z.string(),
    z.array(
      z.object({
        name: z.string(),
        itemID: z.number().nullable(),
        spellID: z.number().nullable().optional(),
      }),
    ),
  ),
});

async function checkGuildRole(db: typeof Db, guildId: string, userId: string) {
  const guild = await db.guild.findUnique({
    where: { id: guildId },
    include: { requiredRoles: true },
  });
  if (!guild) throw new TRPCError({ code: "NOT_FOUND" });

  try {
    const ok = await hasGuildRole(
      guild.discordGuildId,
      guild.requiredRoles.map((r) => r.discordRoleId),
      userId,
    );
    return {
      guild,
      hasAccess: ok,
      needsReauth: false as const,
      retryAfterSeconds: null,
    };
  } catch (err) {
    if (err instanceof DiscordReauthRequiredError) {
      return {
        guild,
        hasAccess: false,
        needsReauth: true as const,
        retryAfterSeconds: null,
      };
    }
    if (err instanceof DiscordRateLimitedError) {
      return {
        guild,
        hasAccess: false,
        needsReauth: false as const,
        retryAfterSeconds: err.retryAfterSeconds,
      };
    }
    throw err;
  }
}

// The guild's creator is always an admin (so they can never lock themselves
// out of their own guild's settings); anyone holding one of the guild's
// configured Discord admin roles is one too — Discord is only consulted for
// the latter, so being the owner never requires a Discord round-trip.
async function checkGuildAdmin(db: typeof Db, guildId: string, userId: string) {
  const guild = await db.guild.findUnique({
    where: { id: guildId },
    include: { adminRoles: true },
  });
  if (!guild) throw new TRPCError({ code: "NOT_FOUND" });

  if (guild.createdById === userId) {
    return {
      guild,
      isAdmin: true,
      needsReauth: false as const,
      retryAfterSeconds: null,
    };
  }

  try {
    const ok = await hasGuildRole(
      guild.discordGuildId,
      guild.adminRoles.map((r) => r.discordRoleId),
      userId,
    );
    return {
      guild,
      isAdmin: ok,
      needsReauth: false as const,
      retryAfterSeconds: null,
    };
  } catch (err) {
    if (err instanceof DiscordReauthRequiredError) {
      return {
        guild,
        isAdmin: false,
        needsReauth: true as const,
        retryAfterSeconds: null,
      };
    }
    if (err instanceof DiscordRateLimitedError) {
      return {
        guild,
        isAdmin: false,
        needsReauth: false as const,
        retryAfterSeconds: err.retryAfterSeconds,
      };
    }
    throw err;
  }
}

// Owns-it-yourself is always enough; being a guild admin is the other way
// in, for cleaning up stray/mistaken entries other members left behind.
async function canModifyCharacter(
  db: typeof Db,
  ownerId: string,
  guildId: string,
  userId: string,
): Promise<boolean> {
  if (ownerId === userId) return true;
  const { isAdmin } = await checkGuildAdmin(db, guildId, userId);
  return isAdmin;
}

function forbiddenOrRateLimited(retryAfterSeconds: number | null) {
  return new TRPCError(
    retryAfterSeconds != null
      ? {
          code: "TOO_MANY_REQUESTS",
          message: `Discord is rate limiting us — try again in about ${retryAfterSeconds}s.`,
        }
      : { code: "FORBIDDEN" },
  );
}

function isGuildCreator(email: string) {
  return email.toLowerCase() === env.GUILD_CREATOR_EMAIL.toLowerCase();
}

export const guildRouter = createTRPCRouter({
  // Drives whether the "Create a guild" button/form shows up at all — the
  // create mutation is the actual enforcement (this is just so non-owners
  // aren't shown a form they'd get a FORBIDDEN back from).
  canCreateGuild: protectedProcedure.query(({ ctx }) => {
    return isGuildCreator(ctx.session.user.email);
  }),

  // Lets the create-guild form offer a "pick your server" dropdown instead
  // of pasting a raw Discord server ID — servers that already have a guild
  // page here are left out, since discordGuildId is unique anyway.
  myDiscordServers: protectedProcedure.query(async ({ ctx }) => {
    let servers;
    try {
      servers = await fetchUserGuilds(ctx.session.user.id);
    } catch {
      return [];
    }

    const existing = await ctx.db.guild.findMany({
      where: { discordGuildId: { in: servers.map((s) => s.id) } },
      select: { discordGuildId: true },
    });
    const taken = new Set(existing.map((g) => g.discordGuildId));

    return servers
      .filter((s) => !taken.has(s.id))
      .map((s) => ({ id: s.id, name: s.name }));
  }),

  // Discord's user-OAuth API can't list a server's full roles (needs a
  // bot) — this is the one role-related thing it can give us: the roles
  // *you* personally hold in that server. No names, just IDs, but it beats
  // typing one blind.
  myRoleIds: protectedProcedure
    .input(z.object({ discordGuildId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        return await getMyRoleIds(input.discordGuildId, ctx.session.user.id);
      } catch {
        return [];
      }
    }),

  // Multiple guilds are allowed per instance, but only GUILD_CREATOR_EMAIL
  // can add new ones — canCreateGuild above is just UI dressing, this check
  // is the actual enforcement (client checks are trivially bypassable).
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        discordGuildId: z.string().min(1),
        requiredRoleIds: z.array(z.string().min(1)).min(1),
        adminRoleIds: z.array(z.string().min(1)).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!isGuildCreator(ctx.session.user.email)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the instance owner can create guilds.",
        });
      }

      return ctx.db.guild.create({
        data: {
          name: input.name,
          discordGuildId: input.discordGuildId,
          createdById: ctx.session.user.id,
          requiredRoles: {
            create: input.requiredRoleIds.map((discordRoleId) => ({
              discordRoleId,
            })),
          },
          adminRoles: {
            create: input.adminRoleIds.map((discordRoleId) => ({
              discordRoleId,
            })),
          },
        },
      });
    }),

  update: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        name: z.string().min(1),
        discordGuildId: z.string().min(1),
        requiredRoleIds: z.array(z.string().min(1)).min(1),
        adminRoleIds: z.array(z.string().min(1)).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { isAdmin, retryAfterSeconds } = await checkGuildAdmin(
        ctx.db,
        input.guildId,
        ctx.session.user.id,
      );
      if (!isAdmin) {
        throw forbiddenOrRateLimited(retryAfterSeconds);
      }

      return ctx.db.$transaction(async (tx) => {
        await tx.guildRequiredRole.deleteMany({
          where: { guildId: input.guildId },
        });
        await tx.guildAdminRole.deleteMany({
          where: { guildId: input.guildId },
        });
        return tx.guild.update({
          where: { id: input.guildId },
          data: {
            name: input.name,
            discordGuildId: input.discordGuildId,
            requiredRoles: {
              create: input.requiredRoleIds.map((discordRoleId) => ({
                discordRoleId,
              })),
            },
            adminRoles: {
              create: input.adminRoleIds.map((discordRoleId) => ({
                discordRoleId,
              })),
            },
          },
        });
      });
    }),

  // Owner-only (not just admin-role holders) — deleting the guild page
  // itself is more severe than editing its settings, and cascades to every
  // character/profession/recipe imported under it.
  delete: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const guild = await ctx.db.guild.findUnique({
        where: { id: input.guildId },
      });
      if (!guild) throw new TRPCError({ code: "NOT_FOUND" });
      if (guild.createdById !== ctx.session.user.id) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      await ctx.db.guild.delete({ where: { id: input.guildId } });
      return { success: true };
    }),

  // Lists every guild the user is at least a Discord member of — created
  // it, or is in that Discord server at all — regardless of whether they
  // hold the specific required role. Membership just gets it to show up;
  // opening one you lack the role for shows the "you don't have the
  // required role" message instead of recipes.
  list: protectedProcedure.query(async ({ ctx }) => {
    const guilds = await ctx.db.guild.findMany({
      orderBy: { createdAt: "desc" },
    });

    const visible = await Promise.all(
      guilds.map(async (guild) => {
        if (guild.createdById === ctx.session.user.id) return guild;
        try {
          const isMember = await isGuildMember(
            guild.discordGuildId,
            ctx.session.user.id,
          );
          return isMember ? guild : null;
        } catch {
          return null;
        }
      }),
    );

    const withIcons = await Promise.all(
      visible
        .filter((g): g is (typeof guilds)[number] => g !== null)
        .map(async (g) => ({
          id: g.id,
          name: g.name,
          createdAt: g.createdAt,
          iconUrl: await safeGuildIconUrl(g.discordGuildId, ctx.session.user.id),
        })),
    );
    return withIcons;
  }),

  get: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { guild, hasAccess, needsReauth, retryAfterSeconds } =
        await checkGuildRole(ctx.db, input.guildId, ctx.session.user.id);
      const { isAdmin } = await checkGuildAdmin(
        ctx.db,
        input.guildId,
        ctx.session.user.id,
      );
      const adminRoles = await ctx.db.guildAdminRole.findMany({
        where: { guildId: input.guildId },
      });
      const iconUrl = await safeGuildIconUrl(
        guild.discordGuildId,
        ctx.session.user.id,
      );
      return {
        id: guild.id,
        name: guild.name,
        discordGuildId: guild.discordGuildId,
        iconUrl,
        requiredRoleIds: guild.requiredRoles.map((r) => r.discordRoleId),
        adminRoleIds: adminRoles.map((r) => r.discordRoleId),
        isOwner: guild.createdById === ctx.session.user.id,
        isAdmin,
        viewerHasAccess: hasAccess,
        needsReauth,
        retryAfterSeconds,
      };
    }),

  myCharacters: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.db.guildCharacter.findMany({
        where: { guildId: input.guildId, userId: ctx.session.user.id },
        include: { professions: { include: { recipes: true } } },
        orderBy: { name: "asc" },
      });
    }),

  roster: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { hasAccess, retryAfterSeconds } = await checkGuildRole(
        ctx.db,
        input.guildId,
        ctx.session.user.id,
      );
      if (!hasAccess) {
        throw forbiddenOrRateLimited(retryAfterSeconds);
      }

      return ctx.db.guildCharacter.findMany({
        where: { guildId: input.guildId },
        include: { user: true, professions: { include: { recipes: true } } },
        orderBy: { name: "asc" },
      });
    }),

  // Who last generated the addon export string, and when — cheap enough to
  // poll without regenerating the (potentially large) export payload itself.
  exportStatus: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
      const guild = await ctx.db.guild.findUnique({
        where: { id: input.guildId },
        select: {
          lastExportedAt: true,
          lastExportedBy: { select: { nickname: true, name: true } },
        },
      });
      if (!guild) throw new TRPCError({ code: "NOT_FOUND" });

      return {
        lastExportedAt: guild.lastExportedAt,
        lastExportedByName: guild.lastExportedBy
          ? (guild.lastExportedBy.nickname ?? guild.lastExportedBy.name)
          : null,
      };
    }),

  // Guild-wide recipe export for the addon's tooltip lookup — see
  // addon/GuildThing/EXPORT_PLAN.md. Reverse-indexed (each recipe lists which
  // character indices can craft it, rather than repeating character names
  // per recipe) to keep the pasted string small in large guilds, then
  // zlib+base64'd the same way Gargul's softres.it import does. A mutation,
  // not a query — generating an export records who did it and when
  // (lastExportedAt/By) so the site can flag stale in-game data.
  exportRoster: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { guild, hasAccess, retryAfterSeconds } = await checkGuildRole(
        ctx.db,
        input.guildId,
        ctx.session.user.id,
      );
      if (!hasAccess) {
        throw forbiddenOrRateLimited(retryAfterSeconds);
      }

      const characters = await ctx.db.guildCharacter.findMany({
        where: { guildId: input.guildId },
        include: { professions: { include: { recipes: true } } },
        orderBy: { name: "asc" },
      });

      const characterIndex = new Map<string, number>();
      const charactersOut = characters.map((c, i) => {
        characterIndex.set(c.id, i);
        return { name: c.name, realm: c.realm, class: c.class };
      });

      const recipeMap = new Map<
        string,
        {
          name: string;
          itemId: number | null;
          spellId: number | null;
          chars: Set<number>;
        }
      >();

      for (const character of characters) {
        const charIdx = characterIndex.get(character.id)!;
        for (const profession of character.professions) {
          for (const recipe of profession.recipes) {
            const key = `${recipe.name}\0${recipe.itemId ?? ""}\0${recipe.spellId ?? ""}`;
            let entry = recipeMap.get(key);
            if (!entry) {
              entry = {
                name: recipe.name,
                itemId: recipe.itemId,
                spellId: recipe.spellId,
                chars: new Set(),
              };
              recipeMap.set(key, entry);
            }
            entry.chars.add(charIdx);
          }
        }
      }

      const recipesOut = [...recipeMap.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => ({
          name: r.name,
          itemId: r.itemId,
          spellId: r.spellId,
          chars: [...r.chars].sort((a, b) => a - b),
        }));

      const payload = {
        guild: guild.name,
        exportedAt: Math.floor(Date.now() / 1000),
        characters: charactersOut,
        recipes: recipesOut,
      };

      await ctx.db.guild.update({
        where: { id: input.guildId },
        data: {
          lastExportedAt: new Date(),
          lastExportedById: ctx.session.user.id,
        },
      });

      return deflateSync(Buffer.from(JSON.stringify(payload), "utf8")).toString(
        "base64",
      );
    }),

  importCharacter: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        character: wowImportSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { hasAccess, retryAfterSeconds } = await checkGuildRole(
        ctx.db,
        input.guildId,
        ctx.session.user.id,
      );
      if (!hasAccess) {
        throw retryAfterSeconds != null
          ? forbiddenOrRateLimited(retryAfterSeconds)
          : new TRPCError({
              code: "FORBIDDEN",
              message: "You don't have the required Discord role for this guild.",
            });
      }

      const { name, realm, class: charClass, professions } = input.character;

      return ctx.db.$transaction(async (tx) => {
        const character = await tx.guildCharacter.upsert({
          where: {
            guildId_userId_name_realm: {
              guildId: input.guildId,
              userId: ctx.session.user.id,
              name,
              realm,
            },
          },
          create: {
            guildId: input.guildId,
            userId: ctx.session.user.id,
            name,
            realm,
            class: charClass,
          },
          update: {
            class: charClass,
          },
        });

        await tx.profession.deleteMany({
          where: { characterId: character.id },
        });

        for (const [professionName, recipes] of Object.entries(professions)) {
          await tx.profession.create({
            data: {
              characterId: character.id,
              name: professionName,
              recipes: {
                create: recipes.map((r) => ({
                  name: r.name,
                  itemId: r.itemID,
                  spellId: r.spellID ?? null,
                })),
              },
            },
          });
        }

        return character;
      });
    }),

  deleteCharacter: protectedProcedure
    .input(z.object({ characterId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const character = await ctx.db.guildCharacter.findUnique({
        where: { id: input.characterId },
      });
      if (
        !character ||
        !(await canModifyCharacter(
          ctx.db,
          character.userId,
          character.guildId,
          ctx.session.user.id,
        ))
      ) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      await ctx.db.guildCharacter.delete({ where: { id: input.characterId } });
      return { success: true };
    }),

  // For people who'd rather not run the addon at all — lets them register a
  // character by hand, then add recipes to it one at a time below.
  createCharacter: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        name: z.string().min(1),
        realm: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { hasAccess, retryAfterSeconds } = await checkGuildRole(
        ctx.db,
        input.guildId,
        ctx.session.user.id,
      );
      if (!hasAccess) {
        throw forbiddenOrRateLimited(retryAfterSeconds);
      }

      const realm = input.realm ?? "";

      return ctx.db.guildCharacter.upsert({
        where: {
          guildId_userId_name_realm: {
            guildId: input.guildId,
            userId: ctx.session.user.id,
            name: input.name,
            realm,
          },
        },
        create: {
          guildId: input.guildId,
          userId: ctx.session.user.id,
          name: input.name,
          realm,
        },
        update: {},
      });
    }),

  // Manual counterpart to the addon's professions blob — adds one recipe at
  // a time to one of your own characters, creating the profession on it if
  // this is the first recipe for it. No itemId/spellId (the addon is what
  // supplies those), so it won't have a Wowhead icon until wowhead-sync gets
  // a real id for it some other way.
  addRecipe: protectedProcedure
    .input(
      z.object({
        characterId: z.string(),
        professionName: z.string().min(1),
        recipeName: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const character = await ctx.db.guildCharacter.findUnique({
        where: { id: input.characterId },
      });
      if (character?.userId !== ctx.session.user.id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      // Only real, known recipes are allowed — keeps manual entries free of
      // typos and, since the name matches the catalog, lets us attach the
      // right item/spell id (and so a Wowhead icon) immediately.
      const knownRecipes = tbcProfessionRecipes[input.professionName];
      if (!knownRecipes?.includes(input.recipeName)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Unknown recipe for that profession.",
        });
      }
      const entry = tbcRecipes[input.recipeName];

      const profession = await ctx.db.profession.upsert({
        where: {
          characterId_name: {
            characterId: input.characterId,
            name: input.professionName,
          },
        },
        create: { characterId: input.characterId, name: input.professionName },
        update: {},
      });

      return ctx.db.recipe.create({
        data: {
          professionId: profession.id,
          name: input.recipeName,
          itemId: entry?.kind === "item" ? entry.id : null,
          spellId: entry?.kind === "spell" ? entry.id : null,
        },
      });
    }),

  deleteRecipe: protectedProcedure
    .input(z.object({ recipeId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const recipe = await ctx.db.recipe.findUnique({
        where: { id: input.recipeId },
        include: { profession: { include: { character: true } } },
      });
      if (
        !recipe ||
        !(await canModifyCharacter(
          ctx.db,
          recipe.profession.character.userId,
          recipe.profession.character.guildId,
          ctx.session.user.id,
        ))
      ) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      await ctx.db.recipe.delete({ where: { id: input.recipeId } });
      return { success: true };
    }),

  // Cleans up a whole profession at once — e.g. a stray/mistyped one from
  // before recipe names were validated against the catalog (cascades to its
  // recipes, same as deleteCharacter does for a character's professions).
  deleteProfession: protectedProcedure
    .input(z.object({ professionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const profession = await ctx.db.profession.findUnique({
        where: { id: input.professionId },
        include: { character: true },
      });
      if (
        !profession ||
        !(await canModifyCharacter(
          ctx.db,
          profession.character.userId,
          profession.character.guildId,
          ctx.session.user.id,
        ))
      ) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      await ctx.db.profession.delete({ where: { id: input.professionId } });
      return { success: true };
    }),

  professionsOverview: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { hasAccess, retryAfterSeconds } = await checkGuildRole(
        ctx.db,
        input.guildId,
        ctx.session.user.id,
      );
      if (!hasAccess) {
        throw forbiddenOrRateLimited(retryAfterSeconds);
      }

      const professions = await ctx.db.profession.findMany({
        where: { character: { guildId: input.guildId } },
        include: { character: true, _count: { select: { recipes: true } } },
        orderBy: { name: "asc" },
      });

      const byName = new Map<string, typeof professions>();
      for (const p of professions) {
        byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
      }

      return [...byName.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entries]) => ({
          name,
          characters: entries.map((p) => ({
            characterId: p.characterId,
            name: p.character.name,
            realm: p.character.realm,
            recipeCount: p._count.recipes,
          })),
        }));
    }),

  professionRecipes: protectedProcedure
    .input(z.object({ guildId: z.string(), professionName: z.string() }))
    .query(async ({ ctx, input }) => {
      const { hasAccess, retryAfterSeconds } = await checkGuildRole(
        ctx.db,
        input.guildId,
        ctx.session.user.id,
      );
      if (!hasAccess) {
        throw forbiddenOrRateLimited(retryAfterSeconds);
      }

      const recipes = await ctx.db.recipe.findMany({
        where: {
          profession: {
            name: input.professionName,
            character: { guildId: input.guildId },
          },
        },
        include: { profession: { include: { character: true } } },
        orderBy: { name: "asc" },
      });

      const byName = new Map<string, typeof recipes>();
      for (const r of recipes) {
        byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
      }

      return [...byName.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entries]) => ({
          name,
          crafters: entries.map((r) => ({
            characterId: r.profession.characterId,
            name: r.profession.character.name,
            realm: r.profession.character.realm,
          })),
        }));
    }),

  // Full replace, not merge — a GuildThing Roster addon scan is a complete
  // point-in-time snapshot of everyone in the guild, so stale rows (people
  // who've since left) should disappear on the next import rather than
  // linger forever.
  importRosterMembers: protectedProcedure
    .input(z.object({ guildId: z.string(), exportString: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { isAdmin, needsReauth, retryAfterSeconds } = await checkGuildAdmin(
        ctx.db,
        input.guildId,
        ctx.session.user.id,
      );
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(input.exportString);
      } catch {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "That doesn't look like valid JSON — make sure you copied the whole export string.",
        });
      }

      const result = rosterExportSchema.safeParse(parsed);
      if (!result.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That doesn't look like a GuildThing Roster export.",
        });
      }

      const { members } = result.data;

      await ctx.db.$transaction([
        ctx.db.guildRosterMember.deleteMany({
          where: { guildId: input.guildId },
        }),
        ctx.db.guildRosterMember.createMany({
          data: members.map((m) => ({
            guildId: input.guildId,
            name: m.name,
            rank: m.rank,
            level: m.level,
            class: m.class ?? null,
            note: m.note ?? null,
            officerNote: m.officernote ?? null,
          })),
        }),
        ctx.db.guild.update({
          where: { id: input.guildId },
          data: {
            lastRosterImportedAt: new Date(),
            lastRosterImportedById: ctx.session.user.id,
          },
        }),
      ]);

      return { count: members.length };
    }),

  // officerNote is stripped for non-admins — same visibility rule the
  // in-game guild panel itself enforces (regular members can't see officer
  // notes there either), so the addon-sourced copy shouldn't leak it.
  rosterMembers: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
      const [{ hasAccess, retryAfterSeconds }, { isAdmin }] = await Promise.all([
        checkGuildRole(ctx.db, input.guildId, ctx.session.user.id),
        checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id),
      ]);
      if (!hasAccess) {
        throw forbiddenOrRateLimited(retryAfterSeconds);
      }

      const members = await ctx.db.guildRosterMember.findMany({
        where: { guildId: input.guildId },
        orderBy: [{ level: "desc" }, { name: "asc" }],
      });

      if (isAdmin) return members;
      return members.map((m) => ({ ...m, officerNote: null }));
    }),

  rosterImportStatus: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
      const guild = await ctx.db.guild.findUnique({
        where: { id: input.guildId },
        select: {
          lastRosterImportedAt: true,
          lastRosterImportedBy: { select: { nickname: true, name: true } },
        },
      });
      if (!guild) throw new TRPCError({ code: "NOT_FOUND" });

      return {
        lastRosterImportedAt: guild.lastRosterImportedAt,
        lastRosterImportedByName: guild.lastRosterImportedBy
          ? (guild.lastRosterImportedBy.nickname ?? guild.lastRosterImportedBy.name)
          : null,
      };
    }),
});
