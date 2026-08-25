import {
  ChannelType,
  type GuildMember,
  type PermissionOverwriteOptions,
} from "discord.js";

import { db } from "@guildthing/db";

import {
  fetchRecentHumanRoleChanges,
  persistBotRoleChange,
  persistManualRoleChange,
} from "./auditLog.js";
import { lookupCharacter } from "./battlenetApi.js";

export const MAX_NICKNAME_LENGTH = 32;

export interface MatchedCharacter {
  rank: string;
  level: number;
  class: string | null;
}

export interface RoleCondition {
  field: string;
  textValue: string | null;
  minNumber: number | null;
  maxNumber: number | null;
}

export interface ChannelGrant {
  channelId: string;
  type: "text" | "voice";
}

interface RuleWithGrants {
  conditions: RoleCondition[];
  grantedRoles: { discordRoleId: string }[];
  grantedChannels: { discordChannelId: string; channelType: string }[];
}

export interface RolePriorityEntry {
  discordRoleId: string;
  priority: number;
}

// Shared by matchRosterAndApply (onboarding) and roleSync.ts (the daily
// background resync) so both decide "what should this person have right
// now" via the exact same rule-firing logic.
export function evaluateRules(
  rules: RuleWithGrants[],
  matched: MatchedCharacter[],
  priorityRoles: RolePriorityEntry[] = [],
): { roleIds: Set<string>; channelGrants: ChannelGrant[] } {
  const roleIds = new Set<string>();
  const channelGrants: ChannelGrant[] = [];
  for (const rule of rules) {
    const fires = rule.conditions.every((condition) =>
      matched.some((character) => conditionMatches(character, condition)),
    );
    if (!fires) continue;
    for (const granted of rule.grantedRoles) roleIds.add(granted.discordRoleId);
    for (const granted of rule.grantedChannels) {
      channelGrants.push({
        channelId: granted.discordChannelId,
        type: granted.channelType === "voice" ? "voice" : "text",
      });
    }
  }

  // Collapse mutually-exclusive tiers down to just the highest-priority
  // role actually granted (see GuildRolePriority in schema.prisma) — keep
  // only the lowest `priority` number among the ones present, drop the
  // rest from what gets granted.
  const grantedPriority = priorityRoles
    .filter((p) => roleIds.has(p.discordRoleId))
    .sort((a, b) => a.priority - b.priority);
  for (const { discordRoleId } of grantedPriority.slice(1)) {
    roleIds.delete(discordRoleId);
  }

  return { roleIds, channelGrants };
}

// Posts to the guild's admin notify channel (if configured) — used for
// anything only an admin can actually fix (permission/hierarchy issues,
// roster claim conflicts), so it reaches them directly instead of relying
// on the affected member to notice a DM and relay it themselves. Returns
// whether it actually got posted, so callers can adjust what they tell the
// member (no point saying "an officer's been notified" if nothing is
// configured to notify them with).
export async function notifyAdmins(
  member: GuildMember,
  guildId: string,
  message: string,
): Promise<boolean> {
  const guild = await db.guild.findUnique({
    where: { id: guildId },
    select: { adminNotifyChannelId: true },
  });
  if (!guild?.adminNotifyChannelId) return false;

  try {
    const channel = await member.guild.channels.fetch(
      guild.adminNotifyChannelId,
    );
    if (!channel?.isTextBased()) return false;
    await channel.send(message);
    return true;
  } catch (err) {
    console.error(
      `[bot] failed to post admin notice for guild ${guildId}:`,
      err,
    );
    return false;
  }
}

// Cuts at the last "/" boundary that still fits under Discord's 32-char
// nickname cap, rather than chopping a name in half.
function truncateNickname(fullName: string): string {
  if (fullName.length <= MAX_NICKNAME_LENGTH) return fullName;
  const cut = fullName.slice(0, MAX_NICKNAME_LENGTH);
  const lastBoundary = cut.lastIndexOf("/");
  return lastBoundary > 0 ? cut.slice(0, lastBoundary) : cut;
}

// field/operator meanings match GuildRoleRuleCondition (schema.prisma):
// rank/class use "equals" against textValue, level uses "between" against
// minNumber/maxNumber. operator itself isn't checked here since field alone
// determines how a condition is evaluated.
export function conditionMatches(
  character: MatchedCharacter,
  condition: RoleCondition,
): boolean {
  if (condition.field === "rank") {
    return character.rank.toLowerCase() === condition.textValue?.toLowerCase();
  }
  if (condition.field === "class") {
    return (
      condition.textValue != null &&
      character.class?.toLowerCase() === condition.textValue.toLowerCase()
    );
  }
  if (condition.field === "level") {
    return (
      condition.minNumber != null &&
      condition.maxNumber != null &&
      character.level >= condition.minNumber &&
      character.level <= condition.maxNumber
    );
  }
  return false;
}

