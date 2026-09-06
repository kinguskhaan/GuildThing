import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  ensureOnboardingFlowMigrated,
  ensurePugActionStepsMigrated,
  generateApiKey,
  uniqueGuildSlug,
} from "@guildthing/db";
import { env } from "~/env";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { WOW_CLASS_TOKENS } from "~/lib/format";
import type { db as Db } from "~/server/db";
import {
  applyCharacterImport,
  applyRosterImport,
  rosterExportSchema,
  wowImportSchema,
} from "~/server/wow-import";
import { EXPANSION_ORDER, tbcProfessionRecipes, tbcRecipes } from "@guildthing/wowhead-data";
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
  getGuildRolesSnapshot,
  getMyRoleIds,
  hasGuildRole,
  isBotInGuild,
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
// min/max pair), "includes" pairs with answer (an onboarding step id +
// at least one of its option ids). Refined so the admin UI can't save a
// nonsensical combination (e.g. a level condition with no numbers).
const roleRuleConditionSchema = z
  .object({
    field: z.enum(["rank", "level", "class", "answer"]),
    operator: z.enum(["equals", "between", "includes"]),
    textValue: z.string().min(1).optional(),
    minNumber: z.number().optional(),
    maxNumber: z.number().optional(),
    onboardingStepId: z.string().min(1).optional(),
    optionIds: z.array(z.string().min(1)).optional(),
  })
  .refine(
    (c) => {
      if (c.field === "level") {
        return (
          c.operator === "between" && c.minNumber != null && c.maxNumber != null
        );
      }
      if (c.field === "answer") {
        return (
          c.operator === "includes" &&
          !!c.onboardingStepId &&
          (c.optionIds?.length ?? 0) > 0
        );
      }
      return c.operator === "equals" && !!c.textValue;
    },
    {
      message:
        "level conditions need a min/max range; answer conditions need a question and at least one option; rank/class conditions need a text value",
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

  // Step 2 of the create-guild wizard polls this to find out whether the
  // bot has actually been invited yet, so it can auto-advance to the named
  // role picker instead of making the user click "continue" on faith.
  checkBotPresence: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id);
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      return isBotInGuild(guild.discordGuildId);
    }),

  // Who's allowed to create guilds is governed by InstanceSettings (see
  // isAllowedToCreateGuild) — canCreateGuild above is just UI dressing,
  // this check is the actual enforcement (client checks are trivially
  // bypassable).
  //
  // requiredRoleIds may be empty — the creator always passes checkGuildRole/
  // checkGuildAdmin regardless (see the createdById bypass above), so an
  // empty list just means "nobody but the creator can see this guild page
  // yet," not "everyone can." The create-guild wizard leans on this to let
  // people finish setup before they've picked any Discord roles.
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        discordGuildId: z.string().min(1),
        requiredRoleIds: z.array(z.string().min(1)).default([]),
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
        lastRosterImportedAt: guild.lastRosterImportedAt,
        botEnabled: guild.botEnabled,
        expansion: guild.expansion,
        // Whether the raid comp tool's Battle.net spec sync can run at all
        // for this guild — all three fields come from the same armory
        // config used by onboarding's character lookup (see
        // battlenetApi.ts), so "configured" means the same thing here.
        bnetConfigured: !!(
          guild.wowRegion &&
          guild.wowRealmSlug &&
          guild.wowNamespaceFlavor
        ),
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
          guildId_name_realm: {
            guildId: input.guildId,
            name: input.name,
            realm,
          },
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
          guildId_name_realm: {
            guildId: input.guildId,
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

      // Custom onboarding-question answers — public, same as class/level/
      // professions, so shown to every viewer regardless of isAdmin (not
      // added to the non-admin strip below). Matched by claimedByDiscordUserId
      // same as lastActiveAt above, since answers are per-person, not tied
      // to a specific roster row.
      const answerRows =
        claimedIds.length > 0
          ? await ctx.db.guildOnboardingStepAnswer.findMany({
              where: {
                guildId: input.guildId,
                discordUserId: { in: claimedIds },
              },
              include: {
                step: { select: { prompt: true, questionType: true } },
                selectedOptions: {
                  include: { option: { select: { label: true } } },
                },
              },
            })
          : [];
      const answersByDiscordId = new Map<
        string,
        { prompt: string; value: string }[]
      >();
      for (const a of answerRows) {
        const value =
          a.step.questionType === "free_text"
            ? (a.textValue ?? "")
            : a.selectedOptions.map((so) => so.option.label).join(", ");
        if (!value) continue;
        const list = answersByDiscordId.get(a.discordUserId) ?? [];
        list.push({ prompt: a.step.prompt ?? "", value });
        answersByDiscordId.set(a.discordUserId, list);
      }

      // Roster-table badge: the exact manual change that's causing the
      // resync to back off for this person, not just a yes/no flag — "role
      // sync skipped" with no reason attached was the one badge in this
      // table an admin couldn't actually act on. Keeps only the most
      // recent manual change per account (ordered desc, first-wins Map).
      const roleSyncSkipReasonByDiscordId = new Map<
        string,
        {
          executorTag: string | null;
          addedRoleNames: string[];
          removedRoleNames: string[];
          detectedAt: Date;
        }
      >();
      if (claimedIds.length > 0) {
        const manualChanges = await ctx.db.guildRoleChangeEvent.findMany({
          where: {
            guildId: input.guildId,
            discordUserId: { in: claimedIds },
            source: "manual",
          },
          orderBy: { detectedAt: "desc" },
        });
        for (const change of manualChanges) {
          if (roleSyncSkipReasonByDiscordId.has(change.discordUserId)) continue;
          roleSyncSkipReasonByDiscordId.set(change.discordUserId, {
            executorTag: change.executorTag,
            addedRoleNames: JSON.parse(change.addedRoleNames) as string[],
            removedRoleNames: JSON.parse(change.removedRoleNames) as string[],
            detectedAt: change.detectedAt,
          });
        }
      }

      const withConflictFlag = members.map(({ claimConflicts, ...m }) => ({
        ...m,
        hasClaimConflict: claimConflicts.length > 0,
        roleSyncSkipReason: m.claimedByDiscordUserId
          ? (roleSyncSkipReasonByDiscordId.get(m.claimedByDiscordUserId) ?? null)
          : null,
        lastActiveAt: m.claimedByDiscordUserId
          ? (lastActiveByDiscordId.get(m.claimedByDiscordUserId) ?? null)
          : null,
        professions: [...(professionsByName.get(m.name.toLowerCase()) ?? [])],
        customAnswers: m.claimedByDiscordUserId
          ? (answersByDiscordId.get(m.claimedByDiscordUserId) ?? [])
          : [],
      }));

      if (isAdmin) return withConflictFlag;
      return withConflictFlag.map((m) => ({
        ...m,
        officerNote: null,
        claimedByDiscordUserId: null,
        claimedByDiscordTag: null,
        lastActiveAt: null,
        roleSyncSkipReason: null,
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

  // Every non-bot Discord server member (id + tag), for the "Claim a
  // character" admin form's member picker — not filtered to
  // claimed/unclaimed like unclaimedMembers above, since an admin might be
  // adding an ADDITIONAL alt for someone who already has a main claimed.
  guildMembersForClaim: protectedProcedure
    .input(z.object({ guildId: z.string() }))
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
        .filter((m) => !m.bot)
        .map((m) => ({ id: m.id, tag: m.tag }));
    }),

  // Manually claims a character for a Discord account — the admin
  // counterpart to onboarding's own name-matching, for cases it can't
  // handle: an out-of-guild alt that'll never show up in an addon export
  // (see the "real character, not a guild member" admin notice in
  // roleLogic.ts), or fixing up a claim by hand. If `name` already exists
  // as an unclaimed roster row, claims that row as-is (rank/level/class
  // untouched). If it doesn't exist, creates a new manuallyAdded row —
  // survives future addon imports (see applyRosterImport's deleteMany).
  // Refuses to steal a claim someone else already holds; use
  // clearRosterClaim first if reassigning is really the intent.
  adminClaimCharacter: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        discordUserId: z.string().min(1),
        discordUserTag: z.string().min(1),
        name: z.string().min(1),
        rank: z.string().optional(),
        level: z.number().int().optional(),
        class: z.string().optional(),
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

      const normalizedName = input.name.trim().toLowerCase();
      const existing = (
        await ctx.db.guildRosterMember.findMany({
          where: { guildId: input.guildId },
        })
      ).find((m) => m.name.toLowerCase() === normalizedName);

      if (existing) {
        if (
          existing.claimedByDiscordUserId &&
          existing.claimedByDiscordUserId !== input.discordUserId
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `"${input.name}" is already claimed by ${existing.claimedByDiscordTag ?? "someone else"} — clear that claim first if you want to reassign it.`,
          });
        }
        await ctx.db.guildRosterMember.update({
          where: { id: existing.id },
          data: {
            claimedByDiscordUserId: input.discordUserId,
            claimedByDiscordTag: input.discordUserTag,
            claimedAt: new Date(),
          },
        });
        return { ok: true, created: false };
      }

      const trimmedRank = input.rank?.trim();
      const trimmedClass = input.class?.trim();
      await ctx.db.guildRosterMember.create({
        data: {
          guildId: input.guildId,
          name: input.name,
          rank:
            trimmedRank === "" || trimmedRank == null ? "Member" : trimmedRank,
          level: input.level ?? 1,
          class:
            trimmedClass === "" || trimmedClass == null ? null : trimmedClass,
          claimedByDiscordUserId: input.discordUserId,
          claimedByDiscordTag: input.discordUserTag,
          claimedAt: new Date(),
          manuallyAdded: true,
        },
      });
      return { ok: true, created: true };
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

  // Real, Battle.net-verified characters typed during onboarding that
  // aren't a member of THIS guild (wrong guild, or none) — see
  // GuildExternalCharacter in schema.prisma and the "real character(s),
  // but not a member of this guild" admin notice in roleLogic.ts. Doesn't
  // show up in rosterMembers/unclaimedMembers at all (those are guild-
  // roster-only), hence a dedicated view.
  externalCharacters: protectedProcedure
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

      return ctx.db.guildExternalCharacter.findMany({
        where: { guildId: input.guildId },
        orderBy: { claimedAt: "desc" },
      });
    }),

  // Unified chronological history — GuildRankChangeEvent (in-game rank
  // transitions) merged with GuildRoleChangeEvent (every Discord role
  // add/remove GuildThing has made, bot-driven or a human's manual edit
  // the resync deliberately left alone) into one feed, same idea as the
  // Guild_Roster_Manager addon's own audit log but spanning both sides.
  // Relayed into the addon via apps/sync as part of GuildThing.lua.
  auditLog: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        // Scopes the feed to one Discord account's own history (the roster
        // table's per-member detail drawer) instead of the whole guild's
        // most recent 100 events — without this, a person whose events fall
        // outside that global top-100 window would show an empty log even
        // though their history exists further back.
        discordUserId: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id);
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      const personCharacterNames = input.discordUserId
        ? (
            await ctx.db.guildRosterMember.findMany({
              where: {
                guildId: input.guildId,
                claimedByDiscordUserId: input.discordUserId,
              },
              select: { name: true },
            })
          ).map((m) => m.name)
        : null;
      const take = personCharacterNames ? 200 : 100;

      const [rankEvents, roleChanges, claims, rosterMembers, snapshot] =
        await Promise.all([
          ctx.db.guildRankChangeEvent.findMany({
            where: {
              guildId: input.guildId,
              ...(personCharacterNames
                ? { characterName: { in: personCharacterNames } }
                : {}),
            },
            orderBy: { detectedAt: "desc" },
            take,
          }),
          ctx.db.guildRoleChangeEvent.findMany({
            where: {
              guildId: input.guildId,
              ...(input.discordUserId
                ? { discordUserId: input.discordUserId }
                : {}),
            },
            orderBy: { detectedAt: "desc" },
            take,
          }),
          ctx.db.guildRosterMember.findMany({
            where: {
              guildId: input.guildId,
              claimedAt: { not: null },
              ...(input.discordUserId
                ? { claimedByDiscordUserId: input.discordUserId }
                : {}),
            },
            select: {
              id: true,
              name: true,
              claimedByDiscordUserId: true,
              claimedByDiscordTag: true,
              claimedAt: true,
            },
            orderBy: { claimedAt: "desc" },
            take,
          }),
          // For resolving a Discord identity's in-game character name (and
          // vice versa) — role_change/claim entries key by discordUserId,
          // rank_change entries key by characterName, but every entry
          // should end up with BOTH so the UI can search/filter/display
          // consistently regardless of which side originated it.
          ctx.db.guildRosterMember.findMany({
            where: {
              guildId: input.guildId,
              claimedByDiscordUserId: { not: null },
            },
            select: { name: true, claimedByDiscordUserId: true },
          }),
          getGuildRolesSnapshot(guild.discordGuildId),
        ]);

      const nameByDiscordUserId = new Map<string, string>();
      const discordUserIdByName = new Map<string, string>();
      for (const m of rosterMembers) {
        if (!m.claimedByDiscordUserId) continue;
        nameByDiscordUserId.set(m.claimedByDiscordUserId, m.name);
        discordUserIdByName.set(m.name, m.claimedByDiscordUserId);
      }
      const discordIdentity = (discordUserId: string | null | undefined) => {
        const entry = discordUserId ? snapshot[discordUserId] : undefined;
        return {
          discordNick: entry?.nick ?? null,
          discordTag: entry?.tag ?? null,
        };
      };

      const entries = [
        ...rankEvents.map((r) => ({
          kind: "rank_change" as const,
          id: r.id,
          detectedAt: r.detectedAt,
          characterName: r.characterName,
          oldRank: r.oldRank,
          newRank: r.newRank,
          ...discordIdentity(discordUserIdByName.get(r.characterName)),
        })),
        ...roleChanges.map((r) => ({
          kind: "role_change" as const,
          id: r.id,
          detectedAt: r.detectedAt,
          characterName:
            nameByDiscordUserId.get(r.discordUserId) ?? r.discordUserTag,
          source: r.source as "bot" | "manual",
          discordUserId: r.discordUserId,
          discordUserTag: r.discordUserTag,
          executorTag: r.executorTag,
          addedRoleNames: JSON.parse(r.addedRoleNames) as string[],
          removedRoleNames: JSON.parse(r.removedRoleNames) as string[],
          ...discordIdentity(r.discordUserId),
        })),
        ...claims.map((c) => ({
          kind: "claim" as const,
          id: c.id,
          // claimedAt is guaranteed non-null by the where clause above.
          detectedAt: c.claimedAt!,
          characterName: c.name,
          discordUserTag: c.claimedByDiscordTag,
          ...discordIdentity(c.claimedByDiscordUserId),
        })),
      ];
      entries.sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime());
      return entries.slice(0, take);
    }),

  // Drops the tracking row — e.g. the admin knows that character will never
  // join this guild and doesn't want it cluttering the list. Purely
  // bookkeeping: doesn't touch the member's channel access, and the row
  // just gets recreated on their next onboarding run if the character is
  // still Battle.net-confirmed external at that point.
  dismissExternalCharacter: protectedProcedure
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

      await ctx.db.guildExternalCharacter.deleteMany({
        where: { id: input.id, guildId: input.guildId },
      });
      return { ok: true };
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
  // everyone except bots, holders of an admin-configured "non-claimable"
  // role (see GuildNonClaimableRole — PUGs and any other role admins don't
  // want nagged, checked live against Discord roles rather than tracked,
  // so it stays correct even if a role is added/removed after the fact),
  // and whoever already has at least one GuildRosterMember row claimed to
  // them. Computed live against Discord + the roster each call rather than
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

      const [members, claimedRows, nonClaimableRoleRows, nicknameRows] = await Promise.all([
        getGuildMembers(guild.discordGuildId),
        ctx.db.guildRosterMember.findMany({
          where: {
            guildId: input.guildId,
            claimedByDiscordUserId: { not: null },
          },
          select: { claimedByDiscordUserId: true },
        }),
        ctx.db.guildNonClaimableRole.findMany({
          where: { guildId: input.guildId },
          select: { discordRoleId: true },
        }),
        // Someone can complete onboarding (typing character names, getting a
        // computed nickname) without ever matching a roster row — they're
        // still unclaimed by the definition above, but their nickname is
        // already real and worth showing/editing here rather than only in
        // the claimed-member drawer.
        ctx.db.guildMemberNickname.findMany({
          where: { guildId: input.guildId },
          select: { discordUserId: true, computedName: true, preferredNickname: true },
        }),
      ]);

      const claimedIds = new Set(
        claimedRows.map((r) => r.claimedByDiscordUserId),
      );
      const nonClaimableRoleIds = new Set(
        nonClaimableRoleRows.map((r) => r.discordRoleId),
      );
      const nicknameByDiscordId = new Map(
        nicknameRows.map((r) => [r.discordUserId, r]),
      );

      return members
        .filter((m) => !m.bot)
        .filter((m) => !m.roleIds.some((id) => nonClaimableRoleIds.has(id)))
        .filter((m) => !claimedIds.has(m.id))
        .map((m) => {
          const nickname = nicknameByDiscordId.get(m.id);
          return {
            id: m.id,
            tag: m.tag,
            roleIds: m.roleIds,
            computedName: nickname?.computedName ?? null,
            preferredNickname: nickname?.preferredNickname ?? null,
          };
        });
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
      const matched = members.filter(
        (m) => !m.bot && m.roleIds.includes(input.discordRoleId),
      );

      // No main/alt distinction exists on GuildRosterMember — every claimed
      // row (main or alt) looks the same — so this is "every character
      // claimed by this person," not specifically their main.
      const claims = await ctx.db.guildRosterMember.findMany({
        where: {
          guildId: input.guildId,
          claimedByDiscordUserId: { in: matched.map((m) => m.id) },
        },
        select: { name: true, claimedByDiscordUserId: true },
      });
      const namesByUser = new Map<string, string[]>();
      for (const c of claims) {
        if (!c.claimedByDiscordUserId) continue;
        namesByUser.set(c.claimedByDiscordUserId, [
          ...(namesByUser.get(c.claimedByDiscordUserId) ?? []),
          c.name,
        ]);
      }

      return matched.map((m) => ({
        id: m.id,
        tag: m.tag,
        nick: m.nick,
        roleIds: m.roleIds,
        characterNames: namesByUser.get(m.id) ?? [],
      }));
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
            ? addRoleToMember(
                guild.discordGuildId,
                c.discordUserId,
                c.discordRoleId,
              )
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

  // Every non-bot Discord member, joined with their GuildMemberActivity row
  // (null if never tracked — e.g. someone who joined before the bot was,
  // or who's simply never sent a message here). Live roleIds decide
  // hasTargetRole/isMarkedInactive, not the DB, since Discord is the
  // source of truth for what someone actually holds right now. Backs the
  // bulk inactivity-management panel (Inactive tab).
  inactivityOverview: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id);
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      const guildRow = await ctx.db.guild.findUnique({
        where: { id: input.guildId },
        select: {
          inactivityDays: true,
          inactivityRoleId: true,
          inactivityTargetRoles: { select: { discordRoleId: true } },
        },
      });
      if (!guildRow) throw new TRPCError({ code: "NOT_FOUND" });

      const [members, activityRows] = await Promise.all([
        getGuildMembers(guild.discordGuildId),
        ctx.db.guildMemberActivity.findMany({
          where: { guildId: input.guildId },
        }),
      ]);
      const activityByUser = new Map(
        activityRows.map((a) => [a.discordUserId, a]),
      );
      const targetRoleIds = new Set(
        guildRow.inactivityTargetRoles.map((r) => r.discordRoleId),
      );

      return {
        inactivityDays: guildRow.inactivityDays,
        inactivityRoleId: guildRow.inactivityRoleId,
        members: members
          .filter((m) => !m.bot)
          .map((m) => {
            const activity = activityByUser.get(m.id);
            return {
              id: m.id,
              tag: m.tag,
              nick: m.nick,
              hasTargetRole: m.roleIds.some((r) => targetRoleIds.has(r)),
              isMarkedInactive: guildRow.inactivityRoleId
                ? m.roleIds.includes(guildRow.inactivityRoleId)
                : false,
              lastActiveAt: activity?.lastActiveAt ?? null,
              joinedAt: activity?.joinedAt ?? m.joinedAt,
            };
          }),
      };
    }),

  // Resets the activity clock to right now for every given member — the
  // bulk counterpart to "grant them a fresh grace period." Upserts rather
  // than just updating: someone who's never sent a tracked message has no
  // GuildMemberActivity row at all (see trackMessageActivity in the bot),
  // so this is also how an admin backfills that for people the automatic
  // tracker never caught. Does NOT touch the inactive role either way —
  // use bulkReactivateMembers for that.
  bulkResetActivity: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        discordUserIds: z.array(z.string()).min(1),
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

      const tagById = new Map(
        (await getGuildMembers(guild.discordGuildId)).map((m) => [m.id, m.tag]),
      );
      const now = new Date();
      await Promise.all(
        input.discordUserIds.map((discordUserId) =>
          ctx.db.guildMemberActivity.upsert({
            where: {
              guildId_discordUserId: { guildId: input.guildId, discordUserId },
            },
            create: {
              guildId: input.guildId,
              discordUserId,
              discordUserTag: tagById.get(discordUserId) ?? discordUserId,
              lastActiveAt: now,
              joinedAt: now,
            },
            update: { lastActiveAt: now },
          }),
        ),
      );
      return { ok: true };
    }),

  // Manually marks the given members inactive right now — grants the
  // inactive role directly (same additive add(), never a role-wipe, as
  // the daily filter itself — see runInactivityFilter in
  // apps/bot/src/activityTracking.ts) instead of waiting for the next
  // daily pass. Also backfills a GuildMemberActivity row for anyone who
  // didn't have one yet, same reasoning as bulkResetActivity.
  bulkMarkInactive: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        discordUserIds: z.array(z.string()).min(1),
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
      const guildRow = await ctx.db.guild.findUnique({
        where: { id: input.guildId },
        select: { inactivityRoleId: true },
      });
      if (!guildRow?.inactivityRoleId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No inactive role configured for this guild.",
        });
      }
      const inactivityRoleId = guildRow.inactivityRoleId;

      const tagById = new Map(
        (await getGuildMembers(guild.discordGuildId)).map((m) => [m.id, m.tag]),
      );
      const now = new Date();
      const results = await Promise.all(
        input.discordUserIds.map(async (discordUserId) => {
          const added = await addRoleToMember(
            guild.discordGuildId,
            discordUserId,
            inactivityRoleId,
          );
          await ctx.db.guildMemberActivity.upsert({
            where: {
              guildId_discordUserId: { guildId: input.guildId, discordUserId },
            },
            create: {
              guildId: input.guildId,
              discordUserId,
              discordUserTag: tagById.get(discordUserId) ?? discordUserId,
              lastActiveAt: now,
              joinedAt: now,
              markedInactiveAt: now,
            },
            update: { markedInactiveAt: now },
          });
          return added;
        }),
      );
      const succeeded = results.filter(Boolean).length;
      return { succeeded, failed: results.length - succeeded };
    }),

  // Bulk /reactivate — removes the inactive role and resets the activity
  // clock for every given member, same effect as each of them running
  // /reactivate themselves (see handleReactivate in
  // apps/bot/src/activityTracking.ts).
  bulkReactivateMembers: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        discordUserIds: z.array(z.string()).min(1),
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
      const guildRow = await ctx.db.guild.findUnique({
        where: { id: input.guildId },
        select: { inactivityRoleId: true },
      });
      if (!guildRow?.inactivityRoleId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No inactive role configured for this guild.",
        });
      }
      const inactivityRoleId = guildRow.inactivityRoleId;

      const now = new Date();
      const results = await Promise.all(
        input.discordUserIds.map(async (discordUserId) => {
          const removed = await removeRoleFromMember(
            guild.discordGuildId,
            discordUserId,
            inactivityRoleId,
          );
          await ctx.db.guildMemberActivity.updateMany({
            where: { guildId: input.guildId, discordUserId },
            data: { lastActiveAt: now, markedInactiveAt: null },
          });
          return removed;
        }),
      );
      const succeeded = results.filter(Boolean).length;
      return { succeeded, failed: results.length - succeeded };
    }),

  // GuildMemberNickname rows for the admin nickname-override panel —
  // computedName (what matchRosterAndApply would set with no override) next
  // to any admin/self-set preferredNickname override, PLUS what's actually
  // live on Discord right now (currentDiscordNick) and the inactivity
  // tracker's lastActiveAt — both read-only context, not editable here, so
  // an admin isn't guessing whether "computed" ever actually landed. See
  // apps/bot/src/roleLogic.ts for where computedName gets refreshed and the
  // override applied.
  memberNicknames: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id);
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      const [rows, discordMembers, activityRows] = await Promise.all([
        ctx.db.guildMemberNickname.findMany({
          where: { guildId: input.guildId },
          orderBy: { updatedAt: "desc" },
        }),
        getGuildMembers(guild.discordGuildId),
        ctx.db.guildMemberActivity.findMany({
          where: { guildId: input.guildId },
          select: { discordUserId: true, lastActiveAt: true },
        }),
      ]);

      const nickById = new Map(discordMembers.map((m) => [m.id, m.nick]));
      const lastActiveById = new Map(
        activityRows.map((a) => [a.discordUserId, a.lastActiveAt]),
      );

      return rows.map((row) => ({
        ...row,
        currentDiscordNick: nickById.get(row.discordUserId) ?? null,
        lastActiveAt: lastActiveById.get(row.discordUserId) ?? null,
      }));
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
        data: { pugRoleId: input.discordRoleId },
      });
      return { ok: true };
    }),

  // Roles that exclude a member from "unclaimed members" (see
  // GuildNonClaimableRole and unclaimedMembers above) — OR'd, rows fully
  // replaced on save, same convention as the inactivity filter's
  // targetRoleIds.
  setNonClaimableRoles: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        roleIds: z.array(z.string().min(1)),
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
        ctx.db.guildNonClaimableRole.deleteMany({
          where: { guildId: input.guildId },
        }),
        ctx.db.guildNonClaimableRole.createMany({
          data: input.roleIds.map((discordRoleId) => ({
            guildId: input.guildId,
            discordRoleId,
          })),
        }),
      ]);
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

  // One row per claimed roster character, joined against their live
  // Discord nickname/account name/roles — for the searchable/sortable/
  // filterable admin table (guild-discord-roles-table.tsx), distinct from
  // the plain role-list `discordRoles` above. Unclaimed roster members are
  // left out entirely — there's no Discord account to show columns for.
  discordRolesTable: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id);
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      const [members, snapshot] = await Promise.all([
        ctx.db.guildRosterMember.findMany({
          where: {
            guildId: input.guildId,
            claimedByDiscordUserId: { not: null },
          },
          select: {
            id: true,
            name: true,
            rank: true,
            claimedByDiscordUserId: true,
          },
          orderBy: { name: "asc" },
        }),
        getGuildRolesSnapshot(guild.discordGuildId),
      ]);

      return members.map((m) => {
        const entry = m.claimedByDiscordUserId
          ? snapshot[m.claimedByDiscordUserId]
          : undefined;
        return {
          id: m.id,
          characterName: m.name,
          rank: m.rank,
          discordTag: entry?.tag ?? null,
          discordNick: entry?.nick ?? null,
          roleNames: entry?.roleNames ?? [],
        };
      });
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

  // Kill switch — see Guild.botEnabled in schema.prisma. Only pauses the
  // bot's own automated background jobs; live slash commands still work,
  // this isn't a full outage toggle.
  setBotEnabled: protectedProcedure
    .input(z.object({ guildId: z.string(), enabled: z.boolean() }))
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
        data: { botEnabled: input.enabled },
      });
      return { ok: true };
    }),

  // Which game expansion this guild's raid comp tool targets — also flows
  // to the bot's onboarding class list (see EXPANSIONS in
  // @guildthing/wowhead-data). A guild's own setting, same "small
  // dedicated mutation" convention as setBotEnabled above, not folded into
  // the general `update` form.
  setExpansion: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        expansion: z.enum(EXPANSION_ORDER as [string, ...string[]]),
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
        data: { expansion: input.expansion },
      });
      return { ok: true };
    }),

  // Roles the bot must never add or remove for anyone, full stop — see
  // GuildProtectedRole in schema.prisma. Full replace, same convention as
  // setInactivitySettings' targetRoleIds.
  setProtectedRoles: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        roleIds: z.array(z.string().min(1)),
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
        ctx.db.guildProtectedRole.deleteMany({
          where: { guildId: input.guildId },
        }),
        ctx.db.guildProtectedRole.createMany({
          data: input.roleIds.map((discordRoleId) => ({
            guildId: input.guildId,
            discordRoleId,
          })),
        }),
      ]);
      return { ok: true };
    }),

  // pugRoleId + adminNotifyChannelId + onboardingChannelId/MessageText +
  // inactivity-filter settings + non-claimable roles + every role rule
  // (with conditions) for the guild, one call for the Discord-roles admin
  // page — same "small dedicated query" shape as exportStatus/
  // rosterImportStatus above.
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

      const [guild, rules, rolePriorities, suggestedRealm] = await Promise.all([
        ctx.db.guild.findUnique({
          where: { id: input.guildId },
          select: {
            rosterSource: true,
            pugRoleId: true,
            adminNotifyChannelId: true,
            onboardingChannelId: true,
            onboardingMessageText: true,
            inactivityFilterEnabled: true,
            inactivityDays: true,
            inactivityRoleId: true,
            inactivityTargetRoles: { select: { discordRoleId: true } },
            protectedRoles: { select: { discordRoleId: true } },
            nonClaimableRoles: { select: { discordRoleId: true } },
            wowRegion: true,
            wowRealmSlug: true,
            wowGuildName: true,
            wowNamespaceFlavor: true,
          },
        }),
        ctx.db.guildRoleRule.findMany({
          where: { guildId: input.guildId },
          include: {
            conditions: {
              include: {
                onboardingStep: { select: { prompt: true } },
                answerOptions: { include: { option: { select: { label: true } } } },
              },
            },
            grantedRoles: true,
            grantedChannels: true,
          },
          orderBy: { id: "asc" },
        }),
        ctx.db.guildRolePriority.findMany({
          where: { guildId: input.guildId },
          orderBy: { priority: "asc" },
        }),
        // Only ever used as a placeholder suggestion for the armory-lookup
        // realm field below — an /ourrecipes profession import already
        // carries a real realm value, so there's no reason to leave that
        // field blank once at least one character's been imported.
        ctx.db.guildCharacter.findFirst({
          where: { guildId: input.guildId },
          orderBy: { importedAt: "desc" },
          select: { realm: true },
        }),
      ]);
      if (!guild) throw new TRPCError({ code: "NOT_FOUND" });

      return {
        suggestedRealm: suggestedRealm?.realm ?? null,
        rosterSource: guild.rosterSource,
        pugRoleId: guild.pugRoleId,
        adminNotifyChannelId: guild.adminNotifyChannelId,
        onboardingChannelId: guild.onboardingChannelId,
        onboardingMessageText: guild.onboardingMessageText,
        inactivityFilterEnabled: guild.inactivityFilterEnabled,
        inactivityDays: guild.inactivityDays,
        inactivityTargetRoleIds: guild.inactivityTargetRoles.map(
          (r) => r.discordRoleId,
        ),
        protectedRoleIds: guild.protectedRoles.map((r) => r.discordRoleId),
        nonClaimableRoleIds: guild.nonClaimableRoles.map((r) => r.discordRoleId),
        inactivityRoleId: guild.inactivityRoleId,
        wowRegion: guild.wowRegion,
        wowRealmSlug: guild.wowRealmSlug,
        wowGuildName: guild.wowGuildName,
        wowNamespaceFlavor: guild.wowNamespaceFlavor,
        rules: rules.map((r) => ({
          ...r,
          conditions: r.conditions.map((c) => ({
            id: c.id,
            ruleId: c.ruleId,
            field: c.field,
            operator: c.operator,
            textValue: c.textValue,
            minNumber: c.minNumber,
            maxNumber: c.maxNumber,
            onboardingStepId: c.onboardingStepId,
            onboardingStepPrompt: c.onboardingStep?.prompt ?? null,
            optionIds: c.answerOptions.map((ao) => ao.optionId),
            optionLabels: c.answerOptions.map((ao) => ao.option.label),
          })),
        })),
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

      const answerConditions = input.conditions.filter(
        (c) => c.field === "answer",
      );
      if (answerConditions.length > 0) {
        const stepIds = [
          ...new Set(answerConditions.map((c) => c.onboardingStepId!)),
        ];
        const steps = await ctx.db.guildOnboardingStep.findMany({
          where: { id: { in: stepIds }, guildId: input.guildId },
          select: { id: true, options: { select: { id: true } } },
        });
        const stepById = new Map(steps.map((s) => [s.id, s]));
        for (const c of answerConditions) {
          const step = stepById.get(c.onboardingStepId!);
          if (!step) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Invalid onboarding question for an answer condition.",
            });
          }
          const validOptionIds = new Set(step.options.map((o) => o.id));
          if (!c.optionIds!.every((id) => validOptionIds.has(id))) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Invalid answer option for an answer condition.",
            });
          }
        }
      }

      const conditionsData = input.conditions.map((c) => ({
        field: c.field,
        operator: c.operator,
        textValue: c.textValue ?? null,
        minNumber: c.minNumber ?? null,
        maxNumber: c.maxNumber ?? null,
        onboardingStepId: c.onboardingStepId ?? null,
        answerOptions: c.optionIds
          ? { create: c.optionIds.map((optionId) => ({ optionId })) }
          : undefined,
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

  // Admin-only: the full step graph for the flowchart canvas builder — see
  // GuildOnboardingStep*/GuildOnboardingStepEdge* in schema.prisma. Runs
  // the one-time legacy migration first (see onboardingMigration.ts) so a
  // guild that's never opened this page yet still gets a populated graph,
  // then the pug->grant actionType backfill for guilds that migrated
  // before that rename shipped.
  onboardingFlow: protectedProcedure
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

      await ensureOnboardingFlowMigrated(ctx.db, input.guildId);
      await ensurePugActionStepsMigrated(ctx.db, input.guildId);

      const [steps, edges] = await Promise.all([
        ctx.db.guildOnboardingStep.findMany({
          where: { guildId: input.guildId },
          include: {
            options: { orderBy: { sortOrder: "asc" } },
            grants: true,
          },
          orderBy: { createdAt: "asc" },
        }),
        ctx.db.guildOnboardingStepEdge.findMany({
          where: { guildId: input.guildId },
          include: {
            conditionOptions: true,
            conditionValues: true,
            conditionClasses: true,
          },
        }),
      ]);

      return {
        steps: steps.map((s) => ({
          id: s.id,
          type: s.type,
          label: s.label,
          prompt: s.prompt,
          questionType: s.questionType,
          varName: s.varName,
          varType: s.varType,
          required: s.required,
          appendList: s.appendList,
          actionType: s.actionType,
          namesVariable: s.namesVariable,
          classesVariable: s.classesVariable,
          nicknameTemplate: s.nicknameTemplate,
          textTemplate: s.textTemplate,
          listVariable: s.listVariable,
          options: s.options.map((o) => ({
            id: o.id,
            label: o.label,
            sortOrder: o.sortOrder,
          })),
          grants: s.grants.map((g) => ({
            id: g.id,
            discordRoleId: g.discordRoleId,
            discordChannelId: g.discordChannelId,
            channelType: g.channelType,
          })),
        })),
        edges: edges.map((e) => ({
          id: e.id,
          fromStepId: e.fromStepId,
          toStepId: e.toStepId,
          conditionType: e.conditionType,
          conditionMinLevel: e.conditionMinLevel,
          conditionMaxLevel: e.conditionMaxLevel,
          conditionOptionIds: e.conditionOptions.map((c) => c.optionId),
          conditionValues: e.conditionValues.map((c) => c.value),
          conditionClasses: e.conditionClasses.map((c) => c.class),
        })),
        onboardingQuestions: steps
          .filter((s) => s.type === "question")
          .map((s) => ({
            id: s.id,
            prompt: s.prompt ?? "",
            options: s.options.map((o) => ({ id: o.id, label: o.label })),
          })),
      };
    }),

  // Full replace of the guild's onboarding flow graph — BUT unlike
  // upsertRoleRule this can't be a blind delete-and-recreate of steps/
  // options, since GuildOnboardingStepAnswer rows FK onto them: wiping and
  // recreating on every canvas edit would orphan (and cascade-delete)
  // every answer already collected. Instead the client sends a stable id
  // per step/option/grant (a fresh crypto.randomUUID() for new ones, the
  // real id for existing ones) and this does an id-diff upsert+prune for
  // steps/options/grants, keeping already-collected answers intact — edges
  // carry no historical data, so those alone are still blind-replaced.
  saveOnboardingFlow: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        steps: z.array(
          z.object({
            id: z.string().min(1),
            type: z.enum(["question", "condition", "action", "loop"]),
            label: z.string().max(100).optional(),
            // --- question ---
            prompt: z.string().min(1).max(300).optional(),
            questionType: z
              .enum(["single_select", "multi_select", "free_text"])
              .optional(),
            varName: z
              .string()
              .regex(
                /^[a-z][a-z0-9_]*$/,
                "lowercase letters, numbers, and underscores only",
              )
              .optional(),
            varType: z
              .enum(["text", "choice", "class", "number", "character"])
              .optional(),
            required: z.boolean().default(true),
            appendList: z.boolean().default(false),
            options: z
              .array(
                z.object({
                  id: z.string().min(1),
                  label: z.string().min(1).max(100),
                  sortOrder: z.number().int(),
                }),
              )
              // 24, not Discord's actual 25-option StringSelectMenu cap —
              // an optional single_select question appends one more "Skip"
              // button (see onboardingQuestions.ts), and Discord also caps
              // messages at 5 button rows of 5, so this leaves room for it
              // without needing a separate cap per question type.
              .max(24)
              .default([]),
            // --- action ---
            actionType: z
              .enum(["claim_characters", "set_nickname", "grant", "dm"])
              .optional(),
            namesVariable: z.string().min(1).optional(),
            classesVariable: z.string().min(1).optional(),
            nicknameTemplate: z.string().max(200).optional(),
            textTemplate: z.string().max(2000).optional(),
            grants: z
              .array(
                z.object({
                  id: z.string().min(1),
                  discordRoleId: z.string().min(1).nullable(),
                  discordChannelId: z.string().min(1).nullable(),
                  channelType: z.enum(["text", "voice"]).nullable(),
                }),
              )
              .default([]),
            // --- loop ---
            listVariable: z.string().min(1).optional(),
          }),
        ),
        edges: z.array(
          z.object({
            fromStepId: z.string().min(1).nullable(),
            toStepId: z.string().min(1),
            conditionType: z.enum([
              "always",
              "answer_equals",
              "var_equals",
              "class_equals",
              "level_between",
            ]),
            conditionOptionIds: z.array(z.string().min(1)).default([]),
            conditionValues: z.array(z.string().min(1)).default([]),
            conditionClasses: z.array(z.string().min(1)).default([]),
            conditionMinLevel: z.number().int().optional(),
            conditionMaxLevel: z.number().int().optional(),
          }),
        ),
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

      const stepsById = new Map(input.steps.map((s) => [s.id, s]));
      const optionIds = new Set<string>();
      const grantIds = new Set<string>();
      const seenVarNames = new Set<string>();

      for (const s of input.steps) {
        if (s.type === "question") {
          if (!s.prompt || !s.questionType || !s.varName || !s.varType) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "A question step needs a prompt, question type, variable name, and variable type.",
            });
          }
          if (s.questionType === "free_text") {
            if (s.options.length > 0) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: `"${s.prompt}" is free text and can't have options.`,
              });
            }
          } else if (s.options.length < 2) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `"${s.prompt}" needs at least 2 options.`,
            });
          }
        } else if (s.type === "action") {
          if (!s.actionType) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "An action step needs an action type.",
            });
          }
          if (s.actionType === "claim_characters" && !s.namesVariable) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `A "${s.actionType}" action needs a names variable.`,
            });
          }
          if (s.actionType === "set_nickname" && !s.nicknameTemplate) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: 'A "set nickname" action needs a nickname template.',
            });
          }
          if (s.actionType === "dm" && !s.textTemplate) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: 'A "DM" action needs a message template.',
            });
          }
          if (s.actionType === "grant") {
            if (s.grants.length === 0) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message:
                  'A "grant" action needs at least one role or channel to grant.',
              });
            }
            for (const g of s.grants) {
              const hasRole = g.discordRoleId != null;
              const hasChannel = g.discordChannelId != null;
              if (hasRole === hasChannel) {
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message:
                    "Each grant needs exactly one of a role or a channel.",
                });
              }
              if (hasChannel && !g.channelType) {
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message: "A channel grant needs a channel type.",
                });
              }
            }
          }
        } else if (s.type === "loop") {
          if (!s.listVariable) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "A loop step needs a list variable.",
            });
          }
        }

        if (s.varName) {
          if (seenVarNames.has(s.varName)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Variable name "${s.varName}" is used by more than one step.`,
            });
          }
          seenVarNames.add(s.varName);
        }
        for (const o of s.options) optionIds.add(o.id);
        for (const g of s.grants) grantIds.add(g.id);
      }

      for (const e of input.edges) {
        if (!stepsById.has(e.toStepId)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "An edge points at an unknown step.",
          });
        }
        const fromStep = e.fromStepId ? stepsById.get(e.fromStepId) : null;
        if (e.fromStepId != null && !fromStep) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "An edge starts at an unknown step.",
          });
        }
        if (e.conditionType === "always") {
          if (
            e.conditionOptionIds.length > 0 ||
            e.conditionValues.length > 0 ||
            e.conditionClasses.length > 0 ||
            e.conditionMinLevel != null ||
            e.conditionMaxLevel != null
          ) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "An unconditional edge can't also carry a condition value.",
            });
          }
        } else if (e.conditionType === "answer_equals") {
          if (
            fromStep?.type !== "question" ||
            e.conditionOptionIds.length === 0 ||
            !e.conditionOptionIds.every((id) =>
              fromStep.options.some((o) => o.id === id),
            )
          ) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                '"Previous answer includes" needs a source question and at least one of its own options.',
            });
          }
        } else if (e.conditionType === "var_equals") {
          if (fromStep == null || e.conditionValues.length === 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                '"Variable equals" needs a source step and at least one value.',
            });
          }
        } else if (e.conditionType === "class_equals") {
          if (
            e.conditionClasses.length === 0 ||
            !e.conditionClasses.every((c) => WOW_CLASS_TOKENS.includes(c))
          ) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: '"Class is" needs at least one valid WoW class.',
            });
          }
        } else {
          // level_between
          if (
            e.conditionMinLevel == null ||
            e.conditionMaxLevel == null ||
            e.conditionMinLevel > e.conditionMaxLevel
          ) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: '"Level is between" needs a valid min/max range.',
            });
          }
        }
      }

      // Per-node outgoing-edge shape: condition nodes need >=1 unconditional
      // + >=1 conditional outgoing edge (so there's always a branch to take
      // and something worth branching on); loop nodes need exactly one
      // unconditional edge, which is the body's entry point.
      const outgoingEdges = new Map<string, (typeof input.edges)[number][]>();
      for (const e of input.edges) {
        if (e.fromStepId == null) continue;
        const list = outgoingEdges.get(e.fromStepId) ?? [];
        list.push(e);
        outgoingEdges.set(e.fromStepId, list);
      }
      for (const s of input.steps) {
        if (s.type === "condition") {
          const edgesOut = outgoingEdges.get(s.id) ?? [];
          const hasAlways = edgesOut.some((e) => e.conditionType === "always");
          const hasConditional = edgesOut.some(
            (e) => e.conditionType !== "always",
          );
          if (edgesOut.length < 2 || !hasAlways || !hasConditional) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Condition step "${s.label ?? s.id}" needs at least one unconditional edge and at least one conditional edge.`,
            });
          }
        } else if (s.type === "loop") {
          const edgesOut = outgoingEdges.get(s.id) ?? [];
          if (edgesOut.length !== 1 || edgesOut[0]?.conditionType !== "always") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Loop step "${s.label ?? s.id}" needs exactly one unconditional outgoing edge (the loop body's start).`,
            });
          }
        }
      }

      // Cycle check over the graph as it will exist after this save (Start
      // = null). A drawn back-edge loop is legal — that IS the loop model —
      // but every DFS back-edge must be conditional (or re-enter a legacy
      // loop node): an unconditional back-edge would spin the bot's walk
      // until the engine's 50-iteration cap, so the save is rejected
      // instead. The editor routes the admin through a condition picker on
      // every ↺ arrow; this is the same rule enforced where it matters.
      const outgoingEdgesForCycle = new Map<string, (typeof input.edges)[number][]>();
      for (const e of input.edges) {
        if (e.fromStepId == null) continue;
        const list = outgoingEdgesForCycle.get(e.fromStepId) ?? [];
        list.push(e);
        outgoingEdgesForCycle.set(e.fromStepId, list);
      }
      const visiting = new Set<string>();
      const finished = new Set<string>();
      function hasIllegalCycle(id: string): boolean {
        if (finished.has(id)) return false;
        visiting.add(id);
        for (const edge of outgoingEdgesForCycle.get(id) ?? []) {
          const next = edge.toStepId;
          if (visiting.has(next)) {
            const reEnteringLegacyLoop = stepsById.get(next)?.type === "loop";
            if (!reEnteringLegacyLoop && edge.conditionType === "always") return true;
            continue;
          }
          if (hasIllegalCycle(next)) return true;
        }
        visiting.delete(id);
        finished.add(id);
        return false;
      }
      for (const id of stepsById.keys()) {
        if (hasIllegalCycle(id)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "This flow loops back unconditionally — a drawn back-edge (a step leading back to an earlier one) needs a condition, or the walk would never stop.",
          });
        }
      }

      // Template validation: {var} references (question prompts, nickname/
      // DM templates) and bare variable refs (claim/pug names/classes
      // variables) may only name a variable collected by an ancestor step —
      // one reachable by walking backwards from this step along the edges
      // above — never a variable collected later in the flow, or one that's
      // never collected on any path leading here.
      const incoming = new Map<string, (string | null)[]>();
      for (const e of input.edges) {
        const list = incoming.get(e.toStepId) ?? [];
        list.push(e.fromStepId);
        incoming.set(e.toStepId, list);
      }
      function collectAvailableVars(stepId: string): Set<string> {
        const seen = new Set<string>();
        const available = new Set<string>();
        const stack: (string | null)[] = [...(incoming.get(stepId) ?? [])];
        while (stack.length > 0) {
          const ancestorId = stack.pop();
          if (ancestorId == null || seen.has(ancestorId)) continue;
          seen.add(ancestorId);
          const ancestor = stepsById.get(ancestorId);
          if (ancestor?.varName) available.add(ancestor.varName);
          if (ancestor?.listVariable) available.add(ancestor.listVariable);
          for (const next of incoming.get(ancestorId) ?? []) stack.push(next);
        }
        return available;
      }
      function checkTemplateVars(stepId: string, template: string, label: string) {
        const available = collectAvailableVars(stepId);
        for (const match of template.matchAll(/\{([a-z][a-z0-9_]*)\}/g)) {
          const varName = match[1]!;
          if (!available.has(varName)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `${label} references "{${varName}}", which isn't collected before this step.`,
            });
          }
        }
      }
      function checkVarRef(stepId: string, varName: string, label: string) {
        if (!collectAvailableVars(stepId).has(varName)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `${label} references "${varName}", which isn't collected before this step.`,
          });
        }
      }
      for (const s of input.steps) {
        if (s.type === "question" && s.prompt) {
          checkTemplateVars(s.id, s.prompt, `Question "${s.prompt}"`);
        }
        if (s.type === "action") {
          if (s.actionType === "claim_characters") {
            if (s.namesVariable) checkVarRef(s.id, s.namesVariable, "Names variable");
            if (s.classesVariable) {
              checkVarRef(s.id, s.classesVariable, "Classes variable");
            }
          }
          if (s.actionType === "set_nickname" && s.nicknameTemplate) {
            checkTemplateVars(s.id, s.nicknameTemplate, "Nickname template");
          }
          if (s.actionType === "dm" && s.textTemplate) {
            checkTemplateVars(s.id, s.textTemplate, "DM template");
          }
        }
      }

      // Client-supplied ids mean a crafted payload could otherwise upsert
      // straight over a DIFFERENT guild's step/option/grant row — reject
      // any id that already exists under another guild before writing
      // anything.
      const submittedStepIds = [...stepsById.keys()];
      if (submittedStepIds.length > 0) {
        const foreignSteps = await ctx.db.guildOnboardingStep.findMany({
          where: {
            id: { in: submittedStepIds },
            guildId: { not: input.guildId },
          },
          select: { id: true },
        });
        if (foreignSteps.length > 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid step id." });
        }
      }
      const submittedOptionIds = [...optionIds];
      if (submittedOptionIds.length > 0) {
        const foreignOptions = await ctx.db.guildOnboardingStepOption.findMany({
          where: {
            id: { in: submittedOptionIds },
            step: { guildId: { not: input.guildId } },
          },
          select: { id: true },
        });
        if (foreignOptions.length > 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid option id." });
        }
      }
      const submittedGrantIds = [...grantIds];
      if (submittedGrantIds.length > 0) {
        const foreignGrants = await ctx.db.guildOnboardingActionGrant.findMany({
          where: {
            id: { in: submittedGrantIds },
            step: { guildId: { not: input.guildId } },
          },
          select: { id: true },
        });
        if (foreignGrants.length > 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid grant id." });
        }
      }

      await ctx.db.$transaction(async (tx) => {
        await tx.guildOnboardingStepEdge.deleteMany({
          where: { guildId: input.guildId },
        });
        await tx.guildOnboardingStep.deleteMany({
          where: { guildId: input.guildId, id: { notIn: submittedStepIds } },
        });

        for (const s of input.steps) {
          await tx.guildOnboardingStep.upsert({
            where: { id: s.id },
            create: {
              id: s.id,
              guildId: input.guildId,
              type: s.type,
              label: s.label ?? null,
              prompt: s.prompt ?? null,
              questionType: s.questionType ?? null,
              varName: s.varName ?? null,
              varType: s.varType ?? null,
              required: s.required,
              appendList: s.appendList,
              actionType: s.actionType ?? null,
              namesVariable: s.namesVariable ?? null,
              classesVariable: s.classesVariable ?? null,
              nicknameTemplate: s.nicknameTemplate ?? null,
              textTemplate: s.textTemplate ?? null,
              listVariable: s.listVariable ?? null,
            },
            update: {
              type: s.type,
              label: s.label ?? null,
              prompt: s.prompt ?? null,
              questionType: s.questionType ?? null,
              varName: s.varName ?? null,
              varType: s.varType ?? null,
              required: s.required,
              appendList: s.appendList,
              actionType: s.actionType ?? null,
              namesVariable: s.namesVariable ?? null,
              classesVariable: s.classesVariable ?? null,
              nicknameTemplate: s.nicknameTemplate ?? null,
              textTemplate: s.textTemplate ?? null,
              listVariable: s.listVariable ?? null,
            },
          });

          const keepOptionIds = s.options.map((o) => o.id);
          await tx.guildOnboardingStepOption.deleteMany({
            where: { stepId: s.id, id: { notIn: keepOptionIds } },
          });
          for (const o of s.options) {
            await tx.guildOnboardingStepOption.upsert({
              where: { id: o.id },
              create: {
                id: o.id,
                stepId: s.id,
                label: o.label,
                sortOrder: o.sortOrder,
              },
              update: { label: o.label, sortOrder: o.sortOrder },
            });
          }

          const keepGrantIds = s.grants.map((g) => g.id);
          await tx.guildOnboardingActionGrant.deleteMany({
            where: { stepId: s.id, id: { notIn: keepGrantIds } },
          });
          for (const g of s.grants) {
            await tx.guildOnboardingActionGrant.upsert({
              where: { id: g.id },
              create: {
                id: g.id,
                stepId: s.id,
                discordRoleId: g.discordRoleId,
                discordChannelId: g.discordChannelId,
                channelType: g.channelType,
              },
              update: {
                discordRoleId: g.discordRoleId,
                discordChannelId: g.discordChannelId,
                channelType: g.channelType,
              },
            });
          }
        }

        if (input.edges.length > 0) {
          // Generated up front (rather than relying on createMany's
          // auto-generated ids, which it doesn't return) so the OR-set
          // child rows below can reference the right edge.
          const edgesWithIds = input.edges.map((e) => ({
            ...e,
            id: randomUUID(),
          }));
          await tx.guildOnboardingStepEdge.createMany({
            data: edgesWithIds.map((e) => ({
              id: e.id,
              guildId: input.guildId,
              fromStepId: e.fromStepId,
              toStepId: e.toStepId,
              conditionType: e.conditionType,
              conditionMinLevel: e.conditionMinLevel ?? null,
              conditionMaxLevel: e.conditionMaxLevel ?? null,
            })),
          });
          const conditionOptionRows = edgesWithIds.flatMap((e) =>
            e.conditionOptionIds.map((optionId) => ({
              edgeId: e.id,
              optionId,
            })),
          );
          if (conditionOptionRows.length > 0) {
            await tx.guildOnboardingStepEdgeConditionOption.createMany({
              data: conditionOptionRows,
            });
          }
          const conditionValueRows = edgesWithIds.flatMap((e) =>
            e.conditionValues.map((value) => ({
              edgeId: e.id,
              value: value.toLowerCase(),
            })),
          );
          if (conditionValueRows.length > 0) {
            await tx.guildOnboardingEdgeConditionValue.createMany({
              data: conditionValueRows,
            });
          }
          const conditionClassRows = edgesWithIds.flatMap((e) =>
            e.conditionClasses.map((cls) => ({ edgeId: e.id, class: cls })),
          );
          if (conditionClassRows.length > 0) {
            await tx.guildOnboardingStepEdgeConditionClass.createMany({
              data: conditionClassRows,
            });
          }
        }
      });

      return { ok: true };
    }),
});
