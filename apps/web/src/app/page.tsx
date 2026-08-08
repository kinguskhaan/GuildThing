import { redirect } from "next/navigation";

import { LoginCard } from "~/app/_components/login-card";
import { auth } from "~/server/better-auth";
import { getSession } from "~/server/better-auth/server";

async function signInWithDiscord() {
  "use server";
  const res = await auth.api.signInSocial({
    body: {
      provider: "discord",
      callbackURL: "/",
    },
  });
  if (!res.url) {
    throw new Error("No URL returned from signInSocial");
  }
  redirect(res.url);
}

export default async function Home() {
  const session = await getSession();

  if (session) {
    redirect("/guilds");
  }

  return <LoginCard signIn={signInWithDiscord} />;
}
