import Link from "next/link";

import { CreateGuildForm } from "~/app/_components/create-guild-form";
import { env } from "~/env";
import { api } from "~/trpc/server";

export default async function GuildsPage() {
  const [guilds, canCreateGuild] = await Promise.all([
    api.guild.list(),
    api.guild.canCreateGuild(),
  ]);

  return (
    <main className="flex min-h-screen flex-col items-center gap-10 px-4 py-16">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-4xl font-extrabold tracking-tight">
          {guilds.length > 0 ? "Your guilds" : "Set up your guild"}
        </h1>
        {guilds.length === 0 && (
          <p className="max-w-md text-discord-text-muted">
            {canCreateGuild
              ? "This instance doesn't have a guild page yet — create one to get started."
              : "This instance doesn't have a guild page yet — ask the owner to set one up."}
          </p>
        )}
      </div>

      {guilds.length > 0 && (
        <ul className="flex w-full max-w-md flex-col gap-2">
          {guilds.map((guild) => (
            <li key={guild.id}>
              <Link
                href={`/guilds/${guild.slug}`}
                className="flex items-center gap-3 rounded-xl bg-discord-elevated p-4 transition hover:bg-discord-elevated-hover"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-discord-elevated-hover text-sm font-semibold">
                  {guild.iconUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={guild.iconUrl}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    guild.name.slice(0, 2).toUpperCase()
                  )}
                </span>
                <span className="font-semibold">{guild.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {canCreateGuild && (
        <CreateGuildForm discordClientId={env.BETTER_AUTH_DISCORD_CLIENT_ID} />
      )}
    </main>
  );
}
