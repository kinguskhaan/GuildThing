import { notFound } from "next/navigation";

import { GuildRoleRulesForm } from "~/app/_components/guild-role-rules-form";
import { api } from "~/trpc/server";

export default async function AdminDiscordRolesPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const guild = await api.guild.get({ guildId });

  if (!guild.isAdmin) notFound();

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <div className="w-full max-w-2xl">
        <h2 className="text-xl font-bold">Discord onboarding roles</h2>
        <p className="mt-1 text-sm text-discord-text-muted">
          Configure the roles the GuildThing Roster bot assigns when someone
          joins the Discord server.
        </p>
      </div>
      <GuildRoleRulesForm guildId={guildId} />
    </div>
  );
}
