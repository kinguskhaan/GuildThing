import type { Client, Guild as DiscordGuild, GuildMember } from "discord.js";

import { db } from "@guildthing/db";

import {
  fetchRecentHumanRoleChanges,
  persistBotRoleChange,
  persistManualRoleChange,
  type HumanRoleChange,
} from "./auditLog.js";
import {
  applyChannelGrants,
  evaluateRules,
  getFlowGrantRoleIds,
  notifyAdmins,
  type MatchedCharacter,
} from "./roleLogic.js";

// How often the whole roster gets walked to add/remove rule-granted roles
// as characters level up, get promoted, etc. Roster data only changes when
// an admin re-imports it (manually today, later maybe an automated WTF-file
// reader) — it doesn't need to reflect instantly, once a day is plenty for
// now. Bump this down if that stops being true.
export const ROLE_SYNC_INTERVAL_MS = 24 * 60 * 60_000;

const GUILD_RULES_INCLUDE = {
  roleRules: {
    include: {
      conditions: { include: { answerOptions: true } },
      grantedRoles: true,
      grantedChannels: true,
    },
  },
  rolePriorities: true,
  protectedRoles: true,
  // Flow "grant" action roles (onboardingFlowEngine.ts) — see
  // managedRoleIdsFor below for why these count as "managed" too.
  onboardingSteps: { select: { grants: { select: { discordRoleId: true } } } },
} as const;

async function loadGuildsWithRules() {
  return db.guild.findMany({ include: GUILD_RULES_INCLUDE });
}

export type GuildWithRules = Awaited<
  ReturnType<typeof loadGuildsWithRules>
>[number];

// Single-guild counterpart of loadGuildsWithRules — for the /bossman
// commands, which only ever need to act on the one guild the interaction
// came from, not every guild the bot is in.
export async function loadGuildWithRules(
  discordGuildId: string,
): Promise<GuildWithRules | null> {
  return db.guild.findFirst({
    where: { discordGuildId },
    include: GUILD_RULES_INCLUDE,
  });
}

// grantedRoles (rule-based) plus every flow "grant" action's role
// (onboardingFlowEngine.ts), minus anything an admin's marked hands-off
// (GuildProtectedRole) — the exact set of roles this guild's rules/flow
// are allowed to add/remove. Shared by syncGuildRoles (applies it) and
// diffGuildRoles (reports it) below so "which roles are ours to manage"
// can never drift between the two.
export function managedRoleIdsFor(guildRow: GuildWithRules): Set<string> {
  const managedRoleIds = new Set(
    guildRow.roleRules.flatMap((r) =>
      r.grantedRoles.map((g) => g.discordRoleId),
    ),
  );
  for (const step of guildRow.onboardingSteps) {
    for (const grant of step.grants) {
      if (grant.discordRoleId) managedRoleIds.add(grant.discordRoleId);
    }
  }
  for (const p of guildRow.protectedRoles)
    managedRoleIds.delete(p.discordRoleId);
  return managedRoleIds;
}

// One query for the whole guild's persisted onboarding-flow answers,
// grouped by discordUserId then stepId -> selected option ids — same
// shape evaluateRules' `answers` param expects. Shared by
// desiredRolesByMember/syncGuildRoles so the daily sync only pays for
// this once per guild, not once per member (see evaluateRules' own doc
// comment on why this matters for any rule with field "answer").
async function loadAnswersByMember(
  guildId: string,
): Promise<Map<string, Map<string, string[]>>> {
  const rows = await db.guildOnboardingStepAnswer.findMany({
    where: { guildId },
    include: { selectedOptions: true },
  });
  const byMember = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    const perStep = byMember.get(row.discordUserId) ?? new Map<string, string[]>();
    perStep.set(row.stepId, row.selectedOptions.map((o) => o.optionId));
    byMember.set(row.discordUserId, perStep);
  }
  return byMember;
}

