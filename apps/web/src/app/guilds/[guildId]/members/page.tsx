import { NicknameEditor } from "~/app/_components/nickname-editor";
import { characterLabel } from "~/lib/format";
import { getSession } from "~/server/better-auth/server";
import { api } from "~/trpc/server";

export default async function MembersPage({
  params,
}: {
  params: Promise<{ guildId: string }>;
}) {
  const { guildId } = await params;
  const [characters, session] = await Promise.all([
    api.guild.roster({ guildId }),
    getSession(),
  ]);

  const byUser = new Map<
    string,
    {
      userId: string;
      displayName: string;
      nickname: string | null;
      characters: typeof characters;
    }
  >();
  for (const character of characters) {
    const entry = byUser.get(character.userId) ?? {
      userId: character.userId,
      displayName: character.user.nickname ?? character.user.name,
      nickname: character.user.nickname,
      characters: [],
    };
    entry.characters.push(character);
    byUser.set(character.userId, entry);
  }
  const members = [...byUser.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );

  return (
    <div className="flex w-full max-w-2xl flex-col gap-4">
      <h2 className="text-center text-2xl font-bold">Members</h2>

      {members.length === 0 ? (
        <div className="w-full rounded-xl bg-discord-elevated p-6 text-center text-discord-text-muted">
          No one has imported a character in this guild yet.
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {members.map((member) => (
            <li
              key={member.userId}
              className="flex flex-col gap-3 rounded-xl bg-discord-elevated p-4"
            >
              {member.userId === session?.user.id ? (
                <NicknameEditor
                  initialNickname={member.nickname}
                  fallback={member.displayName}
                />
              ) : (
                <p className="font-semibold">{member.displayName}</p>
              )}
              <ul className="flex flex-col gap-2">
                {member.characters.map((character) => (
                  <li
                    key={character.id}
                    className="rounded-lg bg-discord-elevated px-3 py-2 text-sm"
                  >
                    <span>{characterLabel(character.name, character.realm)}</span>
                    {character.professions.length > 0 && (
                      <span className="text-discord-text-muted">
                        {" — "}
                        {character.professions.map((p) => p.name).join(", ")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
