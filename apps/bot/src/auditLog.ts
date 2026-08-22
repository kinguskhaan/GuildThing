import { AuditLogEvent, type Guild as DiscordGuild } from "discord.js";

import { db } from "@guildthing/db";

// How far back to look on each sync run for a MemberRoleUpdate entry — one
// day comfortably covers the daily cron's own cadence (ROLE_SYNC_INTERVAL_MS
// in roleSync.ts) plus slack for a bot restart delaying a run. A day of
// overlap on every run costs nothing but re-reading the same entries, which
// is cheap (one REST call per guild per run in the common case).
const AUDIT_LOG_LOOKBACK_MS = 24 * 60 * 60_000;
const AUDIT_LOG_PAGE_SIZE = 100; // Discord's per-request cap

export interface HumanRoleChange {
  executorId: string | null;
  executorTag: string | null;
  addedRoleIds: string[];
  removedRoleIds: string[];
  changedAt: Date;
}

// Fetches recent MemberRoleUpdate audit-log entries for the whole guild in
// one batched call (paginated via `before` if more than one page falls
// inside the lookback window), filters out anything the bot itself did
// (executorId === client.user.id) or that came through an integration
// (entry.extra.integrationType set — not a direct human edit), and returns
// EVERY matching entry per target member, newest-first — not merged or
// deduped. An audit log's whole point is to show what actually happened,
// so a target with two separate edits in the window (e.g. two saves a few
// minutes apart) gets two distinct entries here, not one that silently
// drops whichever roles the earlier edit touched. Callers that only care
// about "was there ANY recent human edit, and how recent" (the "senaste
// ändringen vinner" comparison against rankChangedAt) can just look at
// index 0 of a target's array, since it's the newest.
//
// Never throws on a missing "View Audit Log" permission (or any other
// fetch failure) — logs once and returns an empty map, so a guild that
// hasn't granted it yet just gets the pre-audit-log behavior (no manual-
// change protection) instead of a broken sync.
export async function fetchRecentHumanRoleChanges(
  discordGuild: DiscordGuild,
): Promise<Map<string, HumanRoleChange[]>> {
  const result = new Map<string, HumanRoleChange[]>();
  const cutoff = Date.now() - AUDIT_LOG_LOOKBACK_MS;
  let before: string | undefined;

  for (;;) {
    let page;
    try {
      page = await discordGuild.fetchAuditLogs({
        type: AuditLogEvent.MemberRoleUpdate,
        limit: AUDIT_LOG_PAGE_SIZE,
        before,
      });
    } catch (err) {
      console.error(
        `[bot] couldn't read audit log for ${discordGuild.name} — most likely missing the "View Audit Log" permission:`,
        err,
      );
      return result;
    }
    if (page.entries.size === 0) break;

    let hitCutoff = false;
    for (const entry of page.entries.values()) {
      if (entry.createdTimestamp < cutoff) {
        hitCutoff = true;
        continue;
      }
      if (entry.executorId === discordGuild.client.user.id) continue; // the bot's own change
      if (entry.extra?.integrationType) continue; // not a direct human edit

      const targetId = entry.targetId;
      if (!targetId) continue;

      const added: string[] = [];
      const removed: string[] = [];
      for (const change of entry.changes) {
        if (change.key === "$add") {
          added.push(...(change.new ?? []).map((r) => r.id));
        } else if (change.key === "$remove") {
          removed.push(...(change.new ?? []).map((r) => r.id));
        }
      }
      if (added.length === 0 && removed.length === 0) continue;

      const list = result.get(targetId) ?? [];
      result.set(targetId, list);
      list.push({
        executorId: entry.executorId,
        executorTag: entry.executor?.tag ?? null,
        addedRoleIds: added,
        removedRoleIds: removed,
        changedAt: entry.createdAt,
      });
    }

    const oldestId = [...page.entries.keys()].at(-1);
    if (hitCutoff || !oldestId || page.entries.size < AUDIT_LOG_PAGE_SIZE) break;
    before = oldestId;
  }

  return result;
}

// Persists a GuildRoleChangeEvent row for a human's manual edit (source =
// "manual") — shared by roleSync.ts (the daily cron, skips its whole
// per-member diff on a newer manual change) and roleLogic.ts's
// applyManagedRoles (onboarding/re-claim path, skips just re-ADDING a role
// a human more recently removed by hand). Role names are resolved from the
// guild's live role cache at write time.
//
// Deduplicated on (guildId, discordUserId, "manual", detectedAt): as long
// as the SAME still-unresolved human edit keeps winning the newest-wins
// comparison, every resync cycle would otherwise re-detect and re-log the
// identical audit-log entry again — same executor, same roles, same
// timestamp — until a later rank change finally supersedes it. Skipping a
// repeat of an already-logged (userId, timestamp) pair keeps the log to
// one row per distinct human edit rather than one per resync cycle it
// happened to still be blocking.
export async function persistManualRoleChange(
  guildId: string,
  discordGuild: DiscordGuild,
  member: { id: string; user: { tag: string } },
  change: HumanRoleChange,
): Promise<void> {
  const already = await db.guildRoleChangeEvent.findFirst({
    where: {
      guildId,
      discordUserId: member.id,
      source: "manual",
      detectedAt: change.changedAt,
    },
    select: { id: true },
  });
  if (already) return;

  const roleName = (id: string) => discordGuild.roles.cache.get(id)?.name ?? id;
  await db.guildRoleChangeEvent.create({
    data: {
      guildId,
      discordUserId: member.id,
      discordUserTag: member.user.tag,
      source: "manual",
      executorId: change.executorId,
      executorTag: change.executorTag,
      addedRoleIds: JSON.stringify(change.addedRoleIds),
      addedRoleNames: JSON.stringify(change.addedRoleIds.map(roleName)),
      removedRoleIds: JSON.stringify(change.removedRoleIds),
      removedRoleNames: JSON.stringify(change.removedRoleIds.map(roleName)),
      detectedAt: change.changedAt,
    },
  });
}

// Persists a GuildRoleChangeEvent row for the bot's own successful
// resync-applied diff (source = "bot", no executor). Only ever called from
// a spot that already confirmed toAdd/toRemove is non-empty, so every call
// here represents a real, distinct change — no dedup needed the way the
// manual path requires it.
export async function persistBotRoleChange(
  guildId: string,
  discordGuild: DiscordGuild,
  member: { id: string; user: { tag: string } },
  change: { addedRoleIds: string[]; removedRoleIds: string[] },
): Promise<void> {
  const roleName = (id: string) => discordGuild.roles.cache.get(id)?.name ?? id;
  await db.guildRoleChangeEvent.create({
    data: {
      guildId,
      discordUserId: member.id,
      discordUserTag: member.user.tag,
      source: "bot",
      addedRoleIds: JSON.stringify(change.addedRoleIds),
      addedRoleNames: JSON.stringify(change.addedRoleIds.map(roleName)),
      removedRoleIds: JSON.stringify(change.removedRoleIds),
      removedRoleNames: JSON.stringify(change.removedRoleIds.map(roleName)),
      detectedAt: new Date(),
    },
  });
}
