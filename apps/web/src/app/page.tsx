import { redirect } from "next/navigation";

import { Landing, type SignInState } from "~/app/_components/landing";
import { auth } from "~/server/better-auth";
import { getSession } from "~/server/better-auth/server";

async function signInWithDiscord(): Promise<SignInState> {
  "use server";
  let url: string | undefined;
  try {
    const res = await auth.api.signInSocial({
      body: {
        provider: "discord",
        callbackURL: "/",
      },
    });
    url = res.url;
  } catch {
    return { error: "Couldn't reach Discord. Check your connection and try again." };
  }
  if (!url) {
    return { error: "Discord didn't return a login link. Try again." };
  }
  redirect(url);
}

export default async function Home() {
  const session = await getSession();

  if (session) {
    redirect("/guilds");
  }

  return <Landing signIn={signInWithDiscord} />;
}