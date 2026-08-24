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
        recurrenceIntervalDays: e.recurrenceIntervalDays,
        createdByDiscordTag: e.createdByDiscordTag,
        discordChannelId: e.discordChannelId,
        createdAt: e.createdAt,
        totalCapacity: e.roleSlots.reduce((sum, s) => sum + s.capacity, 0),
        totalSignups: e.roleSlots.reduce((sum, s) => sum + s.signups.length, 0),
        timeOptionCount: e.timeOptions.length,
      }));
    }),

  // Full detail for one event, including its role slots and time option
  // labels — deliberately not part of `list` above (which only returns
  // aggregate counts for a lean list view), fetched lazily when an admin
  // opens the edit form for a specific event.
  get: protectedProcedure
    .input(z.object({ guildId: z.string(), id: z.string() }))
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

      const event = await ctx.db.event.findFirst({
        where: { id: input.id, guildId: input.guildId },
        include: { roleSlots: true, timeOptions: true },
      });
      if (!event) throw new TRPCError({ code: "NOT_FOUND" });

      return {
        id: event.id,
        title: event.title,
        imageUrl: event.imageUrl,
        date: event.date,
        description: event.description,
        allowTimeSuggestions: event.allowTimeSuggestions,
        recurrenceIntervalDays: event.recurrenceIntervalDays,
        discordChannelId: event.discordChannelId,
        roleSlots: event.roleSlots.map((r) => ({
          roleName: r.roleName,
          capacity: r.capacity,
          emoji: r.emoji,
        })),
        timeOptionLabels: event.timeOptions.map((t) => t.label),
      };
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
        allowTimeSuggestions: z.boolean().default(true),
        // Repeat every N days, indefinitely — see recurrenceIntervalDays in
        // schema.prisma. Manually cancelling an occurrence stops the series.
        recurrenceIntervalDays: z.number().int().min(1).max(365).optional(),
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
          allowTimeSuggestions: input.allowTimeSuggestions,
          recurrenceIntervalDays: input.recurrenceIntervalDays ?? null,
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

  // Replaces every editable field, including role slots and time options —
  // an admin fixing a typo'd title and an admin reworking the whole role
  // composition go through the same call. roleSlots/timeOptions are always
  // fully replaced rather than diffed against the existing rows: simpler,
  // and matches how the create form already collects them (a flat list with
  // no stable per-row identity to diff against). That does mean any
  // signups/votes tied to the slots or options being replaced are cascade-
  // deleted (see EventSignup/EventTimeVote's onDelete: Cascade) — acceptable
  // here since changing "what roles are needed" or "what times are on
  // offer" is exactly the kind of edit that should invalidate signups made
  // against the old set. Only allowed while still "open" (same as cancel)
  // so this never fights runEventAutoLock or edits out from under an
  // already-locked lockedTimeOptionId.
  update: protectedProcedure
    .input(
      z.object({
        guildId: z.string(),
        id: z.string(),
        title: z.string().min(1).max(100),
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
        allowTimeSuggestions: z.boolean().default(true),
        recurrenceIntervalDays: z.number().int().min(1).max(365).optional(),
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

      const existing = await ctx.db.event.findFirst({
        where: { id: input.id, guildId: input.guildId },
        select: { status: true },
      });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      if (existing.status !== "open") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only an open event can be edited.",
        });
      }

      await ctx.db.event.update({
        where: { id: input.id },
        data: {
          title: input.title,
          imageUrl: input.imageUrl ?? null,
          date: input.date ?? null,
          description: input.description ?? null,
          allowTimeSuggestions: input.allowTimeSuggestions,
          recurrenceIntervalDays: input.recurrenceIntervalDays ?? null,
          discordChannelId: input.discordChannelId,
          pendingWebUpdate: true,
          roleSlots: { deleteMany: {}, create: input.roleSlots },
          timeOptions: {
            deleteMany: {},
            create: input.timeOptionLabels.map((label) => ({ label })),
          },
        },
      });

      return { ok: true };
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
        buttonMessageText: z.string().nullable().optional(),
        buttonRepostMode: z.enum(["live", "daily"]),
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

      // undefined ("not passed", e.g. the checkbox-only toggle in the UI)
      // leaves an existing custom text untouched on update; null/empty
      // explicitly clears it back to the bot's default.
      const trimmedButtonMessageText = input.buttonMessageText?.trim();
      const buttonMessageText =
        input.buttonMessageText === undefined
          ? undefined
          : trimmedButtonMessageText === ""
            ? null
            : (trimmedButtonMessageText ?? null);

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
          buttonMessageText: buttonMessageText ?? null,
          buttonRepostMode: input.buttonRepostMode,
        },
        update: {
          roles: input.roles ?? null,
          buttonEnabled: input.buttonEnabled,
          buttonMessageText,
          buttonRepostMode: input.buttonRepostMode,
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
