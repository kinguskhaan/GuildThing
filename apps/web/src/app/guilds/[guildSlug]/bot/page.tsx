import { env } from "~/env";

// Manage Nicknames (0x08000000) + Manage Roles (0x10000000) +
// Manage Channels (0x00000010) — everything the onboarding bot needs and
// nothing more. Its own role still has to sit above whatever roles it's
// assigned to hand out in the server's role list — that part Discord makes
// you do by hand after inviting it.
const BOT_PERMISSIONS = 402653200;

export default function BotPage() {
  const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${env.BETTER_AUTH_DISCORD_CLIENT_ID}&scope=bot&permissions=${BOT_PERMISSIONS}`;

  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-10">
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="text-2xl font-bold">GuildThing Roster bot</h2>
        <p className="max-w-md text-discord-text-muted">
          Asks new members for their in-game name and alts right in your
          server (privately, via ephemeral messages — not DMs), then sets
          their nickname and roles from your guild&apos;s roster
          automatically.
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

      <ol className="flex w-full flex-col gap-4">
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
            Set up rank/level/class → role rules, and pick an onboarding
            button channel, on the{" "}
            <span className="font-semibold">Discord onboarding roles</span>{" "}
            admin page for your guild.
          </>,
          "Done — new members get a nudge when they join, and can start onboarding any time from the button in that channel or the /onboarding command.",
        ].map((step, i) => (
          <li key={i} className="flex gap-3 rounded-xl bg-discord-elevated p-4">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-discord-brand text-sm font-semibold">
              {i + 1}
            </span>
            <span className="text-sm">{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