// The full set of roles the bot itself might ever hand out for this guild —
// the PUG role plus every rule's granted roles, minus any GuildProtectedRole
// (a role an admin has marked hands-off, e.g. one meant to stay entirely
// human-assigned even though it's also wired to a rule). Used to scope
// which of a member's current roles are "ours" to add/remove; anything an
// admin gave them manually for an unrelated reason is never touched, and a
// protected role is never touched even when a rule does grant it.
async function getManagedRoleIds(guildId: string): Promise<Set<string>> {
  const [guild, rules, protectedRoles] = await Promise.all([
    db.guild.findUnique({
      where: { id: guildId },
      select: { pugRoleId: true },
    }),
    db.guildRoleRule.findMany({
      where: { guildId },
      select: { grantedRoles: { select: { discordRoleId: true } } },
    }),
    db.guildProtectedRole.findMany({
      where: { guildId },
      select: { discordRoleId: true },
    }),
  ]);

  const ids = new Set<string>();
  if (guild?.pugRoleId) ids.add(guild.pugRoleId);
  for (const rule of rules) {
    for (const granted of rule.grantedRoles) ids.add(granted.discordRoleId);
  }
  for (const p of protectedRoles) ids.delete(p.discordRoleId);
  return ids;
}

// The full set of channels the bot itself might ever grant direct access to
// for this guild — every rule's grantedChannels. Mirrors getManagedRoleIds
// but keyed by channel id -> its type (text/voice), since that determines
// which permission bits get granted.
async function getManagedChannelGrants(
  guildId: string,
): Promise<Map<string, "text" | "voice">> {
  const rules = await db.guildRoleRule.findMany({
    where: { guildId },
    select: {
      grantedChannels: {
        select: { discordChannelId: true, channelType: true },
      },
    },
  });

  const grants = new Map<string, "text" | "voice">();
  for (const rule of rules) {
    for (const granted of rule.grantedChannels) {
      grants.set(
        granted.discordChannelId,
        granted.channelType === "voice" ? "voice" : "text",
      );
    }
  }
  return grants;
}

function channelGrantPermissions(
  type: "text" | "voice",
  value: true | null,
): PermissionOverwriteOptions {
  return type === "voice"
    ? { ViewChannel: value, Connect: value }
    : { ViewChannel: value };
}

// Default notify implementation — DMs the member directly, swallowing any
// failure (DMs disabled, etc.). Used whenever a caller doesn't supply its
// own notify (i.e. every background job — roleSync.ts, pendingMatches.ts —
// which have no live interaction to reply through instead). Prefixed with
// the server name since a plain DM gives no other clue which of a person's
// (possibly several) GuildThing servers it's about.
function dmNotifier(member: GuildMember): (message: string) => Promise<void> {
  return async (message: string) => {
    await member.send(`**${member.guild.name}** — ${message}`).catch(() => {
      // Best-effort — if DMs are closed, there's nothing more to do here.
    });
  };
}

// Channels currently known to be broken (bot lacks "Manage Channels" there,
// or a role hierarchy issue) — keyed by "guildId:channelId", not by member,
// since the failure is per-channel: EVERY member's grant on that channel
// fails the same way. Without this, one broken channel notifies once per
// member who has a grant on it, every single sync run, forever — see the
// incident that motivated this (dozens of "Couldn't update channel access"
// messages in one run, across level-bracket dungeon channels sharing the
// same missing permission). Lives only for this process's uptime — a bot
// restart re-arms every channel, which is fine, worst case one redundant
// notification. Cleared the moment an edit on that channel succeeds again,
// so a real permission fix is reflected without needing a restart.
const notifiedBrokenChannels = new Set<string>();

