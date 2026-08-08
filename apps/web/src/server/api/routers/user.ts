import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";

export const userRouter = createTRPCRouter({
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
