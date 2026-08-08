import Link from "next/link";

export default function AddonPage() {
  return (
    <main className="flex min-h-screen flex-col items-center gap-10 px-4 py-16">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-4xl font-extrabold tracking-tight">
          GuildThing addon
        </h1>
        <p className="max-w-md text-discord-text-muted">
          A small in-game addon that exports your known profession recipes as
          JSON, ready to paste into a guild here.
        </p>
      </div>

      <a
        href="/downloads/GuildThing.zip"
        download
        className="rounded-full bg-discord-brand px-10 py-3 font-semibold text-discord-text no-underline transition hover:bg-discord-brand-hover"
      >
        Download GuildThing.zip
      </a>

      <ol className="flex w-full max-w-xl flex-col gap-4">
        {[
          "Download the addon above.",
          <>
            Unzip it into your WoW AddOns folder, e.g.{" "}
            <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">
              World of Warcraft/_anniversary_/Interface/AddOns/
            </code>{" "}
            — you should end up with a{" "}
            <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">
              GuildThing
            </code>{" "}
            folder next to your other addons.
          </>,
          <>
            In-game, type{" "}
            <code className="rounded bg-discord-elevated-hover px-1 py-0.5 text-sm">
              /gt
            </code>{" "}
            to open the GuildThing window.
          </>,
          'Open a profession window and click "Import" — GuildThing scans it and fills the box with JSON.',
          "Select everything (Ctrl+A) and copy it (Ctrl+C).",
          "Paste it (Ctrl+V) into the import box on a guild page here.",
        ].map((step, i) => (
          <li key={i} className="flex gap-3 rounded-xl bg-discord-elevated p-4">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-discord-brand text-sm font-semibold">
              {i + 1}
            </span>
            <span className="text-sm">{step}</span>
          </li>
        ))}
      </ol>

      <div className="flex w-full max-w-xl flex-col items-center gap-2">
        <p className="text-sm text-discord-text-muted">
          What &ldquo;Import&rdquo; looks like in-game:
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/addon/screenshot.png"
          alt="GuildThing in-game window showing imported professions and the exported JSON, with an Import button at the bottom"
          className="w-full rounded-xl border border-black/20"
        />
      </div>

      <Link href="/guilds" className="underline">
        Back to guilds
      </Link>
    </main>
  );
}