// Adds/removes a per-member permission overwrite (not a role) on every
// "managed" channel (one that's a grantedChannel on at least one of the
// guild's rules) — ViewChannel for text, ViewChannel+Connect for voice.
// Only ever touches the specific bits it grants (via null, not false, when
// revoking), so it never clobbers an unrelated overwrite an admin set by
// hand on the same channel for the same member.
export async function applyChannelGrants(
  member: GuildMember,
  guildId: string,
  desiredGrants: ChannelGrant[],
  options: {
    notifyOnFailure?: boolean;
    notify?: (message: string) => Promise<void>;
  } = {},
): Promise<void> {
  const notify = options.notify ?? dmNotifier(member);
  const managed = await getManagedChannelGrants(guildId);
  if (managed.size === 0) return;
  const desired = new Set(desiredGrants.map((g) => g.channelId));

  for (const [channelId, type] of managed) {
    const channel =
      member.guild.channels.cache.get(channelId) ??
      (await member.guild.channels.fetch(channelId).catch(() => null));
    if (!channel) continue;
    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildVoice
    ) {
      continue;
    }

    const brokenKey = `${guildId}:${channelId}`;
    try {
      await channel.permissionOverwrites.edit(
        member,
        channelGrantPermissions(type, desired.has(channelId) ? true : null),
      );
      notifiedBrokenChannels.delete(brokenKey);
    } catch (err) {
      console.error(
        `[bot] failed to update channel grant for ${member.user.tag} on #${channel.name}:`,
        err,
      );
      const alreadyNotified = notifiedBrokenChannels.has(brokenKey);
      notifiedBrokenChannels.add(brokenKey);

      if (!alreadyNotified) {
        const notified = await notifyAdmins(
          member,
          guildId,
          `⚠️ Couldn't update channel access for ${member.user.tag} on #${channel.name} — most likely missing "Manage Channels" permission there, or a role hierarchy issue. Check the bot's permissions on that channel. (Further failures on this channel won't repeat this notice until it starts working again.)`,
        );
        if (options.notifyOnFailure ?? true) {
          await notify(
            notified
              ? `Heads up — I couldn't update your access to #${channel.name} due to a permissions issue on my end. An officer has been notified.`
              : `Heads up — I couldn't update your access to #${channel.name}, most likely because I'm missing "Manage Channels" permission there, or my role isn't positioned above the relevant roles. Ask an officer to check.`,
          );
        }
      }
    }
  }
}

// Adds/removes "managed" roles (any role that's a grantedRole on some rule,
// or the guild's PUG role — see getManagedRoleIds) to match desiredRoleIds
// exactly, leaving anything an admin assigned by hand for an unrelated
// reason untouched. Extracted out of applyNicknameAndRoles below (which
// still calls this) so a caller that wants to touch ONLY roles — e.g. a
// full account reset with desiredRoleIds: [] — doesn't have to go through
// nickname-setting to get there.
// Guards against exactly the scenario that motivated this: an officer
// manually demotes someone in Discord (removing a rule-granted role) while
// their in-game rank stays put, and the person then runs "Reset everything"
// + re-claims their character hoping the bot hands the role straight back.
// Only gates ADDING roles back, never removing — a "Reset everything" call
// (desiredRoleIds always []) still fully resets regardless, since there's
// nothing to add there in the first place; this only ever blocks handing a
// role BACK to someone a human more recently took it from.
export async function applyManagedRoles(
  member: GuildMember,
  guildId: string,
  desiredRoleIds: string[],
  options: {
    notify?: (message: string) => Promise<void>;
    // Latest rank-change timestamp across this person's matched characters
    // (null if none on record), only supplied by matchRosterAndApply.
    // Omitted (undefined) by the direct "Reset everything" caller in
    // onboarding.ts, which has no per-character rank data to hand — fine,
    // since its desiredRoleIds is always [] and the gate below only ever
    // matters when there's something to add.
    rankChangedAt?: Date | null;
  } = {},
): Promise<void> {
  const notify = options.notify ?? dmNotifier(member);
  const managedRoleIds = await getManagedRoleIds(guildId);
  const desired = new Set(desiredRoleIds);
  const currentManaged = member.roles.cache.filter((r) =>
    managedRoleIds.has(r.id),
  );
  let toAdd = desiredRoleIds.filter((id) => !currentManaged.has(id));
  const toRemoveRoles = currentManaged.filter((r) => !desired.has(r.id));
  const toRemove = toRemoveRoles.map((r) => r.id);

  if (toAdd.length > 0 && options.rankChangedAt !== undefined) {
    const humanChanges = await fetchRecentHumanRoleChanges(member.guild);
    const humanChangeList = humanChanges.get(member.id);
    const rankChangedAt = options.rankChangedAt;
    const newestHumanChange = humanChangeList?.[0];
    if (
      newestHumanChange &&
      (!rankChangedAt || newestHumanChange.changedAt > rankChangedAt)
    ) {
      // Log every entry, not just the newest — see logManualRoleChangeAndSkip
      // in roleSync.ts for why (an audit log should show what happened, not
      // just the latest edit).
      for (const change of humanChangeList) {
        await persistManualRoleChange(guildId, member.guild, member, change);
      }
      console.log(
        `[bot] skipping role grant for ${member.user.tag} in ${member.guild.name} — manual change by ${newestHumanChange.executorTag ?? newestHumanChange.executorId} at ${newestHumanChange.changedAt.toISOString()} is newer than their last rank change`,
      );
      await notifyAdmins(
        member,
        guildId,
        `ℹ️ Held back re-granting a role to ${member.user.tag} — ${newestHumanChange.executorTag ?? "someone"} manually changed their Discord roles more recently than their last rank change. Logged on the site under Admin → Discord roles.`,
      );
      toAdd = [];
    }
  }

  if (toAdd.length === 0 && toRemove.length === 0) return;

  try {
    if (toAdd.length > 0) await member.roles.add(toAdd);
    if (toRemove.length > 0) await member.roles.remove(toRemove);
    const roleName = (id: string) =>
      member.guild.roles.cache.get(id)?.name ?? id;
    const added = toAdd.map(roleName).join(", ") || "none";
    const removed = toRemoveRoles.map((r) => r.name).join(", ") || "none";
    console.log(
      `[bot] role update for ${member.user.tag} in ${member.guild.name}: +[${added}] -[${removed}]`,
    );
    await persistBotRoleChange(guildId, member.guild, member, {
      addedRoleIds: toAdd,
      removedRoleIds: toRemove,
    });
  } catch (err) {
    console.error(`[bot] failed to update roles for ${member.user.tag}:`, err);
    // Most likely cause: the bot's own role sits below the role(s) it's
    // trying to grant/remove in the server's role list — Discord blocks
    // that regardless of permissions.
    const notified = await notifyAdmins(
      member,
      guildId,
      `⚠️ Couldn't update roles for ${member.user.tag} — most likely my role isn't positioned above the role(s) involved. Check Server Settings → Roles.`,
    );
    await notify(
      notified
        ? "Heads up — I couldn't update your role(s) due to a permissions issue on my end. An officer has been notified."
        : "Heads up — I couldn't update your role(s), most likely because my own role isn't positioned above them in this server's role list. Ask an officer to check Server Settings → Roles.",
    );
  }
}

