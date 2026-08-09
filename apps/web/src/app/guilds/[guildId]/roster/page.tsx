import { GuildPendingMatches } from "~/app/_components/guild-pending-matches";
import { GuildRosterImportForm } from "~/app/_components/guild-roster-import-form";
import { GuildRosterTable } from "~/app/_components/guild-roster-table";
import { api } from "~/trpc/server";

export default async function RosterPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const [guild, members] = await Promise.all([
    api.guild.get({ guildId }),
    api.guild.rosterMembers({ guildId }),
  ]);
  const pendingMatches = guild.isAdmin
    ? await api.guild.pendingRosterMatches({ guildId })
    : [];

  return (
    <div className="flex w-full max-w-3xl flex-col gap-4">
      <h2 className="text-center text-2xl font-bold">Roster</h2>

      {guild.isAdmin && <GuildRosterImportForm guildId={guildId} />}
      {guild.isAdmin && (
        <GuildPendingMatches guildId={guildId} entries={pendingMatches} />
      )}

      {members.length === 0 ? (
        <div className="w-full rounded-xl bg-discord-elevated p-6 text-center text-discord-text-muted">
          No roster imported yet.
        </div>
      ) : (
        <GuildRosterTable guildId={guildId} members={members} isAdmin={guild.isAdmin} />
      )}
    </div>
  );
}
