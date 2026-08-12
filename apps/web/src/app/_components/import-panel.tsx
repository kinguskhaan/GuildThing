"use client";

import Link from "next/link";
import { useState } from "react";

import { GuildImportForm } from "~/app/_components/guild-import-form";
import { GuildMyCharacters } from "~/app/_components/guild-my-characters";
import { ManualCharacterForm } from "~/app/_components/manual-character-form";

export function ImportPanel({
  guildId,
  guildSlug,
}: {
  guildId: string;
  guildSlug: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="w-full max-w-xl rounded-xl bg-discord-elevated">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-6 py-3 text-left text-sm font-semibold"
      >
        <span>{open ? "▾" : "▸"}</span>
        Import / My characters
      </button>

      {open && (
        <div className="flex flex-col gap-4 px-6 pb-6">
          <Link
            href={`/guilds/${guildSlug}/addon`}
            className="self-start text-sm text-discord-link hover:underline"
          >
            Get the GuildThing addon →
          </Link>
          <GuildImportForm guildId={guildId} />
          <ManualCharacterForm guildId={guildId} />
          <GuildMyCharacters guildId={guildId} />
        </div>
      )}
    </div>
  );
}
