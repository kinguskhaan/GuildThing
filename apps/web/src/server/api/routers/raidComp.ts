// Raid comp CRUD + Battle.net spec sync — officer/GM only (same
// checkGuildAdmin gate as guild settings), see PRODUCT.md's "officer/GM is
// the default audience" principle and the surface brief at
// .impeccable/surfaces/src-app-guilds-guildslug-admin-raid-comp-page-tsx.md.

import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { EXPANSIONS, getExpansion } from "@guildthing/wowhead-data";

import { lookupCharacterSpecialization } from "~/server/battlenet";
import { checkGuildAdmin, forbiddenOrRateLimited } from "~/server/api/routers/guild";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import type { db as Db } from "~/server/db";

const slotSchema = z.object({
  groupIndex: z.number().int(),
  slotIndex: z.number().int(),
  rosterMemberId: z.string().nullable(),
  characterName: z.string().nullable(),
  classToken: z.string().nullable(),
  specToken: z.string().nullable(),
});

// Shared by every mutation that acts on an existing comp — a comp has no
// guildId in its own input (the client only ever holds a compId), so the
// admin gate has to look the comp up first to know which guild to check.
async function requireCompAdmin(db: typeof Db, userId: string, compId: string) {
  const comp = await db.guildRaidComp.findUnique({ where: { id: compId } });
  if (!comp) throw new TRPCError({ code: "NOT_FOUND" });
  const { isAdmin, needsReauth, retryAfterSeconds } = await checkGuildAdmin(
    db,
    comp.guildId,
    userId,
  );
  if (!isAdmin) {
    throw needsReauth
      ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
      : forbiddenOrRateLimited(retryAfterSeconds);
  }
  return comp;
}