// Groups the guild's claimed roster by the Discord account it's claimed
// under and evaluates the rules for each — "what roles should this person
// have right now, per the roster alone" — with no knowledge yet of what
// roles they actually hold in Discord. Shared by syncGuildRoles (which
// applies the difference) and diffGuildRoles (which only reports it).
async function desiredRolesByMember(
  guildRow: GuildWithRules,
  answersByMember: Map<string, Map<string, string[]>>,
): Promise<Map<string, Set<string>>> {
  const rosterRows = await db.guildRosterMember.findMany({
    where: { guildId: guildRow.id, claimedByDiscordUserId: { not: null } },
  });

  const rowsByDiscordUser = new Map<string, typeof rosterRows>();
  for (const row of rosterRows) {
    const discordUserId = row.claimedByDiscordUserId;
    if (!discordUserId) continue;
    rowsByDiscordUser.set(discordUserId, [
      ...(rowsByDiscordUser.get(discordUserId) ?? []),
      row,
    ]);
  }

  const desired = new Map<string, Set<string>>();
  for (const [discordUserId, rows] of rowsByDiscordUser) {
    const matched: MatchedCharacter[] = rows.map((r) => ({
      rank: r.rank,
      level: r.level,
      class: r.class,
    }));
    const { roleIds } = evaluateRules(
      guildRow.roleRules,
      matched,
      guildRow.rolePriorities,
      answersByMember.get(discordUserId) ?? new Map<string, string[]>(),
    );
    desired.set(discordUserId, roleIds);
  }
  return desired;
}

// A single member's rule-managed roles not matching what the rules say
// they should have right now — toAdd/toRemove describe the roles that
// would close the gap, whether or not anything's actually been done about
// it (syncGuildRoles applies them; diffGuildRoles below just reports them).
export interface RoleMismatch {
  discordUserId: string;
  discordUserTag: string;
  toAdd: string[];
  toRemove: string[];
}

// Keeps GuildRoleMismatchCache fresh for the addon-facing
// /api/v1/role-mismatches endpoint. Written by refreshRoleMismatchCache's
// periodic sweep and by runFullRoleSync right after it applies a fix, so
// the addon's view of "who's out of sync" never has to wait longer than
// ROLE_MISMATCH_REFRESH_INTERVAL_MS for a change made outside the bot
// (e.g. an admin editing roles by hand in Discord) to show up.
async function cacheRoleMismatches(
  guildId: string,
  mismatches: RoleMismatch[],
): Promise<void> {
  await db.guildRoleMismatchCache.upsert({
    where: { guildId },
    create: { guildId, data: JSON.stringify(mismatches) },
    update: { data: JSON.stringify(mismatches), computedAt: new Date() },
  });
}

// How often the read-only mismatch sweep below runs. Independent of
// ROLE_SYNC_INTERVAL_MS (which actually fixes things once a day) — this is
// just for keeping the addon's display current in between, so it's fine
// for this to be much more frequent without costing a real sync.
export const ROLE_MISMATCH_REFRESH_INTERVAL_MS = 60 * 60_000;

// Read-only counterpart to runFullRoleSync — walks every guild's roster
// with diffGuildRoles (never applies anything) and caches the result, so
// an admin can see current drift from the addon without waiting for the
// next daily/on-demand sync to silently fix it.
export async function refreshRoleMismatchCache(
  client: Client<true>,
): Promise<void> {
  const guilds = await loadGuildsWithRules();
  for (const guildRow of guilds) {
    if (!guildRow.botEnabled) continue;
    if (guildRow.roleRules.length === 0) continue;

    const discordGuild = client.guilds.cache.get(guildRow.discordGuildId);
    if (!discordGuild) continue;

    const mismatches = await diffGuildRoles(discordGuild, guildRow);
    await cacheRoleMismatches(guildRow.id, mismatches);
  }
}

// Read-only counterpart to syncGuildRoles — same "what should they have"
// computation, but only ever reads Discord's current roles, never writes.
// For /bossman's role-diff command: an officer wants to see what's
// currently wrong without triggering an actual resync (and its DMs/audit
// log entries) just to look.
export async function diffGuildRoles(
  discordGuild: DiscordGuild,
  guildRow: GuildWithRules,
): Promise<RoleMismatch[]> {
  const managedRoleIds = managedRoleIdsFor(guildRow);
  if (managedRoleIds.size === 0) return [];

  const answersByMember = await loadAnswersByMember(guildRow.id);
  const desired = await desiredRolesByMember(guildRow, answersByMember);
  const flowGrantRoleIds = await getFlowGrantRoleIds(guildRow.id);
  const roleName = (id: string) => discordGuild.roles.cache.get(id)?.name ?? id;

  const mismatches: RoleMismatch[] = [];
  for (const [discordUserId, desiredRoleIds] of desired) {
    let member;
    try {
      member = await discordGuild.members.fetch(discordUserId);
    } catch {
      continue; // no longer in the server
    }

    // Flow "grant" action roles are one-time, never-re-evaluated
    // assignments — preserve any the member already holds so a rules-only
    // diff never reports them as "should be removed" (see
    // managedRoleIdsFor's own doc comment).
    for (const roleId of member.roles.cache.keys()) {
      if (flowGrantRoleIds.has(roleId)) desiredRoleIds.add(roleId);
    }

    const currentManaged = member.roles.cache.filter((r) =>
      managedRoleIds.has(r.id),
    );
    const toAdd = [...desiredRoleIds].filter((id) => !currentManaged.has(id));
    const toRemove = currentManaged.filter((r) => !desiredRoleIds.has(r.id));
    if (toAdd.length === 0 && toRemove.size === 0) continue;

    mismatches.push({
      discordUserId,
      discordUserTag: member.user.tag,
      toAdd: toAdd.map(roleName),
      toRemove: toRemove.map((r) => r.name),
    });
  }
  return mismatches;
}

