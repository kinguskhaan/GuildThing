import { notFound } from "next/navigation";

import { DiscordServerControls } from "~/app/_components/discord-server-controls";
import { api } from "~/trpc/server";

export default async function AdminDiscordRolesPage({
  params,
}: {
  params: Promise<{ guildSlug: string }>;
}) {
  const { guildSlug } = await params;
  const { id: guildId } = await api.guild.resolveSlug({ slug: guildSlug });
  const guild = await api.guild.get({ guildId });

  if (!guild.isAdmin) notFound();

  return (
    <DiscordServerControls
      guildId={guildId}
      initialBotEnabled={guild.botEnabled}
      lastRosterImportedAt={guild.lastRosterImportedAt}
    />
  );
}