interface ApplyNicknameAndRolesOptions {
  // Only supplied by the live onboarding conversation (see
  // askNicknameSelectionInteractive in onboarding.ts) — lets the person
  // pick which alts to drop when the full list won't fit Discord's 32-char
  // nickname cap, instead of silently cutting at a "/" boundary. Background
  // callers (roleSync.ts, pendingMatches.ts) have no conversation to ask
  // in, so they omit this and get the old auto-truncate behavior.
  chooseNicknameNames?: (names: string[]) => Promise<string[]>;
  // How to reach the member with a status/failure message. Defaults to a
  // best-effort DM (see dmNotifier) — the live onboarding conversation
  // instead supplies a notifier that replies/follows-up on the ongoing
  // interaction, since DMs are exactly the unreliable thing this is meant
  // to avoid depending on.
  notify?: (message: string) => Promise<void>;
  // Passed straight through to applyManagedRoles — see its own doc
  // comment. Only matchRosterAndApply supplies this (it's the one place
  // that actually has matched roster rows to read rankChangedAt off of).
  rankChangedAt?: Date | null;
}

export async function applyNicknameAndRoles(
  member: GuildMember,
  guildId: string,
  names: string[],
  desiredRoleIds: string[],
  desiredChannelGrants: ChannelGrant[],
  options: ApplyNicknameAndRolesOptions = {},
): Promise<void> {
  const notify = options.notify ?? dmNotifier(member);

  const fullName = names.join("/");
  let nicknameNames = names;
  if (fullName.length > MAX_NICKNAME_LENGTH && options.chooseNicknameNames) {
    nicknameNames = await options.chooseNicknameNames(names);
  }
  const chosenFullName = nicknameNames.join("/");
  const nickname = truncateNickname(chosenFullName);
  try {
    await member.setNickname(nickname);
    if (nickname !== chosenFullName) {
      // Either no chooseNicknameNames was supplied (background job), or
      // their chosen selection still didn't fit — either way, say so
      // rather than silently dropping names off the end.
      await notify(
        `Heads up — your name list (\`${chosenFullName}\`) didn't fit Discord's 32-character nickname limit, so I set it to \`${nickname}\`. Ask an officer if you'd like a different combination shown instead.`,
      );
    }
  } catch (err) {
    console.error(`[bot] failed to set nickname for ${member.user.tag}:`, err);

    // member.guild.ownerId tells us for certain whether this is the
    // unfixable "nobody can rename the owner" case or an actual permission/
    // hierarchy problem — no need to guess or hedge in the message either
    // way.
    if (member.id === member.guild.ownerId) {
      await notify(
        "Heads up — I couldn't set your nickname for you. This is a built-in Discord platform limitation, not a bug: no bot is ever allowed to rename the server owner, regardless of its permissions or role position. You'll need to set your own nickname manually if you want one. Your roles were still processed normally.",
      );
    } else {
      const notified = await notifyAdmins(
        member,
        guildId,
        `⚠️ Couldn't set nickname for ${member.user.tag} — most likely my role isn't positioned above theirs.`,
      );
      await notify(
        notified
          ? "Heads up — I couldn't set your nickname due to a permissions issue on my end. An officer has been notified."
          : "Heads up — I couldn't set your nickname, most likely because my role isn't positioned above yours. Ask an officer to check Server Settings → Roles. Your roles were still processed normally.",
      );
    }
  }

  // Re-running onboarding (e.g. someone who first said PUG, then re-ran it
  // and matched as a real guild member) should leave them with exactly the
  // roles that apply now — not the old ones on top. So this adds what's
  // missing AND removes any previously-granted "managed" role that no
  // longer belongs, rather than only ever adding.
  await applyManagedRoles(member, guildId, desiredRoleIds, {
    notify,
    rankChangedAt: options.rankChangedAt,
  });

  await applyChannelGrants(member, guildId, desiredChannelGrants, { notify });

  await notify(
    "You're done! If you ever want to redo this, run `/onboarding`.",
  );
}

