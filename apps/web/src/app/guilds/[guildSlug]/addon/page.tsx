export default function AddonPage() {
  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-10">
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="text-2xl font-bold">GuildThing addon</h2>
        <p className="max-w-md text-discord-text-muted">
          A small in-game addon that scans your guild&apos;s roster (name,
          rank, level) and exports it as JSON.
        </p>
      </div>

      <a
        href="/downloads/GuildThing.zip"
        download
        className="rounded-full bg-discord-brand px-10 py-3 font-semibold text-discord-text no-underline transition hover:bg-discord-brand-hover"
      >
        Download GuildThing.zip
      </a>

      <ol className="flex w-full flex-col gap-4">
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
              /gtr
            </code>{" "}
            to open the GuildThing Roster window.
          </>,
          'Click "Scan guild roster" — GuildThing requests the roster and fills the box with JSON.',
          "Select everything (Ctrl+A) and copy it (Ctrl+C).",
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
