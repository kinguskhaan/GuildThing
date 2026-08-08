import { GuildRosterImportForm } from "~/app/_components/guild-roster-import-form";
import { classColor } from "~/lib/format";
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

  return (
    <div className="flex w-full max-w-3xl flex-col gap-4">
      <h2 className="text-center text-2xl font-bold">Roster</h2>

      {guild.isAdmin && <GuildRosterImportForm guildId={guildId} />}

      {members.length === 0 ? (
        <div className="w-full rounded-xl bg-discord-elevated p-6 text-center text-discord-text-muted">
          No roster imported yet.
        </div>
      ) : (
        <div className="w-full overflow-hidden rounded-xl bg-discord-elevated">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-black/20 text-xs uppercase text-discord-text-muted">
                <th className="px-4 py-2 font-semibold">Name</th>
                <th className="px-4 py-2 font-semibold">Rank</th>
                <th className="px-4 py-2 font-semibold">Level</th>
                <th className="px-4 py-2 font-semibold">Note</th>
                {guild.isAdmin && (
                  <th className="px-4 py-2 font-semibold">Officer note</th>
                )}
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr
                  key={member.id}
                  className="border-b border-black/10 last:border-0"
                >
                  <td
                    className="px-4 py-2 font-semibold"
                    style={{ color: classColor(member.class) }}
                  >
                    {member.name}
                  </td>
                  <td className="px-4 py-2 text-discord-text-muted">
                    {member.rank}
                  </td>
                  <td className="px-4 py-2 text-discord-text-muted">
                    {member.level}
                  </td>
                  <td className="px-4 py-2 text-discord-text-muted">
                    {member.note}
                  </td>
                  {guild.isAdmin && (
                    <td className="px-4 py-2 text-discord-text-muted">
                      {member.officerNote}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
