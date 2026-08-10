import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  checkGuildAdmin,
  checkGuildRole,
  forbiddenOrRateLimited,
} from "~/server/api/routers/guild";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import type { db as Db } from "~/server/db";

const roleSlotSchema = z.object({
  roleName: z.string().min(1),
  capacity: z.number().int().min(1),
  // Unicode emoji or a pasted <:name:id>/<a:name:id> custom emoji — see
  // EventRoleSlot.emoji in schema.prisma.
  emoji: z.string().max(100).optional(),
});

// The event's createdByDiscordUserId needs a real Discord snowflake (the
// bot compares it against interaction.user.id for the "only the leader can
// cancel" check) — Better Auth's Account.accountId is that ID for the
// "discord" provider, distinct from ctx.session.user.id (our own DB id).
async function requireDiscordUserId(
  db: typeof Db,
  userId: string,
): Promise<string> {
  const account = await db.account.findFirst({
    where: { userId, providerId: "discord" },
    select: { accountId: true },
  });
  if (!account) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "No linked Discord account found.",
    });
  }
  return account.accountId;
}

// Signing up, voting, leaving, and cancelling all happen through the
// Discord message's own components (see apps/bot/src/events.ts) — this
// router only creates, lists, and cancels, same "site is a management
// view, the bot owns the live interaction" split as everything else here.
export const eventRouter = createTRPCRouter({
  list: protectedProcedure
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

      const events = await ctx.db.event.findMany({
        where: { guildId: input.guildId },
        include: {
          roleSlots: { include: { signups: true } },
          timeOptions: { include: { votes: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      return events.map((e) => ({
        id: e.id,
        title: e.title,
        imageUrl: e.imageUrl,
        date: e.date,
        status: e.status,
        createdByDiscordTag: e.createdByDiscordTag,
        discordChannelId: e.discordChannelId,
        createdAt: e.createdAt,
        totalCapacity: e.roleSlots.reduce((sum, s) => sum + s.capacity, 0),
        totalSignups: e.roleSlots.reduce((sum, s) => sum + s.signups.length, 0),
        timeOptionCount: e.timeOptions.length,
      }));
    }),

  create: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        title: z.string().min(1).max(100),
        // http(s) only — Discord's embed thumbnail rejects data: URIs (and
        // anything else), so reject those here instead of letting the bot
        // fail silently trying to post the event later.
        imageUrl: z
          .string()
          .url()
          .refine((url) => /^https?:\/\//.test(url), {
            message:
              "Image URL must be a normal http(s) link, not a pasted image.",
          })
          .optional(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        description: z.string().max(1000).optional(),
        discordChannelId: z.string().min(1),
        roleSlots: z.array(roleSlotSchema).min(1),
        timeOptionLabels: z.array(z.string().min(1)).default([]),
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
          ? forbiddenOrRateLimited(null)
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      const discordUserId = await requireDiscordUserId(
        ctx.db,
        ctx.session.user.id,
      );

      const event = await ctx.db.event.create({
        data: {
          guildId: input.guildId,
          title: input.title,
          imageUrl: input.imageUrl ?? null,
          date: input.date ?? null,
          description: input.description ?? null,
          createdByDiscordUserId: discordUserId,
          createdByDiscordTag: ctx.session.user.name,
          discordChannelId: input.discordChannelId,
          pendingWebUpdate: true,
          roleSlots: { create: input.roleSlots },
          timeOptions: {
            create: input.timeOptionLabels.map((label) => ({ label })),
          },
        },
      });

      return { id: event.id };
    }),

  cancel: protectedProcedure
    .input(z.object({ guildId: z.string(), id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { isAdmin, needsReauth, retryAfterSeconds } = await checkGuildAdmin(
        ctx.db,
        input.guildId,
        ctx.session.user.id,
      );
      if (!isAdmin) {
        throw needsReauth
          ? forbiddenOrRateLimited(null)
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      await ctx.db.event.updateMany({
        where: { id: input.id, guildId: input.guildId },
        data: { status: "cancelled", pendingWebUpdate: true },
      });
      return { ok: true };
    }),

  // Per-channel default role composition — pre-fills the Roles field when
  // /guildthing event is run in that channel (see EventChannelPreset in
  // schema.prisma), so a dungeon-specific channel doesn't need the same
  // "Tank:1, Healer:1, DPS:3" retyped every time.
  channelPresets: protectedProcedure
    .input(z.object({ guildId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { isAdmin, needsReauth, retryAfterSeconds } = await checkGuildAdmin(
        ctx.db,
        input.guildId,
        ctx.session.user.id,
      );
      if (!isAdmin) {
        throw needsReauth
          ? forbiddenOrRateLimited(null)
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      return ctx.db.eventChannelPreset.findMany({
        where: { guildId: input.guildId },
      });
    }),

  setChannelPreset: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        discordChannelId: z.string().min(1),
        roles: z.string().optional(),
        buttonEnabled: z.boolean(),
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
          ? forbiddenOrRateLimited(null)
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      await ctx.db.eventChannelPreset.upsert({
        where: {
          guildId_discordChannelId: {
            guildId: input.guildId,
            discordChannelId: input.discordChannelId,
          },
        },
        create: {
          guildId: input.guildId,
          discordChannelId: input.discordChannelId,
          roles: input.roles ?? null,
          buttonEnabled: input.buttonEnabled,
        },
        update: {
          roles: input.roles ?? null,
          buttonEnabled: input.buttonEnabled,
        },
      });
      return { ok: true };
    }),

  deleteChannelPreset: protectedProcedure
    .input(z.object({ guildId: z.string(), id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { isAdmin, needsReauth, retryAfterSeconds } = await checkGuildAdmin(
        ctx.db,
        input.guildId,
        ctx.session.user.id,
      );
      if (!isAdmin) {
        throw needsReauth
          ? forbiddenOrRateLimited(null)
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      await ctx.db.eventChannelPreset.deleteMany({
        where: { id: input.id, guildId: input.guildId },
      });
      return { ok: true };
    }),

  // Clears the bot's bookkeeping of which message is "the" create-event
  // button for this channel — its next check (within ~15s) then posts a
  // fresh one, landing at the current bottom. Same idea as
  // guild.repostOnboardingButton, for a button that's drifted up as new
  // messages came in after it.
  repostChannelButton: protectedProcedure
    .input(z.object({ guildId: z.string(), id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { isAdmin, needsReauth, retryAfterSeconds } = await checkGuildAdmin(
        ctx.db,
        input.guildId,
        ctx.session.user.id,
      );
      if (!isAdmin) {
        throw needsReauth
          ? forbiddenOrRateLimited(null)
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      await ctx.db.eventChannelPreset.updateMany({
        where: { id: input.id, guildId: input.guildId },
        data: { buttonMessageId: null },
      });
      return { ok: true };
    }),
});
