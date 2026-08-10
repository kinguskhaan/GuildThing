import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";

export const userRouter = createTRPCRouter({
  // Feeds NicknameEditor's initial value wherever it's rendered outside a
  // list that already joined the User row in (the old per-guild members
  // list did; the merged roster page doesn't).
  me: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
      select: { nickname: true, name: true },
    });
    return { nickname: user?.nickname ?? null, name: user?.name ?? "" };
  }),

  updateNickname: protectedProcedure
    .input(z.object({ nickname: z.string().trim().max(32) }))
    .mutation(async ({ ctx, input }) => {
      const nickname = input.nickname.length > 0 ? input.nickname : null;
      await ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: { nickname },
      });
      return { nickname };
    }),
});
