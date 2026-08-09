import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { isInstanceOwner } from "~/server/api/routers/guild";

const GUILD_CREATION_MODES = ["owner", "allowlist", "public"] as const;
type GuildCreationMode = (typeof GUILD_CREATION_MODES)[number];

// InstanceSettings.guildCreationMode is a plain Prisma String column (no
// native enum support in SQLite), so this narrows the DB value back to our
// literal union for the client — falling back to "owner" for anything
// unexpected there rather than widening the whole API surface to `string`.
function parseGuildCreationMode(value: string | undefined): GuildCreationMode {
  return (GUILD_CREATION_MODES as readonly string[]).includes(value ?? "")
    ? (value as GuildCreationMode)
    : "owner";
}

function requireOwner(email: string) {
  if (!isInstanceOwner(email)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the instance owner can change this.",
    });
  }
}

export const instanceSettingsRouter = createTRPCRouter({
  // Everything the settings page needs: current mode, the allow-list, and
  // whether the caller is even allowed to be looking at this (drives
  // whether the page/sidebar link shows at all — same "UI dressing, real
  // enforcement is server-side" pattern as guild.canCreateGuild).
  get: protectedProcedure.query(async ({ ctx }) => {
    const isOwner = isInstanceOwner(ctx.session.user.email);
    if (!isOwner) {
      return { isOwner: false as const, guildCreationMode: "owner" as const, allowedCreators: [] };
    }

    const [settings, allowed] = await Promise.all([
      ctx.db.instanceSettings.findUnique({ where: { id: "singleton" } }),
      ctx.db.allowedGuildCreator.findMany({ orderBy: { createdAt: "asc" } }),
    ]);

    return {
      isOwner: true as const,
      guildCreationMode: parseGuildCreationMode(settings?.guildCreationMode),
      allowedCreators: allowed.map((a) => ({ id: a.id, email: a.email })),
    };
  }),

  setGuildCreationMode: protectedProcedure
    .input(z.object({ mode: z.enum(GUILD_CREATION_MODES) }))
    .mutation(async ({ ctx, input }) => {
      requireOwner(ctx.session.user.email);

      await ctx.db.instanceSettings.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", guildCreationMode: input.mode },
        update: { guildCreationMode: input.mode },
      });
      return { ok: true };
    }),

  addAllowedCreator: protectedProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ ctx, input }) => {
      requireOwner(ctx.session.user.email);

      await ctx.db.allowedGuildCreator.upsert({
        where: { email: input.email.toLowerCase() },
        create: {
          email: input.email.toLowerCase(),
          addedById: ctx.session.user.id,
        },
        update: {},
      });
      return { ok: true };
    }),

  removeAllowedCreator: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      requireOwner(ctx.session.user.email);

      await ctx.db.allowedGuildCreator.deleteMany({ where: { id: input.id } });
      return { ok: true };
    }),
});
