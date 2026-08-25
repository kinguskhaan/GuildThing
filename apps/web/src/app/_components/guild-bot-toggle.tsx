"use client";

import { useState } from "react";

import { api } from "~/trpc/react";

// Kill switch for the bot's automated background jobs (role sync, channel
// grants, pending-match retries, external character sync, inactivity
// filter) — see Guild.botEnabled in schema.prisma and the botEnabled
// checks in apps/bot/src. Deliberately separate from EditGuildForm: this
// is an emergency control an admin reaches for mid-incident, not a
// settings field they tweak alongside renaming the guild.
export function GuildBotToggle({
  guildId,
  initialEnabled,
}: {
  guildId: string;
  initialEnabled: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const setBotEnabled = api.guild.setBotEnabled.useMutation({
    onSuccess: (_data, variables) => setEnabled(variables.enabled),
  });

  return (
    <div className="bg-discord-elevated flex w-full max-w-md flex-col gap-2 rounded-xl p-4">
      <h3 className="font-bold">Bot automation</h3>
      <p className="text-discord-text-muted text-sm">
        Pauses the bot&apos;s automated background jobs for this server — role
        sync, channel access grants, pending roster-match retries, external
        character sync, and the inactivity filter. Slash commands like{" "}
        <code>/ourrecipes</code> and <code>/bossman</code> still work; this only
        stops the bot from touching things on its own.
      </p>
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input
          type="checkbox"
          checked={enabled}
          disabled={setBotEnabled.isPending}
          onChange={(e) =>
            setBotEnabled.mutate({ guildId, enabled: e.target.checked })
          }
        />
        {enabled ? "Automation enabled" : "Automation disabled"}
      </label>
      {setBotEnabled.error && (
        <span className="text-discord-red text-sm">
          {setBotEnabled.error.message}
        </span>
      )}
    </div>
  );
}
