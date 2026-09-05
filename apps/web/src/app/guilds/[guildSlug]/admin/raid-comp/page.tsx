import { notFound } from "next/navigation";
import Link from "next/link";

import { RaidCompBuilder } from "~/app/_components/raid-comp-builder";
import { api } from "~/trpc/server";

export default async function RaidCompPage({
  params,
}: {
  params: Promise<{ guildSlug: string }>;
}) {
  const { guildSlug } = await params;
  const { id: guildId } = await api.guild.resolveSlug({ slug: guildSlug });
  const guild = await api.guild.get({ guildId });

  if (!guild.isAdmin) notFound();

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="w-full">
        <h2 className="text-xl font-bold">Raid comp</h2>
        <p className="text-discord-text-muted mt-1 text-sm">
          Snap roster members into group blocks and see what the comp covers
          before raid night. Saved comps are only visible to officers and GMs.
        </p>
      </div>
      {!guild.bnetConfigured && (
        <div className="bg-discord-elevated rounded-xl p-4 text-sm">
          <span className="text-discord-text-muted">
            Spec sync is off — without Battle.net armory config, placed
            characters show class only and specs must be set manually.
          </span>{" "}
          <a
            href={`/guilds/${guildSlug}/admin/settings`}
            className="text-discord-link hover:underline"
          >
            Set it in Guild settings
          </a>
        </div>
      )}
      <RaidCompBuilder
        guildId={guildId}
        guildSlug={guildSlug}
        expansionId={guild.expansion}
        bnetConfigured={guild.bnetConfigured}
      />
    </div>
  );
}