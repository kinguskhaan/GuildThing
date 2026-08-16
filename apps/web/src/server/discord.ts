import { env } from "~/env";
import { auth } from "~/server/better-auth";
import { db } from "~/server/db";

export class DiscordReauthRequiredError extends Error {
  constructor() {
    super("Discord re-authentication required");
    this.name = "DiscordReauthRequiredError";
  }
}

export class DiscordRateLimitedError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Discord rate limited, retry after ${retryAfterSeconds}s`);
    this.name = "DiscordRateLimitedError";
  }
}

async function getDiscordAccessToken(userId: string): Promise<string> {
  try {
    const result = await auth.api.getAccessToken({
      body: { providerId: "discord", userId },
    });
    if (!result.accessToken) throw new DiscordReauthRequiredError();
    return result.accessToken;
  } catch {
    throw new DiscordReauthRequiredError();
  }
}

// Discord's /users/@me/guilds/{id}/member endpoint is aggressively rate
// limited (order of minutes, not the normal 50 req/s), and role membership
// rarely changes for people who already have it — so we only actually need
// to check *those* a couple of times a day, not on every nav. But someone
// who isn't a member (yet) is much more likely to become one soon (they
// just joined, or are about to) and there's no login-driven signal to catch
// that the way there is for existing members re-authing — so that case gets
// a much shorter TTL instead, and just naturally rechecks on its own. To
// get there we:
// - cache resolved member roles, keyed per guild+user, for a TTL that
//   depends on the result — see ttlFor()
// - persist that cache to the DB, not just in memory: an in-memory-only
//   cache gets wiped by every dev-server reload or prod deploy, which on its
//   own was enough to trigger repeated 429s against a strict endpoint
// - single-flight concurrent lookups for the same key into one fetch
// - once Discord 429s us, honor retry_after and skip the network entirely
//   until it passes, for every caller, instead of hammering it further
const MEMBER_CACHE_TTL_MS = 12 * 60 * 60_000; // existing members: ~2x/day
const NOT_MEMBER_CACHE_TTL_MS = 2 * 60_000; // not (yet) a member: ~every visit
const MAX_CACHE_TTL_MS = MEMBER_CACHE_TTL_MS;

function ttlFor(roles: string[] | null): number {
  return roles === null ? NOT_MEMBER_CACHE_TTL_MS : MEMBER_CACHE_TTL_MS;
}

const memberCache = new Map<
  string,
  { roles: string[] | null; cachedAt: number }
>();
const rateLimitedUntil = new Map<string, number>();
const pendingLookups = new Map<string, Promise<string[] | null>>();

// A fresh Discord sign-in is the one reliable signal that the user actually
// wants their role membership rechecked (e.g. they just got added to a
// role and logged back in) — better-auth bumps the linked account's row on
// every OAuth callback, so anything cached from before that timestamp is
// treated as stale regardless of its own TTL.
async function discordAccountUpdatedAt(userId: string): Promise<Date | null> {
  const account = await db.account.findFirst({
    where: { userId, providerId: "discord" },
    select: { updatedAt: true },
  });
  return account?.updatedAt ?? null;
}

async function readPersistedRoles(
  discordGuildId: string,
  userId: string,
  accountUpdatedAt: Date | null,
): Promise<{ roles: string[] | null; fetchedAt: Date } | undefined> {
  const row = await db.discordMemberRoleCache.findUnique({
    where: { discordGuildId_userId: { discordGuildId, userId } },
  });
  if (!row || Date.now() - row.fetchedAt.getTime() > MAX_CACHE_TTL_MS) {
    return undefined;
  }
  const roles = row.roles == null ? null : (JSON.parse(row.roles) as string[]);
  if (Date.now() - row.fetchedAt.getTime() > ttlFor(roles)) {
    return undefined;
  }
  if (
    accountUpdatedAt &&
    row.fetchedAt.getTime() < accountUpdatedAt.getTime()
  ) {
    return undefined;
  }
  return { roles, fetchedAt: row.fetchedAt };
}

async function persistRoles(
  discordGuildId: string,
  userId: string,
  roles: string[] | null,
) {
  await db.discordMemberRoleCache.upsert({
    where: { discordGuildId_userId: { discordGuildId, userId } },
    create: {
      discordGuildId,
      userId,
      roles: roles == null ? null : JSON.stringify(roles),
    },
    update: {
      roles: roles == null ? null : JSON.stringify(roles),
      fetchedAt: new Date(),
    },
  });
}

async function fetchMemberRoles(
  discordGuildId: string,
  userId: string,
  cacheKey: string,
): Promise<string[] | null> {
  const accessToken = await getDiscordAccessToken(userId);

  const res = await fetch(
    `https://discord.com/api/users/@me/guilds/${discordGuildId}/member`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (res.status === 404) {
    memberCache.set(cacheKey, { roles: null, cachedAt: Date.now() });
    await persistRoles(discordGuildId, userId, null);
    return null;
  }
  if (res.status === 401 || res.status === 403) {
    throw new DiscordReauthRequiredError();
  }
  if (res.status === 429) {
    const body = await res.text().catch(() => "");
    const retryAfter = Number(
      (JSON.parse(body || "{}") as { retry_after?: number }).retry_after ?? 5,
    );
    rateLimitedUntil.set(cacheKey, Date.now() + retryAfter * 1000);
    console.error(
      `[discord] rate limited for guild ${discordGuildId}, retry after ${retryAfter}s`,
    );
    throw new DiscordRateLimitedError(retryAfter);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(
      `[discord] member lookup failed for guild ${discordGuildId}: ${res.status} ${body}`,
    );
    throw new Error(`Discord API error ${res.status}`);
  }

  const member = (await res.json()) as { roles?: string[] };
  const memberRoles = member.roles ?? [];
  memberCache.set(cacheKey, { roles: memberRoles, cachedAt: Date.now() });
  await persistRoles(discordGuildId, userId, memberRoles);
  return memberRoles;
}