// Walks every registered guild's claimed roster and brings each claimed
// Discord member's rule-granted roles in line with their current
// rank/level/class — adds roles for rules that now fire, removes roles for
// ones that no longer do. Only touches roles that appear as a grantedRole
// on at least one of the guild's rules ("managed roles"); anything an admin
// assigned by hand for an unrelated reason is left alone. The PUG role
// isn't roster-driven (no character is matched for a PUG) so it's out of
// scope here too.
export async function runFullRoleSync(client: Client<true>): Promise<void> {
  const guilds = await loadGuildsWithRules();

  for (const guildRow of guilds) {
    if (!guildRow.botEnabled) continue;
    if (guildRow.roleRules.length === 0) continue;

    const discordGuild = client.guilds.cache.get(guildRow.discordGuildId);
    if (!discordGuild) continue; // bot isn't (or is no longer) in this server

    await syncGuildRoles(discordGuild, guildRow);
    // Re-read the (now hopefully clean) state rather than assuming success —
    // a per-member role.add/remove failure above leaves a real mismatch
    // behind, and the addon's cache should reflect that instead of lying.
    const mismatches = await diffGuildRoles(discordGuild, guildRow);
    await cacheRoleMismatches(guildRow.id, mismatches);
  }
}

// Returns every member actually changed this pass (added/removed roles) —
// /bossman's sync-roster command reports this back to the officer who ran
// it instead of leaving them to go check the audit log for what happened.
export async function syncGuildRoles(
  discordGuild: DiscordGuild,
  guildRow: GuildWithRules,
): Promise<RoleMismatch[]> {
  const changes: RoleMismatch[] = [];
  const managedRoleIds = managedRoleIdsFor(guildRow);
  if (managedRoleIds.size === 0) return changes;

  const rosterRows = await db.guildRosterMember.findMany({
    where: { guildId: guildRow.id, claimedByDiscordUserId: { not: null } },
  });

  const rowsByDiscordUser = new Map<string, typeof rosterRows>();
  for (const row of rosterRows) {
    const discordUserId = row.claimedByDiscordUserId;
    if (!discordUserId) continue;
    rowsByDiscordUser.set(discordUserId, [
      ...(rowsByDiscordUser.get(discordUserId) ?? []),
      row,
    ]);
  }

  // One batched audit-log fetch for the whole guild, not one per member —
  // fetchRecentHumanRoleChanges is a REST call and this loop can run over
  // hundreds of members.
  const humanChanges = await fetchRecentHumanRoleChanges(discordGuild);
  const answersByMember = await loadAnswersByMember(guildRow.id);
  const flowGrantRoleIds = await getFlowGrantRoleIds(guildRow.id);

  for (const [discordUserId, rows] of rowsByDiscordUser) {
    const matched: MatchedCharacter[] = rows.map((r) => ({
      rank: r.rank,
      level: r.level,
      class: r.class,
    }));

    const { roleIds: desiredRoleIds, channelGrants } = evaluateRules(
      guildRow.roleRules,
      matched,
      guildRow.rolePriorities,
      answersByMember.get(discordUserId) ?? new Map<string, string[]>(),
    );

    let member;
    try {
      member = await discordGuild.members.fetch(discordUserId);
    } catch {
      continue; // no longer in the server — nothing to sync
    }

    // Flow "grant" action roles are one-time, never-re-evaluated
    // assignments — preserve any the member already holds so this
    // rules-only desired-set never gets treated as authoritative and
    // strips them right back off (see managedRoleIdsFor's own comment).
    for (const roleId of member.roles.cache.keys()) {
      if (flowGrantRoleIds.has(roleId)) desiredRoleIds.add(roleId);
    }

    // "Senaste ändringen vinner" — a human's manual role edit only blocks
    // this cycle's resync if it happened AFTER this person's last rank
    // change (across any of their claimed characters). An old manual tweak
    // that predates a subsequent promotion/demotion should still be
    // overridden by the rule that now fires off the new rank; a member
    // with no recorded rank change yet (rankChangedAt always null) has no
    // baseline to compare against, so any detected human change wins.
    // humanChangeList is newest-first (see fetchRecentHumanRoleChanges) —
    // only its first entry's timestamp matters for this comparison, but
    // every entry in it gets logged below so the audit log shows the full
    // history, not just whichever edit happened to be newest.
    const humanChangeList = humanChanges.get(discordUserId);
    const newestHumanChange = humanChangeList?.[0];
    if (humanChangeList && newestHumanChange) {
      const latestRankChangeAt = rows.reduce<Date | null>((latest, r) => {
        if (!r.rankChangedAt) return latest;
        return !latest || r.rankChangedAt > latest ? r.rankChangedAt : latest;
      }, null);
      const humanIsNewer =
        !latestRankChangeAt || newestHumanChange.changedAt > latestRankChangeAt;
      if (humanIsNewer) {
        await logManualRoleChangeAndSkip(
          discordGuild,
          guildRow,
          member,
          humanChangeList,
        );
        continue;
      }
    }

    const currentManaged = member.roles.cache.filter((r) =>
      managedRoleIds.has(r.id),
    );
    const toAdd = [...desiredRoleIds].filter((id) => !currentManaged.has(id));
    const toRemoveRoles = currentManaged.filter(
      (r) => !desiredRoleIds.has(r.id),
    );
    const toRemove = toRemoveRoles.map((r) => r.id);

    if (toAdd.length > 0 || toRemove.length > 0) {
      try {
        if (toAdd.length > 0) await member.roles.add(toAdd);
        if (toRemove.length > 0) await member.roles.remove(toRemove);
        const roleName = (id: string) =>
          discordGuild.roles.cache.get(id)?.name ?? id;
        const addedNames = toAdd.map(roleName);
        const removedNames = toRemoveRoles.map((r) => r.name);
        console.log(
          `[bot] role sync for ${member.user.tag} in ${discordGuild.name}: +[${addedNames.join(", ") || "none"}] -[${removedNames.join(", ") || "none"}]`,
        );
        await persistBotRoleChange(guildRow.id, discordGuild, member, {
          addedRoleIds: toAdd,
          removedRoleIds: toRemove,
        });
        changes.push({
          discordUserId,
          discordUserTag: member.user.tag,
          toAdd: addedNames,
          toRemove: removedNames,
        });
      } catch (err) {
        console.error(
          `[bot] role resync failed for ${member.user.tag} in ${discordGuild.name}:`,
          err,
        );
        // Nobody's actively waiting on this (it's a background run), but an
        // officer still needs to know their permissions/role setup broke.
        await notifyAdmins(
          member,
          guildRow.id,
          `⚠️ Daily role resync failed for ${member.user.tag} in ${discordGuild.name} — most likely my role isn't positioned above the role(s) involved.`,
        );
      }
    }

    // Background resync shouldn't DM someone just because a channel-grant
    // update failed (no direct action of theirs triggered this run) —
    // admins still get notified via applyChannelGrants' own notifyAdmins
    // call regardless of this flag.
    await applyChannelGrants(member, guildRow.id, channelGrants, {
      notifyOnFailure: false,
    });
  }
  return changes;
}

