import { notFound } from "next/navigation";

import { GuildAuditLog } from "~/app/_components/guild-audit-log";
import { GuildDiscordRolesTable } from "~/app/_components/guild-discord-roles-table";
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
        <p className="mt-1 text-xs text-discord-text-muted">
          For the bot to notice when an officer manually changes someone&apos;s
          roles (and skip overwriting that on the next resync), grant it the
          <strong> View Audit Log</strong> permission in Server Settings →
          Roles. Without it, resyncs still work, just without that
          protection.
        </p>
      </div>
      <GuildRoleRulesForm guildId={guildId} />
      <div className="w-full max-w-2xl">
        <h3 className="mb-2 font-bold">Discord roles</h3>
        <GuildDiscordRolesTable guildId={guildId} />
      </div>
      <div className="w-full max-w-2xl">
        <GuildAuditLog guildId={guildId} />
      </div>
    </div>
  );
}