// Shared by hasGuildRole and getMyRoleIds — resolves (cached) which role
// IDs `userId` holds in `discordGuildId`, or null if they aren't a member.
async function getMemberRoles(
  discordGuildId: string,
  userId: string,
): Promise<string[] | null> {
  const cacheKey = `${discordGuildId}:${userId}`;
  const accountUpdatedAt = await discordAccountUpdatedAt(userId);

  const cached = memberCache.get(cacheKey);
  if (
    cached &&
    Date.now() - cached.cachedAt < ttlFor(cached.roles) &&
    (!accountUpdatedAt || cached.cachedAt >= accountUpdatedAt.getTime())
  ) {
    return cached.roles;
  }

  const limitedUntil = rateLimitedUntil.get(cacheKey);
  if (limitedUntil && limitedUntil > Date.now()) {
    throw new DiscordRateLimitedError(
      Math.ceil((limitedUntil - Date.now()) / 1000),
    );
  }

  const persisted = await readPersistedRoles(
    discordGuildId,
    userId,
    accountUpdatedAt,
  );
  if (persisted) {
    memberCache.set(cacheKey, {
      roles: persisted.roles,
      cachedAt: persisted.fetchedAt.getTime(),
    });
    return persisted.roles;
  }

  let lookup = pendingLookups.get(cacheKey);
  if (!lookup) {
    lookup = fetchMemberRoles(discordGuildId, userId, cacheKey).finally(() => {
      pendingLookups.delete(cacheKey);
    });
    pendingLookups.set(cacheKey, lookup);
  }

  return lookup;
}

/**
 * Checks whether `userId` holds at least one of `requiredRoleIds` in the
 * discord guild `discordGuildId`, using the user's own OAuth token
 * (guilds.members.read scope) rather than a bot.
 */
export async function hasGuildRole(
  discordGuildId: string,
  requiredRoleIds: string[],
  userId: string,
): Promise<boolean> {
  const memberRoles = await getMemberRoles(discordGuildId, userId);
  return (
    memberRoles !== null &&
    requiredRoleIds.some((roleId) => memberRoles.includes(roleId))
  );
}

/**
 * Whether `userId` is a member of `discordGuildId` at all, regardless of
 * which (if any) roles they hold there. Used to decide whether a guild
 * shows up in someone's list at all — the specific required-role gate is
 * enforced separately, once they open it.
 */
