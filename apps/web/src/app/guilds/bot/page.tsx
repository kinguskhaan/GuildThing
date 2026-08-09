import Link from "next/link";

import { env } from "~/env";

// Manage Nicknames (0x08000000) + Manage Roles (0x10000000) — everything
// the onboarding bot needs and nothing more. Its own role still has to sit
// above whatever roles it's assigned to hand out in the server's role
// list — that part Discord makes you do by hand after inviting it.
const BOT_PERMISSIONS = 402653184;

export default function BotPage() {
  const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${env.BETTER_AUTH_DISCORD_CLIENT_ID}&scope=bot&permissions=${BOT_PERMISSIONS}`;

  return (
    <main className="flex min-h-screen flex-col items-center gap-10 px-4 py-16">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-4xl font-extrabold tracking-tight">
          GuildThing Roster bot
        </h1>
        <p className="max-w-md text-discord-text-muted">
          DMs new members for their in-game name and alts, then sets their
          nickname and roles from your guild&apos;s roster automatically.
        </p>
      </div>

      <a
        href={inviteUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="rounded-full bg-discord-brand px-10 py-3 font-semibold text-discord-text no-underline transition hover:bg-discord-brand-hover"
      >
        Add to Discord server
      </a>

      <ol className="flex w-full max-w-xl flex-col gap-4">
        {[
          "Add the bot to your Discord server above (you need Manage Server permission there).",
          <>
            In the Discord Developer Portal for this bot&apos;s application,
            under <span className="font-semibold">Bot</span>, enable the{" "}
            <span className="font-semibold">Server Members Intent</span> —
            without it the bot can&apos;t see people joining.
          </>,
          "Drag the bot's own role above any role you want it to be able to assign, in Server Settings → Roles.",
          <>
            Set up rank/level/class → role rules on the{" "}
            <span className="font-semibold">Discord onboarding roles</span>{" "}
            admin page for your guild.
          </>,
          "Done — new members get DM'd automatically when they join.",
        ].map((step, i) => (
          <li key={i} className="flex gap-3 rounded-xl bg-discord-elevated p-4">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-discord-brand text-sm font-semibold">
              {i + 1}
            </span>
            <span className="text-sm">{step}</span>
          </li>
        ))}
      </ol>

      <Link href="/guilds" className="underline">
        Back to guilds
      </Link>
    </main>
  );
}