export const raidCompRouter = createTRPCRouter({
  list: protectedProcedure
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

      return ctx.db.guildRaidComp.findMany({
        where: { guildId: input.guildId },
        include: { slots: true },
        orderBy: { createdAt: "asc" },
      });
    }),

  create: protectedProcedure
    .input(z.object({ guildId: z.string(), name: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(ctx.db, input.guildId, ctx.session.user.id);
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      // Default group count from the guild's expansion (classic's 40-man
      // raids get 8 groups, everything since gets 5) — officers can still
      // Add/remove groups freely afterward.
      const expansion = getExpansion(guild.expansion) ?? EXPANSIONS.tbc;
      const groupCount = Math.ceil(expansion.raidSize / expansion.groupSize);

      return ctx.db.guildRaidComp.create({
        data: {
          guildId: input.guildId,
          name: input.name,
          groupCount,
          createdById: ctx.session.user.id,
        },
        include: { slots: true },
      });
    }),

  // Replaces every slot in one nested write (Prisma runs deleteMany+create
  // as a single transaction on a nested update) — the client always sends
  // its full local slot list, so a partial-failure retry can't leave stale
  // rows behind from a slot the client since removed.
  save: protectedProcedure
    .input(
      z.object({
        compId: z.string(),
        name: z.string().min(1),
        groupCount: z.number().int().min(1).max(10),
        slots: z.array(slotSchema),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireCompAdmin(ctx.db, ctx.session.user.id, input.compId);

      return ctx.db.guildRaidComp.update({
        where: { id: input.compId },
        data: {
          name: input.name,
          groupCount: input.groupCount,
          slots: {
            deleteMany: {},
            create: input.slots.map((s) => ({
              groupIndex: s.groupIndex,
              slotIndex: s.slotIndex,
              rosterMemberId: s.rosterMemberId,
              characterName: s.characterName,
              classToken: s.classToken,
              specToken: s.specToken,
            })),
          },
        },
        include: { slots: true },
      });
    }),

  rename: protectedProcedure
    .input(z.object({ compId: z.string(), name: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await requireCompAdmin(ctx.db, ctx.session.user.id, input.compId);
      return ctx.db.guildRaidComp.update({
        where: { id: input.compId },
        data: { name: input.name },
      });
    }),

  delete: protectedProcedure
    .input(z.object({ compId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await requireCompAdmin(ctx.db, ctx.session.user.id, input.compId);
      await ctx.db.guildRaidComp.delete({ where: { id: input.compId } });
      return { success: true };
    }),

  // Refreshes one roster member's spec from Battle.net and persists it —
  // called by the client right after placing a member whose spec is
  // unknown or stale. Never blocks placement: every outcome besides "ok"
  // just means the block stays class-only until an officer sets a spec by
  // hand.
  syncSpec: protectedProcedure
    .input(z.object({ rosterMemberId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const member = await ctx.db.guildRosterMember.findUnique({
        where: { id: input.rosterMemberId },
      });
      if (!member) throw new TRPCError({ code: "NOT_FOUND" });

      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(ctx.db, member.guildId, ctx.session.user.id);
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      const notConfigured =
        !guild.wowRegion ||
        !guild.wowRealmSlug ||
        !guild.wowNamespaceFlavor ||
        !member.class;
      if (notConfigured) {
        return {
          rosterMemberId: member.id,
          specToken: null as string | null,
          status: "not_configured" as const,
        };
      }

      const result = await lookupCharacterSpecialization(
        guild.wowRegion!,
        guild.wowRealmSlug!,
        member.name,
        guild.wowNamespaceFlavor!,
      );
      if (result.status !== "ok") {
        return {
          rosterMemberId: member.id,
          specToken: null as string | null,
          status: result.status,
        };
      }

      const expansion = getExpansion(guild.expansion) ?? EXPANSIONS.tbc;
      const spec = expansion.specs.find(
        (s) =>
          s.classToken === member.class &&
          s.label.toLowerCase() === result.specializationName.toLowerCase(),
      );
      if (!spec) {
        return {
          rosterMemberId: member.id,
          specToken: null as string | null,
          status: "unavailable" as const,
        };
      }

      await ctx.db.guildRosterMember.update({
        where: { id: member.id },
        data: { spec: spec.token, specSyncedAt: new Date() },
      });

      return {
        rosterMemberId: member.id,
        specToken: spec.token as string | null,
        status: "ok" as const,
      };
    }),

  // Officer pins a spec by hand on a roster member — same persisted field
  // as syncSpec's Battle.net result (GuildRosterMember.spec), so a manual
  // pick survives refetches and shows in the roster drawer too. null
  // clears a previously set/pinned spec (specSyncedAt reset with it, since
  // "no spec known" and "spec cleared" are the same state downstream).
  setManualSpec: protectedProcedure
    .input(
      z.object({
        rosterMemberId: z.string(),
        specToken: z.string().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const member = await ctx.db.guildRosterMember.findUnique({
        where: { id: input.rosterMemberId },
      });
      if (!member) throw new TRPCError({ code: "NOT_FOUND" });

      const { guild, isAdmin, needsReauth, retryAfterSeconds } =
        await checkGuildAdmin(
          ctx.db,
          member.guildId,
          ctx.session.user.id,
        );
      if (!isAdmin) {
        throw needsReauth
          ? new TRPCError({ code: "FORBIDDEN", message: "needs-reauth" })
          : forbiddenOrRateLimited(retryAfterSeconds);
      }

      if (input.specToken != null) {
        const expansion = getExpansion(guild.expansion) ?? EXPANSIONS.tbc;
        const valid = expansion.specs.some(
          (s) =>
            s.token === input.specToken &&
            (member.class == null || s.classToken === member.class),
        );
        if (!valid) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "That specialization doesn't belong to this character's class.",
          });
        }
      }

      await ctx.db.guildRosterMember.update({
        where: { id: member.id },
        data: {
          spec: input.specToken,
          specSyncedAt: input.specToken != null ? new Date() : null,
        },
      });
      return {
        rosterMemberId: member.id,
        specToken: input.specToken,
      };
    }),
});