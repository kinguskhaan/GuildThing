import { deflateSync } from "node:zlib";

import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { generateApiKey, uniqueGuildSlug } from "@guildthing/db";
import { env } from "~/env";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import type { db as Db } from "~/server/db";
import {
  applyCharacterImport,
  applyRosterImport,
  rosterExportSchema,
  wowImportSchema,
} from "~/server/wow-import";
import { tbcProfessionRecipes, tbcRecipes } from "@guildthing/wowhead-data";
import {
  addRoleToMember,
  DiscordRateLimitedError,
  DiscordReauthRequiredError,
  fetchUserGuilds,
  getGuildChannels,
  getGuildChannelsForEvents,
  getGuildChannelsForGrants,
  getGuildIconUrl,
  getGuildMembers,
  getGuildRoles,
  getMyRoleIds,
  hasGuildRole,
  isGuildMember,
  removeRoleFromMember,
  sendDirectMessage,
  setMemberNickname,
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

// One condition within a GuildRoleRule (see schema.prisma) — "equals"
// pairs with rank/class (a text value), "between" pairs with level (a
// min/max pair). Refined so the admin UI can't save a nonsensical
// combination (e.g. a level condition with no numbers).
const roleRuleConditionSchema = z
  .object({
    field: z.enum(["rank", "level", "class"]),
    operator: z.enum(["equals", "between"]),
    textValue: z.string().min(1).optional(),
    minNumber: z.number().optional(),
    maxNumber: z.number().optional(),
  })
  .refine(
    (c) =>
      c.field === "level"
        ? c.operator === "between" && c.minNumber != null && c.maxNumber != null
        : c.operator === "equals" && !!c.textValue,
    {
      message:
        "level conditions need a min/max range; rank/class conditions need a text value",
    },
  );

export async function checkGuildRole(
  db: typeof Db,
  guildId: string,
  userId: string,
) {
  const guild = await db.guild.findUnique({
    where: { id: guildId },
    include: { requiredRoles: true },
  });
  if (!guild) throw new TRPCError({ code: "NOT_FOUND" });

  // Same "creator can never lock themselves out" bypass checkGuildAdmin
  // has — without it, an owner who hasn't (yet, or currently) held one of
  // their own configured required roles in Discord would fail this check
  // despite being able to edit those very requirements via EditGuildForm.
  if (guild.createdById === userId) {
    return {
      guild,
      hasAccess: true,
      needsReauth: false as const,
      retryAfterSeconds: null,
    };
  }

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
export async function checkGuildAdmin(
  db: typeof Db,
  guildId: string,
  userId: string,
) {
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
// in, for cleaning up stray/mistaken entries other members left behind. A
// null ownerId is an unclaimed peer-sourced row (see GuildCharacter.userId)
// — nobody self-owns it yet, so only a guild admin can touch it.
async function canModifyCharacter(
  db: typeof Db,
  ownerId: string | null,
  guildId: string,
  userId: string,
): Promise<boolean> {
  if (ownerId === userId) return true;
  const { isAdmin } = await checkGuildAdmin(db, guildId, userId);
  return isAdmin;
}

export function forbiddenOrRateLimited(retryAfterSeconds: number | null) {
  return new TRPCError(
    retryAfterSeconds != null
      ? {
          code: "TOO_MANY_REQUESTS",
          message: `Discord is rate limiting us — try again in about ${retryAfterSeconds}s.`,
        }
      : { code: "FORBIDDEN" },
  );
}

// The instance owner is always allowed to create guilds and manage who
// else can — set once via env, can't be locked out by the settings below.
export function isInstanceOwner(email: string): boolean {
  return email.toLowerCase() === env.GUILD_CREATOR_EMAIL.toLowerCase();
}

// InstanceSettings.guildCreationMode gate — see its doc comment in
// schema.prisma for what each mode means. Defaults to "owner" (the old
// hardcoded behavior) if no settings row exists yet.
export async function isAllowedToCreateGuild(
  db: typeof Db,
  email: string,
): Promise<boolean> {
  if (isInstanceOwner(email)) return true;

  const settings = await db.instanceSettings.findUnique({
    where: { id: "singleton" },
  });
  const mode = settings?.guildCreationMode ?? "owner";
  if (mode === "public") return true;
  if (mode === "allowlist") {
    const allowed = await db.allowedGuildCreator.findUnique({
      where: { email: email.toLowerCase() },
    });
    return allowed != null;
  }
  return false;
}

export const guildRouter = createTRPCRouter({
  // Drives whether the "Create a guild" button/form shows up at all — the
  // create mutation is the actual enforcement (this is just so non-owners
  // aren't shown a form they'd get a FORBIDDEN back from).
  canCreateGuild: protectedProcedure.query(({ ctx }) => {
    return isAllowedToCreateGuild(ctx.db, ctx.session.user.email);
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

  // Who's allowed to create guilds is governed by InstanceSettings (see
  // isAllowedToCreateGuild) — canCreateGuild above is just UI dressing,
  // this check is the actual enforcement (client checks are trivially
  // bypassable).
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
      if (!(await isAllowedToCreateGuild(ctx.db, ctx.session.user.email))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You're not allowed to create guilds on this instance.",
        });
      }

      const slug = await uniqueGuildSlug(ctx.db, input.name);

      return ctx.db.guild.create({
        data: {
          name: input.name,
          slug,
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
  // Resolves the slug in a /guilds/[guildSlug] URL to the guild's real id —
  // every other procedure still takes the id (guildId), so this is the one
  // place a route/page needs to bridge from "what's in the URL" to "what
  // the rest of the API expects". No access check here: a slug->id mapping
  // isn't sensitive (same information `list` already returns to anyone with
  // guild access), the actual access check happens in `get`.
  resolveSlug: protectedProcedure
    .input(z.object({ slug: z.string() }))
    .query(async ({ ctx, input }) => {
      const guild = await ctx.db.guild.findUnique({
        where: { slug: input.slug },
        select: { id: true },
      });
      if (!guild) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No guild found for this URL.",
        });
      }
      return { id: guild.id };
    }),

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
          slug: g.slug,
          name: g.name,
          createdAt: g.createdAt,
          iconUrl: await safeGuildIconUrl(
            g.discordGuildId,
            ctx.session.user.id,
          ),
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
        rosterSource: guild.rosterSource,
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
              message:
                "You don't have the required Discord role for this guild.",
            });
      }

      return applyCharacterImport(
        ctx.db,
        input.guildId,
        ctx.session.user.id,
        input.character,
      );
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

      // Claims an existing unclaimed (peer-sourced) row for this name+realm
      // if one exists, same as importCharacter's self-import branch —
      // otherwise a manual add would create a duplicate row alongside it.
      // Same hijack guard as importCharacter: never steal a row someone
      // else already claimed.
      const existing = await ctx.db.guildCharacter.findUnique({
        where: {
          guildId_name_realm: { guildId: input.guildId, name: input.name, realm },
        },
      });
      if (existing?.userId && existing.userId !== ctx.session.user.id) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `${input.name}-${realm} is already claimed by another member of this guild.`,
        });
      }

      return ctx.db.guildCharacter.upsert({
        where: {
          guildId_name_realm: { guildId: input.guildId, name: input.name, realm },
        },
        create: {
          guildId: input.guildId,
          userId: ctx.session.user.id,
          name: input.name,
          realm,
        },
        update: {
          userId: ctx.session.user.id,
        },
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

  // A GuildThing Roster addon scan is a complete point-in-time snapshot of
  // everyone in the guild, so rows for people who've since left still get
  // deleted on the next import — but existing rows are upserted by name,
  // not deleted and recreated, so claimedByDiscordUserId/Tag (set during
  // Discord onboarding) survives a re-import instead of being wiped every
  // time an admin refreshes the roster.
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

      return applyRosterImport(
        ctx.db,
        input.guildId,
        ctx.session.user.id,
        result.data,
      );
    }),

  // officerNote is stripped for non-admins — same visibility rule the
  // in-game guild panel itself enforces (regular members can't see officer
  // notes there either), so the addon-sourced copy shouldn't leak it.
  rosterMembers: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
      const [{ hasAccess, retryAfterSeconds }, { isAdmin }] = await Promise.all(
        [
          checkGuildRole(ctx.db, input.guildId, ctx.session.user.id),
          checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id),
        ],
      );
      if (!hasAccess) {
        throw forbiddenOrRateLimited(retryAfterSeconds);
      }

      const members = await ctx.db.guildRosterMember.findMany({
        where: { guildId: input.guildId },
        include: { claimConflicts: { select: { id: true } } },
        orderBy: [{ level: "desc" }, { name: "asc" }],
      });

      const claimedIds = members
        .map((m) => m.claimedByDiscordUserId)
        .filter((id): id is string => id != null);
      const activityRows =
        claimedIds.length > 0
          ? await ctx.db.guildMemberActivity.findMany({
              where: {
                guildId: input.guildId,
                discordUserId: { in: claimedIds },
              },
              select: { discordUserId: true, lastActiveAt: true },
            })
          : [];
      const lastActiveByDiscordId = new Map(
        activityRows.map((r) => [r.discordUserId, r.lastActiveAt]),
      );

      // Professions are self-reported separately (manual entry or the
      // old addon flow — see GuildCharacter), matched onto a roster row by
      // character name so "who can craft what" shows up on the same row
      // as the live roster data, without the two systems needing to share
      // a key beyond the name itself.
      const characterRows = await ctx.db.guildCharacter.findMany({
        where: { guildId: input.guildId },
        select: { name: true, professions: { select: { name: true } } },
      });
      const professionsByName = new Map<string, Set<string>>();
      for (const c of characterRows) {
        if (c.professions.length === 0) continue;
        const key = c.name.toLowerCase();
        const set = professionsByName.get(key) ?? new Set<string>();
        for (const p of c.professions) set.add(p.name);
        professionsByName.set(key, set);
      }

      const withConflictFlag = members.map(({ claimConflicts, ...m }) => ({
        ...m,
        hasClaimConflict: claimConflicts.length > 0,
        lastActiveAt: m.claimedByDiscordUserId
          ? (lastActiveByDiscordId.get(m.claimedByDiscordUserId) ?? null)
          : null,
        professions: [...(professionsByName.get(m.name.toLowerCase()) ?? [])],
      }));

      if (isAdmin) return withConflictFlag;
      return withConflictFlag.map((m) => ({
        ...m,
        officerNote: null,
        claimedByDiscordUserId: null,
        claimedByDiscordTag: null,
        lastActiveAt: null,
      }));
    }),

  // Un-claims a roster character (e.g. someone claimed the wrong name, or
  // a conflicted claim needs resetting so the right person can re-run
  // /onboarding and claim it correctly). In "addon" mode this just clears
  // claimedBy* — the row itself is addon-sourced and stays. In
  // "onboarding" mode the row only ever existed BECAUSE someone claimed
  // it (see matchRosterAndApply's create-on-claim path), so an unclaimed
  // row there is just clutter — delete it entirely instead.
  clearRosterClaim: protectedProcedure
    .input(z.object({ guildId: z.string(), rosterMemberId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id);
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      const member = await ctx.db.guildRosterMember.findUnique({
        where: { id: input.rosterMemberId },
        select: { guildId: true },
      });
      if (member?.guildId !== input.guildId) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      if (guild.rosterSource === "onboarding") {
        await ctx.db.guildRosterMember.delete({
          where: { id: input.rosterMemberId },
        });
      } else {
        await ctx.db.$transaction([
          ctx.db.guildRosterClaimConflict.deleteMany({
            where: { rosterMemberId: input.rosterMemberId },
          }),
          ctx.db.guildRosterMember.update({
            where: { id: input.rosterMemberId },
            data: { claimedByDiscordUserId: null, claimedByDiscordTag: null },
          }),
        ]);
      }

      return { ok: true };
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
          ? (guild.lastRosterImportedBy.nickname ??
            guild.lastRosterImportedBy.name)
          : null,
      };
    }),

  // Who's currently queued for the bot's automatic roster-match retry (see
  // GuildPendingRosterMatch) — i.e. people who typed a name during
  // onboarding that wasn't found (yet) in the roster.
  pendingRosterMatches: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
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

      const rows = await ctx.db.guildPendingRosterMatch.findMany({
        where: { guildId: input.guildId },
        orderBy: { createdAt: "desc" },
      });

      return rows.map((r) => ({
        id: r.id,
        discordUserTag: r.discordUserTag,
        names: JSON.parse(r.names) as string[],
        createdAt: r.createdAt,
      }));
    }),

  // Gives up retrying a queued entry — e.g. the admin knows that name will
  // never show up in the roster and would rather stop the notices than
  // wait out the full 42h.
  dismissPendingRosterMatch: protectedProcedure
    .input(z.object({ guildId: z.string(), id: z.string() }))
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

      await ctx.db.guildPendingRosterMatch.deleteMany({
        where: { id: input.id, guildId: input.guildId },
      });
      return { ok: true };
    }),

  // Discord server members who haven't claimed a roster character —
  // everyone except bots, PUGs (they were never meant to claim one — see
  // GuildPugMember, the authoritative "chose PUG" record, not a role
  // check, since a PUG role might not even be configured), and whoever
  // already has at least one GuildRosterMember row claimed to them.
  // Computed live against Discord + the roster each call rather than
  // tracked, since claim state can change from either side.
  unclaimedMembers: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id);
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      const [members, claimedRows, pugRows] = await Promise.all([
        getGuildMembers(guild.discordGuildId),
        ctx.db.guildRosterMember.findMany({
          where: {
            guildId: input.guildId,
            claimedByDiscordUserId: { not: null },
          },
          select: { claimedByDiscordUserId: true },
        }),
        ctx.db.guildPugMember.findMany({
          where: { guildId: input.guildId },
          select: { discordUserId: true },
        }),
      ]);

      const claimedIds = new Set(
        claimedRows.map((r) => r.claimedByDiscordUserId),
      );
      const pugIds = new Set(pugRows.map((r) => r.discordUserId));

      return members
        .filter((m) => !m.bot)
        .filter((m) => !pugIds.has(m.id))
        .filter((m) => !claimedIds.has(m.id))
        .map((m) => ({ id: m.id, tag: m.tag, roleIds: m.roleIds }));
    }),

  // DMs each given member a reminder to onboard, via the bot's own token
  // (no bot process/gateway involved — see sendDirectMessage). Points at
  // the onboarding channel if one's configured, otherwise /onboarding.
  // Failures (DMs closed) are expected and just counted, not treated as
  // errors.
  remindUnclaimedMembers: protectedProcedure
    .input(
      z.object({ guildId: z.string(), memberIds: z.array(z.string()).min(1) }),
    )
    .mutation(async ({ ctx, input }) => {
      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id);
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      const hint = guild.onboardingChannelId
        ? `head to <#${guild.onboardingChannelId}> and click "Start Onboarding"`
        : "run `/onboarding`";
      const content = `Friendly reminder from ${guild.name} — you haven't claimed a character yet! To get set up, ${hint}.`;

      const results = await Promise.all(
        input.memberIds.map((id) => sendDirectMessage(id, content)),
      );
      const sent = results.filter(Boolean).length;
      return { sent, failed: results.length - sent };
    }),

  // Grants discordRoleId to every given member — e.g. a "Needs Onboarding"
  // flair role, so they're visible in the member list. Same role-hierarchy
  // rules as everywhere else the bot grants roles apply; failures are
  // counted, not thrown, since one bad id in a batch shouldn't lose the
  // rest.
  assignRoleToMembers: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        memberIds: z.array(z.string()).min(1),
        discordRoleId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id);
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      const results = await Promise.all(
        input.memberIds.map((id) =>
          addRoleToMember(guild.discordGuildId, id, input.discordRoleId),
        ),
      );
      const succeeded = results.filter(Boolean).length;
      return { succeeded, failed: results.length - succeeded };
    }),

  // Every non-bot member currently holding discordRoleId, with their FULL
  // current role list (not just the filtered one) — the role-audit view
  // filters down to "everyone with Core Raider", say, but also shows what
  // else each of them holds (e.g. a stale PUG role) so an admin can clean
  // up more than the one filtered role at a glance. Live against Discord
  // (via the bot's token), not cached, since the whole point is trusting
  // what's actually there over whatever the roster/rules last computed.
  membersWithRole: protectedProcedure
    .input(z.object({ guildId: z.string(), discordRoleId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id);
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      const members = await getGuildMembers(guild.discordGuildId);
      return members
        .filter((m) => !m.bot && m.roleIds.includes(input.discordRoleId))
        .map((m) => ({ id: m.id, tag: m.tag, roleIds: m.roleIds }));
    }),

  // Applies a batch of per-member/per-role add-or-remove decisions from the
  // role-audit view's grid (each cell there is one entry here) — one
  // Discord API call per entry, failures counted rather than thrown so one
  // bad id doesn't lose the rest. Only touches Discord directly: any role a
  // GuildRoleRule still grants to a given person gets re-added by the next
  // sync regardless of what's staged here, same as elsewhere this panel
  // manages roles by hand.
  applyMemberRoleChanges: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        changes: z
          .array(
            z.object({
              discordUserId: z.string().min(1),
              discordRoleId: z.string().min(1),
              add: z.boolean(),
            }),
          )
          .min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id);
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      const results = await Promise.all(
        input.changes.map((c) =>
          c.add
            ? addRoleToMember(guild.discordGuildId, c.discordUserId, c.discordRoleId)
            : removeRoleFromMember(
                guild.discordGuildId,
                c.discordUserId,
                c.discordRoleId,
              ),
        ),
      );
      const succeeded = results.filter(Boolean).length;
      return { succeeded, failed: results.length - succeeded };
    }),

  // GuildMemberNickname rows for the admin nickname-override panel —
  // computedName (what matchRosterAndApply would set with no override) next
  // to any admin/self-set preferredNickname override. See
  // apps/bot/src/roleLogic.ts for where computedName gets refreshed and the
  // override applied.
  memberNicknames: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
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

      return ctx.db.guildMemberNickname.findMany({
        where: { guildId: input.guildId },
        orderBy: { updatedAt: "desc" },
      });
    }),

  // Sets (nickname: string) or clears (nickname: null, reverting to
  // computedName) an override, and applies it to Discord immediately via
  // the bot's own token — see setMemberNickname in ~/server/discord — so
  // the admin doesn't have to wait for the member to re-run /onboarding.
  setMemberNicknameOverride: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        discordUserId: z.string(),
        nickname: z.string().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id);
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      const row = await ctx.db.guildMemberNickname.findUnique({
        where: {
          guildId_discordUserId: {
            guildId: input.guildId,
            discordUserId: input.discordUserId,
          },
        },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });

      await ctx.db.guildMemberNickname.update({
        where: { id: row.id },
        data: { preferredNickname: input.nickname },
      });

      const applied = await setMemberNickname(
        guild.discordGuildId,
        input.discordUserId,
        input.nickname ?? row.computedName,
      );
      return { ok: true, applied };
    }),

  // Distinct rank/class values already in the roster, so the Discord-roles
  // admin UI can offer a datalist instead of the admin free-typing exact
  // strings that have to match GuildRosterMember rows verbatim.
  rosterRankOptions: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
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

      const rows = await ctx.db.guildRosterMember.findMany({
        where: { guildId: input.guildId },
        distinct: ["rank"],
        select: { rank: true },
        orderBy: { rank: "asc" },
      });
      return rows.map((r) => r.rank);
    }),

  rosterClassOptions: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
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

      const rows = await ctx.db.guildRosterMember.findMany({
        where: { guildId: input.guildId, class: { not: null } },
        distinct: ["class"],
        select: { class: true },
        orderBy: { class: "asc" },
      });
      return rows.map((r) => r.class).filter((c): c is string => c !== null);
    }),

  // "addon" vs "onboarding" — see Guild.rosterSource in schema.prisma for
  // what each means. Changing this doesn't touch existing roster rows,
  // just how future onboarding claims/creates them.
  setRosterSource: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        rosterSource: z.enum(["addon", "onboarding"]),
      }),
    )
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

      await ctx.db.guild.update({
        where: { id: input.guildId },
        data: { rosterSource: input.rosterSource },
      });
      return { ok: true };
    }),

  setPugRole: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        enabled: z.boolean(),
        discordRoleId: z.string().nullable(),
      }),
    )
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

      await ctx.db.guild.update({
        where: { id: input.guildId },
        data: { pugEnabled: input.enabled, pugRoleId: input.discordRoleId },
      });
      return { ok: true };
    }),

  // Full Discord role list (id + name), via the bot's token — lets the
  // admin UI offer a dropdown of actual role names instead of the admin
  // having to paste raw role IDs by hand.
  discordRoles: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id);
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      return getGuildRoles(guild.discordGuildId);
    }),

  // Text-channel list for the guild's Discord server, via the bot's token —
  // same pattern as discordRoles above, used to pick where the bot posts
  // admin notices (e.g. roster-claim conflicts).
  discordChannels: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id);
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      return getGuildChannels(guild.discordGuildId);
    }),

  // Text AND forum channels, for the event-creation channel picker — see
  // getGuildChannelsForEvents for why both are valid there.
  discordChannelsForEvents: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id);
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      return getGuildChannelsForEvents(guild.discordGuildId);
    }),

  // Flags the guild for an out-of-band roster/role/channel-grant resync —
  // the bot polls for this every ~15s (see checkForceSyncRequests) instead
  // of the admin having to wait for the once-a-day automatic one while
  // debugging a rule/channel-grant setup.
  requestSync: protectedProcedure
    .input(z.object({ guildId: z.string() }))
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

      await ctx.db.guild.update({
        where: { id: input.guildId },
        data: { forceSyncRequestedAt: new Date() },
      });
      return { ok: true };
    }),

  // Text AND voice channels, via the bot's token — used by the role-rule
  // builder to let an admin grant direct per-member access to a specific
  // channel (see GuildRoleRuleGrantedChannel), separate from discordChannels
  // above (which is text-only, for the bot's own notice/button posts).
  discordChannelsForGrants: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id);
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      return getGuildChannelsForGrants(guild.discordGuildId);
    }),

  setAdminNotifyChannel: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        discordChannelId: z.string().nullable(),
      }),
    )
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

      await ctx.db.guild.update({
        where: { id: input.guildId },
        data: { adminNotifyChannelId: input.discordChannelId },
      });
      return { ok: true };
    }),

  // Public channel the bot keeps a standing "Start Onboarding" button
  // message in — see Guild.onboardingChannelId in schema.prisma.
  setOnboardingChannel: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        discordChannelId: z.string().nullable(),
      }),
    )
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

      await ctx.db.guild.update({
        where: { id: input.guildId },
        data: { onboardingChannelId: input.discordChannelId },
      });
      return { ok: true };
    }),

  // Custom text for the standing onboarding button message — null resets
  // to the bot's built-in default. The bot edits the existing message in
  // place on its next check (within ~60s), no reposting/repositioning.
  setOnboardingMessageText: protectedProcedure
    .input(z.object({ guildId: z.string(), text: z.string().nullable() }))
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

      await ctx.db.guild.update({
        where: { id: input.guildId },
        data: {
          onboardingMessageText: input.text?.trim() === "" ? null : input.text,
        },
      });
      return { ok: true };
    }),

  // Clears the bot's bookkeeping of which message is "the" onboarding
  // button — its next check (within ~60s) then posts a fresh one, which
  // lands at the current bottom of the channel. Use this to move the
  // button below content added to the channel after it was first posted.
  repostOnboardingButton: protectedProcedure
    .input(z.object({ guildId: z.string() }))
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

      await ctx.db.guild.update({
        where: { id: input.guildId },
        data: { onboardingMessageId: null },
      });
      return { ok: true };
    }),

  // Inactivity filter — see Guild.inactivityFilterEnabled in schema.prisma.
  // targetRoleIds is OR'd (any one of them counts) and its rows are fully
  // replaced on save, same convention as a rule's grantedRoles. days/
  // inactiveRoleId are nullable so the admin can enable the toggle and
  // fill the rest in afterward; the bot's daily job just skips guilds that
  // aren't fully configured yet.
  setInactivitySettings: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        enabled: z.boolean(),
        days: z.number().int().min(1).nullable(),
        targetRoleIds: z.array(z.string().min(1)),
        inactiveRoleId: z.string().nullable(),
      }),
    )
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

      await ctx.db.$transaction([
        ctx.db.guildInactivityTargetRole.deleteMany({
          where: { guildId: input.guildId },
        }),
        ctx.db.guildInactivityTargetRole.createMany({
          data: input.targetRoleIds.map((discordRoleId) => ({
            guildId: input.guildId,
            discordRoleId,
          })),
        }),
        ctx.db.guild.update({
          where: { id: input.guildId },
          data: {
            inactivityFilterEnabled: input.enabled,
            inactivityDays: input.days,
            inactivityRoleId: input.inactiveRoleId,
          },
        }),
      ]);
      return { ok: true };
    }),

  // pugRoleId + adminNotifyChannelId + onboardingChannelId/MessageText +
  // inactivity-filter settings + every role rule (with conditions) for the
  // guild, one call for the Discord-roles admin page — same "small
  // dedicated query" shape as exportStatus/rosterImportStatus above.
  discordRoleConfig: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
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

      const [guild, rules, rolePriorities] = await Promise.all([
        ctx.db.guild.findUnique({
          where: { id: input.guildId },
          select: {
            rosterSource: true,
            pugEnabled: true,
            pugRoleId: true,
            adminNotifyChannelId: true,
            onboardingChannelId: true,
            onboardingMessageText: true,
            inactivityFilterEnabled: true,
            inactivityDays: true,
            inactivityRoleId: true,
            inactivityTargetRoles: { select: { discordRoleId: true } },
            wowRegion: true,
            wowRealmSlug: true,
            wowGuildName: true,
            wowNamespaceFlavor: true,
          },
        }),
        ctx.db.guildRoleRule.findMany({
          where: { guildId: input.guildId },
          include: {
            conditions: true,
            grantedRoles: true,
            grantedChannels: true,
          },
          orderBy: { id: "asc" },
        }),
        ctx.db.guildRolePriority.findMany({
          where: { guildId: input.guildId },
          orderBy: { priority: "asc" },
        }),
      ]);
      if (!guild) throw new TRPCError({ code: "NOT_FOUND" });

      return {
        rosterSource: guild.rosterSource,
        pugEnabled: guild.pugEnabled,
        pugRoleId: guild.pugRoleId,
        adminNotifyChannelId: guild.adminNotifyChannelId,
        onboardingChannelId: guild.onboardingChannelId,
        onboardingMessageText: guild.onboardingMessageText,
        inactivityFilterEnabled: guild.inactivityFilterEnabled,
        inactivityDays: guild.inactivityDays,
        inactivityTargetRoleIds: guild.inactivityTargetRoles.map(
          (r) => r.discordRoleId,
        ),
        inactivityRoleId: guild.inactivityRoleId,
        wowRegion: guild.wowRegion,
        wowRealmSlug: guild.wowRealmSlug,
        wowGuildName: guild.wowGuildName,
        wowNamespaceFlavor: guild.wowNamespaceFlavor,
        rules,
        rolePriorityIds: rolePriorities.map((p) => p.discordRoleId),
      };
    }),

  // Battle.net Game Data API lookup config — lets onboarding tell a typo'd/
  // nickname-typed character name apart from a real character in a
  // different guild, instead of treating both as "probably not imported
  // yet". All four null (the default) skips the lookup entirely — see
  // Guild.wowRegion etc. in schema.prisma and apps/bot/src/battlenetApi.ts.
  setArmoryConfig: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        wowRegion: z.string().nullable(),
        wowRealmSlug: z.string().nullable(),
        wowGuildName: z.string().nullable(),
        wowNamespaceFlavor: z.string().nullable(),
      }),
    )
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

      await ctx.db.guild.update({
        where: { id: input.guildId },
        data: {
          wowRegion: input.wowRegion,
          wowRealmSlug: input.wowRealmSlug,
          wowGuildName: input.wowGuildName,
          wowNamespaceFlavor: input.wowNamespaceFlavor,
        },
      });
      return { ok: true };
    }),

  // Full replace of a rule's conditions AND granted roles on update (delete
  // + recreate both), same convention importRosterMembers uses for the
  // roster snapshot — simplest correct way to handle added/removed/edited
  // rows without diffing them client-side.
  upsertRoleRule: protectedProcedure
    .input(
      z.object({
        id: z.string().optional(),
        guildId: z.string(),
        label: z.string().optional(),
        discordRoleIds: z.array(z.string().min(1)).default([]),
        grantedChannels: z
          .array(
            z.object({
              discordChannelId: z.string().min(1),
              channelType: z.enum(["text", "voice"]),
            }),
          )
          .default([]),
        conditions: z.array(roleRuleConditionSchema).min(1),
      }),
    )
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

      if (
        input.discordRoleIds.length === 0 &&
        input.grantedChannels.length === 0
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A rule needs at least one role or channel to grant.",
        });
      }

      const conditionsData = input.conditions.map((c) => ({
        field: c.field,
        operator: c.operator,
        textValue: c.textValue ?? null,
        minNumber: c.minNumber ?? null,
        maxNumber: c.maxNumber ?? null,
      }));
      const grantedRolesData = input.discordRoleIds.map((discordRoleId) => ({
        discordRoleId,
      }));
      const grantedChannelsData = input.grantedChannels.map((g) => ({
        discordChannelId: g.discordChannelId,
        channelType: g.channelType,
      }));

      if (input.id) {
        const existing = await ctx.db.guildRoleRule.findUnique({
          where: { id: input.id },
          select: { guildId: true },
        });
        if (existing?.guildId !== input.guildId) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }

        await ctx.db.$transaction([
          ctx.db.guildRoleRuleCondition.deleteMany({
            where: { ruleId: input.id },
          }),
          ctx.db.guildRoleRuleGrantedRole.deleteMany({
            where: { ruleId: input.id },
          }),
          ctx.db.guildRoleRuleGrantedChannel.deleteMany({
            where: { ruleId: input.id },
          }),
          ctx.db.guildRoleRule.update({
            where: { id: input.id },
            data: {
              label: input.label,
              conditions: { create: conditionsData },
              grantedRoles: { create: grantedRolesData },
              grantedChannels: { create: grantedChannelsData },
            },
          }),
        ]);
        return { id: input.id };
      }

      const created = await ctx.db.guildRoleRule.create({
        data: {
          guildId: input.guildId,
          label: input.label,
          conditions: { create: conditionsData },
          grantedRoles: { create: grantedRolesData },
          grantedChannels: { create: grantedChannelsData },
        },
      });
      return { id: created.id };
    }),

  deleteRoleRule: protectedProcedure
    .input(z.object({ guildId: z.string(), id: z.string() }))
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

      await ctx.db.guildRoleRule.deleteMany({
        where: { id: input.id, guildId: input.guildId },
      });
      return { ok: true };
    }),

  // Full replace, ordered array = priority (index 0 is highest) — see
  // GuildRolePriority in schema.prisma and evaluateRules in roleLogic.ts.
  // An empty array just clears the list, same as removing every role from
  // it one at a time would.
  setRolePriorities: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        discordRoleIds: z.array(z.string().min(1)),
      }),
    )
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

      await ctx.db.$transaction([
        ctx.db.guildRolePriority.deleteMany({
          where: { guildId: input.guildId },
        }),
        ctx.db.guildRolePriority.createMany({
          data: input.discordRoleIds.map((discordRoleId, priority) => ({
            guildId: input.guildId,
            discordRoleId,
            priority,
          })),
        }),
      ]);
      return { ok: true };
    }),

  // Lets an admin mint a secret bearer token for apps/sync (a locally-run
  // script that reads WoW SavedVariables and pushes roster/character data
  // to /api/v1/roster and /api/v1/characters) — see GuildApiKey in
  // schema.prisma. The raw key is only ever returned here, at creation.
  createApiKey: protectedProcedure
    .input(z.object({ guildId: z.string(), name: z.string().min(1) }))
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

      const { raw, hash, prefix } = generateApiKey();
      const key = await ctx.db.guildApiKey.create({
        data: {
          guildId: input.guildId,
          name: input.name,
          keyHash: hash,
          keyPrefix: prefix,
          createdById: ctx.session.user.id,
        },
      });
      return {
        id: key.id,
        name: key.name,
        prefix: key.keyPrefix,
        createdAt: key.createdAt,
        rawKey: raw,
      };
    }),

  listApiKeys: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
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

      const keys = await ctx.db.guildApiKey.findMany({
        where: { guildId: input.guildId },
        orderBy: { createdAt: "desc" },
      });
      return keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.keyPrefix,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        revokedAt: k.revokedAt,
      }));
    }),

  revokeApiKey: protectedProcedure
    .input(z.object({ guildId: z.string(), id: z.string() }))
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

      await ctx.db.guildApiKey.updateMany({
        where: { id: input.id, guildId: input.guildId },
        data: { revokedAt: new Date() },
      });
      return { ok: true };
    }),
});