// Persists a GuildRoleChangeEvent row for EVERY entry in `changes` (role
// names resolved from the guild's live role cache) and posts one admin
// notice, instead of applying this cycle's role diff for the member — see
// the "senaste ändringen vinner" comment at its call site above. Logging
// every entry (not just the newest) is what makes the audit log a real
// history instead of a "current state" summary — persistManualRoleChange's
// own dedup (by exact detectedAt) keeps re-running this on a later cycle
// from creating repeats.
async function logManualRoleChangeAndSkip(
  discordGuild: DiscordGuild,
  guildRow: GuildWithRules,
  member: GuildMember,
  changes: HumanRoleChange[],
): Promise<void> {
  const [newest] = changes;
  if (!newest) return;
  let anyNew = false;
  for (const change of changes) {
    const created = await persistManualRoleChange(guildRow.id, discordGuild, member, change);
    if (created) anyNew = true;
  }
  if (!anyNew) return; // already logged and notified on an earlier cycle
  console.log(
    `[bot] skipping role resync for ${member.user.tag} in ${discordGuild.name} — manual change by ${newest.executorTag ?? newest.executorId} at ${newest.changedAt.toISOString()} is newer than their last rank change`,
  );
  await notifyAdmins(
    member,
    guildRow.id,
    `ℹ️ Skipped automatic role resync for ${member.user.tag} — ${newest.executorTag ?? "someone"} manually changed their Discord roles more recently than their last rank change. Logged on the site under Admin → Discord roles.`,
  );
}
