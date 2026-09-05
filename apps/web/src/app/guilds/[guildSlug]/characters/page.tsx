import Link from "next/link";

import { GuildImportForm } from "~/app/_components/guild-import-form";
import { GuildMyCharacters } from "~/app/_components/guild-my-characters";
import { ManualCharacterForm } from "~/app/_components/manual-character-form";
import { NicknameEditor } from "~/app/_components/nickname-editor";
import { api } from "~/trpc/server";

export default async function MyCharactersPage({
  params,
}: {
  params: Promise<{ guildSlug: string }>;
}) {
  const { guildSlug } = await params;
  const { id: guildId } = await api.guild.resolveSlug({ slug: guildSlug });
  const me = await api.user.me();

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold">Your nickname & characters</h2>
        <p className="text-sm text-discord-text-muted">
          How you show up on the roster, and which characters and recipes
          are yours.
        </p>
      </div>

      <NicknameEditor initialNickname={me.nickname} fallback={me.name} />

      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h3 className="font-bold">Your characters</h3>
          <Link
            href={`/guilds/${guildSlug}/addon`}
            className="text-sm text-discord-link hover:underline"
          >
            Get the GuildThing addon →
          </Link>
        </div>
        <GuildImportForm guildId={guildId} />
        <ManualCharacterForm guildId={guildId} />
        <GuildMyCharacters guildId={guildId} />
      </div>
    </div>
  );
}