export async function isGuildMember(
  discordGuildId: string,
  userId: string,
): Promise<boolean> {
  return (await getMemberRoles(discordGuildId, userId)) !== null;
}

/**
 * Returns the role IDs `userId` personally holds in `discordGuildId` (empty
 * if they aren't a member). Discord's user-OAuth API has no endpoint for a
 * server's full role list with names (that needs a bot) — this is the one
 * role-related thing available without one, so the create-guild form can at
 * least offer "your roles here" as clickable IDs instead of a blank field.
 */
export async function getMyRoleIds(
  discordGuildId: string,
  userId: string,
): Promise<string[]> {
  return (await getMemberRoles(discordGuildId, userId)) ?? [];
}

// A Discord server's name/icon is server-owned data — the same for every
// viewer — so unlike member roles this is cached per-guild, not per-user.
// /users/@me/guilds returns every guild the token's user is in, so one
// fetch (whichever registered guild triggers the cache miss first) refills
// the cache for every other guild that same user happens to be in too.
const GUILD_INFO_CACHE_TTL_MS = 24 * 60 * 60_000;

export interface DiscordGuildSummary {
  id: string;
  name: string;
  icon: string | null;
}

function guildIconUrl(
  discordGuildId: string,
  icon: string | null,
): string | null {
  if (!icon) return null;
  return `https://cdn.discordapp.com/icons/${discordGuildId}/${icon}.${icon.startsWith("a_") ? "gif" : "png"}`;
}

export async function fetchUserGuilds(
  userId: string,
): Promise<DiscordGuildSummary[]> {
  const accessToken = await getDiscordAccessToken(userId);

  const res = await fetch("https://discord.com/api/users/@me/guilds", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401 || res.status === 403) {
    throw new DiscordReauthRequiredError();
  }
  if (res.status === 429) {
    const body = await res.text().catch(() => "");
    const retryAfter = Number(
      (JSON.parse(body || "{}") as { retry_after?: number }).retry_after ?? 5,
    );
    throw new DiscordRateLimitedError(retryAfter);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[discord] guild list lookup failed: ${res.status} ${body}`);
    throw new Error(`Discord API error ${res.status}`);
  }

  return (await res.json()) as DiscordGuildSummary[];
}

/**
 * Resolves a Discord server's icon URL (or null if it has none / the given
 * user isn't in it), using the user's own OAuth token (guilds scope).
 */
export async function getGuildIconUrl(
  discordGuildId: string,
  requestingUserId: string,
): Promise<string | null> {
  const cached = await db.discordGuildInfoCache.findUnique({
    where: { discordGuildId },
  });
  if (
    cached &&
    Date.now() - cached.fetchedAt.getTime() < GUILD_INFO_CACHE_TTL_MS
  ) {
    return guildIconUrl(discordGuildId, cached.icon);
  }

  const guilds = await fetchUserGuilds(requestingUserId);

  // Free bonus: cache every guild this user is in, not just the one asked
  // for, since we already paid for the request.
  await Promise.all(
    guilds.map((g) =>
      db.discordGuildInfoCache.upsert({
        where: { discordGuildId: g.id },
        create: { discordGuildId: g.id, name: g.name, icon: g.icon },
        update: { name: g.name, icon: g.icon, fetchedAt: new Date() },
      }),
    ),
  );

  const match = guilds.find((g) => g.id === discordGuildId);
  return match ? guildIconUrl(discordGuildId, match.icon) : null;
}

export interface DiscordRoleSummary {
  id: string;
  name: string;
  color: number;
  position: number;
}

/**
 * Full role list (id + name) for a Discord server, using the GuildThing
 * Roster bot's own token — the one thing user OAuth can't give us (see
 * getMyRoleIds above, which exists only because this wasn't available
 * before the bot did). Requires the bot to actually be a member of
 * discordGuildId; returns an empty list rather than throwing if it isn't,
 * since "not invited yet" isn't really an error condition for the admin
 * forms that call this — they just fall back to nothing to pick from.
 */
export async function getGuildRoles(
  discordGuildId: string,
): Promise<DiscordRoleSummary[]> {
  const res = await fetch(
    `https://discord.com/api/v10/guilds/${discordGuildId}/roles`,
    { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } },
  );

  if (res.status === 403 || res.status === 404) {
    return [];
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[discord] role list lookup failed: ${res.status} ${body}`);
    throw new Error(`Discord API error ${res.status}`);
  }

  const roles = (await res.json()) as {
    id: string;
    name: string;
    color: number;
    position: number;
    managed: boolean;
  }[];

  return roles
    .filter((r) => r.name !== "@everyone" && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      position: r.position,
    }));
}

export interface DiscordChannelSummary {
  id: string;
  name: string;
}

// Discord channel types that matter here — GUILD_TEXT for the bot's own
// notice/onboarding-button posts, both for the channel-grant picker (a rule
// can grant direct access to either kind, see GuildRoleRuleGrantedChannel).
const GUILD_TEXT_CHANNEL_TYPE = 0;
const GUILD_VOICE_CHANNEL_TYPE = 2;
const GUILD_FORUM_CHANNEL_TYPE = 15;

interface RawDiscordChannel {
  id: string;
  name: string;
  type: number;
  position: number;
}

async function fetchGuildChannels(
  discordGuildId: string,
): Promise<RawDiscordChannel[]> {
  const res = await fetch(
    `https://discord.com/api/v10/guilds/${discordGuildId}/channels`,
    { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } },
  );

  if (res.status === 403 || res.status === 404) {
    return [];
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(
      `[discord] channel list lookup failed: ${res.status} ${body}`,
    );
    throw new Error(`Discord API error ${res.status}`);
  }

  return (await res.json()) as RawDiscordChannel[];
}

