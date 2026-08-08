import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";

import { env } from "~/env";
import { db } from "~/server/db";

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  database: prismaAdapter(db, {
    provider: "sqlite", // or "sqlite" or "mysql"
  }),
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    discord: {
      clientId: env.BETTER_AUTH_DISCORD_CLIENT_ID,
      clientSecret: env.BETTER_AUTH_DISCORD_CLIENT_SECRET,
      scope: ["guilds.members.read", "guilds"],
    },
  },
  // Must stay last: forwards Set-Cookie headers from auth.api.* calls (e.g.
  // signInSocial in a Server Action) into Next's cookie store — without it
  // the OAuth CSRF state cookie never gets persisted.
  plugins: [nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
