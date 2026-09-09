import Link from "next/link";

import { api } from "~/trpc/server";

const REPO_URL = "https://github.com/kinguskhaan/GuildThing";

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
        <h2 className="text-2xl font-bold">Sync</h2>
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

      <div className="flex w-full flex-col gap-3">
        <h3 className="font-semibold">GuildThing Sync (recommended)</h3>
        <p className="text-sm text-discord-text-muted">
          A desktop app with its own setup wizard — no terminal, no editing
          config files by hand. It finds your WoW install, checks the
          addons are there, and asks for your API key once.
        </p>
        <ol className="flex w-full flex-col gap-4">
          {[
            <>
              Get an API key — an admin creates one on the{" "}
              <span className="font-semibold">API keys</span> admin page.
            </>,
            <>
              Download <span className="font-semibold">GuildThing Sync</span>{" "}
              from the{" "}
              <a
                href={`${REPO_URL}/releases`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-discord-text"
              >
                releases page
              </a>{" "}
              — the Windows installer or the Linux AppImage.
            </>,
            "Open it and follow its own setup wizard: pick your WoW folder, confirm it found the addons, then paste this guild's API key and site URL.",
            <>
              Done — it keeps running in the background and syncs a few
              seconds after you log in/out of WoW. It also flows back the
              other way: your current Discord roles (and the audit log)
              show up in the addon&apos;s own tabs after a plain{" "}
              <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">
                /reload
              </code>
              .
            </>,
          ].map((step, i) => (
            <li
              key={i}
              className="flex gap-3 rounded-xl bg-discord-elevated p-4"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-discord-brand text-sm font-semibold">
                {i + 1}
              </span>
              <span className="text-sm">{step}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex w-full flex-col gap-3 border-t border-black/20 pt-8">
        <h3 className="font-semibold">Command-line script (advanced)</h3>
        <p className="text-sm text-discord-text-muted">
          For running it headless on a server, on a cron schedule, or if you
          just prefer a terminal. Same sync, no GUI.
        </p>
        <ol className="flex w-full flex-col gap-4">
          {[
            <>
              Download{" "}
              <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">
                apps/sync
              </code>{" "}
              from the{" "}
              <a
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-discord-text"
              >
                GuildThing repo
              </a>
              , run{" "}
              <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">
                pnpm install
              </code>
              , and copy{" "}
              <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">
                .env.example
              </code>{" "}
              to{" "}
              <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">
                .env
              </code>
              .
            </>,
            <>
              Syncing more than one guild or WoW install instead? Copy{" "}
              <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">
                sync.config.example.json
              </code>{" "}
              to{" "}
              <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">
                sync.config.json
              </code>{" "}
              instead — one entry per guild. Full details in the script&apos;s
              README.
            </>,
            <>
              Run{" "}
              <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">
                pnpm start
              </code>{" "}
              and leave it running, or{" "}
              <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">
                pnpm start:once
              </code>{" "}
              on a schedule (cron/Task Scheduler).
            </>,
          ].map((step, i) => (
            <li
              key={i}
              className="flex gap-3 rounded-xl bg-discord-elevated p-4"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-discord-elevated-hover text-sm font-semibold">
                {i + 1}
              </span>
              <span className="text-sm">{step}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
