import { notFound } from "next/navigation";

import { GuildRoleRulesForm } from "~/app/_components/guild-role-rules-form";
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
    <div className="flex w-full flex-col items-center gap-6">
      <div className="w-full max-w-2xl">
        <h2 className="text-xl font-bold">Discord Server Controls</h2>
        <p className="mt-1 text-sm text-discord-text-muted">
          Configure onboarding, role rules, inactivity, and everything else
          the GuildThing Roster bot manages on the Discord server.
        </p>
      </div>
      <GuildRoleRulesForm guildId={guildId} />
    </div>
  );
}
