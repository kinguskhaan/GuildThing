import { notFound } from "next/navigation";

import { EditGuildForm } from "~/app/_components/edit-guild-form";
import { GuildBotToggle } from "~/app/_components/guild-bot-toggle";
import { api } from "~/trpc/server";

export default async function AdminSettingsPage({
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
      <div className="w-full max-w-md">
        <h2 className="text-xl font-bold">Guild settings</h2>
        <p className="text-discord-text-muted mt-1 text-sm">
          Rename this guild, change its Discord server or required/admin roles,
          or delete it entirely.
        </p>
      </div>
      <GuildBotToggle guildId={guildId} initialEnabled={guild.botEnabled} />
      <EditGuildForm
        guildId={guildId}
        initialName={guild.name}
        initialDiscordGuildId={guild.discordGuildId}
        initialRequiredRoleIds={guild.requiredRoleIds}
        initialAdminRoleIds={guild.adminRoleIds}
        isOwner={guild.isOwner}
        defaultOpen
      />
    </div>
  );
}
