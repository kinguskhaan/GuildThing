import Link from "next/link";

import { api } from "~/trpc/server";

export default async function SyncPage({
  params,
}: {
  params: Promise<{ guildSlug: string }>;
}) {
  const { guildSlug } = await params;
  const { id: guildId } = await api.guild.resolveSlug({ slug: guildSlug });
  const guild = await api.guild.get({ guildId });

  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-10">
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="text-2xl font-bold">Sync script</h2>
        <p className="max-w-md text-discord-text-muted">
          Reads the GuildThing Roster and OurRecipes addons&apos; files
          directly from your WoW install and pushes them here automatically
          — no more copying export strings and pasting them in by hand.
        </p>
      </div>

      {guild.isAdmin ? (
        <Link
          href={`/guilds/${guildSlug}/admin/api-keys`}
          className="rounded-full bg-discord-brand px-10 py-3 font-semibold text-discord-text no-underline transition hover:bg-discord-brand-hover"
        >
          Create an API key
        </Link>
      ) : (
        <p className="rounded-xl bg-discord-elevated p-4 text-center text-sm text-discord-text-muted">
          You&apos;ll need a key from a guild admin (Admin → API keys) to set
          this up.
        </p>
      )}

      <ol className="flex w-full flex-col gap-4">
        {[
          <>
            Get an API key — an admin creates one on the{" "}
            <span className="font-semibold">API keys</span> admin page.
          </>,
          <>
            Download{" "}
            <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">
              apps/sync
            </code>{" "}
            from the GuildThing repo, run <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">pnpm install</code>, and copy{" "}
            <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">
              .env.example
            </code>{" "}
            to <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">.env</code>.
          </>,
          "Fill in the API key and this site's URL in .env (Linux/Steam Proton users also set WOW_WTF_DIR — see the script's README).",
          <>
            Run <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">pnpm start</code> and
            leave it running, or <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">pnpm start:once</code> on
            a schedule (cron/Task Scheduler) — full setup and both options
            are in the script&apos;s README.
          </>,
          <>
            Done — log into WoW, and your roster and professions update here
            on their own. It also flows back the other way: your current
            Discord roles (and the audit log) show up in the addon&apos;s
            own tabs — not live, only as of your last sync run, and picked
            up in-game after a plain{" "}
            <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">
              /reload
            </code>
            .
          </>,
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