/**
 * Text-channel list for a Discord server, using the bot's own token — same
 * pattern and same "empty list, not an error, if the bot isn't in the
 * server yet" behavior as getGuildRoles above. Used to let an admin pick
 * where the bot should post notices (e.g. roster-claim conflicts) or the
 * standing onboarding button.
 */
export async function getGuildChannels(
  discordGuildId: string,
): Promise<DiscordChannelSummary[]> {
  const channels = await fetchGuildChannels(discordGuildId);
  return channels
    .filter((c) => c.type === GUILD_TEXT_CHANNEL_TYPE)
    .sort((a, b) => a.position - b.position)
    .map((c) => ({ id: c.id, name: c.name }));
}

export interface DiscordEventChannelOption {
  id: string;
  name: string;
  type: "text" | "forum";
}

/**
 * Text AND forum channels for a Discord server, for the event-creation
 * channel picker — the bot posts a text-channel event as a thread, a
 * forum-channel one as a post (see apps/bot/src/events.ts), so both are
 * valid targets unlike the plain-text-only pickers above.
 */
export async function getGuildChannelsForEvents(
  discordGuildId: string,
): Promise<DiscordEventChannelOption[]> {
  const channels = await fetchGuildChannels(discordGuildId);
  return channels
    .filter(
      (c) =>
        c.type === GUILD_TEXT_CHANNEL_TYPE ||
        c.type === GUILD_FORUM_CHANNEL_TYPE,
    )
    .sort((a, b) => a.position - b.position)
    .map((c) => ({
      id: c.id,
      name: c.name,
      type:
        c.type === GUILD_FORUM_CHANNEL_TYPE
          ? ("forum" as const)
          : ("text" as const),
    }));
}

export interface DiscordChannelGrantOption {
  id: string;
  name: string;
  type: "text" | "voice";
}

/**
 * Text AND voice channels for a Discord server, used by the role-rule
 * admin UI to let an admin grant direct per-member access to a specific
 * channel (rather than only via a role) — see GuildRoleRuleGrantedChannel.
 */
export async function getGuildChannelsForGrants(
  discordGuildId: string,
): Promise<DiscordChannelGrantOption[]> {
  const channels = await fetchGuildChannels(discordGuildId);
  return channels
    .filter(
      (c) =>
        c.type === GUILD_TEXT_CHANNEL_TYPE ||
        c.type === GUILD_VOICE_CHANNEL_TYPE,
    )
    .sort((a, b) => a.position - b.position)
    .map((c) => ({
      id: c.id,
      name: c.name,
      type:
        c.type === GUILD_VOICE_CHANNEL_TYPE
          ? ("voice" as const)
          : ("text" as const),
    }));
}

