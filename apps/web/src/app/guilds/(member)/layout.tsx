import Link from "next/link";

import { redirect } from "next/navigation";

import { MemberShell } from "~/app/_components/member-shell";
import { auth } from "~/server/better-auth";
import { getSession } from "~/server/better-auth/server";

export default async function GuildsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session) {
    return (
      <main className="bg-discord-base text-discord-text flex min-h-screen flex-col items-center justify-center gap-4">
        <p>You need to log in to view guilds.</p>
        <form>
          <button
            className="bg-discord-brand hover:bg-discord-brand-hover rounded-full px-6 py-2 font-semibold text-white transition"
            formAction={async () => {
              "use server";
              // No slug context this far out in the tree — after login,
              // land on the guild list and let them click through.
              const res = await auth.api.signInSocial({
                body: {
                  provider: "discord",
                  callbackURL: "/guilds",
                },
              });
              if (!res.url) {
                throw new Error("No URL returned from signInSocial");
              }
              redirect(res.url);
            }}
          >
            Log in with Discord
          </button>
        </form>
        <Link href="/" className="text-discord-text-muted text-sm underline">
          Back to home
        </Link>
      </main>
    );
  }

  return <MemberShell>{children}</MemberShell>;
}
