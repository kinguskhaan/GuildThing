import { GuildPendingMatches } from "~/app/_components/guild-pending-matches";
import { GuildRosterImportForm } from "~/app/_components/guild-roster-import-form";
import { GuildRosterTable } from "~/app/_components/guild-roster-table";
import { GuildUnclaimedMembers } from "~/app/_components/guild-unclaimed-members";
import { NicknameEditor } from "~/app/_components/nickname-editor";
import { api } from "~/trpc/server";

export default async function RosterPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const [guild, members, me] = await Promise.all([
    api.guild.get({ guildId }),
    api.guild.rosterMembers({ guildId }),
    api.user.me(),
  ]);
  const [pendingMatches, unclaimedMembers] = guild.isAdmin
    ? await Promise.all([
        api.guild.pendingRosterMatches({ guildId }),
        api.guild.unclaimedMembers({ guildId }),
      ])
    : [[], []];

  return (
    <div className="flex w-full max-w-3xl flex-col gap-4">
      <h2 className="text-center text-2xl font-bold">Members</h2>

      <NicknameEditor initialNickname={me.nickname} fallback={me.name} />

      {guild.isAdmin && <GuildRosterImportForm guildId={guildId} />}
      {guild.isAdmin && (
        <GuildPendingMatches guildId={guildId} entries={pendingMatches} />
      )}
      {guild.isAdmin && (
        <GuildUnclaimedMembers guildId={guildId} members={unclaimedMembers} />
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
