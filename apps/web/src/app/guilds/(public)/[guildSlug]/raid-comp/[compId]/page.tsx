import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { RaidCompView } from "~/app/_components/raid-comp-view";
import { expansionDef } from "~/app/_components/raid-comp-state";
import { auth } from "~/server/better-auth";
import { api } from "~/trpc/server";

// PUBLIC share view for one saved raid comp — the URL the builder's
// "Copy share link" button puts on the clipboard. The unguessable compId
// in the link is the access control: anyone who holds the link can read
// the comp, logged in or not (so it renders outside the member-gated
// route groups). Logging in from here redirects straight back to this
// page; guild officers then get a link to the live builder.
export default async function RaidCompSharePage({
  params,
}: {
  params: Promise<{ guildSlug: string; compId: string }>;
}) {
  const { guildSlug, compId } = await params;
  const shared = await api.raidComp
    .view({ compId, slug: guildSlug })
    .catch(() => notFound());
  const expansion = expansionDef(shared.guild.expansion);

  return (
    <main className="bg-discord-base text-discord-text mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-4 px-6 py-8">
      <div>
        <p className="text-discord-text-muted text-xs font-bold tracking-wider uppercase">
          {shared.guild.name}
        </p>
        <h2 className="text-xl font-bold">{shared.comp.name}</h2>
        <p className="text-discord-text-muted mt-1 text-sm">
          {shared.viewer.loggedIn ? (
            shared.viewer.isAdmin ? (
              <>
                View-only copy of this comp. Officers make changes in the{" "}
                <Link
                  href={`/guilds/${guildSlug}/admin/raid-comp`}
                  className="text-discord-link hover:underline"
                >
                  builder
                </Link>
                .
              </>
            ) : (
              "View-only copy of this comp. Officers make changes in the builder."
            )
          ) : (
            "View-only copy of this comp. Log in with Discord to edit it."
          )}
        </p>
        {!shared.viewer.loggedIn && (
          <form className="mt-3">
            <button
              className="bg-discord-brand rounded-full px-6 py-2 text-sm font-semibold text-white transition hover:bg-discord-brand-hover"
              formAction={async () => {
                "use server";
                const res = await auth.api.signInSocial({
                  body: {
                    provider: "discord",
                    // Back to this exact comp after the OAuth round-trip.
                    callbackURL: `/guilds/${guildSlug}/raid-comp/${compId}`,
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
        )}
        {shared.viewer.loggedIn && (
          <Link
            href={`/guilds/${shared.guild.slug}`}
            className="text-discord-text-muted mt-3 block w-fit text-sm underline hover:no-underline"
          >
            Open {shared.guild.name}
          </Link>
        )}
      </div>
      <RaidCompView expansion={expansion} comp={shared.comp} />
    </main>
  );
}