export interface DiscordMemberSummary {
  id: string;
  tag: string;
  roleIds: string[];
  bot: boolean;
}

interface RawDiscordMember {
  user: { id: string; username: string; discriminator: string; bot?: boolean };
  roles: string[];
}

// Discord's own tag format: "name" for the new (discriminator "0")
// username system, "name#1234" for the legacy one.
function memberTag(user: RawDiscordMember["user"]): string {
  return user.discriminator === "0" || !user.discriminator
    ? user.username
    : `${user.username}#${user.discriminator}`;
}

/**
 * Every member of a Discord server, via the bot's own token — paginated
 * (Discord caps a single page at 1000). Requires the Server Members Intent
 * enabled for the bot (same one onboarding's join event needs) and the bot
 * to actually be in the server; returns an empty list rather than
 * throwing if it isn't, matching getGuildRoles/getGuildChannels above.
 */
export async function getGuildMembers(
  discordGuildId: string,
): Promise<DiscordMemberSummary[]> {
  const members: DiscordMemberSummary[] = [];
  let after = "0";

  for (;;) {
    const res = await fetch(
      `https://discord.com/api/v10/guilds/${discordGuildId}/members?limit=1000&after=${after}`,
      { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } },
    );

    if (res.status === 403 || res.status === 404) {
      return members.length > 0 ? members : [];
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[discord] member list lookup failed: ${res.status} ${body}`,
      );
      throw new Error(`Discord API error ${res.status}`);
    }

    const page = (await res.json()) as RawDiscordMember[];
    for (const m of page) {
      members.push({
        id: m.user.id,
        tag: memberTag(m.user),
        roleIds: m.roles,
        bot: m.user.bot ?? false,
      });
    }

    if (page.length < 1000) break;
    after = page[page.length - 1]!.user.id;
  }

  return members;
}

/**
 * DMs a Discord user directly via the bot's own token (open-DM-channel +
 * send, the same two REST calls discord.js does internally for
 * member.send()) — no gateway connection needed, so this works from the
 * web server without the separate bot process being involved at all.
 * Returns false (never throws) on failure — most commonly the recipient
 * has DMs from server members turned off, which is an expected outcome
 * here, not an error worth surfacing as one.
 */
export async function sendDirectMessage(
  discordUserId: string,
  content: string,
): Promise<boolean> {
  const openRes = await fetch(
    "https://discord.com/api/v10/users/@me/channels",
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient_id: discordUserId }),
    },
  );
  if (!openRes.ok) return false;
  const channel = (await openRes.json()) as { id: string };

  const sendRes = await fetch(
    `https://discord.com/api/v10/channels/${channel.id}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    },
  );
  return sendRes.ok;
}

/**
 * Grants a Discord role to a member via the bot's own token. Same
 * hierarchy rules as everywhere else the bot assigns roles apply: the
 * bot's own role must sit above discordRoleId, or this fails (returns
 * false rather than throwing — the caller reports failures in bulk).
 */
export async function addRoleToMember(
  discordGuildId: string,
  discordUserId: string,
  discordRoleId: string,
): Promise<boolean> {
  const res = await fetch(
    `https://discord.com/api/v10/guilds/${discordGuildId}/members/${discordUserId}/roles/${discordRoleId}`,
    {
      method: "PUT",
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    },
  );
  return res.ok;
}

/**
 * Sets (or, with `nickname: null`, clears) a member's Discord nickname via
 * the bot's own token — same hierarchy rules as everywhere else the bot
 * renames someone: the bot's own role must sit above theirs, or this fails
 * (returns false rather than throwing). Used by the admin nickname-override
 * panel so a change takes effect immediately, instead of waiting for the
 * member to re-run /onboarding.
 */
export async function setMemberNickname(
  discordGuildId: string,
  discordUserId: string,
  nickname: string | null,
): Promise<boolean> {
  const res = await fetch(
    `https://discord.com/api/v10/guilds/${discordGuildId}/members/${discordUserId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ nick: nickname }),
    },
  );
  return res.ok;
}
