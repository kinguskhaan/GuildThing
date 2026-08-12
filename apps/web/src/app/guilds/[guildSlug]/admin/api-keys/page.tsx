import { notFound } from "next/navigation";

import { GuildApiKeys } from "~/app/_components/guild-api-keys";
import { api } from "~/trpc/server";

export default async function AdminApiKeysPage({
  params,
}: {
  params: Promise<{ guildSlug: string }>;
}) {
  const { guildSlug } = await params;
  const { id: guildId } = await api.guild.resolveSlug({ slug: guildSlug });
  const guild = await api.guild.get({ guildId });

  if (!guild.isAdmin) notFound();

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <div className="w-full max-w-xl">
        <h2 className="text-xl font-bold">API keys</h2>
        <p className="mt-1 text-sm text-discord-text-muted">
          Secret keys for the sync script — lets it push roster and
          character/profession data automatically instead of pasting exports
          by hand. See the{" "}
          <span className="text-discord-text">Sync script</span> page for
          setup instructions.
        </p>
      </div>
      <GuildApiKeys guildId={guildId} />
    </div>
  );
}
