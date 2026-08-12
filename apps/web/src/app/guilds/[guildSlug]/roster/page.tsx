import { GuildExportPanel } from "~/app/_components/guild-export-panel";
import { GuildPendingMatches } from "~/app/_components/guild-pending-matches";
import { GuildRosterImportForm } from "~/app/_components/guild-roster-import-form";
import { GuildRosterTable } from "~/app/_components/guild-roster-table";
import { GuildUnclaimedMembers } from "~/app/_components/guild-unclaimed-members";
import { ImportPanel } from "~/app/_components/import-panel";
import { NicknameEditor } from "~/app/_components/nickname-editor";
import { api } from "~/trpc/server";

export default async function RosterPage({
  params,
}: {
  params: Promise<{ guildSlug: string }>;
}) {
  const { guildSlug } = await params;
  const { id: guildId } = await api.guild.resolveSlug({ slug: guildSlug });
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
      <ImportPanel guildId={guildId} guildSlug={guildSlug} />
      <GuildExportPanel guildId={guildId} />

      {guild.isAdmin && guild.rosterSource === "onboarding" && (
        <div className="bg-discord-elevated text-discord-text-muted w-full rounded-xl p-4 text-sm">
          This guild builds its roster from Discord onboarding — there&apos;s
          nothing to import here. Switch back to &quot;Addon export&quot; on the
          Discord onboarding roles admin page if that changes.
        </div>
      )}
      {guild.isAdmin && guild.rosterSource !== "onboarding" && (
        <GuildRosterImportForm guildId={guildId} />
      )}
      {guild.isAdmin && (
        <GuildPendingMatches guildId={guildId} entries={pendingMatches} />
      )}
      {guild.isAdmin && (
        <GuildUnclaimedMembers guildId={guildId} members={unclaimedMembers} />
      )}

      {members.length === 0 ? (
        <div className="bg-discord-elevated text-discord-text-muted w-full rounded-xl p-6 text-center">
          {guild.rosterSource === "onboarding"
            ? "Nobody has onboarded yet."
            : "No roster imported yet."}
        </div>
      ) : (
        <GuildRosterTable
          guildId={guildId}
          members={members}
          isAdmin={guild.isAdmin}
        />
      )}
    </div>
  );
}