interface MatchAndApplyOptions {
  // Onboarding always sets a nickname immediately, even for names that
  // don't match anything yet (see matchRosterAndApply below). A pending-
  // match retry that still finds nothing shouldn't repeat that — nothing
  // changed, so there's nothing new to apply or announce. Defaults to true
  // (the onboarding behavior).
  applyEvenIfNoMatch?: boolean;
  // Passed straight through to applyNicknameAndRoles — see its own doc
  // comments. Only the live onboarding conversation supplies either.
  chooseNicknameNames?: (names: string[]) => Promise<string[]>;
  notify?: (message: string) => Promise<void>;
}

export interface NamedCharacter {
  name: string;
  // Only meaningful (and only ever asked) when guild.rosterSource is
  // "onboarding" — addon-sourced guilds get class from the roster row
  // itself once matched, never from what the person types.
  class: string | null;
}

// Matches `characters` against the guild's roster, claims newly-matched
// characters for `member` (or flags a conflict if someone else already has),
// evaluates role rules against whatever matched, and applies the resulting
// nickname/roles. Shared by the onboarding flow and the daily
// pending-roster-match retry (see pendingMatches.ts) so both apply the
// exact same matching/claiming/rule logic.
export async function matchRosterAndApply(
  member: GuildMember,
  guild: {
    id: string;
    rosterSource: string;
    wowRegion?: string | null;
    wowRealmSlug?: string | null;
    wowGuildName?: string | null;
    wowNamespaceFlavor?: string | null;
  },
  characters: NamedCharacter[],
  includeAltsInNickname: boolean,
  options: MatchAndApplyOptions = {},
): Promise<{
  matchedCount: number;
  conflictCount: number;
  unmatchedCount: number;
  // Subset of unmatchedCount that Battle.net confirmed really are members
  // of this guild — matchRosterAndApply already sent its own confident
  // member-facing notice for these, so callers should only add their own
  // "probably not imported yet" message for (unmatchedCount - confirmedCount).
  confirmedCount: number;
  invalidCount: number;
  externalCount: number;
}> {
  const rosterRows = await db.guildRosterMember.findMany({
    where: { guildId: guild.id },
  });
  const rosterByName = new Map(
    rosterRows.map((r) => [r.name.toLowerCase(), r]),
  );
  const notify = options.notify ?? dmNotifier(member);

  // Armory lookup is only worth attempting if the guild has fully
  // configured it (see Guild.wowRegion etc.) and it's an addon-sourced
  // guild in the first place — an "onboarding" guild builds its roster
  // from claims directly, so there's no "wrong guild" concept to check.
  const armoryConfig =
    guild.rosterSource === "addon" &&
    guild.wowRegion &&
    guild.wowRealmSlug &&
    guild.wowGuildName &&
    guild.wowNamespaceFlavor
      ? {
          region: guild.wowRegion,
          realmSlug: guild.wowRealmSlug,
          guildName: guild.wowGuildName,
          flavor: guild.wowNamespaceFlavor,
        }
      : null;

  // Prevents different Discord accounts from all claiming the same roster
  // character (e.g. several people all saying they're "Bubblekingen"): the
  // first Discord account to name a character claims it; a later claim by
  // a different account still shows that name in the nickname (cosmetic —
  // see displayNames below) but is excluded from `matched`, so no rule can
  // fire off an impersonated character. Each conflict is logged and, if
  // configured, posted to the guild's admin notify channel.
  const matched: MatchedCharacter[] = [];
  // Latest rankChangedAt across every matched roster row — the "when did
  // their rank last change" side of applyManagedRoles' newest-wins check.
  // Null means no rank change is on record for any of them (a human's
  // manual edit always wins the comparison in that case).
  let latestRankChangedAt: Date | null = null;
  // Names of the matched entries above, same order — kept separately since
  // MatchedCharacter itself has no name (roleLogic only needs rank/level/
  // class to evaluate rules). Used to give admin notices about a person's
  // OTHER (unmatched/external) characters some context: who they actually
  // are in the guild, not just the name that triggered the notice.
  const matchedNames: string[] = [];
  const displayNames: string[] = [];
  const conflictNames: string[] = [];
  const unmatchedNames: string[] = [];
  // Subset of unmatchedNames that Battle.net confirmed really are in this
  // guild (just not in the locally-imported roster yet) — vs. the rest,
  // where we genuinely don't know (no armory config, or the API call
  // failed). Both still go through the same retry queue; only the message
  // differs (confident vs. "probably").
  const confirmedNames: string[] = [];
  const invalidNames: string[] = [];
  // Names that turned out to be in the local roster this run — used to
  // purge any now-stale GuildExternalCharacter row for the same name (see
  // after the loop below).
  const graduatedNames: string[] = [];
  const externalCharacters: {
    name: string;
    level: number;
    class: string | null;
    actualGuildName: string | null;
  }[] = [];
  for (const character of characters) {
    const { name } = character;
    const row = rosterByName.get(name.toLowerCase());

    if (!row) {
      // No pre-existing roster to wait on — a play group with no in-game
      // guild builds its roster from onboarding claims directly, so an
      // unmatched name means "new character", not "not imported yet".
      if (guild.rosterSource === "onboarding") {
        try {
          const created = await db.guildRosterMember.create({
            data: {
              guildId: guild.id,
              name,
              rank: "Member",
              level: 1,
              class: character.class,
              claimedByDiscordUserId: member.id,
              claimedByDiscordTag: member.user.tag,
              claimedAt: new Date(),
            },
          });
          displayNames.push(created.name);
          matchedNames.push(created.name);
          matched.push({
            rank: created.rank,
            level: created.level,
            class: created.class,
          });
        } catch (err) {
          // Unique [guildId, name] violation — someone else claimed this
          // exact name in the tiny window between our lookup and create.
          console.error(
            `[bot] failed to create roster row for "${name}":`,
            err,
          );
          const existing = await db.guildRosterMember.findUnique({
            where: { guildId_name: { guildId: guild.id, name } },
          });
          displayNames.push(existing?.name ?? name);
          if (existing) {
            conflictNames.push(existing.name);
            await db.guildRosterClaimConflict.create({
              data: {
                guildId: guild.id,
                rosterMemberId: existing.id,
                attemptedByDiscordId: member.id,
                attemptedByDiscordTag: member.user.tag,
              },
            });
          }
        }
        continue;
      }

      displayNames.push(name);

      if (armoryConfig) {
        const lookup = await lookupCharacter(
          armoryConfig.region,
          armoryConfig.realmSlug,
          name,
          armoryConfig.flavor,
          armoryConfig.guildName,
        );
        if (lookup.status === "not_found") {
          invalidNames.push(name);
          continue;
        }
        if (lookup.status === "wrong_guild" || lookup.status === "unguilded") {
          externalCharacters.push({
            name,
            level: lookup.level,
            class: lookup.class,
            actualGuildName: lookup.actualGuildName,
          });
          continue;
        }
        if (lookup.status === "matches_expected_guild") {
          confirmedNames.push(name);
        }
        // "matches_expected_guild" or "unavailable" — either way, fall
        // through to the "not yet imported, retry" queue below (unchanged
        // mechanism) — confirmedNames just gets a more confident message.
      }

      unmatchedNames.push(name);
      continue;
    }
    displayNames.push(row.name);
    // Now genuinely in the local roster — if a prior run had this name
    // tracked as an external (wrong-guild/unguilded) character, that's
    // stale now; cleaned up in a batch after the loop (see graduatedNames
    // below).
    graduatedNames.push(row.name);

    if (row.claimedByDiscordUserId == null) {
      await db.guildRosterMember.update({
        where: { id: row.id },
        data: {
          claimedByDiscordUserId: member.id,
          claimedByDiscordTag: member.user.tag,
          claimedAt: new Date(),
        },
      });
      matched.push({ rank: row.rank, level: row.level, class: row.class });
      if (
        row.rankChangedAt &&
        (!latestRankChangedAt || row.rankChangedAt > latestRankChangedAt)
      ) {
        latestRankChangedAt = row.rankChangedAt;
      }
      matchedNames.push(row.name);
    } else if (row.claimedByDiscordUserId === member.id) {
      matched.push({ rank: row.rank, level: row.level, class: row.class });
      if (
        row.rankChangedAt &&
        (!latestRankChangedAt || row.rankChangedAt > latestRankChangedAt)
      ) {
        latestRankChangedAt = row.rankChangedAt;
      }
      matchedNames.push(row.name);
    } else {
      conflictNames.push(row.name);
      await db.guildRosterClaimConflict.create({
        data: {
          guildId: guild.id,
          rosterMemberId: row.id,
          attemptedByDiscordId: member.id,
          attemptedByDiscordTag: member.user.tag,
        },
      });
    }
  }

  if (graduatedNames.length > 0) {
    const graduatedLower = new Set(graduatedNames.map((n) => n.toLowerCase()));
    const staleExternal = await db.guildExternalCharacter.findMany({
      where: { guildId: guild.id, discordUserId: member.id },
      select: { id: true, name: true },
    });
    const staleIds = staleExternal
      .filter((r) => graduatedLower.has(r.name.toLowerCase()))
      .map((r) => r.id);
    if (staleIds.length > 0) {
      await db.guildExternalCharacter.deleteMany({
        where: { id: { in: staleIds } },
      });
    }
  }

  if (conflictNames.length > 0) {
    const list = conflictNames.map((n) => `\`${n}\``).join(", ");
    await notifyAdmins(
      member,
      guild.id,
      `⚠️ **Roster claim conflict**: ${member.user.tag} claimed ${list}, but ${conflictNames.length === 1 ? "it's" : "they're"} already claimed by a different Discord account. Their nickname was still set, but no roles were granted for ${conflictNames.length === 1 ? "that character" : "those characters"}.`,
    );
  }

  const uncertainNames = unmatchedNames.filter(
    (n) => !confirmedNames.includes(n),
  );
  if (confirmedNames.length > 0) {
    const list = confirmedNames.map((n) => `\`${n}\``).join(", ");
    await notifyAdmins(
      member,
      guild.id,
      `✅ ${member.user.tag} typed ${list} — Battle.net confirms ${confirmedNames.length === 1 ? "it's" : "they're"} a member of this guild, just not in the locally-imported roster yet. Their nickname was still set as typed; roles will apply automatically once the roster catches up.`,
    );
    await notify(
      confirmedNames.length === 1
        ? `Good news — I checked directly with Blizzard and \`${confirmedNames[0]}\` really is in this guild. Our member list on this bot just hasn't caught up with the game yet — I'll set your roles automatically the moment it does, nothing you need to do.`
        : `Good news — I checked directly with Blizzard and ${list} really are in this guild. Our member list on this bot just hasn't caught up with the game yet — I'll set your roles automatically the moment it does, nothing you need to do.`,
    );
  }
  if (uncertainNames.length > 0) {
    const list = uncertainNames.map((n) => `\`${n}\``).join(", ");
    await notifyAdmins(
      member,
      guild.id,
      `❓ ${member.user.tag} typed ${list} during onboarding, but ${uncertainNames.length === 1 ? "it wasn't" : "they weren't"} found on our guild's member list — probably just hasn't been imported/re-synced yet. Their nickname was still set as typed; I'll keep retrying automatically for up to 42h.`,
    );
  }

  if (invalidNames.length > 0) {
    const list = invalidNames.map((n) => `\`${n}\``).join(", ");
    await notifyAdmins(
      member,
      guild.id,
      `❌ ${member.user.tag} typed ${list} during onboarding, but no such character exists in-game at all — probably typed a nickname instead of the exact character name. Not queued for retry.`,
    );
    await notify(
      invalidNames.length === 1
        ? `I couldn't find a character actually named "${invalidNames[0]}" in the game at all — double-check you typed the real character name, not a nickname people call you. Your Discord nickname was still set as typed either way; ask an officer if you'd like it fixed.`
        : `I couldn't find characters actually named ${list} in the game at all — double-check you typed the real character names, not nicknames people call you. Your Discord nickname was still set as typed either way; ask an officer if you'd like it fixed.`,
    );
  }

  if (externalCharacters.length > 0) {
    for (const c of externalCharacters) {
      await db.guildExternalCharacter.upsert({
        where: {
          guildId_discordUserId_name: {
            guildId: guild.id,
            discordUserId: member.id,
            name: c.name,
          },
        },
        create: {
          guildId: guild.id,
          discordUserId: member.id,
          discordUserTag: member.user.tag,
          name: c.name,
          level: c.level,
          class: c.class,
          actualGuildName: c.actualGuildName,
        },
        update: {
          discordUserTag: member.user.tag,
          level: c.level,
          class: c.class,
          actualGuildName: c.actualGuildName,
        },
      });
    }

    const list = externalCharacters
      .map((c) =>
        c.actualGuildName
          ? `\`${c.name}\` (in "${c.actualGuildName}")`
          : `\`${c.name}\` (no guild)`,
      )
      .join(", ");
    const realCharactersNote =
      matchedNames.length > 0
        ? ` (real characters: ${matchedNames.map((n) => `\`${n}\``).join(", ")})`
        : "";
    await notifyAdmins(
      member,
      guild.id,
      `⚠️ ${member.user.tag}${realCharactersNote} typed ${list} during onboarding, looked up via BNet API — real character(s), but not a member of this guild. Granted level-range channel access only, no roles.`,
    );
    await notify(
      `${externalCharacters.length === 1 ? "One of your characters isn't" : "Some of your characters aren't"} a member of this guild (${list}) — you'll get access to any level-range channels based on ${externalCharacters.length === 1 ? "it" : "them"}, not full member roles for now. If it ever shows up as a member of this guild, I'll notice automatically and set your roles up — no need to redo anything.`,
    );
  }

  let roleIds = new Set<string>();
  let channelGrants: ChannelGrant[] = [];
  if (matched.length > 0 || externalCharacters.length > 0) {
    const rules = await db.guildRoleRule.findMany({
      where: { guildId: guild.id },
      include: { conditions: true, grantedRoles: true, grantedChannels: true },
    });
    const rolePriorities = await db.guildRolePriority.findMany({
      where: { guildId: guild.id },
    });
    if (matched.length > 0) {
      ({ roleIds, channelGrants } = evaluateRules(
        rules,
        matched,
        rolePriorities,
      ));
    }
    if (externalCharacters.length > 0) {
      // Only channel-only rules (no granted roles) ever fire off an
      // external character — they're not a member of this guild, so no
      // rule should ever hand them a role through this path.
      const channelOnlyRules = rules.filter((r) => r.grantedRoles.length === 0);
      const externalAsMatched: MatchedCharacter[] = externalCharacters.map(
        (c) => ({ rank: "", level: c.level, class: c.class }),
      );
      const { channelGrants: externalGrants } = evaluateRules(
        channelOnlyRules,
        [...matched, ...externalAsMatched],
      );
      const existingChannelIds = new Set(channelGrants.map((g) => g.channelId));
      for (const grant of externalGrants) {
        if (!existingChannelIds.has(grant.channelId)) {
          channelGrants.push(grant);
          existingChannelIds.add(grant.channelId);
        }
      }
    }
  }

  if (matched.length > 0 || (options.applyEvenIfNoMatch ?? true)) {
    let nicknameNames = includeAltsInNickname
      ? displayNames
      : displayNames.slice(0, 1);

    // Refresh the "what it'd be with no override" record every run, and
    // apply a previously-set preferred-nickname override (from onboarding's
    // own question, or set by an officer on the site) in place of the main
    // name slot — alts, if included, are unaffected. See
    // GuildMemberNickname in schema.prisma.
    const nicknameRow = await db.guildMemberNickname.upsert({
      where: {
        guildId_discordUserId: { guildId: guild.id, discordUserId: member.id },
      },
      create: {
        guildId: guild.id,
        discordUserId: member.id,
        discordUserTag: member.user.tag,
        computedName: displayNames.join("/"),
      },
      update: {
        discordUserTag: member.user.tag,
        computedName: displayNames.join("/"),
      },
    });
    if (nicknameRow.preferredNickname) {
      nicknameNames = includeAltsInNickname
        ? [nicknameRow.preferredNickname, ...displayNames.slice(1)]
        : [nicknameRow.preferredNickname];
    }

    await applyNicknameAndRoles(
      member,
      guild.id,
      nicknameNames,
      [...roleIds],
      channelGrants,
      {
        chooseNicknameNames: options.chooseNicknameNames,
        notify: options.notify,
        rankChangedAt: latestRankChangedAt,
      },
    );
  }

  return {
    matchedCount: matched.length,
    conflictCount: conflictNames.length,
    unmatchedCount: unmatchedNames.length,
    confirmedCount: confirmedNames.length,
    invalidCount: invalidNames.length,
    externalCount: externalCharacters.length,
  };
}
