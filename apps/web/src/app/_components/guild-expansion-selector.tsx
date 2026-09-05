"use client";

import { useState } from "react";

import { EXPANSION_ORDER, EXPANSIONS } from "@guildthing/wowhead-data";

import { api } from "~/trpc/react";

// Which game expansion this guild plays — drives the raid comp tool's raid
// size, class/spec roster, and buff/debuff checklist (see EXPANSIONS in
// @guildthing/wowhead-data), and flows through to the bot's onboarding
// class list. Deliberately separate from EditGuildForm, same "own settings
// widget" convention as GuildBotToggle: this changes what a whole tool
// shows, not a field alongside renaming the guild.
export function GuildExpansionSelector({
  guildId,
  initialExpansion,
}: {
  guildId: string;
  initialExpansion: string;
}) {
  const [expansion, setExpansion] = useState(initialExpansion);
  const setGuildExpansion = api.guild.setExpansion.useMutation({
    onSuccess: (_data, variables) => setExpansion(variables.expansion),
  });

  return (
    <div className="bg-discord-elevated flex w-full max-w-md flex-col gap-2 rounded-xl p-4">
      <h3 className="font-bold">Expansion</h3>
      <p className="text-discord-text-muted text-sm">
        Which expansion this guild raids in — sets the raid comp tool&apos;s
        class/spec roster, raid size, and buff checklist.
      </p>
      <div className="flex flex-wrap gap-2">
        {EXPANSION_ORDER.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setGuildExpansion.mutate({ guildId, expansion: id })}
            disabled={setGuildExpansion.isPending}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition disabled:opacity-50 ${
              expansion === id
                ? "bg-discord-brand text-white"
                : "bg-discord-elevated-hover text-discord-text hover:bg-discord-brand/40"
            }`}
          >
            {EXPANSIONS[id].shortLabel}
          </button>
        ))}
      </div>
      {setGuildExpansion.error && (
        <span className="text-discord-red text-sm">
          {setGuildExpansion.error.message}
        </span>
      )}
    </div>
  );
}