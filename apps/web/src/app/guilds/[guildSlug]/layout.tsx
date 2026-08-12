import { notFound, redirect } from "next/navigation";

import { EditGuildForm } from "~/app/_components/edit-guild-form";
import { auth } from "~/server/better-auth";
import { api } from "~/trpc/server";

export default async function GuildLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ guildSlug: string }>;
}) {
  const { guildSlug } = await params;
  let guildId: string;
  try {
    ({ id: guildId } = await api.guild.resolveSlug({ slug: guildSlug }));
  } catch {
    notFound();
  }
  const guild = await api.guild.get({ guildId });

  if (!guild.viewerHasAccess) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 py-16 text-center">
        <h1 className="text-3xl font-extrabold tracking-tight">
          {guild.name}
        </h1>
        <div className="flex max-w-md flex-col items-center gap-4 rounded-xl bg-discord-elevated p-6">
          {guild.needsReauth ? (
            <>
              <p>
                We couldn&apos;t verify your Discord role — log in with
                Discord again to grant the app permission to read your roles.
              </p>
              <form>
                <button
                  className="rounded-full bg-discord-elevated px-6 py-2 font-semibold transition hover:bg-discord-elevated-hover"
                  formAction={async () => {
                    "use server";
                    const res = await auth.api.signInSocial({
                      body: {
                        provider: "discord",
                        callbackURL: `/guilds/${guildSlug}`,
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
            </>
          ) : guild.retryAfterSeconds != null ? (
            <p>
              Discord is rate limiting role lookups right now — try again in
              about {guild.retryAfterSeconds}s.
            </p>
          ) : (
            <p>
              You don&apos;t have the role required in this guild&apos;s
              Discord server, so you can&apos;t view or import recipes here.
            </p>
          )}
        </div>

        {guild.isAdmin && (
          <EditGuildForm
            guildId={guildId}
            initialName={guild.name}
            initialDiscordGuildId={guild.discordGuildId}
            initialRequiredRoleIds={guild.requiredRoleIds}
            initialAdminRoleIds={guild.adminRoleIds}
            isOwner={guild.isOwner}
          />
        )}
      </main>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center gap-6 px-6 py-8">
      <h1 className="text-2xl font-extrabold tracking-tight">{guild.name}</h1>

      {children}
    </div>
  );
}
