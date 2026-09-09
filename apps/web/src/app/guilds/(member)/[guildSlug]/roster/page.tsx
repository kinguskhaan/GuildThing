import Link from "next/link";

import { GuildExternalCharacters } from "~/app/_components/guild-external-characters";
import { GuildPendingMatches } from "~/app/_components/guild-pending-matches";
import { GuildRosterSyncPanel } from "~/app/_components/guild-roster-sync-panel";
import { GuildRosterTable } from "~/app/_components/guild-roster-table";
import { api } from "~/trpc/server";

function ToolGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="px-1 text-[11px] font-semibold tracking-wide text-discord-text-muted uppercase">
        {label}
      </span>
      <div className="grid gap-2">{children}</div>
    </div>
  );
}

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
  const [pendingMatches, unclaimedMembers, memberNicknames, externalCharacters] =
    guild.isAdmin
      ? await Promise.all([
          api.guild.pendingRosterMatches({ guildId }),
          api.guild.unclaimedMembers({ guildId }),
          api.guild.memberNicknames({ guildId }),
          api.guild.externalCharacters({ guildId }),
        ])
      : [[], [], [], []];

  return (
    <div className="flex w-full flex-col gap-4">
      <h2 className="text-center text-2xl font-bold">Members</h2>

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <Link
          href={`/guilds/${guildSlug}/characters`}
          className="self-start text-sm text-discord-text-muted hover:text-discord-text hover:underline"
        >
          Editing as{" "}
          <span className="font-semibold text-discord-text">
            {me.nickname ?? me.name}
          </span>{" "}
          — characters & nickname →
        </Link>

        {guild.isAdmin && pendingMatches.length > 0 && (
          <ToolGroup label="Needs your attention">
            <GuildPendingMatches guildId={guildId} entries={pendingMatches} />
          </ToolGroup>
        )}

        {guild.isAdmin && guild.rosterSource !== "onboarding" && (
          <ToolGroup label="Roster tools">
            <GuildRosterSyncPanel
              guildId={guildId}
              existingMemberNames={members.map((m) => m.name)}
            />
          </ToolGroup>
        )}
        {guild.isAdmin && guild.rosterSource === "onboarding" && (
          <ToolGroup label="Roster tools">
            <div className="w-full rounded-xl bg-discord-elevated p-4 text-sm text-discord-text-muted">
              This guild builds its roster from Discord onboarding —
              there&apos;s nothing to import here. Switch back to &quot;Addon
              export&quot; on the Discord Server Controls admin page if that
              changes.
            </div>
          </ToolGroup>
        )}
      </div>

      {guild.isAdmin && (
        <GuildExternalCharacters guildId={guildId} rows={externalCharacters} />
      )}

      {members.length === 0 && unclaimedMembers.length === 0 ? (
        <div className="w-full rounded-xl bg-discord-elevated p-6 text-center text-discord-text-muted">
          {guild.rosterSource === "onboarding"
            ? "Nobody has onboarded yet."
            : "No roster imported yet."}
        </div>
      ) : (
        <GuildRosterTable
          guildId={guildId}
          members={members}
          isAdmin={guild.isAdmin}
          lastRosterImportedAt={guild.lastRosterImportedAt}
          nicknameRows={memberNicknames}
          unclaimedMembers={unclaimedMembers}
        />
      )}
    </div>
  );
}
