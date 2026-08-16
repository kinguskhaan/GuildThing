"use client";

import { useState } from "react";

import { api } from "~/trpc/react";

// Admin counterpart to onboarding's own name-matching, for what it can't
// handle on its own: an out-of-guild alt (never shows up in an addon
// export, so onboarding can only wait forever) or fixing up a claim by
// hand. If the name already exists as an unclaimed roster row, this just
// claims it as-is; otherwise it creates a new row (rank/level/class only
// matter for that "new character" case — ignored if the row already
// exists).
export function GuildClaimCharacter({ guildId }: { guildId: string }) {
  const [collapsed, setCollapsed] = useState(true);
  const [discordUserId, setDiscordUserId] = useState("");
  const [name, setName] = useState("");
  const [rank, setRank] = useState("");
  const [level, setLevel] = useState("");
  const [charClass, setCharClass] = useState("");

  const utils = api.useUtils();
  const members = api.guild.guildMembersForClaim.useQuery(
    { guildId },
    { enabled: !collapsed },
  );
  const classOptions = api.guild.rosterClassOptions.useQuery(
    { guildId },
    { enabled: !collapsed },
  );
  const claim = api.guild.adminClaimCharacter.useMutation({
    onSuccess: async () => {
      setName("");
      setRank("");
      setLevel("");
      setCharClass("");
      await Promise.all([
        utils.guild.rosterMembers.invalidate({ guildId }),
        utils.guild.unclaimedMembers.invalidate({ guildId }),
        utils.guild.pendingRosterMatches.invalidate({ guildId }),
      ]);
    },
  });

  function submit() {
    const member = members.data?.find((m) => m.id === discordUserId);
    if (!member || name.trim() === "") return;
    claim.mutate({
      guildId,
      discordUserId: member.id,
      discordUserTag: member.tag,
      name: name.trim(),
      rank: rank.trim() === "" ? undefined : rank.trim(),
      level: level.trim() === "" ? undefined : Number(level),
      class: charClass.trim() === "" ? undefined : charClass.trim(),
    });
  }

  return (
    <div className="bg-discord-elevated flex w-full flex-col gap-2 rounded-xl p-4">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center justify-between text-left"
      >
        <h3 className="font-bold">Claim a character</h3>
        <span className="text-discord-text-muted">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <>
          <p className="text-discord-text-muted text-sm">
            Manually claim a character for someone — for an out-of-guild alt
            that&apos;ll never show up in an addon import, or to fix a claim
            by hand. If the name already exists as an unclaimed roster row,
            it&apos;s claimed as-is; otherwise a new row is created (rank/
            level/class below only apply then). Won&apos;t take over a claim
            someone else already holds.
          </p>
          <div className="flex flex-wrap gap-2">
            <select
              className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2"
              value={discordUserId}
              onChange={(e) => setDiscordUserId(e.target.value)}
            >
              <option value="">Which Discord member?</option>
              {members.data?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.tag}
                </option>
              ))}
            </select>
            <input
              className="bg-discord-base text-discord-text flex-1 rounded-full px-4 py-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Exact character name"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              className="bg-discord-base text-discord-text w-32 rounded-full px-4 py-2"
              value={rank}
              onChange={(e) => setRank(e.target.value)}
              placeholder="Rank (if new)"
            />
            <input
              type="number"
              className="bg-discord-base text-discord-text w-24 rounded-full px-4 py-2"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              placeholder="Level"
            />
            <input
              className="bg-discord-base text-discord-text w-40 rounded-full px-4 py-2"
              list="claim-class-options"
              value={charClass}
              onChange={(e) => setCharClass(e.target.value)}
              placeholder="Class (if new)"
            />
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={
              claim.isPending || discordUserId === "" || name.trim() === ""
            }
            className="bg-discord-brand self-start rounded-full px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {claim.isPending ? "Claiming..." : "Claim"}
          </button>
          {claim.error && (
            <p className="text-discord-red text-sm">{claim.error.message}</p>
          )}
          {claim.isSuccess && (
            <p className="text-discord-green text-sm">
              {claim.data.created
                ? "Created and claimed."
                : "Claimed the existing roster row."}
            </p>
          )}
          <datalist id="claim-class-options">
            {classOptions.data?.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </>
      )}
    </div>
  );
}
