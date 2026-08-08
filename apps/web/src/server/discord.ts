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

const memberCache = new Map<string, { roles: string[] | null; cachedAt: number }>();
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
  if (accountUpdatedAt && row.fetchedAt.getTime() < accountUpdatedAt.getTime()) {
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
    console.error(`[discord] rate limited for guild ${discordGuildId}, retry after ${retryAfter}s`);
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
    throw new DiscordRateLimitedError(Math.ceil((limitedUntil - Date.now()) / 1000));
  }

  const persisted = await readPersistedRoles(discordGuildId, userId, accountUpdatedAt);
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

function guildIconUrl(discordGuildId: string, icon: string | null): string | null {
  if (!icon) return null;
  return `https://cdn.discordapp.com/icons/${discordGuildId}/${icon}.${icon.startsWith("a_") ? "gif" : "png"}`;
}

export async function fetchUserGuilds(userId: string): Promise<DiscordGuildSummary[]> {
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
  if (cached && Date.now() - cached.fetchedAt.getTime() < GUILD_INFO_CACHE_TTL_MS) {
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
