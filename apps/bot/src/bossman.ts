import type { ChatInputCommandInteraction } from "discord.js";

import {
  diffGuildRoles,
  loadGuildWithRules,
  syncGuildRoles,
  type RoleMismatch,
} from "./roleSync.js";

// Both /bossman subcommands only ever report on the mismatches they find
// (or found and just fixed), so they share one formatter. Capped rather
// than paginated — a guild with more than this many simultaneous
// mismatches has a bigger problem than this command is meant to surface.
const REPORT_LIMIT = 20;

function formatMismatches(
  mismatches: RoleMismatch[],
  verb: { add: string; remove: string },
): string {
  if (mismatches.length === 0) return "";
  const lines = mismatches.slice(0, REPORT_LIMIT).map((m) => {
    const parts = [
      m.toAdd.length > 0 && `${verb.add} ${m.toAdd.join(", ")}`,
      m.toRemove.length > 0 && `${verb.remove} ${m.toRemove.join(", ")}`,
    ].filter(Boolean);
    return `• **${m.discordUserTag}** — ${parts.join(", ")}`;
  });
  if (mismatches.length > REPORT_LIMIT) {
    lines.push(`…and ${mismatches.length - REPORT_LIMIT} more.`);
  }
  return lines.join("\n");
}

// Read-only — computes what the rules say everyone should currently have
// and flags anyone whose actual Discord roles don't match, without
// touching anything. For spotting drift (an officer's manual edit that
// aged out, a rule that stopped/started firing) before running an actual
// resync.
export async function handleRoleDiffCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({
      content: "This only works in a server.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const guildRow = await loadGuildWithRules(interaction.guildId);
  if (!guildRow) {
    await interaction.editReply(
      "This Discord server isn't set up with GuildThing yet.",
    );
    return;
  }
  if (guildRow.roleRules.length === 0) {
    await interaction.editReply(
      "No role rules configured for this guild — nothing to check against.",
    );
    return;
  }

  const mismatches = await diffGuildRoles(interaction.guild, guildRow);
  if (mismatches.length === 0) {
    await interaction.editReply(
      "✅ Everyone's roles match the rules — no mismatches found.",
    );
    return;
  }

  const report = formatMismatches(mismatches, {
    add: "missing",
    remove: "shouldn't have",
  });
  await interaction.editReply(
    `Found ${mismatches.length} mismatch${mismatches.length === 1 ? "" : "es"}:\n${report}\n\nRun \`/bossman sync-roster\` to fix these.`,
  );
}

// Triggers the same resync the daily background job runs, but immediately
// and scoped to just this guild — for an officer who doesn't want to wait
// up to a day (or for the site's "Sync now" button's up-to-a-few-minutes
// polling delay, see request-sync/route.ts) after fixing a rule or
// re-importing the roster.
export async function handleSyncRosterCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({
      content: "This only works in a server.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const guildRow = await loadGuildWithRules(interaction.guildId);
  if (!guildRow) {
    await interaction.editReply(
      "This Discord server isn't set up with GuildThing yet.",
    );
    return;
  }
  if (guildRow.roleRules.length === 0) {
    await interaction.editReply(
      "No role rules configured for this guild — nothing to sync.",
    );
    return;
  }

  const changes = await syncGuildRoles(interaction.guild, guildRow);
  if (changes.length === 0) {
    await interaction.editReply(
      "✅ Resync complete — everyone's roles already matched, nothing changed.",
    );
    return;
  }

  const report = formatMismatches(changes, { add: "+", remove: "-" });
  await interaction.editReply(
    `Resync complete — updated ${changes.length} member${changes.length === 1 ? "" : "s"}:\n${report}`,
  );
}
